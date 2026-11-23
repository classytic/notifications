/**
 * Small shared pieces of the push providers: a concurrency gate, `Retry-After` parsing, a
 * per-provider cool-down, token redaction, and the delivery-event shape.
 *
 * @module @classytic/notifications/push
 */

import type { PushPlatform } from '../types.js';
import {
  InvalidPushTokenError,
  PushCredentialsError,
  PushRejectedError,
  TransientPushError,
  type InvalidTokenReason,
  type PushProviderName,
} from './errors.js';
import { fingerprint } from './jwt.js';

/** Called when a token is declared dead: delete the device row here. Errors are swallowed. */
export type InvalidTokenHandler = (token: string, reason: InvalidTokenReason) => void | Promise<void>;

/** Run the dead-token hook, swallowing its failure (cleanup must not change the outcome). */
export async function reportInvalid(handler: InvalidTokenHandler | undefined, token: string, reason: InvalidTokenReason) {
  if (!handler) return;
  try {
    await handler(token, reason);
  } catch {
    // The outcome stays "dead token" either way.
  }
}

/** The redacted event fields for a failed send, from the typed error. */
export function failureEvent(
  err: unknown,
): Pick<PushDeliveryEvent, 'outcome' | 'status' | 'reason' | 'retryAfterMs'> {
  if (err instanceof InvalidPushTokenError) return { outcome: 'invalid-token', status: err.status, reason: err.reason };
  if (err instanceof PushCredentialsError) return { outcome: 'credentials', status: 0, reason: 'credentials' };
  if (err instanceof PushRejectedError) return { outcome: 'rejected', status: err.status, reason: err.reason };
  if (err instanceof TransientPushError) {
    return {
      outcome: 'transient',
      status: err.status,
      reason: err.reason,
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    };
  }
  return { outcome: 'transient', status: 0, reason: 'unknown' };
}

/**
 * One structured record per send attempt, for an opt-in delivery log or metrics. Holds only what
 * is safe to persist: a token SUFFIX and HASH (never the token), status codes, latency. No title,
 * body, or data.
 */
export interface PushDeliveryEvent {
  readonly provider: PushProviderName;
  readonly platform?: PushPlatform;
  readonly outcome: 'sent' | 'invalid-token' | 'rejected' | 'transient' | 'credentials';
  /** HTTP status (0 = network failure or no request made). */
  readonly status: number;
  /** Provider reason code (`Unregistered`, `UNAVAILABLE`, ...). */
  readonly reason?: string;
  /** Provider message id on success (`apns-id`, FCM message name). */
  readonly messageId?: string;
  /** Last 6 characters of the device token. */
  readonly tokenSuffix: string;
  /** sha256 prefix of the device token: joins events for one device without storing it. */
  readonly tokenHash: string;
  readonly latencyMs: number;
  readonly retryAfterMs?: number;
}

export type PushDeliveryListener = (event: PushDeliveryEvent) => void;

/** Last 6 characters, for messages and logs. */
export function tokenSuffix(token: string): string {
  return token.length <= 6 ? '***' : token.slice(-6);
}

/** Non-reversible token hash for joining log rows. */
export function tokenHash(token: string): string {
  return fingerprint(token, 16);
}

/**
 * `Retry-After` as milliseconds: delta-seconds or an HTTP-date. Unparseable or negative values
 * are ignored. Capped at one hour so a hostile or broken header cannot park a queue for days.
 */
export function parseRetryAfter(value: string | string[] | null | undefined, now: number): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const trimmed = String(raw).trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, 3_600_000);
}

/** A counting semaphore: at most `limit` sends in flight per provider instance. */
export function createGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`push: maxConcurrency must be a positive integer`);
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Per-process back-pressure after a 429 / 503 with `Retry-After`: until the deadline every send
 * fails fast as retryable with the remaining wait, instead of hammering a provider that already
 * said "not now". Not a circuit breaker: it never opens on its own judgement, only on the
 * provider's explicit instruction, and it closes by itself when the time passes.
 */
export function createCooldown(now: () => number) {
  let until = 0;
  return {
    /** Remaining ms of an active cool-down, or 0. */
    remaining(): number {
      const left = until - now();
      return left > 0 ? left : 0;
    },
    hold(ms: number): void {
      until = Math.max(until, now() + ms);
    },
  };
}
