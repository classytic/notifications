/**
 * Push errors. Every message here is built from provider STATUS fields only (HTTP status, the
 * provider's reason code, a token suffix): never key material, never a full device token, never
 * payload text. A provider's own error body is parsed for its reason code and then dropped,
 * because FCM and APNs bodies may echo the token.
 *
 * @module @classytic/notifications/push
 */

import { NotificationError, PermanentDeliveryError } from '../utils/errors.js';
import { pushRetryFloorMs } from './retry.js';

/** Which provider produced an error or event. */
export type PushProviderName = 'fcm' | 'apns' | 'router';

/**
 * Why a token was declared dead. `unregistered` (FCM UNREGISTERED, APNs 410) is the certain
 * signal: the app was uninstalled or the token rotated. `invalid-token` (FCM INVALID_ARGUMENT
 * naming the token) and `bad-device-token` (APNs 400 BadDeviceToken) also fire when the token
 * was minted for ANOTHER environment or project, so a host unsure its configuration matches the
 * app build may choose to delete only on `unregistered`.
 */
export type InvalidTokenReason = 'unregistered' | 'invalid-token' | 'bad-device-token';

/**
 * The device token will never work again. Permanent (`retryable: false`): the service does not
 * retry it, and the host should delete the device row (the providers' `onInvalidToken` hook and
 * arc-notifications' device channel do).
 */
export class InvalidPushTokenError extends PermanentDeliveryError {
  readonly reason: InvalidTokenReason;
  readonly provider: PushProviderName;
  /** HTTP status the provider answered. */
  readonly status: number;
  /** Last 6 characters of the token: enough to correlate, useless to an attacker. */
  readonly tokenSuffix: string;
  /** Structural marker (survives bundling / duplicate copies of this package). */
  readonly invalidToken = true as const;

  constructor(provider: PushProviderName, reason: InvalidTokenReason, status: number, tokenSuffix: string) {
    super(`${provider} push: device token is ${reason} (status ${status}, token …${tokenSuffix})`, {
      code: 'PUSH_TOKEN_INVALID',
    });
    this.name = 'InvalidPushTokenError';
    this.reason = reason;
    this.provider = provider;
    this.status = status;
    this.tokenSuffix = tokenSuffix;
  }
}

/**
 * A failure no retry fixes that is NOT about the token: a payload the provider rejects, a
 * misconfigured topic or sender, a platform with no provider. The device row is kept.
 */
export class PushRejectedError extends PermanentDeliveryError {
  readonly provider: PushProviderName;
  readonly status: number;
  /** The provider's reason code (`BadTopic`, `INVALID_ARGUMENT`, ...), or a local one. */
  readonly reason: string;

  constructor(provider: PushProviderName, status: number, reason: string, detail?: string) {
    super(`${provider} push rejected: ${status} ${reason}${detail ? ` (${detail})` : ''}`, {
      code: 'PUSH_REJECTED',
    });
    this.name = 'PushRejectedError';
    this.provider = provider;
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Credentials are missing, malformed, or refused by the provider. Permanent: retrying with the
 * same credentials cannot succeed (a rotated credential is picked up on the next send anyway).
 * The message names FIELDS, never values.
 */
export class PushCredentialsError extends PermanentDeliveryError {
  readonly provider: PushProviderName;

  constructor(provider: PushProviderName, message: string) {
    super(`${provider} credentials: ${message}`, { code: 'PUSH_CREDENTIALS' });
    this.name = 'PushCredentialsError';
    this.provider = provider;
  }
}

/**
 * A transient failure (429, 5xx, timeout, connection reset). Retryable; `retryAfterMs` carries the
 * provider's `Retry-After`, which the service's retry loop honours (`retryAfterHint`), and
 * `retryFloorMs` the provider's minimum wait (FCM 10 s, FCM 429 60 s, APNs 5xx 15 min, APNs 429 60 s;
 * `PUSH_RETRY_DEFAULTS`), which nothing may retry sooner than (2.10).
 */
export class TransientPushError extends NotificationError {
  readonly retryable = true as const;
  readonly provider: PushProviderName;
  /** HTTP status, or 0 for a network-level failure. */
  readonly status: number;
  readonly reason: string;
  readonly retryAfterMs?: number;
  /**
   * The provider's minimum wait before a retry (ms). Defaults from {@link pushRetryFloorMs}
   * (provider + status); a throw site may pass its own. `withRetry` and `planPushRetry` never
   * retry sooner.
   */
  readonly retryFloorMs: number;

  constructor(
    provider: PushProviderName,
    status: number,
    reason: string,
    options?: { retryAfterMs?: number; retryFloorMs?: number; cause?: Error },
  ) {
    super(
      `${provider} push failed (retryable): ${status || 'network'} ${reason}` +
        (options?.retryAfterMs !== undefined ? ` (retry after ${options.retryAfterMs} ms)` : ''),
      { code: 'PUSH_TRANSIENT', ...(options?.cause ? { cause: options.cause } : {}) },
    );
    this.name = 'TransientPushError';
    this.provider = provider;
    this.status = status;
    this.reason = reason;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    this.retryFloorMs = options?.retryFloorMs ?? pushRetryFloorMs(provider, status);
  }
}

/** Structural check: is this an invalid-token error (from any copy of this package)? */
export function isInvalidPushTokenError(err: unknown): err is InvalidPushTokenError {
  return (
    err !== null &&
    typeof err === 'object' &&
    ((err as { invalidToken?: unknown }).invalidToken === true ||
      (err as { code?: unknown }).code === 'PUSH_TOKEN_INVALID')
  );
}
