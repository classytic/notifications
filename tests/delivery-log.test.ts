import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDeliveryLog } from '../src/utils/delivery-log.js';
import { NotificationService } from '../src/NotificationService.js';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import type { NotificationPayload, SendResult, ChannelConfig } from '../src/types.js';

// ===========================================================================
// Test Helpers
// ===========================================================================

class MockChannel extends BaseChannel {
  shouldFail = false;
  constructor(config: ChannelConfig & { shouldFail?: boolean } = {}) {
    super({ name: 'mock', ...config });
    this.shouldFail = config.shouldFail ?? false;
  }
  async send(p: NotificationPayload): Promise<SendResult> {
    if (this.shouldFail) throw new Error('Mock failure');
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
// MemoryDeliveryLog
// ===========================================================================

describe('MemoryDeliveryLog', () => {
  let log: MemoryDeliveryLog;

  beforeEach(() => {
    log = new MemoryDeliveryLog();
  });

  it('records a delivery', () => {
    log.record(makePayload(), {
      event: 'user.created',
      results: [{ status: 'sent', channel: 'email' }],
      sent: 1,
      failed: 0,
      skipped: 0,
      duration: 50,
    });

    expect(log.size).toBe(1);
  });

  it('queries by recipientId', () => {
    log.record(makePayload({ recipient: { id: 'u1' } }), {
      event: 'user.created',
      results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });
    log.record(makePayload({ recipient: { id: 'u2' } }), {
      event: 'user.created',
      results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });

    const results = log.query({ recipientId: 'u1' });
    expect(results).toHaveLength(1);
    expect(results[0].recipientId).toBe('u1');
  });

  it('queries by event', () => {
    log.record(makePayload(), {
      event: 'user.created', results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });
    log.record(makePayload({ event: 'order.completed' }), {
      event: 'order.completed', results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });

    const results = log.query({ event: 'order.completed' });
    expect(results).toHaveLength(1);
    expect(results[0].event).toBe('order.completed');
  });

  it('queries by status', () => {
    log.record(makePayload(), {
      event: 'a', results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });
    log.record(makePayload(), {
      event: 'b', results: [{ status: 'failed', channel: 'email', error: 'fail' }],
      sent: 0, failed: 1, skipped: 0, duration: 10,
    });

    expect(log.query({ status: 'delivered' })).toHaveLength(1);
    expect(log.query({ status: 'failed' })).toHaveLength(1);
  });

  it('queries by channel', () => {
    log.record(makePayload(), {
      event: 'a', results: [{ status: 'sent', channel: 'email' }, { status: 'sent', channel: 'sms' }],
      sent: 2, failed: 0, skipped: 0, duration: 10,
    });
    log.record(makePayload(), {
      event: 'b', results: [{ status: 'sent', channel: 'webhook' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });

    expect(log.query({ channel: 'sms' })).toHaveLength(1);
    expect(log.query({ channel: 'webhook' })).toHaveLength(1);
  });

  it('limits results', () => {
    for (let i = 0; i < 10; i++) {
      log.record(makePayload(), {
        event: 'test', results: [{ status: 'sent', channel: 'email' }],
        sent: 1, failed: 0, skipped: 0, duration: 10,
      });
    }

    expect(log.query({ limit: 3 })).toHaveLength(3);
  });

  it('returns newest first', () => {
    log.record(makePayload({ event: 'first' }), {
      event: 'first', results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });
    log.record(makePayload({ event: 'second' }), {
      event: 'second', results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });

    const results = log.query({});
    expect(results[0].event).toBe('second');
    expect(results[1].event).toBe('first');
  });

  it('queries by date range (after/before)', () => {
    const pastDate = new Date(Date.now() - 10_000);

    log.record(makePayload({ event: 'old' }), {
      event: 'old', results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });

    const futureDate = new Date(Date.now() + 10_000);

    // after: should include the entry (it was recorded after pastDate)
    expect(log.query({ after: pastDate })).toHaveLength(1);
    // after futureDate: should exclude it
    expect(log.query({ after: futureDate })).toHaveLength(0);
    // before futureDate: should include it
    expect(log.query({ before: futureDate })).toHaveLength(1);
    // before pastDate: should exclude it
    expect(log.query({ before: pastDate })).toHaveLength(0);
  });

  it('queries by recipientEmail', () => {
    log.record(makePayload({ recipient: { email: 'a@test.com' } }), {
      event: 'test', results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });
    log.record(makePayload({ recipient: { email: 'b@test.com' } }), {
      event: 'test', results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });

    expect(log.query({ recipientEmail: 'a@test.com' })).toHaveLength(1);
    expect(log.query({ recipientEmail: 'c@test.com' })).toHaveLength(0);
  });

  it('gets entry by ID', () => {
    log.record(makePayload(), {
      event: 'test', results: [{ status: 'sent', channel: 'email' }],
      sent: 1, failed: 0, skipped: 0, duration: 10,
    });

    const all = log.query({});
    const entry = log.get(all[0].id);
    expect(entry).toBeTruthy();
    expect(entry!.event).toBe('test');
  });

  it('returns null for unknown ID', () => {
    expect(log.get('unknown')).toBeNull();
  });

  it('evicts oldest entries when maxEntries exceeded', () => {
    const smallLog = new MemoryDeliveryLog({ maxEntries: 3 });

    for (let i = 0; i < 5; i++) {
      smallLog.record(makePayload({ event: `event-${i}` }), {
        event: `event-${i}`, results: [{ status: 'sent', channel: 'email' }],
        sent: 1, failed: 0, skipped: 0, duration: 10,
      });
    }

    expect(smallLog.size).toBe(3);
    const entries = smallLog.query({});
    // Should have the 3 newest
    expect(entries.map(e => e.event)).toEqual(['event-4', 'event-3', 'event-2']);
  });

  it('clears all entries', () => {
    log.record(makePayload(), {
      event: 'test', results: [], sent: 0, failed: 0, skipped: 0, duration: 0,
    });
    expect(log.size).toBe(1);
    log.clear();
    expect(log.size).toBe(0);
  });

  it('resolves partial status correctly', () => {
    log.record(makePayload(), {
      event: 'test',
      results: [
        { status: 'sent', channel: 'email' },
        { status: 'failed', channel: 'sms', error: 'fail' },
      ],
      sent: 1, failed: 1, skipped: 0, duration: 10,
    });

    const entries = log.query({});
    expect(entries[0].status).toBe('partial');
  });
});

// ===========================================================================
// Delivery Log in NotificationService
// ===========================================================================

describe('NotificationService - Delivery Log', () => {
  it('records sends to delivery log', async () => {
    const log = new MemoryDeliveryLog();
    const ch = new MockChannel({ name: 'email' });

    const service = new NotificationService({
      channels: [ch],
      deliveryLog: log,
    });

    await service.send(makePayload());

    expect(log.size).toBe(1);
    const entries = log.query({});
    expect(entries[0].status).toBe('delivered');
    expect(entries[0].recipientId).toBe('u1');
  });

  it('records failed sends to delivery log', async () => {
    const log = new MemoryDeliveryLog();
    const ch = new MockChannel({ name: 'email', shouldFail: true });

    const service = new NotificationService({
      channels: [ch],
      deliveryLog: log,
    });

    await service.send(makePayload());

    const entries = log.query({});
    expect(entries[0].status).toBe('failed');
  });

  it('is accessible via getDeliveryLog()', async () => {
    const log = new MemoryDeliveryLog();
    const service = new NotificationService({ deliveryLog: log });

    expect(service.getDeliveryLog()).toBe(log);
  });

  it('logs skipped notifications (idempotency) to delivery log', async () => {
    const log = new MemoryDeliveryLog();
    const ch = new MockChannel({ name: 'email' });

    const service = new NotificationService({
      channels: [ch],
      deliveryLog: log,
      idempotency: { store: undefined, ttl: 60_000 },
    });

    // Send twice with same idempotency key
    await service.send(makePayload({ idempotencyKey: 'dup-1' }));
    await service.send(makePayload({ idempotencyKey: 'dup-1' }));

    // Both should be logged — the second as skipped
    expect(log.size).toBe(2);
    const entries = log.query({});
    expect(entries[0].status).toBe('failed'); // 0 sent, 0 failed, 1 skipped
    expect(entries[1].status).toBe('delivered');
  });

  it('logs skipped notifications (quiet hours) to delivery log', async () => {
    const log = new MemoryDeliveryLog();
    const ch = new MockChannel({ name: 'email' });

    const service = new NotificationService({
      channels: [ch],
      deliveryLog: log,
      preferences: () => ({
        quiet: { start: '00:00', end: '23:59', timezone: 'UTC' },
      }),
    });

    await service.send(makePayload());

    expect(log.size).toBe(1);
    const entries = log.query({});
    // Skipped due to quiet hours, so status should be 'failed' (0 sent)
    expect(entries[0].status).toBe('failed');
  });

  it('emits after:send for skipped notifications', async () => {
    const ch = new MockChannel({ name: 'email' });

    const service = new NotificationService({
      channels: [ch],
      idempotency: { store: undefined, ttl: 60_000 },
    });

    const afterSendCalls: unknown[] = [];
    service.on('after:send', (data) => { afterSendCalls.push(data); });

    await service.send(makePayload({ idempotencyKey: 'dup-2' }));
    await service.send(makePayload({ idempotencyKey: 'dup-2' }));

    // Both sends should trigger after:send
    expect(afterSendCalls).toHaveLength(2);
  });

  it('does not throw when delivery log record() fails', async () => {
    const brokenLog = {
      record: () => { throw new Error('DB down'); },
      query: () => [],
      get: () => null,
    };
    const ch = new MockChannel({ name: 'email' });

    const service = new NotificationService({
      channels: [ch],
      deliveryLog: brokenLog,
    });

    // Should not throw — delivery log errors are caught and logged
    const result = await service.send(makePayload());
    expect(result.sent).toBe(1);
  });
});
