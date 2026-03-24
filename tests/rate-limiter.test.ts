import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRateLimitStore } from '../src/utils/rate-limiter.js';
import { NotificationService } from '../src/NotificationService.js';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import type { NotificationPayload, SendResult, ChannelConfig } from '../src/types.js';
import type { RateLimitConfig } from '../src/utils/rate-limiter.js';

// ===========================================================================
// Test Helpers
// ===========================================================================

class MockChannel extends BaseChannel {
  sent: NotificationPayload[] = [];
  constructor(config: ChannelConfig & { rateLimit?: RateLimitConfig } = {}) {
    super({ name: 'mock', ...config });
  }
  async send(p: NotificationPayload): Promise<SendResult> {
    this.sent.push(p);
    return { status: 'sent', channel: this.name };
  }
}

const makePayload = (overrides?: Partial<NotificationPayload>): NotificationPayload => ({
  event: 'user.created',
  recipient: { id: 'u1', email: 'test@example.com' },
  data: { subject: 'Test' },
  ...overrides,
});

// ===========================================================================
// MemoryRateLimitStore
// ===========================================================================

describe('MemoryRateLimitStore', () => {
  let store: MemoryRateLimitStore;
  const config: RateLimitConfig = { maxPerWindow: 3, windowMs: 1000 };

  beforeEach(() => {
    store = new MemoryRateLimitStore();
  });

  it('allows sends within the limit', () => {
    expect(store.consume('email', config)).toBe(true);
    expect(store.consume('email', config)).toBe(true);
    expect(store.consume('email', config)).toBe(true);
  });

  it('rejects sends over the limit', () => {
    store.consume('email', config);
    store.consume('email', config);
    store.consume('email', config);
    expect(store.consume('email', config)).toBe(false);
  });

  it('tracks remaining tokens', () => {
    expect(store.remaining('email', config)).toBe(3);
    store.consume('email', config);
    expect(store.remaining('email', config)).toBe(2);
    store.consume('email', config);
    store.consume('email', config);
    expect(store.remaining('email', config)).toBe(0);
  });

  it('isolates rate limits between channels', () => {
    store.consume('email', config);
    store.consume('email', config);
    store.consume('email', config);
    // email is exhausted, but sms should still work
    expect(store.consume('email', config)).toBe(false);
    expect(store.consume('sms', config)).toBe(true);
  });

  it('resets after the window expires', async () => {
    const shortConfig: RateLimitConfig = { maxPerWindow: 1, windowMs: 50 };
    store.consume('email', shortConfig);
    expect(store.consume('email', shortConfig)).toBe(false);

    await new Promise(r => setTimeout(r, 60));
    expect(store.consume('email', shortConfig)).toBe(true);
  });

  it('resets a specific channel', () => {
    store.consume('email', config);
    store.consume('email', config);
    store.consume('email', config);
    expect(store.remaining('email', config)).toBe(0);

    store.reset('email');
    expect(store.remaining('email', config)).toBe(3);
  });
});

// ===========================================================================
// Rate Limiting in NotificationService
// ===========================================================================

describe('NotificationService - Rate Limiting', () => {
  it('skips channel when rate limited', async () => {
    const ch = new MockChannel({
      name: 'email',
      rateLimit: { maxPerWindow: 2, windowMs: 60_000 },
    });

    const service = new NotificationService({ channels: [ch] });

    await service.send(makePayload());
    await service.send(makePayload());
    const result = await service.send(makePayload());

    expect(ch.sent).toHaveLength(2);
    expect(result.skipped).toBe(1);
    expect(result.results[0].error).toBe('Rate limited');
  });

  it('emits send:rate_limited event', async () => {
    const ch = new MockChannel({
      name: 'email',
      rateLimit: { maxPerWindow: 1, windowMs: 60_000 },
    });

    const service = new NotificationService({ channels: [ch] });
    const rateLimitedHandler = vi.fn();
    service.on('send:rate_limited', rateLimitedHandler);

    await service.send(makePayload());
    await service.send(makePayload());

    // Give the async emit time to fire
    await new Promise(r => setTimeout(r, 10));

    expect(rateLimitedHandler).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', event: 'user.created' }),
    );
  });

  it('rate limits per channel independently', async () => {
    const email = new MockChannel({
      name: 'email',
      rateLimit: { maxPerWindow: 1, windowMs: 60_000 },
    });
    const webhook = new MockChannel({ name: 'webhook' });

    const service = new NotificationService({ channels: [email, webhook] });

    await service.send(makePayload());
    const result = await service.send(makePayload());

    // email is rate limited, webhook is not
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(webhook.sent).toHaveLength(2);
  });

  it('accepts custom rate limit store', async () => {
    const customStore = new MemoryRateLimitStore();
    const ch = new MockChannel({
      name: 'email',
      rateLimit: { maxPerWindow: 1, windowMs: 60_000 },
    });

    const service = new NotificationService({
      channels: [ch],
      rateLimitStore: customStore,
    });

    await service.send(makePayload());
    expect(customStore.remaining('email', { maxPerWindow: 1, windowMs: 60_000 })).toBe(0);
  });

  it('auto-creates rate limit store when channel has rateLimit config', async () => {
    const ch = new MockChannel({
      name: 'email',
      rateLimit: { maxPerWindow: 100, windowMs: 60_000 },
    });

    // No explicit rateLimitStore — should auto-create
    const service = new NotificationService({ channels: [ch] });
    const result = await service.send(makePayload());
    expect(result.sent).toBe(1);
  });
});
