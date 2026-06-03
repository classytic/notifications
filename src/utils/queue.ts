/**
 * Queue Adapter
 * @module @classytic/notifications/utils
 *
 * Optional queue layer for crash-resilient notification delivery.
 * Without a queue, notifications are fire-and-forget (lost on crash).
 *
 * Ships with a MemoryQueue (dev/testing); use BullMQ, Redis, or
 * database-backed adapters in production.
 *
 * @example
 * ```typescript
 * import { NotificationService } from '@classytic/notifications';
 * import { MemoryQueue } from '@classytic/notifications/utils';
 *
 * const queue = new MemoryQueue();
 * const service = new NotificationService({
 *   channels: [...],
 *   queue,
 * });
 *
 * // Notifications are now queued before sending
 * await service.send({ event: 'user.created', ... });
 *
 * // For production, implement QueueAdapter with BullMQ:
 * // import { BullMQAdapter } from './your-bullmq-adapter';
 * // const queue = new BullMQAdapter({ connection: { host: 'redis' } });
 * ```
 */

import { randomUUID } from 'node:crypto';
import type { NotificationPayload } from '../types.js';

/** Status of a queued job */
export type QueueJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** A queued notification job */
export interface QueueJob {
  id: string;
  payload: NotificationPayload;
  status: QueueJobStatus;
  attempts: number;
  maxAttempts: number;
  retryDelay: number;
  maxRetryDelay: number;
  createdAt: Date;
  updatedAt: Date;
  error?: string;
}

/** Queue adapter interface — implement for BullMQ, Redis, DB, etc. */
export interface QueueAdapter {
  /**
   * Enqueue a notification for later processing.
   * Returns a job ID for tracking.
   */
  enqueue(payload: NotificationPayload, options?: QueueEnqueueOptions): string | Promise<string>;

  /**
   * Process queued jobs. Called by the service when queue is attached.
   * The processor function is the service's internal send pipeline.
   */
  process(processor: QueueProcessor): void | Promise<void>;

  /** Get job by ID */
  getJob(id: string): QueueJob | null | Promise<QueueJob | null>;

  /** Get queue size (pending + processing) */
  size(): number | Promise<number>;

  /** Pause processing */
  pause(): void | Promise<void>;

  /** Resume processing */
  resume(): void | Promise<void>;

  /** Drain the queue (remove all pending jobs) */
  drain(): void | Promise<void>;
}

/** Options for enqueuing a notification */
export interface QueueEnqueueOptions {
  /** Delay before processing (ms) */
  delay?: number;
  /** Max processing attempts (default: 3) */
  maxAttempts?: number;
  /**
   * Base delay in ms between retry attempts.
   * Actual delay uses exponential backoff with ±25% jitter:
   *   attempt 1 → retryDelay * 2^0 = retryDelay
   *   attempt 2 → retryDelay * 2^1
   *   attempt 3 → retryDelay * 2^2
   * Capped at `maxRetryDelay`. Default: 1000 (1 second).
   */
  retryDelay?: number;
  /** Maximum backoff delay cap in ms. Default: 30000 (30 seconds). */
  maxRetryDelay?: number;
}

/** Processor function called by the queue for each job */
export type QueueProcessor = (payload: NotificationPayload) => Promise<void>;

/** Generate a collision-free job ID (Node 18+ `crypto.randomUUID`). */
function generateId(): string {
  return `q-${randomUUID()}`;
}

/**
 * In-memory queue for development and testing.
 *
 * Jobs are processed immediately in FIFO order with concurrency control.
 * **Not crash-resilient** — use BullMQ or a database-backed adapter for production.
 */
export class MemoryQueue implements QueueAdapter {
  private jobs = new Map<string, QueueJob>();
  private pending: string[] = [];
  private processor: QueueProcessor | null = null;
  private paused = false;
  private readonly concurrency: number;
  private activeCount = 0;
  private delayTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly defaultRetryDelay: number;
  private readonly defaultMaxRetryDelay: number;

  constructor(options?: { concurrency?: number; retryDelay?: number; maxRetryDelay?: number }) {
    this.concurrency = options?.concurrency ?? 5;
    this.defaultRetryDelay = options?.retryDelay ?? 1_000;
    this.defaultMaxRetryDelay = options?.maxRetryDelay ?? 30_000;
  }

  enqueue(payload: NotificationPayload, options?: QueueEnqueueOptions): string {
    const id = generateId();
    const job: QueueJob = {
      id,
      payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
      retryDelay: options?.retryDelay ?? this.defaultRetryDelay,
      maxRetryDelay: options?.maxRetryDelay ?? this.defaultMaxRetryDelay,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.jobs.set(id, job);

    if (options?.delay) {
      const timer = setTimeout(() => {
        this.delayTimers.delete(id);
        this.pending.push(id);
        this.drain_queue();
      }, options.delay);
      this.delayTimers.set(id, timer);
    } else {
      this.pending.push(id);
      this.drain_queue();
    }

    return id;
  }

  process(processor: QueueProcessor): void {
    this.processor = processor;
    this.drain_queue();
  }

  getJob(id: string): QueueJob | null {
    return this.jobs.get(id) ?? null;
  }

  size(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'pending' || job.status === 'processing') count++;
    }
    return count;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.drain_queue();
  }

  /**
   * Drain the queue: cancel delayed timers and remove all not-yet-running
   * jobs from the pipeline.
   *
   * Semantics note: drained jobs (both delayed-but-unfired and pending) are
   * marked with status `'completed'`, NOT a distinct "drained"/"cancelled"
   * state — `QueueJobStatus` has no such value. So `'completed'` here means
   * "no longer in the queue", which is NOT the same as "delivered". Anything
   * that treats `completed` as proof of delivery (dashboards, metrics) should
   * read delivery success from the delivery log, not from queue job status.
   */
  drain(): void {
    // Cancel delayed timers so they don't fire after drain
    for (const timer of this.delayTimers.values()) {
      clearTimeout(timer);
    }
    // Mark delayed jobs that haven't entered pending yet as completed
    for (const [id] of this.delayTimers) {
      const job = this.jobs.get(id);
      if (job && job.status === 'pending') {
        job.status = 'completed';
        job.updatedAt = new Date();
      }
    }
    this.delayTimers.clear();

    // Mark pending jobs as completed
    for (const id of this.pending) {
      const job = this.jobs.get(id);
      if (job) {
        job.status = 'completed';
        job.updatedAt = new Date();
      }
    }
    this.pending = [];
  }

  /** Get all jobs (for testing/debugging) */
  getAllJobs(): QueueJob[] {
    return Array.from(this.jobs.values());
  }

  /** Clear all jobs and cancel all timers */
  clear(): void {
    for (const timer of this.delayTimers.values()) {
      clearTimeout(timer);
    }
    this.delayTimers.clear();
    this.jobs.clear();
    this.pending = [];
  }

  private drain_queue(): void {
    if (this.paused || !this.processor || this.pending.length === 0) return;

    while (this.activeCount < this.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift();
      if (!jobId) break;

      const job = this.jobs.get(jobId);
      if (!job || job.status !== 'pending') continue;

      this.activeCount++;
      job.status = 'processing';
      job.attempts++;
      job.updatedAt = new Date();

      this.processor(job.payload)
        .then(() => {
          job.status = 'completed';
          job.updatedAt = new Date();
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          job.error = message;
          job.updatedAt = new Date();
          if (job.attempts < job.maxAttempts) {
            // Exponential backoff with ±25% jitter to spread retry load.
            const base = Math.min(
              job.retryDelay * Math.pow(2, job.attempts - 1),
              job.maxRetryDelay,
            );
            const jitter = base * 0.25 * (Math.random() * 2 - 1);
            const delay = Math.max(0, Math.round(base + jitter));

            job.status = 'pending';
            const timer = setTimeout(() => {
              this.delayTimers.delete(jobId);
              this.pending.push(jobId);
              this.drain_queue();
            }, delay);
            this.delayTimers.set(jobId, timer);
          } else {
            job.status = 'failed';
          }
        })
        .finally(() => {
          this.activeCount--;
          this.drain_queue();
        });
    }
  }
}
