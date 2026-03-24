import { describe, it, expect, vi } from 'vitest';
import { mergeHooks } from '../src/utils/merge-hooks.js';
import { withRetry, resolveRetryConfig, calculateDelay } from '../src/utils/retry.js';
import { Emitter } from '../src/utils/emitter.js';
import { NotificationError, ChannelError, ProviderNotInstalledError } from '../src/utils/errors.js';
import { isQuietHours } from '../src/utils/quiet-hours.js';
import { MemoryIdempotencyStore } from '../src/utils/idempotency.js';
import { pMap } from '../src/utils/concurrency.js';
import type { ResolvedRetryConfig } from '../src/types.js';

// ===========================================================================
// mergeHooks
// ===========================================================================

describe('mergeHooks', () => {
  it('merges handlers for the same event', () => {
    const h1 = async () => undefined;
    const h2 = async () => undefined;

    const merged = mergeHooks(
      { 'user.created': [h1] },
      { 'user.created': [h2] },
    );

    expect(merged['user.created']).toHaveLength(2);
    expect(merged['user.created'][0]).toBe(h1);
    expect(merged['user.created'][1]).toBe(h2);
  });

  it('preserves separate events', () => {
    const merged = mergeHooks(
      { 'event.a': [async () => undefined] },
      { 'event.b': [async () => undefined] },
    );

    expect(Object.keys(merged)).toEqual(['event.a', 'event.b']);
  });

  it('converts single handlers to arrays', () => {
    const handler = async () => undefined;
    const merged = mergeHooks({ 'event.a': handler });

    expect(Array.isArray(merged['event.a'])).toBe(true);
    expect(merged['event.a']).toHaveLength(1);
  });

  it('ignores null and undefined configs', () => {
    const merged = mergeHooks(
      null,
      undefined,
      { 'event.a': [async () => undefined] },
    );

    expect(merged['event.a']).toHaveLength(1);
  });

  it('returns empty object for no configs', () => {
    const merged = mergeHooks();
    expect(merged).toEqual({});
  });
});

// ===========================================================================
// Retry
// ===========================================================================

describe('resolveRetryConfig', () => {
  it('applies defaults when no config provided', () => {
    const config = resolveRetryConfig();
    expect(config.maxAttempts).toBe(1);
    expect(config.backoff).toBe('exponential');
    expect(config.initialDelay).toBe(500);
    expect(config.maxDelay).toBe(30_000);
  });

  it('merges partial config with defaults', () => {
    const config = resolveRetryConfig({ maxAttempts: 5 });
    expect(config.maxAttempts).toBe(5);
    expect(config.backoff).toBe('exponential');
  });
});

describe('calculateDelay', () => {
  const baseConfig: ResolvedRetryConfig = {
    maxAttempts: 3,
    backoff: 'exponential',
    initialDelay: 100,
    maxDelay: 10_000,
  };

  it('calculates exponential backoff', () => {
    // With jitter, we check the ballpark
    const d1 = calculateDelay(1, baseConfig);
    const d2 = calculateDelay(2, baseConfig);
    const d3 = calculateDelay(3, baseConfig);

    // Exponential: 100, 200, 400 (± 25% jitter)
    expect(d1).toBeGreaterThanOrEqual(75);
    expect(d1).toBeLessThanOrEqual(125);
    expect(d2).toBeGreaterThanOrEqual(150);
    expect(d2).toBeLessThanOrEqual(250);
    expect(d3).toBeGreaterThanOrEqual(300);
    expect(d3).toBeLessThanOrEqual(500);
  });

  it('calculates linear backoff', () => {
    const config = { ...baseConfig, backoff: 'linear' as const };
    const d1 = calculateDelay(1, config);
    const d2 = calculateDelay(2, config);

    // Linear: 100, 200 (± 25% jitter)
    expect(d1).toBeGreaterThanOrEqual(75);
    expect(d1).toBeLessThanOrEqual(125);
    expect(d2).toBeGreaterThanOrEqual(150);
    expect(d2).toBeLessThanOrEqual(250);
  });

  it('calculates fixed delay', () => {
    const config = { ...baseConfig, backoff: 'fixed' as const };
    const d1 = calculateDelay(1, config);
    const d2 = calculateDelay(2, config);

    // Fixed: always 100 (± 25% jitter)
    expect(d1).toBeGreaterThanOrEqual(75);
    expect(d1).toBeLessThanOrEqual(125);
    expect(d2).toBeGreaterThanOrEqual(75);
    expect(d2).toBeLessThanOrEqual(125);
  });

  it('caps delay at maxDelay', () => {
    const config = { ...baseConfig, maxDelay: 150 };
    const delay = calculateDelay(10, config);
    expect(delay).toBeLessThanOrEqual(150);
  });
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, resolveRetryConfig({ maxAttempts: 3 }));

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on failure and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('ok');

    const result = await withRetry(
      fn,
      resolveRetryConfig({ maxAttempts: 3, backoff: 'fixed', initialDelay: 10 }),
    );

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws last error after all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));

    await expect(
      withRetry(fn, resolveRetryConfig({ maxAttempts: 2, backoff: 'fixed', initialDelay: 10 })),
    ).rejects.toThrow('permanent');

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('calls onRetry callback between attempts', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const onRetry = vi.fn();

    await withRetry(
      fn,
      resolveRetryConfig({ maxAttempts: 2, backoff: 'fixed', initialDelay: 10 }),
      onRetry,
    );

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('handles non-Error thrown values', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce('string error')
      .mockResolvedValue('ok');

    const result = await withRetry(
      fn,
      resolveRetryConfig({ maxAttempts: 2, backoff: 'fixed', initialDelay: 10 }),
    );

    expect(result).toBe('ok');
  });
});

// ===========================================================================
// Emitter
// ===========================================================================

describe('Emitter', () => {
  it('emits events and calls handlers', async () => {
    const emitter = new Emitter();
    const spy = vi.fn();

    emitter.on('test', spy);
    await emitter.emit('test', 'arg1', 'arg2');

    expect(spy).toHaveBeenCalledWith('arg1', 'arg2');
  });

  it('supports multiple handlers per event', async () => {
    const emitter = new Emitter();
    const spy1 = vi.fn();
    const spy2 = vi.fn();

    emitter.on('test', spy1);
    emitter.on('test', spy2);
    await emitter.emit('test');

    expect(spy1).toHaveBeenCalledOnce();
    expect(spy2).toHaveBeenCalledOnce();
  });

  it('removes specific handlers', async () => {
    const emitter = new Emitter();
    const spy = vi.fn();

    emitter.on('test', spy);
    emitter.off('test', spy);
    await emitter.emit('test');

    expect(spy).not.toHaveBeenCalled();
  });

  it('removes all handlers for an event', async () => {
    const emitter = new Emitter();
    const spy1 = vi.fn();
    const spy2 = vi.fn();

    emitter.on('test', spy1);
    emitter.on('test', spy2);
    emitter.removeAll('test');
    await emitter.emit('test');

    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
  });

  it('removes all handlers for all events', async () => {
    const emitter = new Emitter();
    const spy = vi.fn();

    emitter.on('a', spy);
    emitter.on('b', spy);
    emitter.removeAll();
    await emitter.emit('a');
    await emitter.emit('b');

    expect(spy).not.toHaveBeenCalled();
  });

  it('awaits async handlers sequentially', async () => {
    const emitter = new Emitter();
    const order: number[] = [];

    emitter.on('test', async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push(1);
    });
    emitter.on('test', async () => {
      order.push(2);
    });

    await emitter.emit('test');

    expect(order).toEqual([1, 2]);
  });

  it('does nothing when emitting unknown event', async () => {
    const emitter = new Emitter();
    await emitter.emit('nonexistent'); // should not throw
  });

  it('supports chaining on/off', () => {
    const emitter = new Emitter();
    const spy = vi.fn();

    const result = emitter.on('test', spy).off('test', spy);
    expect(result).toBe(emitter);
  });
});

// ===========================================================================
// Errors
// ===========================================================================

describe('Errors', () => {
  it('NotificationError has code and name', () => {
    const err = new NotificationError('test', { code: 'TEST_CODE' });
    expect(err.name).toBe('NotificationError');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test');
  });

  it('ChannelError includes channel name', () => {
    const err = new ChannelError('email', 'SMTP failed');
    expect(err.name).toBe('ChannelError');
    expect(err.channel).toBe('email');
    expect(err.message).toContain('email');
    expect(err.message).toContain('SMTP failed');
  });

  it('ProviderNotInstalledError includes install command', () => {
    const err = new ProviderNotInstalledError('nodemailer', 'npm install nodemailer');
    expect(err.name).toBe('ProviderNotInstalledError');
    expect(err.code).toBe('PROVIDER_NOT_INSTALLED');
    expect(err.message).toContain('npm install nodemailer');
  });

  it('ChannelError preserves cause', () => {
    const cause = new Error('original');
    const err = new ChannelError('webhook', 'Failed', cause);
    expect(err.cause).toBe(cause);
  });
});

// ===========================================================================
// isQuietHours
// ===========================================================================

describe('isQuietHours', () => {
  it('returns false when start/end are missing', () => {
    expect(isQuietHours({})).toBe(false);
    expect(isQuietHours({ start: '22:00' })).toBe(false);
    expect(isQuietHours({ end: '07:00' })).toBe(false);
  });

  it('detects same-day quiet window (09:00 - 17:00)', () => {
    // 12:00 UTC → inside
    const noon = new Date('2024-06-15T12:00:00Z');
    expect(isQuietHours({ start: '09:00', end: '17:00' }, noon)).toBe(true);

    // 08:00 UTC → outside
    const morning = new Date('2024-06-15T08:00:00Z');
    expect(isQuietHours({ start: '09:00', end: '17:00' }, morning)).toBe(false);

    // 18:00 UTC → outside
    const evening = new Date('2024-06-15T18:00:00Z');
    expect(isQuietHours({ start: '09:00', end: '17:00' }, evening)).toBe(false);
  });

  it('detects overnight quiet window (22:00 - 07:00)', () => {
    // 23:00 UTC → inside
    const lateNight = new Date('2024-06-15T23:00:00Z');
    expect(isQuietHours({ start: '22:00', end: '07:00' }, lateNight)).toBe(true);

    // 03:00 UTC → inside
    const earlyMorning = new Date('2024-06-16T03:00:00Z');
    expect(isQuietHours({ start: '22:00', end: '07:00' }, earlyMorning)).toBe(true);

    // 12:00 UTC → outside
    const midday = new Date('2024-06-15T12:00:00Z');
    expect(isQuietHours({ start: '22:00', end: '07:00' }, midday)).toBe(false);
  });

  it('respects timezone', () => {
    // 03:00 UTC = 23:00 ET (previous day) → inside 22:00-07:00 ET
    const utc3am = new Date('2024-06-15T03:00:00Z');
    expect(isQuietHours({ start: '22:00', end: '07:00', timezone: 'America/New_York' }, utc3am)).toBe(true);

    // 15:00 UTC = 11:00 ET → outside 22:00-07:00 ET
    const utc3pm = new Date('2024-06-15T15:00:00Z');
    expect(isQuietHours({ start: '22:00', end: '07:00', timezone: 'America/New_York' }, utc3pm)).toBe(false);
  });

  it('end time is exclusive', () => {
    // Exactly at end time → outside
    const atEnd = new Date('2024-06-15T07:00:00Z');
    expect(isQuietHours({ start: '22:00', end: '07:00' }, atEnd)).toBe(false);
  });

  it('start time is inclusive', () => {
    // Exactly at start time → inside
    const atStart = new Date('2024-06-15T22:00:00Z');
    expect(isQuietHours({ start: '22:00', end: '07:00' }, atStart)).toBe(true);
  });

  it('returns false on malformed time strings', () => {
    const now = new Date('2024-06-15T12:00:00Z');
    expect(isQuietHours({ start: 'bad', end: '07:00' }, now)).toBe(false);
    expect(isQuietHours({ start: '22:00', end: 'nope' }, now)).toBe(false);
    expect(isQuietHours({ start: '25:00', end: '07:00' }, now)).toBe(false);
    expect(isQuietHours({ start: '22:00', end: '07:60' }, now)).toBe(false);
  });
});

// ===========================================================================
// MemoryIdempotencyStore
// ===========================================================================

describe('MemoryIdempotencyStore', () => {
  it('returns false for unseen keys', () => {
    const store = new MemoryIdempotencyStore();
    expect(store.has('key-1')).toBe(false);
  });

  it('returns true for seen keys within TTL', () => {
    const store = new MemoryIdempotencyStore();
    store.set('key-1', 60_000);
    expect(store.has('key-1')).toBe(true);
  });

  it('returns false for expired keys', () => {
    vi.useFakeTimers();
    const store = new MemoryIdempotencyStore();
    store.set('key-1', 100);
    expect(store.has('key-1')).toBe(true);

    // Advance past TTL
    vi.advanceTimersByTime(101);
    expect(store.has('key-1')).toBe(false);
    vi.useRealTimers();
  });

  it('tracks size', () => {
    const store = new MemoryIdempotencyStore();
    store.set('a', 60_000);
    store.set('b', 60_000);
    expect(store.size).toBe(2);
  });

  it('clears all entries', () => {
    const store = new MemoryIdempotencyStore();
    store.set('a', 60_000);
    store.set('b', 60_000);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.has('a')).toBe(false);
  });

  it('cleans up expired entries periodically', () => {
    vi.useFakeTimers();
    const store = new MemoryIdempotencyStore({ cleanupInterval: 3 });

    store.set('a', 50);
    store.set('b', 50);

    // Advance time so 'a' and 'b' expire
    vi.advanceTimersByTime(51);

    // Third set triggers cleanup (interval = 3)
    store.set('c', 60_000);

    // 'a' and 'b' should be cleaned up, 'c' should remain
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(false);
    expect(store.has('c')).toBe(true);
    vi.useRealTimers();
  });
});

// ===========================================================================
// pMap
// ===========================================================================

describe('pMap', () => {
  it('returns empty array for empty input', async () => {
    const result = await pMap([], async (x) => x);
    expect(result).toEqual([]);
  });

  it('processes all items and preserves order', async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await pMap(items, async (x) => x * 2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it('respects concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;

    const items = Array.from({ length: 20 }, (_, i) => i);
    await pMap(
      items,
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 10));
        active--;
      },
      { concurrency: 5 },
    );

    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBeGreaterThanOrEqual(2); // should actually use the pool
  });

  it('defaults concurrency to 10', async () => {
    let active = 0;
    let maxActive = 0;

    const items = Array.from({ length: 30 }, (_, i) => i);
    await pMap(items, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    });

    expect(maxActive).toBeLessThanOrEqual(10);
  });

  it('handles concurrency > items.length', async () => {
    const items = [1, 2, 3];
    const result = await pMap(items, async (x) => x * 10, { concurrency: 100 });
    expect(result).toEqual([10, 20, 30]);
  });

  it('passes index to the mapper function', async () => {
    const items = ['a', 'b', 'c'];
    const result = await pMap(items, async (item, index) => `${item}-${index}`);
    expect(result).toEqual(['a-0', 'b-1', 'c-2']);
  });

  it('propagates errors from the mapper', async () => {
    await expect(
      pMap([1, 2, 3], async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }, { concurrency: 1 }),
    ).rejects.toThrow('boom');
  });

  it('is faster than sequential processing', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const start = Date.now();

    await pMap(
      items,
      async () => new Promise(r => setTimeout(r, 20)),
      { concurrency: 10 },
    );

    const elapsed = Date.now() - start;
    // 10 items × 20ms each, but 10 concurrency → ~20ms total, not ~200ms
    expect(elapsed).toBeLessThan(100);
  });

  it('throws RangeError for concurrency: 0', async () => {
    await expect(
      pMap([1, 2], async (x) => x, { concurrency: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it('throws RangeError for negative concurrency', async () => {
    await expect(
      pMap([1], async (x) => x, { concurrency: -1 }),
    ).rejects.toThrow('positive integer');
  });

  it('throws RangeError for non-integer concurrency', async () => {
    await expect(
      pMap([1], async (x) => x, { concurrency: 2.5 }),
    ).rejects.toThrow('positive integer');
  });
});
