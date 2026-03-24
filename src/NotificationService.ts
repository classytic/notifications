/**
 * Notification Service
 * @module @classytic/notifications
 *
 * Central orchestrator for multi-channel notifications.
 * Routes notifications to channels, resolves templates,
 * applies user preferences, retries on failure, and emits lifecycle events.
 *
 * v2 additions: rate limiting, delivery log, queue adapter, BCC batching.
 *
 * @example
 * ```typescript
 * import { NotificationService } from '@classytic/notifications';
 * import { EmailChannel, ConsoleChannel } from '@classytic/notifications/channels';
 * import { MemoryDeliveryLog } from '@classytic/notifications/utils';
 *
 * const notifications = new NotificationService({
 *   channels: [
 *     new EmailChannel({
 *       from: 'noreply@app.com',
 *       transport: { service: 'gmail', auth: { user, pass } },
 *       rateLimit: { maxPerWindow: 500, windowMs: 86_400_000 }, // Gmail 500/day
 *     }),
 *     new ConsoleChannel(),
 *   ],
 *   templates: async (id, data) => {
 *     const templates = { welcome: { subject: `Welcome ${data.name}!`, html: `<p>Hi ${data.name}</p>` } };
 *     return templates[id] ?? { subject: id, text: JSON.stringify(data) };
 *   },
 *   retry: { maxAttempts: 3, backoff: 'exponential' },
 *   deliveryLog: new MemoryDeliveryLog(),
 * });
 *
 * // Send a notification
 * const result = await notifications.send({
 *   event: 'user.created',
 *   recipient: { email: 'user@example.com', name: 'John' },
 *   data: { name: 'John' },
 *   template: 'welcome',
 * });
 *
 * // Listen to lifecycle events
 * notifications.on('send:failed', ({ channel, error }) => {
 *   alertOps(`Notification channel ${channel} failed: ${error}`);
 * });
 * ```
 */

import { Emitter } from './utils/emitter.js';
import { withRetry, resolveRetryConfig } from './utils/retry.js';
import { NotificationError } from './utils/errors.js';
import { isQuietHours } from './utils/quiet-hours.js';
import { MemoryIdempotencyStore, IDEMPOTENCY_DEFAULT_TTL } from './utils/idempotency.js';
import { MemoryRateLimitStore } from './utils/rate-limiter.js';
import { pMap } from './utils/concurrency.js';
import type { IdempotencyStore } from './utils/idempotency.js';
import type { RateLimitConfig, RateLimitStore } from './utils/rate-limiter.js';
import type { DeliveryLog } from './utils/delivery-log.js';
import type { QueueAdapter } from './utils/queue.js';
import type {
  Channel,
  NotificationPayload,
  NotificationServiceConfig,
  SendResult,
  DispatchResult,
  BatchOptions,
  BatchResult,
  TemplateResolver,
  PreferenceResolver,
  RetryConfig,
  ResolvedRetryConfig,
  Logger,
  ServiceEvent,
  EventHandler,
  NotificationHookConfig,
  HookHandler,
  HookMap,
} from './types.js';

/** Silent logger (no output) */
const SILENT_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export class NotificationService {
  private channels: Channel[] = [];
  private templateResolver?: TemplateResolver;
  private preferenceResolver?: PreferenceResolver;
  private retryConfig: ResolvedRetryConfig;
  private logger: Logger;
  private emitter = new Emitter();
  private idempotencyStore?: IdempotencyStore;
  private idempotencyTtl: number;
  private deliveryLog?: DeliveryLog;
  private rateLimitStore?: RateLimitStore;
  private queueAdapter?: QueueAdapter;

  constructor(config: NotificationServiceConfig = {}) {
    this.channels = config.channels ?? [];
    this.templateResolver = config.templates;
    this.preferenceResolver = config.preferences;
    this.retryConfig = resolveRetryConfig(config.retry);
    this.logger = config.logger ?? SILENT_LOGGER;

    // Idempotency: use provided store, or create default if config is present
    if (config.idempotency) {
      this.idempotencyStore = config.idempotency.store ?? new MemoryIdempotencyStore();
      this.idempotencyTtl = config.idempotency.ttl ?? IDEMPOTENCY_DEFAULT_TTL;
    } else {
      this.idempotencyTtl = IDEMPOTENCY_DEFAULT_TTL;
    }

    // Delivery log
    this.deliveryLog = config.deliveryLog;

    // Rate limiting: use provided store, or auto-create if any channel has rateLimit
    if (config.rateLimitStore) {
      this.rateLimitStore = config.rateLimitStore;
    } else if (this.channels.some(ch => this.getChannelRateLimit(ch))) {
      this.rateLimitStore = new MemoryRateLimitStore();
    }

    // Queue adapter — service owns the queue, wires up processing immediately
    if (config.queue) {
      this.queueAdapter = config.queue;
      this.queueAdapter.process(async (payload) => {
        await this.sendDirect(payload);
      });
    }
  }

  // ===========================================================================
  // Channel Management
  // ===========================================================================

  /** Add a channel at runtime */
  addChannel(channel: Channel): this {
    this.channels.push(channel);
    // Auto-create rate limit store if the new channel has rate limiting
    if (!this.rateLimitStore && this.getChannelRateLimit(channel)) {
      this.rateLimitStore = new MemoryRateLimitStore();
    }
    return this;
  }

  /** Remove a channel by name */
  removeChannel(name: string): this {
    this.channels = this.channels.filter(c => c.name !== name);
    return this;
  }

  /** Get a registered channel by name */
  getChannel(name: string): Channel | undefined {
    return this.channels.find(c => c.name === name);
  }

  /** List all registered channel names */
  getChannelNames(): string[] {
    return this.channels.map(c => c.name);
  }

  /** Get the delivery log instance (for querying history) */
  getDeliveryLog(): DeliveryLog | undefined {
    return this.deliveryLog;
  }

  // ===========================================================================
  // Core Send
  // ===========================================================================

  /**
   * Send a notification to all matching channels.
   *
   * When a queue adapter is configured, notifications are enqueued
   * for crash-resilient delivery instead of sending immediately.
   *
   * Flow:
   * 1. Emit `before:send` (awaited — listeners can block or throw to abort)
   * 2. If queue is configured, enqueue and return early
   * 3. Resolve template (if provided)
   * 4. Filter channels by event + target list
   * 5. Apply user preference filtering
   * 6. Check per-channel rate limits
   * 7. Send to all channels in parallel (with retry)
   * 8. Record to delivery log
   * 9. Emit `after:send` / `send:success` / `send:failed`
   */
  async send(payload: NotificationPayload): Promise<DispatchResult> {
    // If a queue is configured (or payload has delay), enqueue instead of sending directly
    if (this.queueAdapter) {
      const enqueueOptions = payload.delay ? { delay: payload.delay } : undefined;
      const jobId = await this.queueAdapter.enqueue(payload, enqueueOptions);
      this.logger.debug?.(`Notification queued (job: ${jobId}${payload.delay ? `, delay: ${payload.delay}ms` : ''})`);

      try {
        await this.emitter.emit('send:queued', { jobId, payload });
      } catch {
        // safe — don't let listener errors affect the queue result
      }

      return {
        event: payload.event,
        results: [],
        sent: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        queued: true,
      };
    }

    // Delay without a queue: warn and send immediately
    if (payload.delay) {
      this.logger.warn('payload.delay requires a queue adapter — sending immediately');
    }

    return this.sendDirect(payload);
  }

  /**
   * Internal send pipeline (used by both direct sends and queue processor).
   *
   * Every code path — including skips for idempotency, quiet hours, and
   * preferences — flows through finalize() so delivery logging and
   * lifecycle events are always emitted.
   */
  private async sendDirect(payload: NotificationPayload): Promise<DispatchResult> {
    const start = Date.now();

    // 1. Lifecycle: before
    await this.emitter.emit('before:send', payload);

    // 1b. Idempotency check
    if (payload.idempotencyKey && this.idempotencyStore) {
      const seen = await this.idempotencyStore.has(payload.idempotencyKey);
      if (seen) {
        this.logger.debug?.(`Duplicate notification skipped (key: ${payload.idempotencyKey})`);
        return this.finalize(payload, {
          event: payload.event,
          results: [],
          sent: 0,
          failed: 0,
          skipped: 1,
          duration: Date.now() - start,
        });
      }
    }

    // 2. Resolve template
    let enrichedPayload = payload;
    if (payload.template && this.templateResolver) {
      try {
        const rendered = await this.templateResolver(payload.template, payload.data);
        enrichedPayload = {
          ...payload,
          data: { ...payload.data, ...rendered },
        };
      } catch (err) {
        this.logger.error(`Template resolution failed for "${payload.template}"`, err);
        throw new NotificationError(
          `Template "${payload.template}" failed: ${err instanceof Error ? err.message : err}`,
          { code: 'TEMPLATE_ERROR' },
        );
      }
    }

    // 3. Filter channels by event + optional target list
    let activeChannels = this.channels.filter(ch => ch.shouldHandle(payload.event));

    if (payload.channels?.length) {
      const targetSet = new Set(payload.channels);
      activeChannels = activeChannels.filter(ch => targetSet.has(ch.name));
    }

    // 4. Apply preference filtering
    if (enrichedPayload.recipient.id && this.preferenceResolver) {
      try {
        const prefs = await this.preferenceResolver(
          enrichedPayload.recipient.id,
          enrichedPayload.event,
        );
        if (prefs) {
          if (prefs.quiet && isQuietHours(prefs.quiet)) {
            this.logger.debug?.(`Notification skipped: quiet hours active for ${enrichedPayload.recipient.id}`);
            return this.finalize(payload, {
              event: enrichedPayload.event,
              results: [],
              sent: 0,
              failed: 0,
              skipped: activeChannels.length,
              duration: Date.now() - start,
            });
          }

          if (prefs.channels) {
            activeChannels = activeChannels.filter(
              ch => prefs.channels![ch.name] !== false,
            );
          }

          if (prefs.events?.[enrichedPayload.event] === false) {
            return this.finalize(payload, {
              event: enrichedPayload.event,
              results: [],
              sent: 0,
              failed: 0,
              skipped: activeChannels.length,
              duration: Date.now() - start,
            });
          }
        }
      } catch (err) {
        this.logger.warn('Preference resolution failed, sending to all channels', err);
      }
    }

    if (!activeChannels.length) {
      return this.finalize(payload, {
        event: enrichedPayload.event,
        results: [],
        sent: 0,
        failed: 0,
        skipped: 0,
        duration: Date.now() - start,
      });
    }

    // 5. Send to all channels in parallel (with rate limit check)
    const results: SendResult[] = await Promise.all(
      activeChannels.map(channel => this.sendToChannel(channel, enrichedPayload)),
    );

    const dispatch: DispatchResult = {
      event: enrichedPayload.event,
      results,
      sent: results.filter(r => r.status === 'sent').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      duration: Date.now() - start,
    };

    // Record idempotency key on successful delivery
    if (payload.idempotencyKey && this.idempotencyStore && dispatch.sent > 0) {
      try {
        await this.idempotencyStore.set(payload.idempotencyKey, this.idempotencyTtl);
      } catch (err) {
        this.logger.warn(`Idempotency store error: ${err instanceof Error ? err.message : err}`);
      }
    }

    return this.finalize(payload, dispatch);
  }

  /**
   * Single exit path for all send outcomes.
   * Records to delivery log and emits lifecycle events regardless of
   * whether the notification was sent, skipped, or failed.
   */
  private async finalize(
    payload: NotificationPayload,
    dispatch: DispatchResult,
  ): Promise<DispatchResult> {
    // Record to delivery log (all outcomes — sent, skipped, failed)
    if (this.deliveryLog) {
      try {
        await this.deliveryLog.record(payload, dispatch);
      } catch (err) {
        this.logger.warn(`Delivery log error: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Lifecycle events (errors logged, never mask the dispatch result)
    try {
      await this.emitter.emit('after:send', dispatch);

      if (dispatch.failed > 0) {
        await this.emitter.emit('send:failed', dispatch);
      }
      if (dispatch.sent > 0) {
        await this.emitter.emit('send:success', dispatch);
      }
    } catch (err) {
      this.logger.error(
        `Lifecycle listener error: ${err instanceof Error ? err.message : err}`,
      );
    }

    return dispatch;
  }

  /** Send to a single channel with rate limiting and retry */
  private async sendToChannel(
    channel: Channel,
    payload: NotificationPayload,
  ): Promise<SendResult> {
    // Rate limit check
    const rateLimit = this.getChannelRateLimit(channel);
    if (rateLimit && this.rateLimitStore) {
      const allowed = await this.rateLimitStore.consume(channel.name, rateLimit);
      if (!allowed) {
        this.logger.warn(`[${channel.name}] Rate limited — skipping`);
        this.emitter.emit('send:rate_limited', {
          channel: channel.name,
          event: payload.event,
        }).catch(err => {
          this.logger.error(`[${channel.name}] send:rate_limited listener error: ${err instanceof Error ? err.message : err}`);
        });
        return {
          status: 'skipped',
          channel: channel.name,
          error: 'Rate limited',
        };
      }
    }

    const channelRetryRaw = (channel as { config?: { retry?: RetryConfig } }).config?.retry;

    // Use channel-specific retry if explicitly configured, otherwise global.
    const retryConfig = channelRetryRaw
      ? resolveRetryConfig(channelRetryRaw)
      : this.retryConfig;

    const start = Date.now();

    try {
      const result = await withRetry(
        () => channel.send(payload),
        retryConfig,
        (attempt, error) => {
          this.logger.warn(
            `[${channel.name}] Retry ${attempt}/${retryConfig.maxAttempts}: ${error.message}`,
          );
          this.emitter.emit('send:retry', {
            channel: channel.name,
            attempt,
            error: error.message,
          }).catch(emitErr => {
            this.logger.error(`[${channel.name}] send:retry listener error: ${emitErr instanceof Error ? emitErr.message : emitErr}`);
          });
        },
      );

      return { ...result, duration: Date.now() - start };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${channel.name}] Failed: ${message}`);
      return {
        status: 'failed',
        channel: channel.name,
        error: message,
        duration: Date.now() - start,
      };
    }
  }

  /** Extract rate limit config from a channel */
  private getChannelRateLimit(channel: Channel): RateLimitConfig | undefined {
    return (channel as { config?: { rateLimit?: RateLimitConfig } }).config?.rateLimit;
  }

  // ===========================================================================
  // Batch Send
  // ===========================================================================

  /**
   * Send multiple notifications with controlled concurrency.
   *
   * Uses a worker-pool pattern: N workers pull from a shared queue,
   * keeping the pipeline full at all times. Unlike chunk-and-wait,
   * there's no idle time from slow outliers.
   *
   * Each notification goes through the full `send()` pipeline
   * (lifecycle events, templates, preferences, retry). Errors in
   * individual notifications are caught and reported — they never
   * abort the batch.
   *
   * @example
   * ```typescript
   * const payloads = students.map(s => ({
   *   event: 'birthday',
   *   recipient: { id: s.id, email: s.email },
   *   data: { name: s.name },
   *   template: 'birthday',
   *   idempotencyKey: `birthday-${s.id}-2024`,
   * }));
   *
   * const batch = await notifications.sendBatch(payloads, {
   *   concurrency: 20,
   *   onProgress: ({ completed, total }) => {
   *     console.log(`${completed}/${total}`);
   *   },
   * });
   *
   * console.log(`Sent: ${batch.sent}, Failed: ${batch.failed}`);
   * ```
   */
  async sendBatch(
    payloads: NotificationPayload[],
    options: BatchOptions = {},
  ): Promise<BatchResult> {
    const { concurrency = 10, onProgress } = options;
    const start = Date.now();
    let completed = 0;

    const results = await pMap(
      payloads,
      async (payload) => {
        let result: DispatchResult;
        try {
          result = await this.send(payload);
        } catch (err) {
          // Catch errors from before:send listeners, template failures, etc.
          // so one bad notification never kills the batch.
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`[batch] Notification failed for event "${payload.event}": ${message}`);
          result = {
            event: payload.event,
            results: [],
            sent: 0,
            failed: 1,
            skipped: 0,
            duration: 0,
          };
        }
        completed++;
        onProgress?.({ completed, total: payloads.length, result });
        return result;
      },
      { concurrency },
    );

    return {
      total: payloads.length,
      sent: results.reduce((sum, r) => sum + r.sent, 0),
      failed: results.reduce((sum, r) => sum + r.failed, 0),
      skipped: results.reduce((sum, r) => sum + r.skipped, 0),
      duration: Date.now() - start,
      results,
    };
  }

  // ===========================================================================
  // Hook Factories (framework integration)
  // ===========================================================================

  /**
   * Create event-specific hook handlers
   *
   * Returns a map of event name -> handler functions that can be plugged
   * into any event system (EventEmitter, MongoKit hooks, custom).
   *
   * @example
   * ```typescript
   * const hooks = notifications.createHooks([
   *   {
   *     event: 'user.created',
   *     getRecipient: (user) => ({ email: user.email, name: user.name }),
   *     getData: (user) => ({ name: user.name }),
   *     template: 'welcome',
   *   },
   *   {
   *     event: 'order.completed',
   *     getRecipient: (order) => ({ email: order.customer.email }),
   *     getData: (order) => ({ orderId: order.id, total: order.total }),
   *     template: 'order-confirmation',
   *     channels: ['email'], // only email for this event
   *   },
   * ]);
   *
   * // Plug into EventEmitter
   * emitter.on('user.created', hooks['user.created'][0]);
   *
   * // Plug into MongoKit
   * repo.on('after:create', hooks['user.created'][0]);
   * ```
   */
  createHooks(configs: NotificationHookConfig[]): HookMap {
    const hooks: HookMap = {};

    for (const config of configs) {
      if (config.enabled === false) continue;

      const handler: HookHandler = async (eventData: unknown) => {
        try {
          const recipient = await config.getRecipient(eventData);
          if (!recipient) return undefined;

          return await this.send({
            event: config.event,
            recipient,
            data: config.getData(eventData),
            template: config.template,
            channels: config.channels,
          });
        } catch (err) {
          // Fire-and-forget: log but don't throw to avoid breaking the caller's flow
          this.logger.error(`[hook:${config.event}] ${err instanceof Error ? err.message : err}`);
          return undefined;
        }
      };

      if (!hooks[config.event]) hooks[config.event] = [];
      hooks[config.event].push(handler);
    }

    return hooks;
  }

  // ===========================================================================
  // Event System
  // ===========================================================================

  /** Listen to service lifecycle events */
  on(event: ServiceEvent, handler: EventHandler): this {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return this;
  }

  /** Remove an event listener */
  off(event: ServiceEvent, handler: EventHandler): this {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
    return this;
  }
}
