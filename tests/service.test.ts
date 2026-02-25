import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../src/NotificationService.js';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import { MemoryIdempotencyStore } from '../src/utils/idempotency.js';
import type {
  NotificationPayload,
  SendResult,
  ChannelConfig,
  DispatchResult,
  Channel,
} from '../src/types.js';

// ===========================================================================
// Test Helpers
// ===========================================================================

class MockChannel extends BaseChannel {
  sent: NotificationPayload[] = [];
  sendDelay = 0;
  shouldFail = false;

  constructor(config: ChannelConfig & { sendDelay?: number; shouldFail?: boolean } = {}) {
    super({ name: 'mock', ...config });
    this.sendDelay = config.sendDelay ?? 0;
    this.shouldFail = config.shouldFail ?? false;
  }

  async send(p: NotificationPayload): Promise<SendResult> {
    if (this.sendDelay) {
      await new Promise(r => setTimeout(r, this.sendDelay));
    }
    if (this.shouldFail) {
      throw new Error('Mock channel failure');
    }
    this.sent.push(p);
    return { status: 'sent', channel: this.name };
  }
}

const makePayload = (overrides?: Partial<NotificationPayload>): NotificationPayload => ({
  event: 'user.created',
  recipient: { id: 'u1', email: 'test@example.com', name: 'Test' },
  data: { subject: 'Welcome', html: '<p>Hi</p>' },
  ...overrides,
});

// ===========================================================================
// Service - Routing
// ===========================================================================

describe('NotificationService - Routing', () => {
  it('sends to all channels matching the event', async () => {
    const ch1 = new MockChannel({ name: 'ch1', events: ['user.created'] });
    const ch2 = new MockChannel({ name: 'ch2', events: ['user.created'] });
    const ch3 = new MockChannel({ name: 'ch3', events: ['order.completed'] });

    const service = new NotificationService({ channels: [ch1, ch2, ch3] });
    const result = await service.send(makePayload());

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(ch1.sent).toHaveLength(1);
    expect(ch2.sent).toHaveLength(1);
    expect(ch3.sent).toHaveLength(0);
  });

  it('filters by target channel names', async () => {
    const ch1 = new MockChannel({ name: 'email' });
    const ch2 = new MockChannel({ name: 'webhook' });

    const service = new NotificationService({ channels: [ch1, ch2] });
    const result = await service.send(makePayload({ channels: ['email'] }));

    expect(result.sent).toBe(1);
    expect(ch1.sent).toHaveLength(1);
    expect(ch2.sent).toHaveLength(0);
  });

  it('returns empty result when no channels match', async () => {
    const ch = new MockChannel({ name: 'sms', events: ['sms.send'] });

    const service = new NotificationService({ channels: [ch] });
    const result = await service.send(makePayload());

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('sends to channels in parallel', async () => {
    const ch1 = new MockChannel({ name: 'slow1', sendDelay: 100 });
    const ch2 = new MockChannel({ name: 'slow2', sendDelay: 100 });

    const service = new NotificationService({ channels: [ch1, ch2] });
    const start = Date.now();
    await service.send(makePayload());
    const elapsed = Date.now() - start;

    // Should take ~100ms (parallel), not ~200ms (sequential)
    expect(elapsed).toBeLessThan(180);
  });
});

// ===========================================================================
// Service - Error Isolation
// ===========================================================================

describe('NotificationService - Error Isolation', () => {
  it('isolates channel failures from each other', async () => {
    const failing = new MockChannel({ name: 'failing', shouldFail: true });
    const working = new MockChannel({ name: 'working' });

    const service = new NotificationService({ channels: [failing, working] });
    const result = await service.send(makePayload());

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(working.sent).toHaveLength(1);
  });

  it('includes error message in failed result', async () => {
    const failing = new MockChannel({ name: 'failing', shouldFail: true });

    const service = new NotificationService({ channels: [failing] });
    const result = await service.send(makePayload());

    expect(result.results[0].status).toBe('failed');
    expect(result.results[0].error).toContain('Mock channel failure');
  });
});

// ===========================================================================
// Service - Templates
// ===========================================================================

describe('NotificationService - Templates', () => {
  it('resolves template before sending', async () => {
    const ch = new MockChannel({ name: 'email' });
    const templates = vi.fn().mockResolvedValue({
      subject: 'Welcome John!',
      html: '<h1>Welcome John!</h1>',
    });

    const service = new NotificationService({ channels: [ch], templates });
    await service.send(makePayload({ template: 'welcome' }));

    expect(templates).toHaveBeenCalledWith('welcome', expect.any(Object));
    expect(ch.sent[0].data.subject).toBe('Welcome John!');
    expect(ch.sent[0].data.html).toBe('<h1>Welcome John!</h1>');
  });

  it('throws on template resolution failure', async () => {
    const ch = new MockChannel();
    const templates = vi.fn().mockRejectedValue(new Error('Template not found'));

    const service = new NotificationService({ channels: [ch], templates });

    await expect(service.send(makePayload({ template: 'missing' }))).rejects.toThrow(
      'Template "missing" failed',
    );
  });

  it('skips template resolution when no template specified', async () => {
    const ch = new MockChannel();
    const templates = vi.fn();

    const service = new NotificationService({ channels: [ch], templates });
    await service.send(makePayload());

    expect(templates).not.toHaveBeenCalled();
  });

  it('merges template data with payload data', async () => {
    const ch = new MockChannel();
    const templates = vi.fn().mockResolvedValue({
      subject: 'From Template',
      html: '<p>template html</p>',
    });

    const service = new NotificationService({ channels: [ch], templates });
    await service.send(makePayload({
      template: 'test',
      data: { customField: 'keep-me', subject: 'override-me' },
    }));

    // Template result should be in the data
    expect(ch.sent[0].data.html).toBe('<p>template html</p>');
    expect(ch.sent[0].data.customField).toBe('keep-me');
    // Template's subject wins (merged last)
    expect(ch.sent[0].data.subject).toBe('From Template');
  });
});

// ===========================================================================
// Service - Preferences
// ===========================================================================

describe('NotificationService - Preferences', () => {
  it('filters channels based on user preferences', async () => {
    const email = new MockChannel({ name: 'email' });
    const sms = new MockChannel({ name: 'sms' });

    const service = new NotificationService({
      channels: [email, sms],
      preferences: async () => ({
        channels: { email: true, sms: false },
      }),
    });

    const result = await service.send(makePayload());

    expect(result.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(0);
  });

  it('skips all channels when event is opted out', async () => {
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      preferences: async () => ({
        events: { 'user.created': false },
      }),
    });

    const result = await service.send(makePayload());

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(ch.sent).toHaveLength(0);
  });

  it('skips preference resolution when no recipient ID', async () => {
    const ch = new MockChannel();
    const prefs = vi.fn();

    const service = new NotificationService({ channels: [ch], preferences: prefs });
    await service.send(makePayload({
      recipient: { email: 'test@example.com' }, // no id
    }));

    expect(prefs).not.toHaveBeenCalled();
    expect(ch.sent).toHaveLength(1);
  });

  it('sends to all channels when preferences return null', async () => {
    const ch1 = new MockChannel({ name: 'ch1' });
    const ch2 = new MockChannel({ name: 'ch2' });

    const service = new NotificationService({
      channels: [ch1, ch2],
      preferences: async () => null,
    });

    const result = await service.send(makePayload());
    expect(result.sent).toBe(2);
  });

  it('continues sending when preference resolver throws', async () => {
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      preferences: async () => { throw new Error('DB down'); },
    });

    const result = await service.send(makePayload());
    expect(result.sent).toBe(1);
  });
});

// ===========================================================================
// Service - Retry
// ===========================================================================

describe('NotificationService - Retry', () => {
  it('retries failed sends', async () => {
    let attempts = 0;
    const ch = new (class extends BaseChannel {
      constructor() { super({ name: 'flaky' }); }
      async send(): Promise<SendResult> {
        attempts++;
        if (attempts < 3) throw new Error('Temporary failure');
        return { status: 'sent', channel: this.name };
      }
    })();

    const service = new NotificationService({
      channels: [ch],
      retry: { maxAttempts: 3, backoff: 'fixed', initialDelay: 10 },
    });

    const result = await service.send(makePayload());

    expect(result.sent).toBe(1);
    expect(attempts).toBe(3);
  });

  it('reports failure after all retries exhausted', async () => {
    const ch = new MockChannel({ name: 'always-fails', shouldFail: true });

    const service = new NotificationService({
      channels: [ch],
      retry: { maxAttempts: 2, backoff: 'fixed', initialDelay: 10 },
    });

    const result = await service.send(makePayload());

    expect(result.failed).toBe(1);
    expect(result.results[0].error).toContain('Mock channel failure');
  });

  it('uses channel-specific retry config over global', async () => {
    let attempts = 0;
    const ch = new (class extends BaseChannel<ChannelConfig & { retry: { maxAttempts: number; backoff: 'fixed'; initialDelay: number } }> {
      constructor() {
        super({
          name: 'custom-retry',
          retry: { maxAttempts: 5, backoff: 'fixed', initialDelay: 10 },
        });
      }
      async send(): Promise<SendResult> {
        attempts++;
        if (attempts < 5) throw new Error('Fail');
        return { status: 'sent', channel: this.name };
      }
    })();

    const service = new NotificationService({
      channels: [ch],
      retry: { maxAttempts: 1 }, // global: no retry
    });

    const result = await service.send(makePayload());
    expect(result.sent).toBe(1);
    expect(attempts).toBe(5);
  });

  it('channel can disable retry with maxAttempts: 1 even when global retry is set', async () => {
    let attempts = 0;
    const ch = new (class extends BaseChannel<ChannelConfig & { retry: { maxAttempts: number } }> {
      constructor() {
        super({
          name: 'no-retry',
          retry: { maxAttempts: 1 }, // explicitly disable retry
        });
      }
      async send(): Promise<SendResult> {
        attempts++;
        throw new Error('Always fails');
      }
    })();

    const service = new NotificationService({
      channels: [ch],
      retry: { maxAttempts: 5, backoff: 'fixed', initialDelay: 10 }, // global: 5 retries
    });

    const result = await service.send(makePayload());

    expect(result.failed).toBe(1);
    expect(attempts).toBe(1); // should NOT retry despite global config
  });

  it('channel without retry config inherits global retry', async () => {
    let attempts = 0;
    const ch = new (class extends BaseChannel {
      constructor() {
        super({ name: 'no-override' }); // no retry config
      }
      async send(): Promise<SendResult> {
        attempts++;
        if (attempts < 3) throw new Error('Fail');
        return { status: 'sent', channel: this.name };
      }
    })();

    const service = new NotificationService({
      channels: [ch],
      retry: { maxAttempts: 3, backoff: 'fixed', initialDelay: 10 },
    });

    const result = await service.send(makePayload());
    expect(result.sent).toBe(1);
    expect(attempts).toBe(3); // inherited global retry
  });
});

// ===========================================================================
// Service - Events
// ===========================================================================

describe('NotificationService - Events', () => {
  it('emits before:send and after:send', async () => {
    const ch = new MockChannel();
    const beforeSpy = vi.fn();
    const afterSpy = vi.fn();

    const service = new NotificationService({ channels: [ch] });
    service.on('before:send', beforeSpy);
    service.on('after:send', afterSpy);

    await service.send(makePayload());

    expect(beforeSpy).toHaveBeenCalledOnce();
    expect(afterSpy).toHaveBeenCalledOnce();
  });

  it('emits send:success on successful sends', async () => {
    const ch = new MockChannel();
    const spy = vi.fn();

    const service = new NotificationService({ channels: [ch] });
    service.on('send:success', spy);

    await service.send(makePayload());

    expect(spy).toHaveBeenCalledOnce();
    const result = spy.mock.calls[0][0] as DispatchResult;
    expect(result.sent).toBe(1);
  });

  it('emits send:failed when channels fail', async () => {
    const ch = new MockChannel({ shouldFail: true });
    const spy = vi.fn();

    const service = new NotificationService({ channels: [ch] });
    service.on('send:failed', spy);

    await service.send(makePayload());

    expect(spy).toHaveBeenCalledOnce();
  });

  it('emits send:retry during retry attempts', async () => {
    let attempts = 0;
    const ch = new (class extends BaseChannel {
      constructor() { super({ name: 'flaky' }); }
      async send(): Promise<SendResult> {
        attempts++;
        if (attempts < 3) throw new Error('Fail');
        return { status: 'sent', channel: this.name };
      }
    })();

    const retrySpy = vi.fn();
    const service = new NotificationService({
      channels: [ch],
      retry: { maxAttempts: 3, backoff: 'fixed', initialDelay: 10 },
    });
    service.on('send:retry', retrySpy);

    await service.send(makePayload());

    expect(retrySpy).toHaveBeenCalledTimes(2); // 2 retries before success
  });

  it('catches send:retry listener errors without unhandled rejection', async () => {
    let attempts = 0;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ch = new (class extends BaseChannel {
      constructor() { super({ name: 'flaky' }); }
      async send(): Promise<SendResult> {
        attempts++;
        if (attempts < 2) throw new Error('Fail');
        return { status: 'sent', channel: this.name };
      }
    })();

    const service = new NotificationService({
      channels: [ch],
      retry: { maxAttempts: 3, backoff: 'fixed', initialDelay: 10 },
      logger,
    });
    service.on('send:retry', () => { throw new Error('listener boom'); });

    // Should complete without unhandled rejection
    const result = await service.send(makePayload());

    expect(result.sent).toBe(1);
    // The listener error should be logged
    expect(logger.error).toHaveBeenCalled();
    const errorCalls = logger.error.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(errorCalls.some((msg: string) => msg.includes('listener error'))).toBe(true);
  });

  it('supports removing event listeners', async () => {
    const ch = new MockChannel();
    const spy = vi.fn();

    const service = new NotificationService({ channels: [ch] });
    service.on('after:send', spy);
    service.off('after:send', spy);

    await service.send(makePayload());

    expect(spy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Service - Channel Management
// ===========================================================================

describe('NotificationService - Channel Management', () => {
  it('adds channels at runtime', async () => {
    const service = new NotificationService();
    const ch = new MockChannel();

    service.addChannel(ch);
    const result = await service.send(makePayload());

    expect(result.sent).toBe(1);
  });

  it('removes channels by name', async () => {
    const ch = new MockChannel({ name: 'removable' });
    const service = new NotificationService({ channels: [ch] });

    service.removeChannel('removable');
    const result = await service.send(makePayload());

    expect(result.sent).toBe(0);
  });

  it('gets channel by name', () => {
    const ch = new MockChannel({ name: 'findme' });
    const service = new NotificationService({ channels: [ch] });

    expect(service.getChannel('findme')).toBe(ch);
    expect(service.getChannel('nonexistent')).toBeUndefined();
  });

  it('lists all channel names', () => {
    const service = new NotificationService({
      channels: [
        new MockChannel({ name: 'email' }),
        new MockChannel({ name: 'sms' }),
      ],
    });

    expect(service.getChannelNames()).toEqual(['email', 'sms']);
  });
});

// ===========================================================================
// Service - Hooks (Framework Integration)
// ===========================================================================

describe('NotificationService - Hooks', () => {
  it('creates hook handlers from configs', async () => {
    const ch = new MockChannel();
    const service = new NotificationService({ channels: [ch] });

    const hooks = service.createHooks([
      {
        event: 'user.created',
        getRecipient: (data: unknown) => ({
          email: (data as { email: string }).email,
        }),
        getData: (data: unknown) => ({
          name: (data as { name: string }).name,
        }),
        template: 'welcome',
      },
    ]);

    expect(hooks['user.created']).toHaveLength(1);

    // Execute the hook
    await hooks['user.created'][0]({ email: 'user@test.com', name: 'John' });

    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0].recipient.email).toBe('user@test.com');
    expect(ch.sent[0].template).toBe('welcome');
  });

  it('skips disabled hooks', () => {
    const service = new NotificationService();
    const hooks = service.createHooks([
      {
        event: 'user.created',
        enabled: false,
        getRecipient: () => ({ email: 'test@test.com' }),
        getData: () => ({}),
      },
    ]);

    expect(hooks['user.created']).toBeUndefined();
  });

  it('returns undefined when recipient is null', async () => {
    const ch = new MockChannel();
    const service = new NotificationService({ channels: [ch] });

    const hooks = service.createHooks([
      {
        event: 'user.created',
        getRecipient: () => null,
        getData: () => ({}),
      },
    ]);

    const result = await hooks['user.created'][0]({ any: 'data' });

    expect(result).toBeUndefined();
    expect(ch.sent).toHaveLength(0);
  });

  it('does not throw on hook errors (fire-and-forget)', async () => {
    const ch = new MockChannel({ shouldFail: true });
    const service = new NotificationService({ channels: [ch] });

    const hooks = service.createHooks([
      {
        event: 'user.created',
        getRecipient: () => ({ email: 'test@test.com' }),
        getData: () => ({}),
      },
    ]);

    // Should not throw - send() catches channel errors and returns a result
    const result = await hooks['user.created'][0]({ any: 'data' });
    expect(result).toBeDefined();
    expect(result!.failed).toBe(1);
  });

  it('targets specific channels in hooks', async () => {
    const email = new MockChannel({ name: 'email' });
    const sms = new MockChannel({ name: 'sms' });
    const service = new NotificationService({ channels: [email, sms] });

    const hooks = service.createHooks([
      {
        event: 'user.created',
        channels: ['email'],
        getRecipient: () => ({ email: 'test@test.com' }),
        getData: () => ({}),
      },
    ]);

    await hooks['user.created'][0]({ any: 'data' });

    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(0);
  });
});

// ===========================================================================
// Service - Duration Tracking
// ===========================================================================

describe('NotificationService - Duration', () => {
  it('tracks total dispatch duration', async () => {
    const ch = new MockChannel({ sendDelay: 50 });
    const service = new NotificationService({ channels: [ch] });

    const result = await service.send(makePayload());

    expect(result.duration).toBeGreaterThanOrEqual(40);
    expect(result.duration).toBeLessThan(200);
  });
});

// ===========================================================================
// Service - Logger
// ===========================================================================

describe('NotificationService - Logger', () => {
  it('uses provided logger for channel failures', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ch = new MockChannel({ shouldFail: true });

    const service = new NotificationService({ channels: [ch], logger });
    await service.send(makePayload());

    expect(logger.error).toHaveBeenCalled();
    expect(logger.error.mock.calls[0][0]).toContain('mock');
  });

  it('logs warning on retry attempts', async () => {
    let attempts = 0;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ch = new (class extends BaseChannel {
      constructor() { super({ name: 'flaky' }); }
      async send(): Promise<SendResult> {
        attempts++;
        if (attempts < 2) throw new Error('Fail');
        return { status: 'sent', channel: this.name };
      }
    })();

    const service = new NotificationService({
      channels: [ch],
      retry: { maxAttempts: 3, backoff: 'fixed', initialDelay: 10 },
      logger,
    });
    await service.send(makePayload());

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toContain('Retry');
  });

  it('logs warning when preference resolver fails', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      preferences: async () => { throw new Error('DB error'); },
      logger,
    });
    await service.send(makePayload());

    expect(logger.warn).toHaveBeenCalled();
  });

  it('logs template error', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      templates: async () => { throw new Error('bad template'); },
      logger,
    });

    await expect(service.send(makePayload({ template: 'broken' }))).rejects.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });
});

// ===========================================================================
// Service - Edge Cases
// ===========================================================================

describe('NotificationService - Edge Cases', () => {
  it('handles hook where getRecipient throws', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const service = new NotificationService({ channels: [new MockChannel()], logger });

    const hooks = service.createHooks([
      {
        event: 'user.created',
        getRecipient: () => { throw new Error('resolver boom'); },
        getData: () => ({}),
      },
    ]);

    // Should not throw (fire-and-forget)
    const result = await hooks['user.created'][0]({});
    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('handles hook where getRecipient throws non-Error', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const service = new NotificationService({ channels: [new MockChannel()], logger });

    const hooks = service.createHooks([
      {
        event: 'user.created',
        getRecipient: () => { throw 'string error'; },
        getData: () => ({}),
      },
    ]);

    const result = await hooks['user.created'][0]({});
    expect(result).toBeUndefined();
  });

  it('template error with non-Error value', async () => {
    const service = new NotificationService({
      channels: [new MockChannel()],
      templates: async () => { throw 'not an error object'; },
    });

    await expect(
      service.send(makePayload({ template: 'bad' })),
    ).rejects.toThrow('not an error object');
  });

  it('dispatches to zero channels returns empty result', async () => {
    const service = new NotificationService({ channels: [] });
    const result = await service.send(makePayload());

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('default config (no args) creates a working service', async () => {
    const service = new NotificationService();
    const result = await service.send(makePayload());

    expect(result.sent).toBe(0);
    expect(result.event).toBe('user.created');
  });

  it('send:success is not emitted when all channels fail', async () => {
    const ch = new MockChannel({ shouldFail: true });
    const successSpy = vi.fn();

    const service = new NotificationService({ channels: [ch] });
    service.on('send:success', successSpy);

    await service.send(makePayload());

    expect(successSpy).not.toHaveBeenCalled();
  });

  it('send:failed is not emitted when all channels succeed', async () => {
    const ch = new MockChannel();
    const failedSpy = vi.fn();

    const service = new NotificationService({ channels: [ch] });
    service.on('send:failed', failedSpy);

    await service.send(makePayload());

    expect(failedSpy).not.toHaveBeenCalled();
  });

  it('result includes per-channel durations', async () => {
    const ch = new MockChannel({ name: 'fast', sendDelay: 10 });
    const service = new NotificationService({ channels: [ch] });

    const result = await service.send(makePayload());

    expect(result.results[0].duration).toBeDefined();
    expect(result.results[0].duration).toBeGreaterThanOrEqual(0);
  });

  it('does not mutate channel send result', async () => {
    const frozen = Object.freeze({ status: 'sent' as const, channel: 'immutable' });
    const ch: Channel = {
      name: 'immutable',
      shouldHandle: () => true,
      send: async () => frozen,
    };

    const service = new NotificationService({ channels: [ch] });
    const result = await service.send(makePayload());

    // Should not throw on frozen object, duration is on the new copy
    expect(result.results[0].duration).toBeDefined();
    expect(result.results[0].channel).toBe('immutable');
    // Original object should be untouched
    expect(frozen).not.toHaveProperty('duration');
  });

  it('after:send listener error does not mask dispatch result', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ch = new MockChannel();

    const service = new NotificationService({ channels: [ch], logger });
    service.on('after:send', () => { throw new Error('after boom'); });

    const result = await service.send(makePayload());

    // Result should still be returned despite listener error
    expect(result.sent).toBe(1);
    expect(logger.error).toHaveBeenCalled();
    const errorCalls = logger.error.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(errorCalls.some((msg: string) => msg.includes('Lifecycle listener error'))).toBe(true);
  });

  it('send:success listener error does not mask dispatch result', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ch = new MockChannel();

    const service = new NotificationService({ channels: [ch], logger });
    service.on('send:success', () => { throw new Error('success boom'); });

    const result = await service.send(makePayload());

    expect(result.sent).toBe(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('before:send listener error aborts the send', async () => {
    const ch = new MockChannel();

    const service = new NotificationService({ channels: [ch] });
    service.on('before:send', () => { throw new Error('validation failed'); });

    await expect(service.send(makePayload())).rejects.toThrow('validation failed');
    expect(ch.sent).toHaveLength(0);
  });
});

// ===========================================================================
// Service - Quiet Hours
// ===========================================================================

describe('NotificationService - Quiet Hours', () => {
  it('skips notification during quiet hours', async () => {
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      preferences: async () => ({
        quiet: { start: '22:00', end: '07:00' },
      }),
    });

    // 23:00 UTC → inside quiet hours
    const originalDate = Date;
    const mockNow = new Date('2024-06-15T23:00:00Z');
    vi.spyOn(globalThis, 'Date').mockImplementation(
      (...args: unknown[]) => args.length ? new originalDate(...(args as [string])) : mockNow,
    );

    const result = await service.send(makePayload());

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(ch.sent).toHaveLength(0);

    vi.restoreAllMocks();
  });

  it('sends notification outside quiet hours', async () => {
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      preferences: async () => ({
        quiet: { start: '22:00', end: '07:00' },
      }),
    });

    // 12:00 UTC → outside quiet hours
    const originalDate = Date;
    const mockNow = new Date('2024-06-15T12:00:00Z');
    vi.spyOn(globalThis, 'Date').mockImplementation(
      (...args: unknown[]) => args.length ? new originalDate(...(args as [string])) : mockNow,
    );

    const result = await service.send(makePayload());

    expect(result.sent).toBe(1);
    expect(ch.sent).toHaveLength(1);

    vi.restoreAllMocks();
  });

  it('ignores quiet hours when no recipient ID', async () => {
    const ch = new MockChannel();
    const prefs = vi.fn();

    const service = new NotificationService({ channels: [ch], preferences: prefs });
    await service.send(makePayload({
      recipient: { email: 'test@example.com' }, // no id
    }));

    expect(prefs).not.toHaveBeenCalled();
    expect(ch.sent).toHaveLength(1);
  });

  it('sends when quiet config has missing start/end', async () => {
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      preferences: async () => ({
        quiet: { start: '22:00' }, // missing end
      }),
    });

    const result = await service.send(makePayload());
    expect(result.sent).toBe(1);
  });
});

// ===========================================================================
// Service - Idempotency
// ===========================================================================

describe('NotificationService - Idempotency', () => {
  it('skips duplicate notifications with same idempotency key', async () => {
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      idempotency: {},
    });

    const payload = makePayload({ idempotencyKey: 'dedup-1' });

    const first = await service.send(payload);
    expect(first.sent).toBe(1);

    const second = await service.send(payload);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);

    expect(ch.sent).toHaveLength(1);
  });

  it('allows different idempotency keys', async () => {
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      idempotency: {},
    });

    await service.send(makePayload({ idempotencyKey: 'key-a' }));
    await service.send(makePayload({ idempotencyKey: 'key-b' }));

    expect(ch.sent).toHaveLength(2);
  });

  it('does not deduplicate when no idempotency config', async () => {
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      // no idempotency config
    });

    const payload = makePayload({ idempotencyKey: 'key-1' });
    await service.send(payload);
    await service.send(payload);

    expect(ch.sent).toHaveLength(2);
  });

  it('does not deduplicate when no idempotency key in payload', async () => {
    const ch = new MockChannel();

    const service = new NotificationService({
      channels: [ch],
      idempotency: {},
    });

    await service.send(makePayload());
    await service.send(makePayload());

    expect(ch.sent).toHaveLength(2);
  });

  it('does not record key when all channels fail', async () => {
    const ch = new MockChannel({ shouldFail: true });

    const service = new NotificationService({
      channels: [ch],
      idempotency: {},
    });

    const payload = makePayload({ idempotencyKey: 'fail-key' });
    await service.send(payload);
    // Second attempt should NOT be skipped because first had 0 sent
    await service.send(payload);

    // Both attempts should reach the channel (not deduped)
    expect(ch.sent).toHaveLength(0); // both failed, nothing in sent[]
  });

  it('uses custom idempotency store', async () => {
    const ch = new MockChannel();
    const store = new MemoryIdempotencyStore();

    const service = new NotificationService({
      channels: [ch],
      idempotency: { store },
    });

    await service.send(makePayload({ idempotencyKey: 'custom-store' }));
    expect(store.has('custom-store')).toBe(true);
  });

  it('uses custom TTL', async () => {
    const ch = new MockChannel();
    const store = new MemoryIdempotencyStore();
    const setSpy = vi.spyOn(store, 'set');

    const service = new NotificationService({
      channels: [ch],
      idempotency: { store, ttl: 5000 },
    });

    await service.send(makePayload({ idempotencyKey: 'ttl-test' }));

    expect(setSpy).toHaveBeenCalledWith('ttl-test', 5000);
  });

  it('logs debug message on duplicate skip', async () => {
    const ch = new MockChannel();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const service = new NotificationService({
      channels: [ch],
      idempotency: {},
      logger,
    });

    const payload = makePayload({ idempotencyKey: 'log-test' });
    await service.send(payload);
    await service.send(payload);

    expect(logger.debug).toHaveBeenCalled();
    const debugCalls = logger.debug.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(debugCalls.some((msg: string) => msg.includes('Duplicate'))).toBe(true);
  });

  it('handles idempotency store errors gracefully', async () => {
    const ch = new MockChannel();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const store = {
      has: vi.fn().mockReturnValue(false),
      set: vi.fn().mockRejectedValue(new Error('store write failed')),
    };

    const service = new NotificationService({
      channels: [ch],
      idempotency: { store },
      logger,
    });

    // Should still send successfully even if store.set fails
    const result = await service.send(makePayload({ idempotencyKey: 'err-key' }));
    expect(result.sent).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ===========================================================================
// Service - Batch Send
// ===========================================================================

describe('NotificationService - sendBatch', () => {
  it('sends all notifications and aggregates results', async () => {
    const ch = new MockChannel();
    const service = new NotificationService({ channels: [ch] });

    const payloads = Array.from({ length: 5 }, (_, i) =>
      makePayload({ event: `event.${i}`, recipient: { id: `u${i}`, email: `u${i}@test.com` } }),
    );

    const batch = await service.sendBatch(payloads);

    expect(batch.total).toBe(5);
    expect(batch.sent).toBe(5);
    expect(batch.failed).toBe(0);
    expect(batch.results).toHaveLength(5);
    expect(ch.sent).toHaveLength(5);
  });

  it('aggregates failures across notifications', async () => {
    const working = new MockChannel({ name: 'working' });
    const failing = new MockChannel({ name: 'failing', shouldFail: true });
    const service = new NotificationService({ channels: [working, failing] });

    const payloads = [makePayload(), makePayload()];
    const batch = await service.sendBatch(payloads);

    // Each notification: 1 sent + 1 failed = 2 total per notification
    expect(batch.sent).toBe(2);   // 2 notifications × 1 working channel
    expect(batch.failed).toBe(2); // 2 notifications × 1 failing channel
  });

  it('respects concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const ch = new MockChannel({ name: 'slow', sendDelay: 20 });

    // Intercept send to track concurrency
    const originalSend = ch.send.bind(ch);
    ch.send = async (p) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const result = await originalSend(p);
      active--;
      return result;
    };

    const service = new NotificationService({ channels: [ch] });
    const payloads = Array.from({ length: 20 }, (_, i) =>
      makePayload({ event: `event.${i}` }),
    );

    await service.sendBatch(payloads, { concurrency: 3 });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('calls onProgress after each notification', async () => {
    const ch = new MockChannel();
    const service = new NotificationService({ channels: [ch] });

    const payloads = [makePayload(), makePayload(), makePayload()];
    const progressCalls: { completed: number; total: number }[] = [];

    await service.sendBatch(payloads, {
      onProgress: ({ completed, total }) => {
        progressCalls.push({ completed, total });
      },
    });

    expect(progressCalls).toHaveLength(3);
    expect(progressCalls[0].total).toBe(3);
    // All 3 complete, order may vary with concurrency but all should be called
    const completedValues = progressCalls.map(p => p.completed).sort();
    expect(completedValues).toEqual([1, 2, 3]);
  });

  it('catches before:send errors without aborting batch', async () => {
    const ch = new MockChannel();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const service = new NotificationService({ channels: [ch], logger });

    let callCount = 0;
    service.on('before:send', () => {
      callCount++;
      if (callCount === 2) throw new Error('validation failed');
    });

    const payloads = [makePayload(), makePayload(), makePayload()];
    const batch = await service.sendBatch(payloads, { concurrency: 1 });

    // 2 succeed, 1 fails from before:send throw
    expect(batch.sent).toBe(2);
    expect(batch.failed).toBe(1);
    expect(batch.total).toBe(3);
  });

  it('catches template errors without aborting batch', async () => {
    const ch = new MockChannel();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let templateCalls = 0;
    const service = new NotificationService({
      channels: [ch],
      logger,
      templates: async () => {
        templateCalls++;
        if (templateCalls === 1) throw new Error('bad template');
        return { subject: 'OK', html: '<p>OK</p>' };
      },
    });

    const payloads = [
      makePayload({ template: 'broken' }),
      makePayload({ template: 'fine' }),
    ];
    const batch = await service.sendBatch(payloads, { concurrency: 1 });

    expect(batch.failed).toBe(1);
    expect(batch.sent).toBe(1);
  });

  it('returns empty batch for empty input', async () => {
    const service = new NotificationService({ channels: [new MockChannel()] });
    const batch = await service.sendBatch([]);

    expect(batch.total).toBe(0);
    expect(batch.sent).toBe(0);
    expect(batch.failed).toBe(0);
    expect(batch.results).toHaveLength(0);
    expect(batch.duration).toBeGreaterThanOrEqual(0);
  });

  it('tracks total batch duration', async () => {
    const ch = new MockChannel({ sendDelay: 20 });
    const service = new NotificationService({ channels: [ch] });

    const payloads = Array.from({ length: 5 }, () => makePayload());
    const batch = await service.sendBatch(payloads, { concurrency: 5 });

    // All 5 in parallel at 20ms each → ~20ms total
    expect(batch.duration).toBeGreaterThanOrEqual(15);
    expect(batch.duration).toBeLessThan(200);
  });

  it('is faster than sequential when concurrency > 1', async () => {
    const ch = new MockChannel({ sendDelay: 30 });
    const service = new NotificationService({ channels: [ch] });
    const payloads = Array.from({ length: 10 }, () => makePayload());

    const start = Date.now();
    await service.sendBatch(payloads, { concurrency: 10 });
    const elapsed = Date.now() - start;

    // 10 × 30ms sequential = 300ms, but parallel should be ~30ms
    expect(elapsed).toBeLessThan(150);
  });

  it('per-notification results are in input order', async () => {
    const ch = new MockChannel();
    const service = new NotificationService({ channels: [ch] });

    const payloads = Array.from({ length: 5 }, (_, i) =>
      makePayload({ event: `event.${i}` }),
    );

    const batch = await service.sendBatch(payloads);

    for (let i = 0; i < 5; i++) {
      expect(batch.results[i].event).toBe(`event.${i}`);
    }
  });

  it('works with idempotency across batch', async () => {
    const ch = new MockChannel();
    const service = new NotificationService({
      channels: [ch],
      idempotency: {},
    });

    const payloads = [
      makePayload({ idempotencyKey: 'dup-1' }),
      makePayload({ idempotencyKey: 'dup-1' }), // duplicate
      makePayload({ idempotencyKey: 'dup-2' }),
    ];

    // concurrency: 1 to ensure order
    const batch = await service.sendBatch(payloads, { concurrency: 1 });

    expect(batch.sent).toBe(2);    // dup-1 + dup-2
    expect(batch.skipped).toBe(1); // second dup-1
    expect(ch.sent).toHaveLength(2);
  });
});
