/**
 * Scenario-based E2E tests
 *
 * These test real-world workflows end-to-end, not isolated units.
 * Each scenario mimics how a developer would actually use the package.
 */

import { describe, it, expect, vi } from 'vitest';
import { NotificationService } from '../src/NotificationService.js';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import { MemoryDeliveryLog } from '../src/utils/delivery-log.js';
import { MemoryQueue } from '../src/utils/queue.js';
import { MemoryRateLimitStore } from '../src/utils/rate-limiter.js';
import { createSimpleResolver } from '../src/utils/template-engine.js';
import { withFallback } from '../src/utils/fallback.js';
import { createStatusHandler } from '../src/utils/status-webhook.js';
import type {
  NotificationPayload,
  SendResult,
  ChannelConfig,
  SmsProvider,
  PushProvider,
} from '../src/types.js';
import type { RateLimitConfig } from '../src/utils/rate-limiter.js';

// ===========================================================================
// Reusable channel mocks (simulate real providers)
// ===========================================================================

class FakeEmailChannel extends BaseChannel {
  sent: NotificationPayload[] = [];
  constructor(config: ChannelConfig & { rateLimit?: RateLimitConfig } = {}) {
    super({ name: 'email', ...config });
  }
  async send(p: NotificationPayload): Promise<SendResult> {
    if (!p.recipient.email) return { status: 'skipped', channel: this.name, error: 'No email' };
    this.sent.push(p);
    return { status: 'sent', channel: this.name, metadata: { messageId: `email-${Date.now()}` } };
  }
}

class FakeSmsChannel extends BaseChannel {
  sent: NotificationPayload[] = [];
  private provider: SmsProvider;
  constructor(config: ChannelConfig & { provider: SmsProvider; rateLimit?: RateLimitConfig }) {
    super({ name: 'sms', ...config });
    this.provider = config.provider;
  }
  async send(p: NotificationPayload): Promise<SendResult> {
    if (!p.recipient.phone) return { status: 'skipped', channel: this.name, error: 'No phone' };
    const result = await this.provider.send({
      to: p.recipient.phone,
      from: '+15551234567',
      body: (p.data.text as string) ?? '',
    });
    this.sent.push(p);
    return { status: 'sent', channel: this.name, metadata: { sid: result.sid } };
  }
}

class FakePushChannel extends BaseChannel {
  sent: NotificationPayload[] = [];
  private shouldFail: boolean;
  constructor(config: ChannelConfig & { shouldFail?: boolean } = {}) {
    super({ name: 'push', ...config });
    this.shouldFail = config.shouldFail ?? false;
  }
  async send(p: NotificationPayload): Promise<SendResult> {
    if (!p.recipient.deviceToken) return { status: 'skipped', channel: this.name, error: 'No device token' };
    if (this.shouldFail) throw new Error('FCM unavailable');
    this.sent.push(p);
    return { status: 'sent', channel: this.name, metadata: { messageId: `push-${Date.now()}` } };
  }
}

// ===========================================================================
// Scenario 1: E-commerce order confirmation
// Send email + SMS + push for an order, with templates and delivery log
// ===========================================================================

describe('Scenario: E-commerce order confirmation', () => {
  it('sends to all channels with template resolution and logs delivery', async () => {
    const smsProvider: SmsProvider = {
      send: vi.fn().mockResolvedValue({ sid: 'sms-123' }),
    };
    const log = new MemoryDeliveryLog();

    const service = new NotificationService({
      channels: [
        new FakeEmailChannel(),
        new FakeSmsChannel({ provider: smsProvider }),
        new FakePushChannel(),
      ],
      templates: createSimpleResolver({
        'order-confirmation': {
          subject: 'Order #${orderId} confirmed',
          html: '<p>Hi ${name}, your order of $${total} is confirmed.</p>',
          text: 'Hi ${name}, order #${orderId} confirmed. Total: $${total}',
        },
      }),
      deliveryLog: log,
    });

    const result = await service.send({
      event: 'order.completed',
      recipient: {
        id: 'u1',
        email: 'customer@example.com',
        phone: '+15559876543',
        deviceToken: 'fcm-token-abc',
        name: 'Alice',
      },
      data: { name: 'Alice', orderId: 'ORD-789', total: '49.99' },
      template: 'order-confirmation',
    });

    // All 3 channels should succeed
    expect(result.sent).toBe(3);
    expect(result.failed).toBe(0);

    // Template should have been resolved
    expect(smsProvider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Hi Alice, order #ORD-789 confirmed. Total: $49.99',
      }),
    );

    // Delivery log should have the entry
    const entries = log.query({ recipientId: 'u1' });
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('delivered');
    expect(entries[0].channels).toEqual(['email', 'sms', 'push']);
  });
});

// ===========================================================================
// Scenario 2: OTP with fallback (push -> SMS -> email)
// Push fails, falls back to SMS
// ===========================================================================

describe('Scenario: OTP delivery with channel fallback', () => {
  it('falls back from push to SMS when push fails', async () => {
    const smsProvider: SmsProvider = {
      send: vi.fn().mockResolvedValue({ sid: 'sms-otp' }),
    };

    const service = new NotificationService({
      channels: [
        new FakePushChannel({ shouldFail: true }),
        new FakeSmsChannel({ provider: smsProvider }),
        new FakeEmailChannel(),
      ],
    });

    const fallbacks: string[] = [];
    const result = await withFallback(
      service,
      {
        event: 'auth.otp',
        recipient: {
          id: 'u2',
          email: 'user@example.com',
          phone: '+15551112222',
          deviceToken: 'fcm-token',
        },
        data: { text: 'Your code is 4821' },
      },
      ['push', 'sms', 'email'],
      {
        onFallback: (failed, _error, next) => {
          fallbacks.push(`${failed}->${next}`);
        },
      },
    );

    // Push failed, SMS should have succeeded
    expect(result.sent).toBe(1);
    expect(result.results[0].channel).toBe('sms');
    expect(fallbacks).toEqual(['push->sms']);
    // Email should NOT have been tried
    expect(smsProvider.send).toHaveBeenCalledTimes(1);
  });

  it('falls back from push to SMS to email when both fail', async () => {
    const failingSms: SmsProvider = {
      send: vi.fn().mockRejectedValue(new Error('SMS quota exceeded')),
    };

    const email = new FakeEmailChannel();
    const service = new NotificationService({
      channels: [
        new FakePushChannel({ shouldFail: true }),
        new FakeSmsChannel({ provider: failingSms }),
        email,
      ],
    });

    const result = await withFallback(
      service,
      {
        event: 'auth.otp',
        recipient: { id: 'u2', email: 'user@example.com', phone: '+15551112222', deviceToken: 'tok' },
        data: { text: 'Your code is 9999', subject: 'OTP Code' },
      },
      ['push', 'sms', 'email'],
    );

    expect(result.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
  });
});

// ===========================================================================
// Scenario 3: Rate-limited marketing blast
// Send 1000 marketing emails, Gmail limits at 500/day
// ===========================================================================

describe('Scenario: Rate-limited marketing email blast', () => {
  it('rate limits after hitting the window cap', async () => {
    const email = new FakeEmailChannel({
      rateLimit: { maxPerWindow: 5, windowMs: 60_000 },
    });
    const log = new MemoryDeliveryLog();

    const service = new NotificationService({
      channels: [email],
      deliveryLog: log,
    });

    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(
        await service.send({
          event: 'marketing.promo',
          recipient: { id: `u${i}`, email: `user${i}@example.com` },
          data: { subject: 'Big Sale!', html: '<p>50% off</p>' },
        }),
      );
    }

    const sent = results.filter(r => r.sent > 0).length;
    const rateLimited = results.filter(r => r.skipped > 0).length;

    expect(sent).toBe(5);
    expect(rateLimited).toBe(3);

    // All 8 should be in the delivery log (including rate-limited ones)
    expect(log.size).toBe(8);

    const delivered = log.query({ status: 'delivered' });
    const failed = log.query({ status: 'failed' });
    expect(delivered).toHaveLength(5);
    expect(failed).toHaveLength(3); // rate-limited = 0 sent = "failed" status in log
  });
});

// ===========================================================================
// Scenario 4: Queued notifications with delayed delivery
// Schedule an interview reminder via queue
// ===========================================================================

describe('Scenario: Queued interview reminder with delay', () => {
  it('queues and delivers after delay', async () => {
    const email = new FakeEmailChannel();
    const queue = new MemoryQueue();

    const service = new NotificationService({
      channels: [email],
      queue,
      templates: createSimpleResolver({
        'interview-reminder': {
          subject: 'Interview reminder: ${company}',
          text: 'Your interview with ${company} is in 1 hour.',
        },
      }),
    });

    const result = await service.send({
      event: 'interview.reminder',
      recipient: { id: 'candidate-1', email: 'alice@example.com' },
      data: { company: 'Acme Corp' },
      template: 'interview-reminder',
      delay: 50, // 50ms for testing
    });

    // Should be queued, not sent yet
    expect(result.queued).toBe(true);
    expect(result.sent).toBe(0);
    expect(email.sent).toHaveLength(0);

    // Wait for delay + processing
    await new Promise(r => setTimeout(r, 150));

    // Now it should have been delivered
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].data.subject).toBe('Interview reminder: Acme Corp');
  });
});

// ===========================================================================
// Scenario 5: Fallback + queue compatibility
// withFallback should NOT cascade when queue accepts the job
// ===========================================================================

describe('Scenario: Fallback with queue mode', () => {
  it('does not create duplicate jobs when queue accepts first channel', async () => {
    const push = new FakePushChannel();
    const email = new FakeEmailChannel();
    const queue = new MemoryQueue();

    const service = new NotificationService({
      channels: [push, email],
      queue,
    });

    const result = await withFallback(
      service,
      {
        event: 'alert.critical',
        recipient: { id: 'u1', email: 'admin@example.com', deviceToken: 'tok' },
        data: { title: 'Server down', body: 'Production is offline' },
      },
      ['push', 'email'],
    );

    // Queue accepted on first try
    expect(result.queued).toBe(true);

    // Only 1 job should exist — not 2
    expect(queue.getAllJobs()).toHaveLength(1);
  });
});

// ===========================================================================
// Scenario 6: User preference opt-out + quiet hours
// User opted out of SMS, is in quiet hours for email, only push works
// ===========================================================================

describe('Scenario: User preferences and quiet hours', () => {
  it('respects channel opt-out and sends only to allowed channels', async () => {
    const email = new FakeEmailChannel();
    const smsProvider: SmsProvider = { send: vi.fn().mockResolvedValue({ sid: 'x' }) };
    const sms = new FakeSmsChannel({ provider: smsProvider });
    const push = new FakePushChannel();
    const log = new MemoryDeliveryLog();

    const service = new NotificationService({
      channels: [email, sms, push],
      deliveryLog: log,
      preferences: async (recipientId) => ({
        channels: { sms: false },        // opted out of SMS
        events: {},
      }),
    });

    const result = await service.send({
      event: 'order.shipped',
      recipient: { id: 'u5', email: 'user@example.com', phone: '+1555', deviceToken: 'tok' },
      data: { subject: 'Shipped!', text: 'Order shipped', title: 'Shipped', body: 'Your order shipped' },
    });

    // Email and push should send, SMS should be filtered
    expect(result.sent).toBe(2);
    expect(smsProvider.send).not.toHaveBeenCalled();

    // Delivery log should record the event
    expect(log.size).toBe(1);
    const entry = log.query({})[0];
    expect(entry.channels).toEqual(['email', 'push']);
  });
});

// ===========================================================================
// Scenario 7: Idempotency prevents duplicate birthday emails
// ===========================================================================

describe('Scenario: Idempotent birthday notification', () => {
  it('sends once, skips duplicate, both logged', async () => {
    const email = new FakeEmailChannel();
    const log = new MemoryDeliveryLog();

    const service = new NotificationService({
      channels: [email],
      idempotency: {},
      deliveryLog: log,
    });

    const payload = {
      event: 'birthday',
      recipient: { id: 'u10', email: 'bob@example.com' },
      data: { subject: 'Happy Birthday!', html: '<p>HBD!</p>' },
      idempotencyKey: 'birthday-u10-2026',
    };

    const first = await service.send(payload);
    const second = await service.send(payload);

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(email.sent).toHaveLength(1);

    // Both attempts should be in the delivery log
    expect(log.size).toBe(2);
  });
});

// ===========================================================================
// Scenario 8: Status webhook tracks full delivery lifecycle
// ===========================================================================

describe('Scenario: Delivery status tracking via webhooks', () => {
  it('tracks queued -> sent -> delivered -> opened for an email', async () => {
    const handler = createStatusHandler();

    // Simulate Twilio/SES webhook callbacks over time
    await handler.handle({
      provider: 'ses',
      notificationId: 'ses-msg-001',
      channel: 'email',
      status: 'accepted',
      timestamp: new Date('2026-03-24T10:00:00Z'),
    });

    await handler.handle({
      provider: 'ses',
      notificationId: 'ses-msg-001',
      channel: 'email',
      status: 'sent',
      timestamp: new Date('2026-03-24T10:00:01Z'),
    });

    await handler.handle({
      provider: 'ses',
      notificationId: 'ses-msg-001',
      channel: 'email',
      status: 'delivered',
      timestamp: new Date('2026-03-24T10:00:05Z'),
    });

    await handler.handle({
      provider: 'ses',
      notificationId: 'ses-msg-001',
      channel: 'email',
      status: 'opened',
      timestamp: new Date('2026-03-24T10:15:00Z'),
    });

    const timeline = handler.getUpdatesFor('ses-msg-001');
    expect(timeline).toHaveLength(4);
    expect(timeline.map(u => u.status)).toEqual([
      'accepted', 'sent', 'delivered', 'opened',
    ]);
  });

  it('tracks bounced email with error details', async () => {
    const handler = createStatusHandler();

    await handler.handle({
      provider: 'ses',
      notificationId: 'ses-msg-002',
      channel: 'email',
      status: 'bounced',
      error: 'Mailbox full',
      recipient: 'invalid@example.com',
      timestamp: new Date(),
    });

    const updates = handler.getUpdatesFor('ses-msg-002');
    expect(updates[0].status).toBe('bounced');
    expect(updates[0].error).toBe('Mailbox full');
    expect(updates[0].recipient).toBe('invalid@example.com');
  });
});

// ===========================================================================
// Scenario 9: Batch send with mixed outcomes
// Some succeed, some rate limited, some fail — all tracked
// ===========================================================================

describe('Scenario: Batch send with mixed outcomes', () => {
  it('handles success, rate limit, and failure in one batch', async () => {
    const email = new FakeEmailChannel({
      rateLimit: { maxPerWindow: 2, windowMs: 60_000 },
    });
    const log = new MemoryDeliveryLog();

    const service = new NotificationService({
      channels: [email],
      deliveryLog: log,
    });

    const payloads = [
      { event: 'newsletter', recipient: { id: 'u1', email: 'a@test.com' }, data: { subject: 'News', html: '<p>A</p>' } },
      { event: 'newsletter', recipient: { id: 'u2', email: 'b@test.com' }, data: { subject: 'News', html: '<p>B</p>' } },
      { event: 'newsletter', recipient: { id: 'u3', email: 'c@test.com' }, data: { subject: 'News', html: '<p>C</p>' } },
      { event: 'newsletter', recipient: { id: 'u4', email: 'd@test.com' }, data: { subject: 'News', html: '<p>D</p>' } },
    ];

    const batch = await service.sendBatch(payloads, { concurrency: 1 });

    // First 2 succeed, last 2 rate limited
    expect(batch.sent).toBe(2);
    expect(batch.skipped).toBe(2);
    expect(batch.total).toBe(4);

    // All 4 in delivery log
    expect(log.size).toBe(4);
    expect(log.query({ status: 'delivered' })).toHaveLength(2);
    expect(log.query({ status: 'failed' })).toHaveLength(2);
  });
});

// ===========================================================================
// Scenario 10: Full lifecycle — hooks, events, logging, retry
// ===========================================================================

describe('Scenario: Full lifecycle with hooks and retry', () => {
  it('retries failed channel, emits events, logs everything', async () => {
    let attempts = 0;

    class FlakySmsChannel extends BaseChannel {
      constructor() { super({ name: 'sms', retry: { maxAttempts: 3, backoff: 'fixed', initialDelay: 10 } }); }
      async send(p: NotificationPayload): Promise<SendResult> {
        attempts++;
        if (attempts < 3) throw new Error('Network timeout');
        return { status: 'sent', channel: this.name, metadata: { sid: 'sms-retry-ok' } };
      }
    }

    const log = new MemoryDeliveryLog();
    const retryEvents: unknown[] = [];
    const afterEvents: unknown[] = [];

    const service = new NotificationService({
      channels: [new FlakySmsChannel()],
      deliveryLog: log,
      retry: { maxAttempts: 1 }, // global = no retry
    });

    service.on('send:retry', (data) => retryEvents.push(data));
    service.on('after:send', (data) => afterEvents.push(data));

    const result = await service.send({
      event: 'alert.sms',
      recipient: { id: 'u1', phone: '+15551234567' },
      data: { text: 'Server recovered' },
    });

    // Should succeed after 2 retries (channel overrides global retry)
    expect(result.sent).toBe(1);
    expect(attempts).toBe(3);
    expect(retryEvents).toHaveLength(2);
    expect(afterEvents).toHaveLength(1);
    expect(log.size).toBe(1);
    expect(log.query({})[0].status).toBe('delivered');
  });
});
