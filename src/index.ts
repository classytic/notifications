/**
 * @classytic/notifications
 * Multi-Channel Notification System
 *
 * Pluggable channels, templates, retry, and preferences.
 * Zero required dependencies - bring your own providers.
 *
 * @module @classytic/notifications
 * @author Classytic (https://github.com/classytic)
 * @license MIT
 *
 * @example
 * ```typescript
 * import { NotificationService } from '@classytic/notifications';
 * import { EmailChannel, WebhookChannel, ConsoleChannel } from '@classytic/notifications/channels';
 *
 * const notifications = new NotificationService({
 *   channels: [
 *     new EmailChannel({
 *       from: 'App <noreply@app.com>',
 *       transport: { host: 'smtp.gmail.com', port: 587, auth: { user, pass } },
 *     }),
 *     new WebhookChannel({
 *       url: 'https://hooks.slack.com/services/...',
 *       events: ['order.*'],
 *     }),
 *     new ConsoleChannel(), // dev/testing
 *   ],
 *   templates: async (id, data) => ({
 *     subject: `Notification: ${id}`,
 *     html: `<p>${JSON.stringify(data)}</p>`,
 *   }),
 *   retry: { maxAttempts: 3, backoff: 'exponential' },
 * });
 *
 * await notifications.send({
 *   event: 'user.created',
 *   recipient: { email: 'user@example.com', name: 'John' },
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
