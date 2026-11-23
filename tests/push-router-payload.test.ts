import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../src/NotificationService.js';
import { PushChannel } from '../src/channels/push.channel.js';
import { calculateDelay, resolveRetryConfig, retryAfterHint, withRetry } from '../src/utils/retry.js';
import type { PushProvider, PushProviderMessage } from '../src/types.js';
import {
  contentFreeOnly,
  createContentFreeBuilder,
  fcmProvider,
  isInvalidPushTokenError,
  parseFcmServiceAccount,
  pushRouter,
  PushRejectedError,
  TransientPushError,
  InvalidPushTokenError,
  parseRetryAfter,
} from '../src/push/index.js';
import { fcmError, rsaKeys, startFakeFcm, type FakeFcm } from './support/push-fakes.js';

function recorder(name: string) {
  const sent: PushProviderMessage[] = [];
  const provider: PushProvider & { close: ReturnType<typeof vi.fn> } = {
    send: async (m) => {
      sent.push(m);
      return { messageId: `${name}-${sent.length}` };
    },
    close: vi.fn(),
  };
  return { provider, sent };
}

describe('pushRouter', () => {
  it('dispatches by platform', async () => {
    const android = recorder('fcm');
    const ios = recorder('apns');
    const router = pushRouter({ android: android.provider, ios: ios.provider });
    await router.send({ token: 't1', title: 'a', body: '', platform: 'android' });
    await router.send({ token: 't2', title: 'b', body: '', platform: 'ios' });
    expect(android.sent.map((m) => m.token)).toEqual(['t1']);
    expect(ios.sent.map((m) => m.token)).toEqual(['t2']);
    expect(router.platforms).toEqual(['android', 'ios']);
  });

  it('a disabled platform is a permanent rejection, not a dead token', async () => {
    const router = pushRouter({ android: recorder('fcm').provider });
    const err = await router.send({ token: 't', title: 'x', body: '', platform: 'ios' }).catch((e) => e);
    expect(err).toBeInstanceOf(PushRejectedError);
    expect((err as PushRejectedError).reason).toBe('platform-disabled');
    expect(isInvalidPushTokenError(err)).toBe(false);
  });

  it('missing platform: rejected, or routed to defaultPlatform', async () => {
    const android = recorder('fcm');
    await expect(pushRouter({ android: android.provider }).send({ token: 't', title: 'x', body: '' })).rejects.toMatchObject({
      reason: 'platform-missing',
    });
    await pushRouter({ android: android.provider, defaultPlatform: 'android' }).send({ token: 't', title: 'x', body: '' });
    expect(android.sent[0]!.platform).toBe('android');
  });

  it('close() closes each distinct provider once', async () => {
    const shared = recorder('fcm');
    await pushRouter({ android: shared.provider, ios: shared.provider }).close();
    expect(shared.provider.close).toHaveBeenCalledTimes(1);
  });

  it('needs at least one provider', () => {
    expect(() => pushRouter({})).toThrow(/at least one/);
  });
});

describe('content-free payloads', () => {
  const build = createContentFreeBuilder({ allowedKeys: ['incidentId', 'offerId'], types: ['task_offer'] });

  it('builds type + ids with a generic title and no body', () => {
    expect(build({ type: 'task_offer', refs: { offerId: 'o_1', incidentId: undefined }, title: 'New task' })).toEqual({
      title: 'New task',
      body: '',
      data: { type: 'task_offer', offerId: 'o_1' },
      contentAvailable: false,
    });
  });

  it('no title = a data-only push', () => {
    expect(build({ type: 'task_offer' }).contentAvailable).toBe(true);
  });

  it('refuses unknown keys, non-id values and unknown types', () => {
    expect(() => build({ type: 'task_offer', refs: { name: 'Ali' } })).toThrow(/not allowed/);
    expect(() => build({ type: 'task_offer', refs: { offerId: 'has space' } })).toThrow(/opaque id/);
    expect(() => build({ type: 'other' })).toThrow(/known push type/);
  });

  it('contentFreeOnly guards a provider at the transport', async () => {
    const inner = recorder('fcm');
    const guarded = contentFreeOnly(inner.provider, { allowedKeys: ['offerId'] });
    await expect(guarded.send({ token: 't', title: 'x', body: 'leak', data: { type: 'a' } })).rejects.toThrow(/no body/);
    await expect(guarded.send({ token: 't', title: 'x', body: '', imageUrl: 'https://x', data: { type: 'a' } })).rejects.toThrow(/no image/);
    await expect(guarded.send({ token: 't', title: 'x', body: '', data: { type: 'a', email: 'a@b.c' } })).rejects.toThrow(/not allowed/);
    await guarded.send({ token: 't', title: 'x', body: '', data: { type: 'a', offerId: 'o1' } });
    expect(inner.sent).toHaveLength(1);
  });
});

describe('parseFcmServiceAccount', () => {
  const { privateKey } = rsaKeys();
  const file = {
    type: 'service_account',
    project_id: 'demo-project',
    private_key_id: 'abc',
    private_key: privateKey,
    client_email: 'push@demo-project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  };

  it('accepts the downloaded JSON object, its text, and its base64', () => {
    const expected = {
      projectId: 'demo-project',
      clientEmail: 'push@demo-project.iam.gserviceaccount.com',
      privateKeyId: 'abc',
      tokenUri: 'https://oauth2.googleapis.com/token',
    };
    expect(parseFcmServiceAccount(file)).toMatchObject(expected);
    expect(parseFcmServiceAccount(JSON.stringify(file))).toMatchObject(expected);
    expect(parseFcmServiceAccount(Buffer.from(JSON.stringify(file)).toString('base64'))).toMatchObject(expected);
  });

  it('rejects garbage without echoing it', () => {
    expect(() => parseFcmServiceAccount('SECRET-garbage')).toThrow(/neither JSON nor base64/);
  });
});

describe('Retry-After', () => {
  it('parses seconds and HTTP dates; ignores junk; caps at one hour', () => {
    const now = Date.parse('2026-11-23T00:00:00Z');
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter('Mon, 23 Nov 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter('999999', now)).toBe(3_600_000);
  });

  it('retryAfterHint walks the cause chain', () => {
    const inner = new TransientPushError('fcm', 503, 'UNAVAILABLE', { retryAfterMs: 1500 });
    const outer = Object.assign(new Error('[push] failed'), { cause: inner });
    expect(retryAfterHint(outer)).toBe(1500);
    expect(retryAfterHint(new Error('x'))).toBeUndefined();
  });

  it('withRetry waits at least the hinted time', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new TransientPushError('fcm', 503, 'UNAVAILABLE', { retryAfterMs: 4000 }))
        .mockResolvedValueOnce('ok');
      const config = resolveRetryConfig({ maxAttempts: 2, initialDelay: 10, maxDelay: 10_000 });
      const done = withRetry(fn, config);
      await vi.advanceTimersByTimeAsync(3999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2);
      await expect(done).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('withRetry stops (does not shorten the wait) when the hint exceeds maxDelay', async () => {
    const fn = vi.fn().mockRejectedValue(new TransientPushError('fcm', 429, 'QUOTA', { retryAfterMs: 60_000 }));
    await expect(withRetry(fn, resolveRetryConfig({ maxAttempts: 3, maxDelay: 1000 }))).rejects.toBeInstanceOf(TransientPushError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('errors without a hint keep the old backoff', () => {
    const delay = calculateDelay(1, resolveRetryConfig({ initialDelay: 100 }));
    expect(delay).toBeGreaterThanOrEqual(75);
    expect(delay).toBeLessThanOrEqual(125);
  });
});

describe('PushChannel — delivery hints and data-only', () => {
  it('forwards platform, priority, ttl, interruption level, sound, channel and category', async () => {
    const rec = recorder('p');
    const channel = new PushChannel({ provider: rec.provider });
    await channel.send({
      event: 'e',
      recipient: { deviceToken: 'tok' },
      data: {
        title: 'T',
        platform: 'ios',
        priority: 'normal',
        ttlSeconds: 30,
        interruptionLevel: 'time-sensitive',
        sound: null,
        channelId: 'alerts',
        category: 'OFFER',
      },
    });
    expect(rec.sent[0]).toMatchObject({
      platform: 'ios',
      priority: 'normal',
      ttlSeconds: 30,
      interruptionLevel: 'time-sensitive',
      sound: null,
      channelId: 'alerts',
      category: 'OFFER',
    });
  });

  it('ignores ill-typed hints', async () => {
    const rec = recorder('p');
    await new PushChannel({ provider: rec.provider }).send({
      event: 'e',
      recipient: { deviceToken: 'tok' },
      data: { title: 'T', platform: 'symbian', priority: 'urgent', ttlSeconds: -1, interruptionLevel: 'loud' },
    });
    const m = rec.sent[0]!;
    expect(m.platform).toBeUndefined();
    expect(m.priority).toBeUndefined();
    expect(m.ttlSeconds).toBeUndefined();
    expect(m.interruptionLevel).toBeUndefined();
  });

  it('a data-only push is sent only when explicitly flagged', async () => {
    const rec = recorder('p');
    const channel = new PushChannel({ provider: rec.provider });
    const base = { event: 'e', recipient: { deviceToken: 'tok' } };
    expect(channel.canSend({ ...base, data: { pushData: { type: 'sync' } } })?.status).toBe('skipped');
    expect(channel.canSend({ ...base, data: { pushData: { type: 'sync' }, dataOnly: true } })).toBeNull();
    const result = await channel.send({ ...base, data: { pushData: { type: 'sync' }, contentAvailable: true } });
    expect(result.status).toBe('sent');
    expect(rec.sent[0]).toMatchObject({ title: '', body: '', contentAvailable: true, data: { type: 'sync' } });
  });
});

describe('NotificationService + PushChannel + fcmProvider (end to end, fake FCM)', () => {
  const keys = rsaKeys();
  let fake: FakeFcm;
  beforeAll(async () => {
    fake = await startFakeFcm(keys.publicKey);
  });
  afterAll(() => fake.close());

  function service(onInvalidToken = vi.fn()) {
    const provider = fcmProvider({
      endpoint: fake.url,
      credentials: {
        projectId: 'demo-project',
        clientEmail: 'push@demo-project.iam.gserviceaccount.com',
        privateKey: keys.privateKey,
        tokenUri: fake.tokenUri,
      },
      onInvalidToken,
    });
    return new NotificationService({
      channels: [new PushChannel({ provider })],
      retry: { maxAttempts: 3, initialDelay: 1, maxDelay: 50 },
    });
  }
  const send = (svc: NotificationService) =>
    svc.send({ event: 'x', recipient: { deviceToken: 'fcm-token-123456789' }, data: { title: 'Hi', platform: 'android' } });

  it('a dead token fails once, is reported, and is NOT retried', async () => {
    fake.sends.length = 0;
    fake.sendScript.push(fcmError(404, 'NOT_FOUND', 'UNREGISTERED'));
    const hook = vi.fn();
    const result = await send(service(hook));
    expect(result.results[0]).toMatchObject({ status: 'failed', retryable: false });
    expect(fake.sends).toHaveLength(1);
    expect(hook).toHaveBeenCalledWith('fcm-token-123456789', 'unregistered');
  });

  it('a transient 503 is retried and then delivered', async () => {
    fake.sends.length = 0;
    fake.sendScript.push(fcmError(503, 'UNAVAILABLE', 'UNAVAILABLE'));
    const result = await send(service());
    expect(result.results[0]!.status).toBe('sent');
    expect(fake.sends).toHaveLength(2);
  });

  it('InvalidPushTokenError is structurally detectable', () => {
    const err = new InvalidPushTokenError('apns', 'unregistered', 410, 'abcdef');
    expect(isInvalidPushTokenError(err)).toBe(true);
    expect(isInvalidPushTokenError({ code: 'PUSH_TOKEN_INVALID' })).toBe(true);
    expect(String(err)).toContain('…abcdef');
  });
});
