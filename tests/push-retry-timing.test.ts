/**
 * G4 (arc-notifications docs/push-gaps-2026-11.md; ADR 0001 section 5.3): push retry timing.
 * Provider floors on every TransientPushError, Retry-After, jittered backoff that never undercuts
 * a floor, the FCM 60 min give-up window, the notification's expiry, and withRetry never sleeping
 * less than a floor in process.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveRetryConfig, retryFloorHint, withRetry } from '../src/utils/retry.js';
import {
  apnsProvider,
  fcmProvider,
  planPushRetry,
  PUSH_RETRY_DEFAULTS,
  pushRetryDelay,
  pushRetryFloorMs,
  PushRejectedError,
  TransientPushError,
} from '../src/push/index.js';
import { apnsToken, ecKeys, fcmError, rsaKeys, startFakeApns, startFakeFcm, type FakeApns, type FakeFcm } from './support/push-fakes.js';

const SEC = 1000;
const MIN = 60 * SEC;
const low = () => 0;
const high = () => 0.999_999;

describe('provider floors on TransientPushError', () => {
  it('FCM: 10 s for 5xx / network, 60 s for 429', () => {
    expect(new TransientPushError('fcm', 503, 'UNAVAILABLE').retryFloorMs).toBe(10 * SEC);
    expect(new TransientPushError('fcm', 500, 'INTERNAL').retryFloorMs).toBe(10 * SEC);
    expect(new TransientPushError('fcm', 0, 'timeout').retryFloorMs).toBe(10 * SEC);
    expect(new TransientPushError('fcm', 429, 'QUOTA_EXCEEDED').retryFloorMs).toBe(60 * SEC);
  });

  it('APNs: 15 min for 5xx, 60 s for 429, 10 s for network', () => {
    expect(new TransientPushError('apns', 503, 'ServiceUnavailable').retryFloorMs).toBe(15 * MIN);
    expect(new TransientPushError('apns', 500, 'InternalServerError').retryFloorMs).toBe(15 * MIN);
    expect(new TransientPushError('apns', 429, 'TooManyRequests').retryFloorMs).toBe(60 * SEC);
    expect(new TransientPushError('apns', 0, 'network').retryFloorMs).toBe(10 * SEC);
  });

  it('a throw site can override the floor; the table is exported', () => {
    expect(new TransientPushError('fcm', 503, 'x', { retryFloorMs: 1234 }).retryFloorMs).toBe(1234);
    expect(pushRetryFloorMs('router', 0)).toBe(PUSH_RETRY_DEFAULTS.networkDelayMs);
    expect(retryFloorHint(Object.assign(new Error('wrap'), { cause: new TransientPushError('apns', 503, 'x') }))).toBe(15 * MIN);
  });
});

describe('pushRetryDelay', () => {
  it('first FCM retry is never sooner than 10 s, then doubles; jitter only adds (at most 20 %)', () => {
    const err = new TransientPushError('fcm', 503, 'UNAVAILABLE');
    expect(pushRetryDelay(err, 1, { random: low })).toBe(10 * SEC);
    expect(pushRetryDelay(err, 1, { random: high })).toBeLessThanOrEqual(12 * SEC);
    expect(pushRetryDelay(err, 2, { random: low })).toBe(20 * SEC);
    expect(pushRetryDelay(err, 3, { random: low })).toBe(40 * SEC);
    for (let i = 0; i < 200; i++) expect(pushRetryDelay(err, 1)).toBeGreaterThanOrEqual(10 * SEC);
  });

  it('FCM 429 without Retry-After waits 60 s; a longer Retry-After wins', () => {
    expect(pushRetryDelay(new TransientPushError('fcm', 429, 'QUOTA_EXCEEDED'), 1, { random: low })).toBe(60 * SEC);
    const hinted = new TransientPushError('fcm', 429, 'QUOTA_EXCEEDED', { retryAfterMs: 90 * SEC });
    expect(pushRetryDelay(hinted, 1, { random: low })).toBe(90 * SEC);
    // A Retry-After shorter than the floor does not shorten the floor.
    expect(pushRetryDelay(new TransientPushError('fcm', 503, 'x', { retryAfterMs: 2 * SEC }), 1, { random: low })).toBe(10 * SEC);
  });

  it('APNs 5xx waits at least 15 min; APNs 429 at least 60 s', () => {
    expect(pushRetryDelay(new TransientPushError('apns', 503, 'ServiceUnavailable'), 1, { random: low })).toBe(15 * MIN);
    expect(pushRetryDelay(new TransientPushError('apns', 429, 'TooManyRequests'), 1, { random: low })).toBe(60 * SEC);
  });

  it('growth is capped at maxDelayMs, but never below the floor', () => {
    const err = new TransientPushError('fcm', 503, 'x');
    expect(pushRetryDelay(err, 10, { random: low, maxDelayMs: 30 * SEC })).toBe(30 * SEC);
    expect(pushRetryDelay(new TransientPushError('apns', 503, 'x'), 3, { random: low, maxDelayMs: 1 * MIN })).toBe(15 * MIN);
  });

  it('an unknown error gets the 10 s default floor', () => {
    expect(pushRetryDelay(new Error('socket hang up'), 1, { random: low })).toBe(10 * SEC);
  });
});

describe('planPushRetry', () => {
  const t0 = 1_800_000_000_000;

  it('schedules with the delay and the absolute time', () => {
    const d = planPushRetry({ error: new TransientPushError('fcm', 503, 'x'), attempt: 1, firstFailureAt: t0, now: t0, random: low });
    expect(d).toEqual({ retry: true, delayMs: 10 * SEC, at: t0 + 10 * SEC });
  });

  it('never schedules past the notification expiry', () => {
    const err = new TransientPushError('apns', 503, 'x');
    expect(planPushRetry({ error: err, attempt: 1, firstFailureAt: t0, now: t0, expiresAt: t0 + 10 * MIN, random: low })).toEqual({
      retry: false,
      reason: 'expired',
    });
    expect(planPushRetry({ error: err, attempt: 1, firstFailureAt: t0, now: t0, expiresAt: t0 + 20 * MIN, random: low })).toMatchObject({
      retry: true,
      delayMs: 15 * MIN,
    });
  });

  it('FCM stops after 60 min of continuous failure; APNs is bounded by expiry instead', () => {
    const fcm = new TransientPushError('fcm', 503, 'x');
    // 59.5 min in + a 40 s third retry lands past the 60 min window.
    expect(planPushRetry({ error: fcm, attempt: 3, firstFailureAt: t0, now: t0 + 59.5 * MIN, random: low })).toEqual({
      retry: false,
      reason: 'gave-up',
    });
    expect(planPushRetry({ error: fcm, attempt: 3, firstFailureAt: t0, now: t0 + 50 * MIN, random: low })).toMatchObject({ retry: true });
    const apns = new TransientPushError('apns', 503, 'x');
    expect(planPushRetry({ error: apns, attempt: 2, firstFailureAt: t0, now: t0 + 55 * MIN, random: low })).toMatchObject({ retry: true });
  });

  it('stops after maxAttempts (default 5) and on permanent errors', () => {
    const err = new TransientPushError('fcm', 503, 'x');
    expect(planPushRetry({ error: err, attempt: 5, firstFailureAt: t0, now: t0 })).toEqual({ retry: false, reason: 'attempts' });
    expect(planPushRetry({ error: err, attempt: 2, firstFailureAt: t0, now: t0, maxAttempts: 2 })).toEqual({ retry: false, reason: 'attempts' });
    expect(planPushRetry({ error: new PushRejectedError('fcm', 400, 'INVALID_ARGUMENT'), attempt: 1, firstFailureAt: t0, now: t0 })).toEqual({
      retry: false,
      reason: 'permanent',
    });
  });
});

describe('withRetry honours provider floors in process', () => {
  it('a floor above maxDelay stops in-process retrying at once (the queue owns the wait)', async () => {
    const fn = vi.fn().mockRejectedValue(new TransientPushError('apns', 503, 'ServiceUnavailable'));
    await expect(withRetry(fn, resolveRetryConfig({ maxAttempts: 5, initialDelay: 1, maxDelay: 30_000 }))).rejects.toBeInstanceOf(TransientPushError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a floor within maxDelay is waited in full, never the shorter backoff', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new TransientPushError('fcm', 503, 'UNAVAILABLE'))
        .mockResolvedValueOnce('ok');
      const done = withRetry(fn, resolveRetryConfig({ maxAttempts: 2, initialDelay: 1, maxDelay: 30_000 }));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2);
      await expect(done).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('errors without a floor (email, sms) keep the old backoff', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('smtp 421')).mockResolvedValueOnce('ok');
    const started = Date.now();
    await expect(withRetry(fn, resolveRetryConfig({ maxAttempts: 2, backoff: 'fixed', initialDelay: 5 }))).resolves.toBe('ok');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('providers set the floor on real answers', () => {
  const rsa = rsaKeys();
  const ec = ecKeys();
  let fcmFake: FakeFcm;
  let apnsFake: FakeApns;
  const closers: Array<{ close(): Promise<void> }> = [];
  beforeAll(async () => {
    fcmFake = await startFakeFcm(rsa.publicKey);
    apnsFake = await startFakeApns(ec.publicKey);
  });
  afterAll(async () => {
    await Promise.all(closers.map((c) => c.close()));
    await fcmFake.close();
    await apnsFake.close();
  });

  const fcm = () =>
    fcmProvider({
      endpoint: fcmFake.url,
      credentials: {
        projectId: 'demo-project',
        clientEmail: 'push@demo-project.iam.gserviceaccount.com',
        privateKey: rsa.privateKey,
        tokenUri: fcmFake.tokenUri,
      },
    });

  it('FCM 429 without Retry-After: floor 60 s; 503 with Retry-After 30 s: delay 30 s', async () => {
    fcmFake.sendScript.push(fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', 'Device message rate exceeded'));
    const quota = await fcm().send({ token: 'fcm-token-1234567', title: 't', body: '' }).catch((e) => e);
    expect(quota).toBeInstanceOf(TransientPushError);
    expect(quota.retryFloorMs).toBe(60 * SEC);
    expect(pushRetryDelay(quota, 1, { random: low })).toBe(60 * SEC);

    fcmFake.sendScript.push({ ...fcmError(503, 'UNAVAILABLE', 'UNAVAILABLE'), headers: { 'retry-after': '30' } });
    const busy = await fcm().send({ token: 'fcm-token-1234567', title: 't', body: '' }).catch((e) => e);
    expect(busy.retryFloorMs).toBe(10 * SEC);
    expect(pushRetryDelay(busy, 1, { random: low })).toBe(30 * SEC);
  });

  it('APNs 503: floor 15 min', async () => {
    const p = apnsProvider({
      credentials: { keyId: 'KEY1234567', teamId: 'TEAM123456', privateKey: ec.privateKey, bundleId: 'com.example.app', environment: 'sandbox' },
      host: apnsFake.url,
      allowPlaintext: true,
    });
    closers.push(p);
    apnsFake.script.push({ status: 503, body: { reason: 'ServiceUnavailable' } });
    const err = await p.send({ token: apnsToken('cd'), title: 't', body: '', platform: 'ios' }).catch((e) => e);
    expect(err).toBeInstanceOf(TransientPushError);
    expect(err.retryFloorMs).toBe(15 * MIN);
  });
});
