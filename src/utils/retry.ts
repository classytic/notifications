/**
 * Retry with Backoff
 * @module @classytic/notifications
 */

import type { RetryConfig, ResolvedRetryConfig } from '../types.js';

/** Resolve retry config with defaults */
export function resolveRetryConfig(config?: RetryConfig): ResolvedRetryConfig {
  return {
    maxAttempts: config?.maxAttempts ?? 1,
    backoff: config?.backoff ?? 'exponential',
    initialDelay: config?.initialDelay ?? 500,
    maxDelay: config?.maxDelay ?? 30_000,
  };
}

/** Calculate delay for a given attempt */
export function calculateDelay(attempt: number, config: ResolvedRetryConfig): number {
  let delay: number;

  switch (config.backoff) {
    case 'exponential':
      delay = config.initialDelay * Math.pow(2, attempt - 1);
      break;
    case 'linear':
      delay = config.initialDelay * attempt;
      break;
    case 'fixed':
    default:
      delay = config.initialDelay;
  }

  // Add jitter (+-25%) to prevent thundering herd
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  delay = Math.min(delay + jitter, config.maxDelay);

  return Math.max(0, Math.round(delay));
}

/**
 * The `retryAfterMs` an error (or one of its causes, up to 4 deep) carries — set by providers
 * from an HTTP `Retry-After` header. Channels wrap provider errors in `ChannelError`, so the hint
 * usually rides on `cause`.
 */
export function retryAfterHint(error: unknown): number | undefined {
  let cursor: unknown = error;
  for (let depth = 0; cursor !== null && typeof cursor === 'object' && depth < 5; depth++) {
    const hint = (cursor as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof hint === 'number' && Number.isFinite(hint) && hint >= 0) return hint;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The `retryFloorMs` an error (or one of its causes) carries: the provider's MINIMUM wait before a
 * retry (push: FCM 10 s, FCM 429 60 s, APNs 5xx 15 min; `TransientPushError` sets it). 2.10.
 */
export function retryFloorHint(error: unknown): number | undefined {
  let cursor: unknown = error;
  for (let depth = 0; cursor !== null && typeof cursor === 'object' && depth < 5; depth++) {
    const floor = (cursor as { retryFloorMs?: unknown }).retryFloorMs;
    if (typeof floor === 'number' && Number.isFinite(floor) && floor >= 0) return floor;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Sleep for a given duration */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry and backoff
 *
 * @param fn - Async function to retry
 * @param config - Retry configuration
 * @param onRetry - Called before each retry attempt
 * @returns Result of fn
 * @throws Last error after all attempts exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: ResolvedRetryConfig,
  onRetry?: (attempt: number, error: Error) => void,
  /** Return `false` to stop retrying and rethrow this error at once. Default: retry everything. */
  shouldRetry?: (error: Error) => boolean,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === config.maxAttempts || shouldRetry?.(lastError) === false) break;

      let delay = calculateDelay(attempt, config);
      // A provider that said WHEN to come back (HTTP `Retry-After`) is obeyed: never retry
      // sooner than asked. A wait longer than `maxDelay` is not shortened (that is exactly the
      // hammering Retry-After forbids); the attempt stops here and the caller's queue retries later.
      const hinted = retryAfterHint(lastError);
      if (hinted !== undefined) {
        if (hinted > config.maxDelay) break;
        delay = Math.max(delay, hinted);
      }
      // The same rule for a provider's documented minimum (2.10, ADR 0001 section 5.3): FCM's
      // first retry is at least 10 s, APNs 5xx 15 min. A floor above `maxDelay` stops in-process
      // retrying; the job queue (arc-notifications' per-device retry job) owns waits that long.
      const floor = retryFloorHint(lastError);
      if (floor !== undefined) {
        if (floor > config.maxDelay) break;
        delay = Math.max(delay, floor);
      }
      onRetry?.(attempt, lastError);

      await sleep(delay);
    }
  }

  throw lastError;
}
