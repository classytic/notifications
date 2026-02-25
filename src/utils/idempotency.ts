/**
 * Idempotency / deduplication utilities
 * @module @classytic/notifications/utils
 *
 * Prevents duplicate notification delivery using idempotency keys.
 * Ships with an in-memory store; implement IdempotencyStore for
 * Redis, database, or other distributed backends.
 */

/** Default TTL: 24 hours */
const DEFAULT_TTL = 24 * 60 * 60 * 1000;

/**
 * Interface for idempotency stores.
 *
 * Methods may be sync or async to support both in-memory and
 * distributed backends (Redis, DB).
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
 * Expired entries are lazily cleaned up every `cleanupInterval` writes.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, number>();
  private cleanupCounter = 0;
  private readonly cleanupInterval: number;

  constructor(options?: { cleanupInterval?: number }) {
    this.cleanupInterval = options?.cleanupInterval ?? 100;
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
    this.maybeCleanup();
  }

  /** Number of entries (including possibly expired) */
  get size(): number {
    return this.store.size;
  }

  /** Remove all entries */
  clear(): void {
    this.store.clear();
  }

  private maybeCleanup(): void {
    if (++this.cleanupCounter < this.cleanupInterval) return;
    this.cleanupCounter = 0;
    const now = Date.now();
    for (const [key, expiry] of this.store) {
      if (now > expiry) this.store.delete(key);
    }
  }
}

/** Default TTL for idempotency keys (24 hours) */
export const IDEMPOTENCY_DEFAULT_TTL = DEFAULT_TTL;
