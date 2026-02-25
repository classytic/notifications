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
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === config.maxAttempts) break;

      const delay = calculateDelay(attempt, config);
      onRetry?.(attempt, lastError);

      await sleep(delay);
    }
  }

  throw lastError;
}
