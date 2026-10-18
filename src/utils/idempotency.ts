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
  /**
   * Atomically take the key for an in-flight send (`SET key NX PX leaseMs`).
   * Resolves `true` only for the one caller that took it; every concurrent or
   * later duplicate (any process) gets `false` and is skipped. When present the
   * service uses it instead of `has()`: it claims before delivery, then `set()`s
   * the full TTL on success or `release()`s on failure so a retry can deliver.
   * The lease bounds how long a crashed sender holds the key.
   */
  claim?(key: string, leaseMs: number): boolean | Promise<boolean>;
  /** Drop a claimed key (delivery failed or never started). */
  release?(key: string): void | Promise<void>;
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

  claim(key: string, leaseMs: number): boolean {
    if (this.has(key)) return false;
    this.set(key, leaseMs);
    return true;
  }

  release(key: string): void {
    this.store.delete(key);
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

/** Default in-flight lease for `claim()` (5 minutes): covers a send with its retries. */
export const IDEMPOTENCY_DEFAULT_LEASE = 5 * 60 * 1000;

/**
 * The subset of a Redis client the store needs, typed structurally so the
 * package has no Redis dependency. ioredis (`Redis`, `Cluster`) matches as is;
 * for node-redis pass `{ set: (k, v, _px, ms, nx) => client.set(k, v, nx ? { PX: ms, NX: true } : { PX: ms }), del: (k) => client.del(k), exists: (k) => client.exists(k) }`.
 */
export interface RedisIdempotencyClient {
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<unknown>;
  del(key: string): Promise<unknown>;
  exists(key: string): Promise<number>;
}

/**
 * Distributed idempotency store on Redis: `claim()` is one `SET key 1 PX lease NX`,
 * so exactly one process delivers a given key across restarts and replicas.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly client: RedisIdempotencyClient;
  private readonly prefix: string;

  constructor(options: {
    client: RedisIdempotencyClient;
    /** Key prefix. Default: `notif:idem:`. */
    prefix?: string;
  }) {
    this.client = options.client;
    this.prefix = options.prefix ?? 'notif:idem:';
  }

  async has(key: string): Promise<boolean> {
    return (await this.client.exists(this.prefix + key)) > 0;
  }

  async set(key: string, ttlMs: number): Promise<void> {
    await this.client.set(this.prefix + key, '1', 'PX', Math.max(1, Math.ceil(ttlMs)));
  }

  async claim(key: string, leaseMs: number): Promise<boolean> {
    return (await this.client.set(this.prefix + key, '1', 'PX', Math.max(1, Math.ceil(leaseMs)), 'NX')) === 'OK';
  }

  async release(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }
}
