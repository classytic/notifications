/**
 * G3 (arc-notifications docs/push-gaps-2026-11.md): per-channel idempotency in NotificationService.
 * A failed push beside a successful in-app write must be retried, and only the push.
 */
import { describe, expect, it } from 'vitest';
import { NotificationService } from '../src/NotificationService.js';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import { type IdempotencyStore, MemoryIdempotencyStore } from '../src/utils/idempotency.js';
import { MemoryQueue } from '../src/utils/queue.js';
import type { NotificationPayload, SendResult } from '../src/types.js';

class ScriptedChannel extends BaseChannel {
  delivered: string[] = [];
  /** Results to return in order; empty = sent. */
  script: Array<'fail' | 'fail-permanent'> = [];
  constructor(name: string, private readonly delayMs = 0) {
    super({ name });
  }
  async send(payload: NotificationPayload): Promise<SendResult> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const next = this.script.shift();
    if (next === 'fail') return { status: 'failed', channel: this.name, error: 'provider down' };
    if (next === 'fail-permanent') return { status: 'failed', channel: this.name, error: 'bad', retryable: false };
    this.delivered.push(payload.idempotencyKey ?? '');
    return { status: 'sent', channel: this.name };
  }
}

const payload = (key: string): NotificationPayload => ({
  event: 'order.created',
  recipient: { id: 'u1' },
  data: { title: 'x' },
  idempotencyKey: key,
});

describe('per-channel idempotency (default scope)', () => {
  it('in-app sent + push failed: a redelivery sends ONLY the push', async () => {
    const inApp = new ScriptedChannel('in-app');
    const push = new ScriptedChannel('push');
    push.script.push('fail');
    const store = new MemoryIdempotencyStore({ cleanupIntervalMs: 0 });
    const service = new NotificationService({ channels: [inApp, push], idempotency: { store } });

    const first = await service.send(payload('evt-1'));
    expect(first).toMatchObject({ sent: 1, failed: 1 });
    expect(store.has('evt-1:in-app')).toBe(true);
    expect(store.has('evt-1:push')).toBe(false);

    const second = await service.send(payload('evt-1'));
    expect(second).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    expect(second.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'push', status: 'sent' }),
        expect.objectContaining({ channel: 'in-app', status: 'skipped', error: 'duplicate (idempotency)' }),
      ]),
    );
    expect(inApp.delivered).toEqual(['evt-1']);
    expect(push.delivered).toEqual(['evt-1']);

    // Third time: every channel done -> the 2.9 duplicate shape.
    const third = await service.send(payload('evt-1'));
    expect(third).toMatchObject({ sent: 0, failed: 0, skipped: 1, results: [] });
  });

  it("scope 'payload' (2.9) loses the failed push: the documented reason for the change", async () => {
    const inApp = new ScriptedChannel('in-app');
    const push = new ScriptedChannel('push');
    push.script.push('fail');
    const service = new NotificationService({ channels: [inApp, push], idempotency: { scope: 'payload' } });
    await service.send(payload('evt-2'));
    const again = await service.send(payload('evt-2'));
    expect(again).toMatchObject({ sent: 0, skipped: 1 });
    expect(push.delivered).toEqual([]);
  });

  it('concurrent duplicates deliver each channel exactly once', async () => {
    const inApp = new ScriptedChannel('in-app', 15);
    const push = new ScriptedChannel('push', 15);
    const service = new NotificationService({ channels: [inApp, push], idempotency: {} });
    await Promise.all([1, 2, 3].map(() => service.send(payload('evt-3'))));
    expect(inApp.delivered).toEqual(['evt-3']);
    expect(push.delivered).toEqual(['evt-3']);
  });

  it('a store without claim() dedupes per channel with has()/set()', async () => {
    const inner = new MemoryIdempotencyStore({ cleanupIntervalMs: 0 });
    const store: IdempotencyStore = { has: (k) => inner.has(k), set: (k, ms) => inner.set(k, ms) };
    const inApp = new ScriptedChannel('in-app');
    const push = new ScriptedChannel('push');
    push.script.push('fail');
    const service = new NotificationService({ channels: [inApp, push], idempotency: { store } });
    await service.send(payload('evt-4'));
    await service.send(payload('evt-4'));
    expect(inApp.delivered).toEqual(['evt-4']);
    expect(push.delivered).toEqual(['evt-4']);
  });

  it('a pipeline error releases every claim', async () => {
    const store = new MemoryIdempotencyStore({ cleanupIntervalMs: 0 });
    const service = new NotificationService({
      channels: [new ScriptedChannel('in-app'), new ScriptedChannel('push')],
      idempotency: { store },
      templates: () => {
        throw new Error('boom');
      },
    });
    await expect(service.send({ ...payload('evt-5'), template: 't' })).rejects.toThrow(/boom/);
    expect(store.has('evt-5:in-app')).toBe(false);
    expect(store.has('evt-5:push')).toBe(false);
  });

  it('a payload targeting one channel claims only that channel', async () => {
    const store = new MemoryIdempotencyStore({ cleanupIntervalMs: 0 });
    const inApp = new ScriptedChannel('in-app');
    const push = new ScriptedChannel('push');
    const service = new NotificationService({ channels: [inApp, push], idempotency: { store } });
    await service.send({ ...payload('evt-6'), channels: ['push'] });
    expect(store.has('evt-6:push')).toBe(true);
    expect(store.has('evt-6:in-app')).toBe(false);
    // The same key later targeting in-app is not a duplicate.
    await service.send({ ...payload('evt-6'), channels: ['in-app'] });
    expect(inApp.delivered).toEqual(['evt-6']);
  });
});

describe('per-channel idempotency with a queue', () => {
  async function settle(queue: MemoryQueue, ms = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (queue.getAllJobs().every((j) => j.status === 'completed' || j.status === 'failed')) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('a partial failure throws so the queue retries, and the retry sends only the failed channel', async () => {
    const queue = new MemoryQueue({ concurrency: 1, retryDelay: 0 });
    const inApp = new ScriptedChannel('in-app');
    const push = new ScriptedChannel('push');
    push.script.push('fail');
    const service = new NotificationService({ channels: [inApp, push], queue, idempotency: {}, retry: { maxAttempts: 1 } });
    await service.send(payload('evt-q1'));
    await settle(queue);
    const job = queue.getAllJobs()[0]!;
    expect(job.status).toBe('completed');
    expect(job.attempts).toBe(2);
    expect(inApp.delivered).toEqual(['evt-q1']);
    expect(push.delivered).toEqual(['evt-q1']);
  });

  it('a permanent (retryable: false) failure beside a success does not make the queue retry', async () => {
    const queue = new MemoryQueue({ concurrency: 1, retryDelay: 0 });
    const inApp = new ScriptedChannel('in-app');
    const push = new ScriptedChannel('push');
    push.script.push('fail-permanent');
    const service = new NotificationService({ channels: [inApp, push], queue, idempotency: {}, retry: { maxAttempts: 1 } });
    await service.send(payload('evt-q2'));
    await settle(queue);
    expect(queue.getAllJobs()[0]).toMatchObject({ status: 'completed', attempts: 1 });
  });

  it('without an idempotency key a partial failure still completes (a re-run would duplicate)', async () => {
    const queue = new MemoryQueue({ concurrency: 1, retryDelay: 0 });
    const inApp = new ScriptedChannel('in-app');
    const push = new ScriptedChannel('push');
    push.script.push('fail');
    const service = new NotificationService({ channels: [inApp, push], queue, idempotency: {}, retry: { maxAttempts: 1 } });
    await service.send({ ...payload('x'), idempotencyKey: undefined });
    await settle(queue);
    expect(queue.getAllJobs()[0]).toMatchObject({ status: 'completed', attempts: 1 });
    expect(inApp.delivered).toHaveLength(1);
  });
});
