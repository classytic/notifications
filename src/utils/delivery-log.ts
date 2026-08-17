/**
 * Delivery Log / Audit Trail
 * @module @classytic/notifications/utils
 *
 * Tracks what was sent to whom, when, and via which channel.
 * Ships with an in-memory store; implement DeliveryLog for
 * database-backed persistence.
 *
 * @example
 * ```typescript
 * import { NotificationService } from '@classytic/notifications';
 * import { MemoryDeliveryLog } from '@classytic/notifications/utils';
 *
 * const log = new MemoryDeliveryLog();
 * const service = new NotificationService({
 *   channels: [...],
 *   deliveryLog: log,
 * });
 *
 * // Query delivery history
 * const entries = log.query({ recipientId: 'u1', event: 'user.created' });
 * ```
 */

import { randomUUID } from 'node:crypto';
import type { DispatchResult, NotificationPayload, NotificationSubject, SendResult } from '../types.js';

/** A single delivery log entry */
export interface DeliveryLogEntry {
  /** Unique log entry ID */
  id: string;
  /** Timestamp of the delivery attempt */
  timestamp: Date;
  /** Event name */
  event: string;
  /** Recipient ID (if available) */
  recipientId?: string;
  /** Recipient email (if available) */
  recipientEmail?: string;
  /** Channels attempted */
  channels: string[];
  /** Per-channel results */
  results: SendResult[];
  /** Overall status */
  status: 'delivered' | 'partial' | 'failed' | 'skipped';
  /** Total duration in ms */
  duration: number;
  /** Original payload metadata */
  metadata?: Record<string, unknown>;
  /**
   * The business document this delivery was about (see
   * `NotificationPayload.subject`). Carried verbatim so a store can index it —
   * this is what makes "every message sent about invoice X" a keyed read.
   */
  subject?: NotificationSubject;
}

/** Query filter for delivery log entries */
export interface DeliveryLogQuery {
  recipientId?: string;
  recipientEmail?: string;
  event?: string;
  /**
   * Filter to one business document. A store MUST support this as an indexed
   * read — a `metadata` scan would work at ten rows and time out at ten million,
   * which is the version of "supported" that fails only in production.
   */
  subject?: NotificationSubject;
  channel?: string;
  status?: 'delivered' | 'partial' | 'failed' | 'skipped';
  /** Only entries after this date */
  after?: Date;
  /** Only entries before this date */
  before?: Date;
  /** Max entries to return (default: 100) */
  limit?: number;
}

/** Interface for pluggable delivery log stores (MongoDB, Postgres, etc.) */
export interface DeliveryLog {
  /** Record a delivery attempt */
  record(payload: NotificationPayload, dispatch: DispatchResult): void | Promise<void>;
  /** Query delivery history */
  query(filter: DeliveryLogQuery): DeliveryLogEntry[] | Promise<DeliveryLogEntry[]>;
  /** Get a specific log entry by ID */
  get(id: string): DeliveryLogEntry | null | Promise<DeliveryLogEntry | null>;
}

/** Generate a collision-free log entry ID (Node 18+ `crypto.randomUUID`). */
function generateId(): string {
  return randomUUID();
}

/**
 * In-memory delivery log with query support.
 *
 * Keeps entries in memory with optional max size (evicts oldest).
 * For production, implement `DeliveryLog` with your database.
 */
export class MemoryDeliveryLog implements DeliveryLog {
  private entries: DeliveryLogEntry[] = [];
  private readonly maxEntries: number;

  constructor(options?: { maxEntries?: number }) {
    this.maxEntries = options?.maxEntries ?? 10_000;
  }

  record(payload: NotificationPayload, dispatch: DispatchResult): void {
    const entry: DeliveryLogEntry = {
      id: generateId(),
      timestamp: new Date(),
      event: dispatch.event,
      recipientId: payload.recipient.id,
      recipientEmail: payload.recipient.email,
      channels: dispatch.results.map(r => r.channel),
      results: dispatch.results,
      status: this.resolveStatus(dispatch),
      duration: dispatch.duration,
      metadata: payload.metadata,
      ...(payload.subject ? { subject: payload.subject } : {}),
    };

    this.entries.push(entry);

    // Evict oldest if over limit
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  query(filter: DeliveryLogQuery): DeliveryLogEntry[] {
    const limit = filter.limit ?? 100;
    let results = this.entries;

    if (filter.recipientId) {
      results = results.filter(e => e.recipientId === filter.recipientId);
    }
    if (filter.recipientEmail) {
      results = results.filter(e => e.recipientEmail === filter.recipientEmail);
    }
    if (filter.event) {
      results = results.filter(e => e.event === filter.event);
    }
    if (filter.subject) {
      const { sourceModel, sourceId } = filter.subject;
      // BOTH parts, always. Matching on id alone would collide across models
      // the moment two collections share an ObjectId space.
      results = results.filter(
        e => e.subject?.sourceModel === sourceModel && e.subject?.sourceId === sourceId,
      );
    }
    if (filter.channel) {
      results = results.filter(e => e.channels.includes(filter.channel!));
    }
    if (filter.status) {
      results = results.filter(e => e.status === filter.status);
    }
    if (filter.after) {
      const after = filter.after.getTime();
      results = results.filter(e => e.timestamp.getTime() >= after);
    }
    if (filter.before) {
      const before = filter.before.getTime();
      results = results.filter(e => e.timestamp.getTime() <= before);
    }

    // Return newest first, limited
    return results.slice(-limit).reverse();
  }

  get(id: string): DeliveryLogEntry | null {
    return this.entries.find(e => e.id === id) ?? null;
  }

  /** Get total number of entries */
  get size(): number {
    return this.entries.length;
  }

  /** Clear all entries */
  clear(): void {
    this.entries = [];
  }

  private resolveStatus(dispatch: DispatchResult): 'delivered' | 'partial' | 'failed' | 'skipped' {
    if (dispatch.sent > 0 && dispatch.failed === 0) return 'delivered';
    if (dispatch.sent > 0 && dispatch.failed > 0) return 'partial';
    // All channels skipped (quiet hours, preferences, rate limit, no recipient) —
    // not a failure; the notification was intentionally suppressed.
    if (dispatch.failed === 0 && dispatch.skipped > 0) return 'skipped';
    return 'failed';
  }
}
