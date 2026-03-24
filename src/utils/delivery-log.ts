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

import type { DispatchResult, NotificationPayload, SendResult } from '../types.js';

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
  status: 'delivered' | 'partial' | 'failed';
  /** Total duration in ms */
  duration: number;
  /** Original payload metadata */
  metadata?: Record<string, unknown>;
}

/** Query filter for delivery log entries */
export interface DeliveryLogQuery {
  recipientId?: string;
  recipientEmail?: string;
  event?: string;
  channel?: string;
  status?: 'delivered' | 'partial' | 'failed';
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

/** Generate a simple unique ID */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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

  private resolveStatus(dispatch: DispatchResult): 'delivered' | 'partial' | 'failed' {
    if (dispatch.sent > 0 && dispatch.failed === 0) return 'delivered';
    if (dispatch.sent > 0 && dispatch.failed > 0) return 'partial';
    return 'failed';
  }
}
