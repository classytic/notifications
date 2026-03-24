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
}

/** Processor function called by the queue for each job */
export type QueueProcessor = (payload: NotificationPayload) => Promise<void>;

/** Generate a simple unique ID */
function generateId(): string {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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

  constructor(options?: { concurrency?: number }) {
    this.concurrency = options?.concurrency ?? 5;
  }

  enqueue(payload: NotificationPayload, options?: QueueEnqueueOptions): string {
    const id = generateId();
    const job: QueueJob = {
      id,
      payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
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
          if (job.attempts < job.maxAttempts) {
            job.status = 'pending';
            job.error = message;
            job.updatedAt = new Date();
            this.pending.push(jobId);
          } else {
            job.status = 'failed';
            job.error = message;
            job.updatedAt = new Date();
          }
        })
        .finally(() => {
          this.activeCount--;
          this.drain_queue();
        });
    }
  }
}
