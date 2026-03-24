/**
 * Utility exports
 * @module @classytic/notifications/utils
 */

export { mergeHooks } from './merge-hooks.js';
export { withRetry, resolveRetryConfig, calculateDelay } from './retry.js';
export { Emitter } from './emitter.js';
export { NotificationError, ChannelError, ProviderNotInstalledError } from './errors.js';
export { isQuietHours } from './quiet-hours.js';
export type { QuietHoursConfig } from './quiet-hours.js';
export { MemoryIdempotencyStore, IDEMPOTENCY_DEFAULT_TTL } from './idempotency.js';
export type { IdempotencyStore } from './idempotency.js';
export { pMap } from './concurrency.js';
export type { PMapOptions } from './concurrency.js';

// v2: Rate limiting
export { MemoryRateLimitStore } from './rate-limiter.js';
export type { RateLimitConfig, RateLimitStore } from './rate-limiter.js';

// v2: Delivery log
export { MemoryDeliveryLog } from './delivery-log.js';
export type { DeliveryLog, DeliveryLogEntry, DeliveryLogQuery } from './delivery-log.js';

// v2: Queue adapter
export { MemoryQueue } from './queue.js';
export type { QueueAdapter, QueueJob, QueueJobStatus, QueueEnqueueOptions, QueueProcessor } from './queue.js';

// v2: Built-in template resolver
export { createSimpleResolver } from './template-engine.js';
export type { TemplateDefinition, TemplateMap } from './template-engine.js';

// v2: Channel fallback
export { withFallback } from './fallback.js';
export type { FallbackOptions } from './fallback.js';

// v2: Status webhook handler
export { createStatusHandler } from './status-webhook.js';
export type { StatusUpdate, StatusHandler, StatusHandlerConfig, DeliveryStatus } from './status-webhook.js';
