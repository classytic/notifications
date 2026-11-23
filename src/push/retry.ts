/**
 * Push retry timing: provider minimums, `Retry-After`, exponential backoff with jitter, a give-up
 * window and the notification's own expiry. Pure functions: nothing here sleeps. The caller (a job
 * queue, arc-notifications' per-device retry job) schedules the next attempt at the returned delay.
 *
 * Sources (ADR 0001 section 5.3, arc-ecosystem `docs/adr/0001-notifications-and-push.md`):
 *   - FCM "Scale FCM" [S3]: first retry at least 10 s; on 429 wait `Retry-After`, else 60 s;
 *     exponential after that; stop after 60 min of continuous failure; drop requests that are no
 *     longer timely. FCM ErrorCode [S2]: "minimum initial delay of 1 minute" for quota (429).
 *   - APNs "Handling notification responses" [A3]: 5xx "After 15 minutes, you can retry";
 *     429 `TooManyRequests` "You can retry with a delay" (the 60 s floor is our value).
 *   - Network errors and timeouts: 10 s floor (our value, same as FCM's minimum).
 *
 * @module @classytic/notifications/push
 */

/** The numbers behind every push retry decision. Exported so hosts and docs quote one table. */
export const PUSH_RETRY_DEFAULTS = {
  /** FCM: first retry not sooner than 10 s (5xx, network, timeout) [S3]. */
  fcmMinDelayMs: 10_000,
  /** FCM 429: `Retry-After`, else 60 s; quota errors need a 1 minute initial delay [S2][S3]. */
  fcmQuotaDelayMs: 60_000,
  /** FCM: stop after 60 minutes of continuous failure [S3]. */
  fcmGiveUpAfterMs: 3_600_000,
  /** APNs 500 / 503: retry after 15 minutes [A3]. */
  apnsServerErrorDelayMs: 900_000,
  /** APNs 429 (`TooManyRequests`, `TooManyProviderTokenUpdates`): 60 s (our value) [A3]. */
  apnsTooManyRequestsDelayMs: 60_000,
  /** Network failure, timeout, credentials store down, unknown provider: 10 s (our value). */
  networkDelayMs: 10_000,
  /** Attempts per device, the first send included (ADR 5.3). */
  maxAttempts: 5,
  /** Backoff growth stops here (a floor or Retry-After above it still wins). */
  maxDelayMs: 3_600_000,
  /** Upward jitter: a delay is stretched by up to this fraction, never shortened. */
  jitter: 0.2,
} as const;

/**
 * The provider's minimum wait before retrying a transient failure with this HTTP status
 * (`0` = network failure / timeout / no request made). `TransientPushError` fills
 * `retryFloorMs` from this table unless the throw site passes its own.
 */
export function pushRetryFloorMs(provider: string, status: number): number {
  const d = PUSH_RETRY_DEFAULTS;
  if (provider === 'fcm') return status === 429 ? d.fcmQuotaDelayMs : d.fcmMinDelayMs;
  if (provider === 'apns') {
    if (status === 429) return d.apnsTooManyRequestsDelayMs;
    if (status >= 500) return d.apnsServerErrorDelayMs;
    return d.networkDelayMs;
  }
  return d.networkDelayMs;
}

/** Walk an error and its causes (4 deep) for a numeric field. Structural: any copy of the package. */
function numericField(error: unknown, field: 'retryAfterMs' | 'retryFloorMs'): number | undefined {
  let cursor: unknown = error;
  for (let depth = 0; cursor !== null && typeof cursor === 'object' && depth < 5; depth++) {
    const value = (cursor as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

function providerOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; cursor !== null && typeof cursor === 'object' && depth < 5; depth++) {
    const value = (cursor as { provider?: unknown }).provider;
    if (typeof value === 'string' && value !== 'router') return value;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface PushRetryDelayOptions {
  /** `[0, 1)` source for jitter. Default `Math.random` (tests pass a constant). */
  readonly random?: () => number;
  /** Cap on exponential growth. Default 60 min. A floor or `Retry-After` above it still wins. */
  readonly maxDelayMs?: number;
}

/**
 * How long to wait before retry number `attempt` (1 = the first retry, after one failed send):
 * `max(Retry-After, provider floor) x 2^(attempt - 1)`, capped at `maxDelayMs`, then stretched by
 * up to 20 % jitter. Jitter only ever ADDS: the result is never below the provider minimum or the
 * provider's `Retry-After`.
 */
export function pushRetryDelay(error: unknown, attempt: number, options: PushRetryDelayOptions = {}): number {
  const random = options.random ?? Math.random;
  const floor = numericField(error, 'retryFloorMs') ?? PUSH_RETRY_DEFAULTS.networkDelayMs;
  const retryAfter = numericField(error, 'retryAfterMs') ?? 0;
  const base = Math.max(floor, retryAfter);
  const n = Math.max(1, Math.floor(attempt));
  const cap = Math.max(options.maxDelayMs ?? PUSH_RETRY_DEFAULTS.maxDelayMs, base);
  const raw = Math.min(base * 2 ** (n - 1), cap);
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(raw + raw * PUSH_RETRY_DEFAULTS.jitter * r);
}

export interface PushRetryInput extends PushRetryDelayOptions {
  /** The error the last attempt threw. */
  readonly error: unknown;
  /** Attempts made so far for this message and device (1 after the first failed send). */
  readonly attempt: number;
  /** When the first attempt failed (ms epoch): the FCM 60 min window counts from here. */
  readonly firstFailureAt: number;
  /** Now (ms epoch). */
  readonly now: number;
  /** The notification's expiry (ms epoch). A retry that would land at or after it is dropped. */
  readonly expiresAt?: number;
  /** Total attempts allowed, the first send included. Default 5. */
  readonly maxAttempts?: number;
  /**
   * Stop once this long has passed since `firstFailureAt`. Default: 60 min for FCM errors [S3],
   * none for APNs (bounded by `expiresAt` and `maxAttempts`).
   */
  readonly giveUpAfterMs?: number;
}

export type PushRetryDecision =
  | { readonly retry: true; readonly delayMs: number; readonly at: number }
  | {
      readonly retry: false;
      /**
       * `permanent`: not retryable (dead token, rejected payload, credentials);
       * `attempts`: `maxAttempts` used; `expired`: the next attempt would be past `expiresAt`;
       * `gave-up`: past the provider's continuous-failure window (FCM 60 min).
       */
      readonly reason: 'permanent' | 'attempts' | 'expired' | 'gave-up';
    };

/**
 * Decide whether, and when, to retry one push to one device. Never sleeps; the caller schedules a
 * job at `delayMs`. Order: permanent errors stop, then the attempt budget, then the timing check
 * against the give-up window and the notification's expiry.
 */
export function planPushRetry(input: PushRetryInput): PushRetryDecision {
  const { error, attempt, firstFailureAt, now } = input;
  if ((error as { retryable?: unknown } | null)?.retryable === false) return { retry: false, reason: 'permanent' };
  const maxAttempts = input.maxAttempts ?? PUSH_RETRY_DEFAULTS.maxAttempts;
  if (attempt >= maxAttempts) return { retry: false, reason: 'attempts' };
  const delayMs = pushRetryDelay(error, attempt, input);
  const at = now + delayMs;
  if (input.expiresAt !== undefined && at >= input.expiresAt) return { retry: false, reason: 'expired' };
  const window = input.giveUpAfterMs ?? (providerOf(error) === 'fcm' ? PUSH_RETRY_DEFAULTS.fcmGiveUpAfterMs : undefined);
  if (window !== undefined && at - firstFailureAt > window) return { retry: false, reason: 'gave-up' };
  return { retry: true, delayMs, at };
}
