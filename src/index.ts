/**
 * @classytic/notifications
 * Multi-Channel Notification System
 *
 * Pluggable channels, templates, retry, and preferences.
 * Zero required dependencies - bring your own providers.
 *
 * v2: Rate limiting, delivery tracking, queue adapter,
 * BCC batching, template engines, SMS & push channels.
 *
 * @module @classytic/notifications
 * @author Classytic (https://github.com/classytic)
 * @license MIT
 *
 * @example
 * ```typescript
 * import { NotificationService } from '@classytic/notifications';
 * import { EmailChannel, SmsChannel, PushChannel } from '@classytic/notifications/channels';
 * import { MemoryDeliveryLog, createSimpleResolver } from '@classytic/notifications/utils';
 *
 * const notifications = new NotificationService({
 *   channels: [
 *     new EmailChannel({
 *       from: 'App <noreply@app.com>',
 *       transport: { host: 'smtp.gmail.com', port: 587, auth: { user, pass } },
 *       rateLimit: { maxPerWindow: 500, windowMs: 86_400_000 }, // Gmail 500/day
 *     }),
 *     new SmsChannel({
 *       from: '+15551234567',
 *       provider: { send: async ({ to, from, body }) => ({ sid: 'custom' }) },
 *     }),
 *     new PushChannel({
 *       provider: { send: async ({ token, title, body }) => ({ messageId: 'custom' }) },
 *     }),
 *   ],
 *   templates: createSimpleResolver({
 *     welcome: { subject: 'Welcome ${name}!', html: '<p>Hi ${name}</p>' },
 *   }),
 *   retry: { maxAttempts: 3, backoff: 'exponential' },
 *   deliveryLog: new MemoryDeliveryLog(),
 * });
 *
 * await notifications.send({
 *   event: 'user.created',
 *   recipient: { email: 'user@example.com', phone: '+15559876543', name: 'John' },
 *   data: { name: 'John' },
 *   template: 'welcome',
 * });
 * ```
 */

// Core
export { NotificationService } from './NotificationService.js';

// Channels
export { BaseChannel } from './channels/BaseChannel.js';
export { EmailChannel } from './channels/email.channel.js';
export { WebhookChannel } from './channels/webhook.channel.js';
export { ConsoleChannel } from './channels/console.channel.js';
export { SmsChannel } from './channels/sms.channel.js';
export { PushChannel } from './channels/push.channel.js';

// Utilities
export { mergeHooks } from './utils/merge-hooks.js';
export { withRetry, resolveRetryConfig, calculateDelay } from './utils/retry.js';
export { Emitter } from './utils/emitter.js';
export { NotificationError, ChannelError, ProviderNotInstalledError } from './utils/errors.js';
export { isQuietHours } from './utils/quiet-hours.js';
export type { QuietHoursConfig } from './utils/quiet-hours.js';
export { MemoryIdempotencyStore, IDEMPOTENCY_DEFAULT_TTL } from './utils/idempotency.js';
export type { IdempotencyStore } from './utils/idempotency.js';
export { pMap } from './utils/concurrency.js';
export type { PMapOptions } from './utils/concurrency.js';

// v2: Rate limiting
export { MemoryRateLimitStore } from './utils/rate-limiter.js';
export type { RateLimitConfig, RateLimitStore } from './utils/rate-limiter.js';

// v2: Delivery log
export { MemoryDeliveryLog } from './utils/delivery-log.js';
export type { DeliveryLog, DeliveryLogEntry, DeliveryLogQuery } from './utils/delivery-log.js';

// v2: Queue adapter
export { MemoryQueue } from './utils/queue.js';
export type { QueueAdapter, QueueJob, QueueJobStatus, QueueEnqueueOptions, QueueProcessor } from './utils/queue.js';

// v2: Built-in template resolver
export { createSimpleResolver } from './utils/template-engine.js';
export type { TemplateDefinition, TemplateMap } from './utils/template-engine.js';

// v2: Channel fallback
export { withFallback } from './utils/fallback.js';
export type { FallbackOptions } from './utils/fallback.js';

// v2: Status webhook handler
export { createStatusHandler } from './utils/status-webhook.js';
export type { StatusUpdate, StatusHandler, StatusHandlerConfig, DeliveryStatus } from './utils/status-webhook.js';

// Types
export type {
  // Core
  Recipient,
  NotificationPayload,
  SendResult,
  DispatchResult,

  // Channel
  Channel,
  ChannelConfig,

  // Email
  EmailChannelConfig,
  SmtpTransportOptions,
  EmailAttachment,
  NodemailerTransporter,

  // Webhook
  WebhookChannelConfig,

  // SMS
  SmsChannelConfig,
  SmsProvider,

  // Push
  PushChannelConfig,
  PushProvider,

  // Templates
  TemplateResult,
  TemplateResolver,

  // Retry
  RetryConfig,
  ResolvedRetryConfig,

  // Preferences
  NotificationPreferences,
  PreferenceResolver,

  // Logger
  Logger,

  // Service
  NotificationServiceConfig,
  ServiceEvent,
  EventHandler,

  // Hooks
  NotificationHookConfig,
  HookHandler,
  HookMap,

  // Batch
  BatchOptions,
  BatchProgress,
  BatchResult,
} from './types.js';
