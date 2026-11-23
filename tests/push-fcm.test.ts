import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fcmProvider,
  InvalidPushTokenError,
  PushCredentialsError,
  PushRejectedError,
  TransientPushError,
  type FcmCredentials,
  type PushDeliveryEvent,
} from '../src/push/index.js';
import { ecKeys, fcmError, rsaKeys, startFakeFcm, type FakeFcm } from './support/push-fakes.js';

const keys = rsaKeys();
const TOKEN = 'fcm-device-token-0123456789-ABCDEFGHIJ';
let fake: FakeFcm;

function creds(overrides: Partial<FcmCredentials> = {}): FcmCredentials {
  return {
    projectId: 'demo-project',
    clientEmail: 'push@demo-project.iam.gserviceaccount.com',
    privateKey: keys.privateKey,
    privateKeyId: 'kid-1',
    tokenUri: fake.tokenUri,
    ...overrides,
  };
}

function provider(extra: Partial<Parameters<typeof fcmProvider>[0]> = {}) {
  return fcmProvider({ credentials: creds(), endpoint: fake.url, ...extra });
}

const msg = { token: TOKEN, title: 'Hello', body: 'World', platform: 'android' as const };

beforeAll(async () => {
  fake = await startFakeFcm(keys.publicKey);
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.tokenRequests.length = 0;
  fake.sends.length = 0;
  fake.sendScript.length = 0;
  fake.tokenScript.length = 0;
  fake.expiresIn = 3600;
});

describe('fcmProvider — OAuth2 service-account token', () => {
  it('signs a valid RS256 assertion with the documented claims', async () => {
    await provider().send(msg);
    expect(fake.tokenRequests).toHaveLength(1);
    const jwt = fake.tokenRequests[0]!;
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    expect(jwt.claims).toMatchObject({
      iss: 'push@demo-project.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: fake.tokenUri,
    });
    expect((jwt.claims.exp as number) - (jwt.claims.iat as number)).toBe(3600);
  });

  it('caches the access token across sends', async () => {
    const p = provider();
    await p.send(msg);
    await p.send(msg);
    await p.send(msg);
    expect(fake.tokenRequests).toHaveLength(1);
    const auth = fake.sends.map((s) => s.authorization);
    expect(auth[0]).toMatch(/^Bearer at-\d+$/);
    expect(new Set(auth).size).toBe(1);
  });

  it('single-flight: 20 concurrent sends share ONE token refresh', async () => {
    const p = provider();
    await Promise.all(Array.from({ length: 20 }, () => p.send(msg)));
    expect(fake.tokenRequests).toHaveLength(1);
    expect(fake.sends).toHaveLength(20);
  });

  it('refreshes 60 s before expiry, not after', async () => {
    let clock = 1_800_000_000_000;
    fake.expiresIn = 120;
    const p = provider({ now: () => clock });
    await p.send(msg);
    clock += 59_000; // 61 s left: still valid
    await p.send(msg);
    expect(fake.tokenRequests).toHaveLength(1);
    clock += 2_000; // 59 s left: refresh
    await p.send(msg);
    expect(fake.tokenRequests).toHaveLength(2);
  });

  it('a rotated credential (new version) applies on the next send without a restart', async () => {
    const other = rsaKeys();
    let current = creds({ version: '1' });
    const p = fcmProvider({ credentials: () => current, endpoint: fake.url });
    await p.send(msg);
    current = creds({ version: '2', privateKey: other.privateKey, privateKeyId: 'kid-2' });
    await p.send(msg);
    expect(fake.tokenRequests).toHaveLength(2);
    expect(fake.tokenRequests[1]!.header.kid).toBe('kid-2');
    // Signed by the NEW key: the fake verifies against the old public key, so it fails there.
    expect(fake.tokenRequests[1]!.valid).toBe(false);
  });

  it('an async credentials function is awaited and resolved per send', async () => {
    const source = vi.fn(async () => creds({ version: 'v1' }));
    const p = fcmProvider({ credentials: source, endpoint: fake.url });
    await p.send(msg);
    await p.send(msg);
    expect(source).toHaveBeenCalledTimes(2);
    expect(fake.tokenRequests).toHaveLength(1);
  });

  it('token endpoint refusal is a credentials error that names no secret', async () => {
    fake.tokenScript.push({ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } });
    const err = await provider().send(msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushCredentialsError);
    expect((err as PushCredentialsError).retryable).toBe(false);
    expect(String(err)).toContain('invalid_grant');
    expect(String(err)).not.toContain('PRIVATE KEY');
  });

  it('token endpoint 503 is retryable', async () => {
    fake.tokenScript.push({ status: 503, headers: { 'retry-after': '2' } });
    const err = await provider().send(msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientPushError);
    expect((err as TransientPushError).retryAfterMs).toBe(2000);
  });
});

describe('fcmProvider — message shape', () => {
  it('builds notification + android + apns blocks for a visible push', async () => {
    await provider().send({
      ...msg,
      data: { type: 'task_offer', offerId: 'o1' },
      collapseKey: 'offer-o1',
      threadId: 'offers',
      badge: 3,
      ttlSeconds: 60,
      channelId: 'p1_critical',
      interruptionLevel: 'critical',
    });
    const sent = fake.sends[0]!;
    expect(sent.path).toBe('/v1/projects/demo-project/messages:send');
    const message = (sent.body as { message: Record<string, any> }).message;
    expect(message.token).toBe(TOKEN);
    expect(message.notification).toEqual({ title: 'Hello', body: 'World' });
    expect(message.data).toEqual({ type: 'task_offer', offerId: 'o1' });
    expect(message.android).toEqual({
      priority: 'HIGH',
      ttl: '60s',
      collapseKey: 'offer-o1',
      notification: { tag: 'offer-o1', notificationCount: 3, channelId: 'p1_critical', sound: 'default' },
    });
    expect(message.apns.headers).toMatchObject({ 'apns-priority': '10', 'apns-push-type': 'alert', 'apns-collapse-id': 'offer-o1' });
    // No critical-alerts entitlement declared: downgraded to time-sensitive.
    expect(message.apns.payload.aps).toMatchObject({ 'interruption-level': 'time-sensitive', 'thread-id': 'offers', badge: 3, sound: 'default' });
  });

  it('critical with the entitlement uses the critical sound dictionary', async () => {
    await provider({ allowCriticalAlerts: true }).send({ ...msg, interruptionLevel: 'critical' });
    const aps = (fake.sends[0]!.body as any).message.apns.payload.aps;
    expect(aps['interruption-level']).toBe('critical');
    expect(aps.sound).toEqual({ critical: 1, name: 'default', volume: 1 });
  });

  it('a data-only push has no notification block and wakes in the background', async () => {
    await provider().send({ token: TOKEN, title: '', body: '', data: { type: 'sync' }, contentAvailable: true });
    const message = (fake.sends[0]!.body as any).message;
    expect(message.notification).toBeUndefined();
    expect(message.android).toEqual({ priority: 'NORMAL' });
    expect(message.apns.headers).toMatchObject({ 'apns-priority': '5', 'apns-push-type': 'background' });
    expect(message.apns.payload.aps).toEqual({ 'content-available': 1 });
  });

  it('validateOnly sends validate_only', async () => {
    await provider({ validateOnly: true }).send(msg);
    expect((fake.sends[0]!.body as any).validate_only).toBe(true);
  });

  it('rejects reserved / non-string data and long collapse keys before any request', async () => {
    const p = provider();
    await expect(p.send({ ...msg, data: { from: 'x' } })).rejects.toBeInstanceOf(PushRejectedError);
    await expect(p.send({ ...msg, data: { google_x: 'x' } })).rejects.toBeInstanceOf(PushRejectedError);
    await expect(p.send({ ...msg, data: { n: 1 as unknown as string } })).rejects.toBeInstanceOf(PushRejectedError);
    await expect(p.send({ ...msg, collapseKey: 'x'.repeat(65) })).rejects.toBeInstanceOf(PushRejectedError);
    await expect(p.send({ ...msg, token: 'has space' })).rejects.toBeInstanceOf(PushRejectedError);
    expect(fake.sends).toHaveLength(0);
  });
});

describe('fcmProvider — error mapping', () => {
  const table: Array<[string, ReturnType<typeof fcmError>, string, boolean]> = [
    ['UNREGISTERED', fcmError(404, 'NOT_FOUND', 'UNREGISTERED'), 'invalid:unregistered', true],
    [
      'INVALID_ARGUMENT (token)',
      fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token'),
      'invalid:invalid-token',
      true,
    ],
    [
      'INVALID_ARGUMENT (fieldViolations token)',
      fcmError(400, 'INVALID_ARGUMENT', undefined, 'Request contains an invalid argument.', [
        { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token' }] },
      ]),
      'invalid:invalid-token',
      true,
    ],
    ['INVALID_ARGUMENT (payload)', fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'Invalid data payload key: x'), 'rejected', false],
    ['SENDER_ID_MISMATCH', fcmError(403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH'), 'rejected', false],
    ['THIRD_PARTY_AUTH_ERROR', fcmError(401, 'UNAUTHENTICATED', 'THIRD_PARTY_AUTH_ERROR'), 'rejected', false],
    ['PERMISSION_DENIED', fcmError(403, 'PERMISSION_DENIED'), 'credentials', false],
    ['QUOTA_EXCEEDED', fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', 'Device message rate exceeded'), 'transient', false],
    ['UNAVAILABLE', fcmError(503, 'UNAVAILABLE', 'UNAVAILABLE'), 'transient', false],
    ['INTERNAL', fcmError(500, 'INTERNAL', 'INTERNAL'), 'transient', false],
    ['other 4xx', fcmError(409, 'ABORTED'), 'rejected', false],
  ];

  it.each(table)('%s', async (_name, response, expected, hookCalled) => {
    const onInvalidToken = vi.fn();
    fake.sendScript.push(response);
    const err = await provider({ onInvalidToken }).send(msg).catch((e: unknown) => e);
    const [kind, reason] = expected.split(':');
    if (kind === 'invalid') {
      expect(err).toBeInstanceOf(InvalidPushTokenError);
      expect((err as InvalidPushTokenError).reason).toBe(reason);
      expect((err as InvalidPushTokenError).retryable).toBe(false);
    } else if (kind === 'rejected') {
      expect(err).toBeInstanceOf(PushRejectedError);
      expect((err as PushRejectedError).retryable).toBe(false);
    } else if (kind === 'credentials') {
      expect(err).toBeInstanceOf(PushCredentialsError);
    } else {
      expect(err).toBeInstanceOf(TransientPushError);
      expect((err as TransientPushError).retryable).toBe(true);
    }
    if (hookCalled) expect(onInvalidToken).toHaveBeenCalledWith(TOKEN, reason);
    else expect(onInvalidToken).not.toHaveBeenCalled();
    // Redaction: never the full token, never key material.
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(String((err as Error).message)).not.toContain('PRIVATE');
  });

  it('a throwing onInvalidToken hook does not change the outcome', async () => {
    fake.sendScript.push(fcmError(404, 'NOT_FOUND', 'UNREGISTERED'));
    const err = await provider({ onInvalidToken: () => Promise.reject(new Error('db down')) }).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidPushTokenError);
  });

  it('401 refreshes the access token and retries ONCE', async () => {
    const p = provider();
    await p.send(msg); // token at-1 cached
    fake.sendScript.push(fcmError(401, 'UNAUTHENTICATED'));
    await expect(p.send(msg)).resolves.toMatchObject({ messageId: expect.stringContaining('messages/') });
    expect(fake.tokenRequests).toHaveLength(2);
    fake.sendScript.push(fcmError(401, 'UNAUTHENTICATED'), fcmError(401, 'UNAUTHENTICATED'));
    await expect(p.send(msg)).rejects.toBeInstanceOf(PushCredentialsError);
  });

  it('Retry-After on a provider-wide 429 cools the provider down (fail fast, no request)', async () => {
    let clock = 1_000_000;
    const p = provider({ now: () => clock });
    fake.sendScript.push({ ...fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', 'Quota exceeded for project'), headers: { 'retry-after': '7' } });
    const first = await p.send(msg).catch((e) => e);
    expect((first as TransientPushError).retryAfterMs).toBe(7000);
    const before = fake.sends.length;
    const second = await p.send(msg).catch((e) => e);
    expect(second).toBeInstanceOf(TransientPushError);
    expect((second as TransientPushError).reason).toBe('cooling-down');
    expect(fake.sends.length).toBe(before);
    clock += 7001;
    await expect(p.send(msg)).resolves.toBeTruthy();
  });

  it('a per-DEVICE 429 does not pause the whole provider', async () => {
    const p = provider();
    fake.sendScript.push({ ...fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', 'Device message rate exceeded'), headers: { 'retry-after': '30' } });
    await expect(p.send(msg)).rejects.toBeInstanceOf(TransientPushError);
    await expect(p.send(msg)).resolves.toBeTruthy();
  });

  it('a timeout is retryable', async () => {
    fake.sendScript.push({ status: 200, body: { name: 'late' }, delayMs: 300 });
    const err = await provider({ timeoutMs: 50 }).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(TransientPushError);
    expect((err as TransientPushError).reason).toBe('timeout');
  });
});

describe('fcmProvider — delivery events and concurrency', () => {
  it('emits one redacted event per send', async () => {
    const events: PushDeliveryEvent[] = [];
    const p = provider({ onDelivery: (e) => events.push(e) });
    await p.send(msg);
    fake.sendScript.push(fcmError(404, 'NOT_FOUND', 'UNREGISTERED'));
    await p.send(msg).catch(() => undefined);
    expect(events.map((e) => e.outcome)).toEqual(['sent', 'invalid-token']);
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain(TOKEN);
      expect(e.tokenSuffix).toBe(TOKEN.slice(-6));
      expect(e.tokenHash).toMatch(/^[0-9a-f]{16}$/);
      expect(e.provider).toBe('fcm');
      expect(e.platform).toBe('android');
    }
  });

  it('maxConcurrency bounds in-flight requests', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchSpy: typeof fetch = async (input, init) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await fetch(input, init);
      } finally {
        inFlight--;
      }
    };
    const p = provider({ fetch: fetchSpy, maxConcurrency: 3 });
    await p.send(msg); // prime the token so only sends race
    peak = 0;
    await Promise.all(Array.from({ length: 12 }, () => p.send(msg)));
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('fcmProvider — credential validation', () => {
  it('names missing fields, never values', async () => {
    const p = fcmProvider({ credentials: { projectId: 'demo-project', clientEmail: '', privateKey: '' } as FcmCredentials, endpoint: fake.url });
    const err = await p.send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(PushCredentialsError);
    expect((err as Error).message).toContain('clientEmail, privateKey');
  });

  it('refuses a non-RSA key', async () => {
    const p = fcmProvider({ credentials: creds({ privateKey: ecKeys().privateKey }), endpoint: fake.url });
    await expect(p.send(msg)).rejects.toThrow(/RSA/);
  });

  it('refuses an unreadable PEM without echoing it', async () => {
    const p = fcmProvider({ credentials: creds({ privateKey: 'not-a-key-SECRET123' }), endpoint: fake.url });
    const err = await p.send(msg).catch((e) => e);
    expect((err as Error).message).not.toContain('SECRET123');
  });

  it('a credentials function that throws is retryable (store down), keeping the cause', async () => {
    const p = fcmProvider({ credentials: () => Promise.reject(new Error('mongo down')), endpoint: fake.url });
    const err = await p.send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(TransientPushError);
    expect((err as TransientPushError).cause?.message).toBe('mongo down');
  });
});
