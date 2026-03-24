/**
 * Rate Limiter (Token Bucket)
 * @module @classytic/notifications/utils
 *
 * Per-channel rate limiting using the token bucket algorithm.
 * Prevents exceeding provider limits (e.g., Gmail 500/day, SendGrid 100/sec).
 *
 * Ships with an in-memory store; implement RateLimitStore for
 * Redis or other distributed backends.
 *
 * @example
 * ```typescript
 * import { EmailChannel } from '@classytic/notifications/channels';
 *
 * const email = new EmailChannel({
 *   from: 'noreply@app.com',
 *   transport: { service: 'gmail', auth: { user, pass } },
 *   rateLimit: {
 *     maxPerWindow: 500,    // max 500 emails
 *     windowMs: 86_400_000, // per day (24h)
 *   },
 * });
 * ```
 */

/** Rate limit configuration for a channel */
export interface RateLimitConfig {
  /** Maximum sends allowed within the time window */
  maxPerWindow: number;
  /** Time window in milliseconds (e.g., 60_000 for 1 minute) */
  windowMs: number;
}

/** Interface for pluggable rate limit stores (Redis, DB, etc.) */
export interface RateLimitStore {
  /** Record a send and return whether it was allowed */
  consume(channelName: string, config: RateLimitConfig): boolean | Promise<boolean>;
  /** Get remaining tokens for a channel */
  remaining(channelName: string, config: RateLimitConfig): number | Promise<number>;
  /** Reset rate limit state for a channel */
  reset(channelName: string): void | Promise<void>;
}

/**
 * In-memory sliding window rate limiter.
 *
 * Tracks timestamps of recent sends per channel and checks
 * against the configured window. Suitable for single-process apps.
 * For distributed systems, implement `RateLimitStore` with Redis.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private windows = new Map<string, number[]>();

  consume(channelName: string, config: RateLimitConfig): boolean {
    const now = Date.now();
    const timestamps = this.getActive(channelName, now, config.windowMs);

    if (timestamps.length >= config.maxPerWindow) {
      return false;
    }

    timestamps.push(now);
    this.windows.set(channelName, timestamps);
    return true;
  }

  remaining(channelName: string, config: RateLimitConfig): number {
    const now = Date.now();
    const timestamps = this.getActive(channelName, now, config.windowMs);
    return Math.max(0, config.maxPerWindow - timestamps.length);
  }

  reset(channelName: string): void {
    this.windows.delete(channelName);
  }

  /** Get only the timestamps that fall within the current window */
  private getActive(channelName: string, now: number, windowMs: number): number[] {
    const cutoff = now - windowMs;
    const all = this.windows.get(channelName) ?? [];
    const active = all.filter(t => t > cutoff);
    this.windows.set(channelName, active);
    return active;
  }
}
