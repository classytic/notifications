import { describe, it, expect, vi } from 'vitest';
import { withFallback } from '../src/utils/fallback.js';
import { NotificationService } from '../src/NotificationService.js';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import { MemoryQueue } from '../src/utils/queue.js';
import type { NotificationPayload, SendResult, ChannelConfig } from '../src/types.js';

// ===========================================================================
// Test Helpers
// ===========================================================================

class MockChannel extends BaseChannel {
  sent: NotificationPayload[] = [];
  shouldFail = false;
  constructor(config: ChannelConfig & { shouldFail?: boolean } = {}) {
    super({ name: 'mock', ...config });
    this.shouldFail = config.shouldFail ?? false;
  }
  async send(p: NotificationPayload): Promise<SendResult> {
    if (this.shouldFail) throw new Error('channel failed');
    this.sent.push(p);
    return { status: 'sent', channel: this.name };
  }
}

const makePayload = (overrides?: Partial<NotificationPayload>): NotificationPayload => ({
  event: 'test.event',
  recipient: { id: 'u1', email: 'test@example.com', phone: '+15551234567', deviceToken: 'tok' },
  data: { message: 'Hello' },
  ...overrides,
});

// ===========================================================================
// withFallback
// ===========================================================================

describe('withFallback', () => {
  it('sends via first channel when it succeeds', async () => {
    const push = new MockChannel({ name: 'push' });
    const sms = new MockChannel({ name: 'sms' });
    const email = new MockChannel({ name: 'email' });

    const service = new NotificationService({ channels: [push, sms, email] });
    const result = await withFallback(service, makePayload(), ['push', 'sms', 'email']);

    expect(result.sent).toBe(1);
    expect(push.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
  });

  it('falls back to second channel when first fails', async () => {
    const push = new MockChannel({ name: 'push', shouldFail: true });
    const sms = new MockChannel({ name: 'sms' });
    const email = new MockChannel({ name: 'email' });

    const service = new NotificationService({ channels: [push, sms, email] });
    const result = await withFallback(service, makePayload(), ['push', 'sms', 'email']);

    expect(result.sent).toBe(1);
    expect(sms.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(0);
  });

  it('falls through all channels to last resort', async () => {
    const push = new MockChannel({ name: 'push', shouldFail: true });
    const sms = new MockChannel({ name: 'sms', shouldFail: true });
    const email = new MockChannel({ name: 'email' });

    const service = new NotificationService({ channels: [push, sms, email] });
    const result = await withFallback(service, makePayload(), ['push', 'sms', 'email']);

    expect(result.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
  });

  it('returns last failure when all channels fail', async () => {
    const push = new MockChannel({ name: 'push', shouldFail: true });
    const sms = new MockChannel({ name: 'sms', shouldFail: true });

    const service = new NotificationService({ channels: [push, sms] });
    const result = await withFallback(service, makePayload(), ['push', 'sms']);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('calls onFallback when channel fails', async () => {
    const push = new MockChannel({ name: 'push', shouldFail: true });
    const sms = new MockChannel({ name: 'sms' });

    const service = new NotificationService({ channels: [push, sms] });
    const onFallback = vi.fn();

    await withFallback(service, makePayload(), ['push', 'sms'], { onFallback });

    expect(onFallback).toHaveBeenCalledWith('push', expect.any(String), 'sms');
  });

  it('does not call onFallback on last channel', async () => {
    const push = new MockChannel({ name: 'push', shouldFail: true });
    const sms = new MockChannel({ name: 'sms', shouldFail: true });

    const service = new NotificationService({ channels: [push, sms] });
    const onFallback = vi.fn();

    await withFallback(service, makePayload(), ['push', 'sms'], { onFallback });

    // Only called once (push -> sms), not after sms fails
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('returns empty result for empty channel order', async () => {
    const service = new NotificationService({});
    const result = await withFallback(service, makePayload(), []);

    expect(result.sent).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('treats queued delivery as success (does not cascade)', async () => {
    const push = new MockChannel({ name: 'push' });
    const sms = new MockChannel({ name: 'sms' });
    const queue = new MemoryQueue();

    const service = new NotificationService({
      channels: [push, sms],
      queue,
    });

    const result = await withFallback(service, makePayload(), ['push', 'sms']);

    // Queue mode returns sent=0, failed=0, skipped=0 — but job was accepted.
    // withFallback should treat this as success and NOT fall through to sms.
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(0);

    // Only 1 job should be in the queue (for 'push'), not 2
    await new Promise(r => setTimeout(r, 50));
    // Both channels will process the single queued job since queue processor
    // calls sendDirect which sends to the channel specified in payload.channels
    expect(queue.getAllJobs()).toHaveLength(1);
  });

  it('skips channels not registered on the service', async () => {
    const email = new MockChannel({ name: 'email' });
    const service = new NotificationService({ channels: [email] });

    // 'push' is not registered, should skip to 'email'
    const result = await withFallback(service, makePayload(), ['push', 'email']);

    expect(result.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
  });
});
