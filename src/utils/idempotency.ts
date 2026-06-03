/**
 * Idempotency / deduplication utilities
 * @module @classytic/notifications/utils
 *
 * Prevents duplicate notification delivery using idempotency keys.
 * Ships with an in-memory store; implement IdempotencyStore for
 * Redis, database, or other distributed backends.
 *
 * ## Distributed systems note
 *
 * `MemoryIdempotencyStore` is not suitable for multi-process deployments.
 * The `has()` + `set()` pair is not atomic — two concurrent processes can
 * both call `has()`, both see `false`, and both deliver the notification.
 * For distributed safety, implement `IdempotencyStore` backed by a store
 * that supports atomic `SET key value NX PX ttl` semantics (Redis, Postgres
 * advisory locks, etc.). The interface is intentionally async to allow this.
 */

/** Default TTL: 24 hours */
const DEFAULT_TTL = 24 * 60 * 60 * 1000;

/**
 * Interface for idempotency stores.
 *
 * Methods may be sync or async to support both in-memory and
 * distributed backends (Redis, DB).
 *
 * **Atomicity requirement**: for distributed deployments, `has()`/`set()`
 * MUST be implemented as a single atomic operation (e.g. Redis `SET NX`).
 * The two-method interface exists for in-process convenience only.
 */
export interface IdempotencyStore {
  /** Check if a key has been seen (within TTL) */
  has(key: string): boolean | Promise<boolean>;
  /** Record a key with TTL in milliseconds */
  set(key: string, ttlMs: number): void | Promise<void>;
}

/**
 * In-memory idempotency store with TTL-based expiry.
 *
 * Suitable for single-process apps. For distributed systems,
 * implement `IdempotencyStore` with Redis or your database.
 *
 * Cleanup strategy:
 *   - **Write-triggered**: every `cleanupInterval` writes a full pass
 *     removes expired keys (prevents unbounded growth under high write load).
 *   - **Time-triggered**: a background `setInterval` runs every
 *     `cleanupIntervalMs` so sparse-traffic apps don't accumulate stale keys
 *     indefinitely. Pass `cleanupIntervalMs: 0` to disable the timer
 *     (e.g. in tests that use fake timers).
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, number>();
  private writeCounter = 0;
  private readonly writeCleanupThreshold: number;
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(options?: {
    /** Trigger a cleanup sweep after this many writes. Default: 100. */
    cleanupInterval?: number;
    /**
     * Run a time-based cleanup sweep every N ms. Default: 5 minutes.
     * Set to 0 to disable the timer (useful in test environments with
     * fake timers — drive cleanup via writes or call `cleanup()` manually).
     */
    cleanupIntervalMs?: number;
  }) {
    this.writeCleanupThreshold = options?.cleanupInterval ?? 100;
    const intervalMs = options?.cleanupIntervalMs ?? 5 * 60 * 1000;
    this.timer = intervalMs > 0
      ? setInterval(() => this.cleanup(), intervalMs).unref?.() ?? setInterval(() => this.cleanup(), intervalMs)
      : null;
  }

  has(key: string): boolean {
    const expiry = this.store.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  set(key: string, ttlMs: number): void {
    this.store.set(key, Date.now() + ttlMs);
    if (++this.writeCounter >= this.writeCleanupThreshold) {
      this.writeCounter = 0;
      this.cleanup();
    }
  }

  /** Remove all expired entries. Safe to call at any time. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, expiry] of this.store) {
      if (now > expiry) this.store.delete(key);
    }
  }

  /** Number of entries (including possibly expired). */
  get size(): number {
    return this.store.size;
  }

  /** Remove all entries and stop the background timer. */
  clear(): void {
    this.store.clear();
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Stop the background cleanup timer without clearing entries.
   * Call in tests / shutdown hooks to avoid open-handle warnings.
   */
  destroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** Default TTL for idempotency keys (24 hours) */
export const IDEMPOTENCY_DEFAULT_TTL = DEFAULT_TTL;
