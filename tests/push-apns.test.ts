import http2 from 'node:http2';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apnsProvider,
  APNS_HOSTS,
  InvalidPushTokenError,
  PushCredentialsError,
  PushRejectedError,
  TransientPushError,
  type ApnsCredentials,
  type ApnsSession,
} from '../src/push/index.js';
import { apnsToken, ecKeys, rsaKeys, startFakeApns, type FakeApns } from './support/push-fakes.js';

const keys = ecKeys();
const TOKEN = apnsToken('ab');
let fake: FakeApns;

function creds(overrides: Partial<ApnsCredentials> = {}): ApnsCredentials {
  return {
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    privateKey: keys.privateKey,
    bundleId: 'com.example.app',
    environment: 'sandbox',
    ...overrides,
  };
}

type Opts = Partial<Parameters<typeof apnsProvider>[0]>;
const opened: Array<{ close(): Promise<void> }> = [];
function provider(extra: Opts = {}) {
  const p = apnsProvider({ credentials: creds(), host: fake.url, allowPlaintext: true, ...extra });
  opened.push(p);
  return p;
}

const msg = { token: TOKEN, title: 'Hello', body: 'World', platform: 'ios' as const };

beforeAll(async () => {
  fake = await startFakeApns(keys.publicKey);
});
afterAll(async () => {
  await Promise.all(opened.map((p) => p.close()));
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.script.length = 0;
});

describe('apnsProvider — request', () => {
  it('sends a token-authenticated HTTP/2 request with the documented headers', async () => {
    const res = await provider().send({ ...msg, collapseKey: 'c1', ttlSeconds: 0, data: { type: 'offer', offerId: 'o1' } });
    expect(res.messageId).toMatch(/^apns-/);
    const req = fake.requests[0]!;
    expect(req.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(req.headers['apns-topic']).toBe('com.example.app');
    expect(req.headers['apns-push-type']).toBe('alert');
    expect(req.headers['apns-priority']).toBe('10');
    expect(req.headers['apns-collapse-id']).toBe('c1');
    expect(req.headers['apns-expiration']).toBe('0');
    expect(req.jwt.valid).toBe(true);
    expect(req.jwt.header).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(req.jwt.claims.iss).toBe('TEAM123456');
    expect(req.body).toEqual({
      type: 'offer',
      offerId: 'o1',
      aps: { alert: { title: 'Hello', body: 'World' }, sound: 'default' },
    });
  });

  it('a data-only push is background, priority 5, content-available', async () => {
    await provider().send({ token: TOKEN, title: '', body: '', data: { type: 'sync' }, contentAvailable: true });
    const req = fake.requests[0]!;
    expect(req.headers['apns-push-type']).toBe('background');
    expect(req.headers['apns-priority']).toBe('5');
    expect(req.body).toEqual({ type: 'sync', aps: { 'content-available': 1 } });
  });

  it('expiration is absolute epoch seconds for a positive ttl', async () => {
    const now = 1_800_000_000_000;
    await provider({ now: () => now }).send({ ...msg, ttlSeconds: 90 });
    expect(fake.requests[0]!.headers['apns-expiration']).toBe(String(1_800_000_000 + 90));
  });

  it('interruption levels: critical needs the entitlement, passive passes through', async () => {
    await provider().send({ ...msg, interruptionLevel: 'critical' });
    expect((fake.requests[0]!.body.aps as any)['interruption-level']).toBe('time-sensitive');
    await provider({ allowCriticalAlerts: true }).send({ ...msg, interruptionLevel: 'critical' });
    expect(fake.requests[1]!.body.aps).toMatchObject({
      'interruption-level': 'critical',
      sound: { critical: 1, name: 'default', volume: 1 },
    });
    await provider().send({ ...msg, interruptionLevel: 'passive', sound: null });
    expect(fake.requests[2]!.body.aps).toEqual({ alert: { title: 'Hello', body: 'World' }, 'interruption-level': 'passive' });
  });

  it('rejects bad tokens, reserved keys, long collapse ids and oversize payloads before any request', async () => {
    const p = provider();
    await expect(p.send({ ...msg, token: 'not-hex!' })).rejects.toBeInstanceOf(PushRejectedError);
    await expect(p.send({ ...msg, data: { aps: 'x' } })).rejects.toBeInstanceOf(PushRejectedError);
    await expect(p.send({ ...msg, collapseKey: 'é'.repeat(33) })).rejects.toBeInstanceOf(PushRejectedError);
    await expect(p.send({ ...msg, body: 'x'.repeat(5000) })).rejects.toThrow(/4096/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('apnsProvider — session and provider token', () => {
  it('reuses ONE HTTP/2 session for many sends', async () => {
    const before = fake.sessions;
    const p = provider();
    await Promise.all(Array.from({ length: 10 }, () => p.send(msg)));
    await p.send(msg);
    expect(fake.sessions - before).toBe(1);
  });

  it('reconnects after GOAWAY', async () => {
    const before = fake.sessions;
    const p = provider();
    fake.goawayAfterNext = true;
    await p.send(msg);
    await new Promise((r) => setTimeout(r, 30));
    await p.send(msg);
    expect(fake.sessions - before).toBe(2);
  });

  it('reuses the JWT within its TTL and re-signs after it', async () => {
    let clock = 1_800_000_000_000;
    const p = provider({ now: () => clock });
    await p.send(msg);
    clock += 49 * 60_000;
    await p.send(msg);
    const [a, b] = fake.requests.map((r) => r.headers.authorization);
    expect(a).toBe(b);
    clock += 2 * 60_000; // 51 min: past the 50 min default
    await p.send(msg);
    expect(fake.requests[2]!.headers.authorization).not.toBe(a);
  });

  it('re-signs immediately when credentials rotate', async () => {
    let current = creds({ version: '1' });
    const p = provider({ credentials: () => current });
    await p.send(msg);
    current = creds({ version: '2', keyId: 'KEY7654321' });
    await p.send(msg);
    expect(fake.requests[1]!.jwt.header.kid).toBe('KEY7654321');
  });

  it('refuses a token TTL outside Apple’s 20 to 60 minute window', () => {
    expect(() => apnsProvider({ credentials: creds(), tokenTtlMs: 10 * 60_000 })).toThrow(/20 minutes/);
    expect(() => apnsProvider({ credentials: creds(), tokenTtlMs: 60 * 60_000 })).toThrow(/60 minutes/);
  });

  it('refuses a plaintext host unless allowPlaintext (tests only)', () => {
    expect(() => apnsProvider({ credentials: creds(), host: 'http://127.0.0.1:1' })).toThrow(/https/);
  });

  it('picks the APNs host from credentials.environment', async () => {
    const authorities: string[] = [];
    const connect = (authority: string) => {
      authorities.push(authority);
      return http2.connect(fake.url) as unknown as ApnsSession;
    };
    let current = creds({ environment: 'sandbox' });
    const p = apnsProvider({ credentials: () => current, connect });
    opened.push(p);
    await p.send(msg);
    current = creds({ environment: 'production', version: 'prod' });
    await p.send(msg);
    expect(authorities).toEqual([APNS_HOSTS.sandbox, APNS_HOSTS.production]);
  });

  it('close() ends the session', async () => {
    const p = provider();
    await p.send(msg);
    await expect(p.close()).resolves.toBeUndefined();
  });
});

describe('apnsProvider — error mapping', () => {
  const table: Array<[string, number, string | undefined, string, boolean]> = [
    ['410 Unregistered', 410, 'Unregistered', 'invalid:unregistered', true],
    ['400 BadDeviceToken', 400, 'BadDeviceToken', 'invalid:bad-device-token', true],
    ['400 DeviceTokenNotForTopic', 400, 'DeviceTokenNotForTopic', 'rejected', false],
    ['400 BadTopic', 400, 'BadTopic', 'rejected', false],
    ['413 PayloadTooLarge', 413, 'PayloadTooLarge', 'rejected', false],
    ['404 BadPath', 404, 'BadPath', 'rejected', false],
    ['403 MissingProviderToken', 403, 'MissingProviderToken', 'credentials', false],
    ['429 TooManyRequests', 429, 'TooManyRequests', 'transient', false],
    ['500 InternalServerError', 500, 'InternalServerError', 'transient', false],
    ['503 ServiceUnavailable', 503, 'ServiceUnavailable', 'transient', false],
  ];

  it.each(table)('%s', async (_name, status, reason, expected, hookCalled) => {
    const onInvalidToken = vi.fn();
    fake.script.push({ status, ...(reason ? { body: { reason } } : {}) });
    const err = await provider({ onInvalidToken }).send(msg).catch((e: unknown) => e);
    const [kind, why] = expected.split(':');
    if (kind === 'invalid') {
      expect(err).toBeInstanceOf(InvalidPushTokenError);
      expect((err as InvalidPushTokenError).reason).toBe(why);
    } else if (kind === 'rejected') expect(err).toBeInstanceOf(PushRejectedError);
    else if (kind === 'credentials') expect(err).toBeInstanceOf(PushCredentialsError);
    else expect(err).toBeInstanceOf(TransientPushError);
    if (hookCalled) expect(onInvalidToken).toHaveBeenCalledWith(TOKEN, why);
    else expect(onInvalidToken).not.toHaveBeenCalled();
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('403 ExpiredProviderToken re-signs and retries ONCE', async () => {
    const p = provider();
    fake.script.push({ status: 403, body: { reason: 'ExpiredProviderToken' } });
    await expect(p.send(msg)).resolves.toBeTruthy();
    expect(fake.requests).toHaveLength(2);
    fake.script.push({ status: 403, body: { reason: 'InvalidProviderToken' } }, { status: 403, body: { reason: 'InvalidProviderToken' } });
    await expect(p.send(msg)).rejects.toBeInstanceOf(PushCredentialsError);
  });

  it('TooManyRequests (one device) does not pause the provider; 503 + Retry-After does', async () => {
    let clock = 5_000_000;
    const p = provider({ now: () => clock });
    fake.script.push({ status: 429, body: { reason: 'TooManyRequests' } });
    await expect(p.send(msg)).rejects.toBeInstanceOf(TransientPushError);
    await expect(p.send(msg)).resolves.toBeTruthy();

    fake.script.push({ status: 503, body: { reason: 'ServiceUnavailable' }, headers: { 'retry-after': '3' } });
    const err = await p.send(msg).catch((e) => e);
    expect((err as TransientPushError).retryAfterMs).toBe(3000);
    const n = fake.requests.length;
    await expect(p.send(msg)).rejects.toMatchObject({ reason: 'cooling-down' });
    expect(fake.requests.length).toBe(n);
    clock += 3001;
    await expect(p.send(msg)).resolves.toBeTruthy();
  });

  it('a request timeout is retryable', async () => {
    fake.script.push({ status: 200, delayMs: 300 });
    const err = await provider({ requestTimeoutMs: 50 }).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(TransientPushError);
    expect((err as TransientPushError).reason).toBe('timeout');
  });

  it('a connection failure is retryable', async () => {
    const p = apnsProvider({ credentials: creds(), host: 'http://127.0.0.1:1', allowPlaintext: true });
    const err = await p.send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(TransientPushError);
    await p.close();
  });
});

describe('apnsProvider — credential validation', () => {
  it('requires an EC P-256 key and well-formed ids', async () => {
    await expect(provider({ credentials: creds({ privateKey: rsaKeys().privateKey }) }).send(msg)).rejects.toThrow(/P-256/);
    await expect(provider({ credentials: creds({ keyId: 'short' }) }).send(msg)).rejects.toThrow(/keyId/);
    await expect(provider({ credentials: creds({ teamId: '' }) }).send(msg)).rejects.toThrow(/missing teamId/);
    await expect(
      provider({ credentials: creds({ environment: 'staging' as 'sandbox' }) }).send(msg),
    ).rejects.toThrow(/environment/);
  });

  it('accepts a PEM with literal \\n escapes (env var form)', async () => {
    const escaped = keys.privateKey.replace(/\n/g, '\\n');
    await expect(provider({ credentials: creds({ privateKey: escaped }) }).send(msg)).resolves.toBeTruthy();
  });
});
