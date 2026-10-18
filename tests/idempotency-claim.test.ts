/**
 * Atomic idempotency claims (one delivery per key across processes):
 *   - MemoryIdempotencyStore claim/release, lease expiry
 *   - NotificationService: concurrent duplicates deliver once, failures release
 *   - RedisIdempotencyStore against a real Redis (`NOTIFICATIONS_TEST_REDIS_URL`,
 *     default redis://localhost:6379). Skipped with a message when unreachable.
 */
import { createConnection, type Socket } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { NotificationService } from '../src/NotificationService.js';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import {
  type IdempotencyStore,
  MemoryIdempotencyStore,
  type RedisIdempotencyClient,
  RedisIdempotencyStore,
} from '../src/utils/idempotency.js';
import type { NotificationPayload, SendResult } from '../src/types.js';

class CountingChannel extends BaseChannel {
  delivered: string[] = [];
  constructor(private readonly opts: { fail?: boolean; delayMs?: number } = {}) {
    super({ name: 'push' });
  }
  async send(payload: NotificationPayload): Promise<SendResult> {
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (this.opts.fail) return { status: 'failed', channel: this.name, error: 'down' };
    this.delivered.push(payload.idempotencyKey ?? '');
    return { status: 'sent', channel: this.name };
  }
}

const payload = (key: string): NotificationPayload => ({
  event: 'incident.created',
  recipient: { id: 'u1', deviceToken: 't1' },
  data: { title: 'x' },
  idempotencyKey: key,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MemoryIdempotencyStore.claim', () => {
  it('first claim wins, duplicates lose until release', () => {
    const store = new MemoryIdempotencyStore({ cleanupIntervalMs: 0 });
    expect(store.claim('k', 60_000)).toBe(true);
    expect(store.claim('k', 60_000)).toBe(false);
    expect(store.has('k')).toBe(true);
    store.release('k');
    expect(store.claim('k', 60_000)).toBe(true);
  });

  it('an expired lease (crashed sender) can be claimed again', async () => {
    const store = new MemoryIdempotencyStore({ cleanupIntervalMs: 0 });
    expect(store.claim('k', 20)).toBe(true);
    await sleep(40);
    expect(store.claim('k', 20)).toBe(true);
  });
});

describe('NotificationService with a claiming store', () => {
  it('concurrent duplicates deliver exactly once', async () => {
    const ch = new CountingChannel({ delayMs: 20 });
    const service = new NotificationService({ channels: [ch], idempotency: {} });
    const results = await Promise.all([service.send(payload('e1')), service.send(payload('e1')), service.send(payload('e1'))]);
    expect(ch.delivered).toEqual(['e1']);
    expect(results.map((r) => r.sent).sort()).toEqual([0, 0, 1]);
    expect(results.filter((r) => r.skipped === 1)).toHaveLength(2);
  });

  it('a failed delivery releases the claim so a redelivery can send', async () => {
    const store = new MemoryIdempotencyStore({ cleanupIntervalMs: 0 });
    const down = new NotificationService({ channels: [new CountingChannel({ fail: true })], idempotency: { store } });
    expect((await down.send(payload('e2'))).failed).toBe(1);
    expect(store.has('e2')).toBe(false);
    const up = new CountingChannel();
    const service = new NotificationService({ channels: [up], idempotency: { store } });
    expect((await service.send(payload('e2'))).sent).toBe(1);
    expect(up.delivered).toEqual(['e2']);
  });

  it('a thrown pipeline error releases the claim', async () => {
    const store = new MemoryIdempotencyStore({ cleanupIntervalMs: 0 });
    const service = new NotificationService({
      channels: [new CountingChannel()],
      idempotency: { store },
      templates: () => {
        throw new Error('boom');
      },
    });
    await expect(service.send({ ...payload('e3'), template: 't' })).rejects.toThrow(/boom/);
    expect(store.has('e3')).toBe(false);
  });

  it('success upgrades the lease to the full TTL', async () => {
    const calls: Array<[string, string, number]> = [];
    const inner = new MemoryIdempotencyStore({ cleanupIntervalMs: 0 });
    const store: IdempotencyStore = {
      has: (k) => inner.has(k),
      set: (k, ms) => {
        calls.push(['set', k, ms]);
        inner.set(k, ms);
      },
      claim: (k, ms) => {
        calls.push(['claim', k, ms]);
        return inner.claim(k, ms);
      },
      release: (k) => inner.release(k),
    };
    const service = new NotificationService({
      channels: [new CountingChannel()],
      idempotency: { store, ttl: 86_400_000, leaseMs: 30_000 },
    });
    await service.send(payload('e4'));
    expect(calls).toEqual([
      ['claim', 'e4', 30_000],
      ['set', 'e4', 86_400_000],
    ]);
  });

  it('stores without claim() keep the has/set behaviour', async () => {
    const inner = new MemoryIdempotencyStore({ cleanupIntervalMs: 0 });
    const store: IdempotencyStore = { has: (k) => inner.has(k), set: (k, ms) => inner.set(k, ms) };
    const ch = new CountingChannel();
    const service = new NotificationService({ channels: [ch], idempotency: { store } });
    await service.send(payload('e5'));
    await service.send(payload('e5'));
    expect(ch.delivered).toEqual(['e5']);
  });
});

// ---------------------------------------------------------------------------
// Redis: a minimal RESP client stands in for ioredis (the store is structurally
// typed), so the package keeps zero Redis dependencies.
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.NOTIFICATIONS_TEST_REDIS_URL ?? 'redis://localhost:6379';

function respClient(url: string): Promise<RedisIdempotencyClient & { raw(...args: string[]): Promise<unknown>; quit(): void }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ host: u.hostname, port: Number(u.port || 6379) });
    let buf = '';
    const waiting: Array<(v: unknown) => void> = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      // Replies used here are single-line: +OK, $-1, $1\r\n1, :n, -ERR.
      for (;;) {
        const end = buf.indexOf('\r\n');
        if (end < 0) return;
        const line = buf.slice(0, end);
        if (line[0] === '$' && line !== '$-1') {
          const len = Number(line.slice(1));
          if (buf.length < end + 2 + len + 2) return;
          const value = buf.slice(end + 2, end + 2 + len);
          buf = buf.slice(end + 2 + len + 2);
          waiting.shift()?.(value);
          continue;
        }
        buf = buf.slice(end + 2);
        const value =
          line[0] === '+' ? line.slice(1) : line[0] === ':' ? Number(line.slice(1)) : line === '$-1' ? null : new Error(line.slice(1));
        waiting.shift()?.(value);
      }
    });
    const raw = (...args: string[]) =>
      new Promise<unknown>((res, rej) => {
        waiting.push((v) => (v instanceof Error ? rej(v) : res(v)));
        socket.write(`*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`);
      });
    socket.once('error', reject);
    socket.once('connect', () =>
      resolve({
        raw,
        set: (k: string, v: string, px: 'PX', ms: number, nx?: 'NX') => raw('SET', k, v, px, String(ms), ...(nx ? [nx] : [])),
        del: (k: string) => raw('DEL', k),
        exists: async (k: string) => Number(await raw('EXISTS', k)),
        quit: () => socket.destroy(),
      } as RedisIdempotencyClient & { raw(...args: string[]): Promise<unknown>; quit(): void }),
    );
  });
}

const redisReachable = await respClient(REDIS_URL)
  .then(async (c) => {
    const pong = await c.raw('PING');
    c.quit();
    return pong === 'PONG';
  })
  .catch(() => false);

if (!redisReachable) {
  console.warn(`[idempotency-claim] Redis not reachable at ${new URL(REDIS_URL).host}: skipping RedisIdempotencyStore tests (set NOTIFICATIONS_TEST_REDIS_URL or start Redis).`);
}

describe.skipIf(!redisReachable)('RedisIdempotencyStore (real Redis)', () => {
  const prefix = `notif-test:${process.pid}:${Date.now()}:`;
  const clients: Array<Awaited<ReturnType<typeof respClient>>> = [];
  const connect = async () => {
    const c = await respClient(REDIS_URL);
    clients.push(c);
    return c;
  };

  afterAll(async () => {
    const c = clients[0];
    if (c) for (const k of ['r1', 'r2', 'r3', 'r4']) await c.del(prefix + k);
    for (const x of clients) x.quit();
  });

  it('claim is SET NX PX: one winner, set() extends, release() frees', async () => {
    const c = await connect();
    const store = new RedisIdempotencyStore({ client: c, prefix });
    expect(await store.claim('r1', 60_000)).toBe(true);
    expect(await store.claim('r1', 60_000)).toBe(false);
    expect(await store.has('r1')).toBe(true);
    await store.set('r1', 86_400_000);
    expect(Number(await c.raw('PTTL', prefix + 'r1'))).toBeGreaterThan(60_000);
    await store.release('r1');
    expect(await store.has('r1')).toBe(false);
  });

  it('the lease expires (a crashed sender does not hold the key)', async () => {
    const store = new RedisIdempotencyStore({ client: await connect(), prefix });
    expect(await store.claim('r2', 50)).toBe(true);
    await sleep(120);
    expect(await store.claim('r2', 50)).toBe(true);
  });

  it('two processes (separate connections + services) deliver a redelivered event once', async () => {
    const a = new CountingChannel({ delayMs: 20 });
    const b = new CountingChannel({ delayMs: 20 });
    const replicaA = new NotificationService({ channels: [a], idempotency: { store: new RedisIdempotencyStore({ client: await connect(), prefix }) } });
    const replicaB = new NotificationService({ channels: [b], idempotency: { store: new RedisIdempotencyStore({ client: await connect(), prefix }) } });
    await Promise.all([replicaA.send(payload('r3')), replicaB.send(payload('r3'))]);
    expect(a.delivered.length + b.delivered.length).toBe(1);
    // After a "restart" (fresh service, fresh connection) the key is still taken.
    const restarted = new CountingChannel();
    const replicaC = new NotificationService({ channels: [restarted], idempotency: { store: new RedisIdempotencyStore({ client: await connect(), prefix }) } });
    expect((await replicaC.send(payload('r3'))).skipped).toBe(1);
    expect(restarted.delivered).toEqual([]);
  });

  it('a failed send on one replica leaves the key free for the next', async () => {
    const store = new RedisIdempotencyStore({ client: await connect(), prefix });
    await new NotificationService({ channels: [new CountingChannel({ fail: true })], idempotency: { store } }).send(payload('r4'));
    expect(await store.has('r4')).toBe(false);
  });
});
