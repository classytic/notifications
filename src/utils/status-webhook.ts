/**
 * Status Webhook Handler
 * @module @classytic/notifications/utils
 *
 * Ingest delivery status updates from providers (Twilio, SES, SendGrid, etc.)
 * into a normalized timeline. Provider-agnostic: you write a small mapper
 * from the provider's webhook payload to our normalized status.
 *
 * Use `onStatusChange` to persist updates to your own storage (DB, delivery log, etc.).
 *
 * @example
 * ```typescript
 * import { createStatusHandler } from '@classytic/notifications/utils';
 *
 * const handler = createStatusHandler({
 *   onStatusChange: async (update) => {
 *     // Persist to your DB, delivery log, metrics, etc.
 *     await db.notificationStatuses.insert(update);
 *     console.log(`${update.channel} ${update.notificationId}: ${update.status}`);
 *   },
 * });
 *
 * // In your Express/Fastify route:
 * app.post('/webhooks/twilio', (req, res) => {
 *   handler.handle({
 *     provider: 'twilio',
 *     notificationId: req.body.MessageSid,
 *     channel: 'sms',
 *     status: mapTwilioStatus(req.body.MessageStatus),
 *     rawPayload: req.body,
 *     timestamp: new Date(),
 *   });
 *   res.sendStatus(200);
 * });
 * ```
 */

/** Normalized delivery status across all providers */
export type DeliveryStatus =
  | 'queued'
  | 'accepted'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'bounced'
  | 'opened'
  | 'clicked'
  | 'complained'
  | 'unsubscribed';

/** A normalized status update from a provider webhook */
export interface StatusUpdate {
  /** Provider name (e.g., 'twilio', 'ses', 'sendgrid', 'fcm') */
  provider: string;
  /** Notification or message ID from the provider */
  notificationId: string;
  /** Channel name (e.g., 'sms', 'email', 'push') */
  channel: string;
  /** Normalized delivery status */
  status: DeliveryStatus;
  /** When the status change occurred */
  timestamp: Date;
  /** Error message (for undelivered/bounced) */
  error?: string;
  /** Raw webhook payload from the provider (for debugging) */
  rawPayload?: unknown;
  /** Recipient identifier (email, phone, token) */
  recipient?: string;
}

/** Configuration for the status handler */
export interface StatusHandlerConfig {
  /** Called on every status update */
  onStatusChange?: (update: StatusUpdate) => void | Promise<void>;
}

/** Status handler instance */
export interface StatusHandler {
  /** Process a normalized status update */
  handle(update: StatusUpdate): Promise<void>;
  /** Get all recorded status updates (for testing/debugging) */
  getUpdates(): StatusUpdate[];
  /** Get updates for a specific notification */
  getUpdatesFor(notificationId: string): StatusUpdate[];
}

/**
 * Create a status webhook handler.
 *
 * Collects delivery status updates from provider webhooks.
 * You normalize the provider's payload into a `StatusUpdate` and call `handle()`.
 */
export function createStatusHandler(config: StatusHandlerConfig = {}): StatusHandler {
  const updates: StatusUpdate[] = [];

  return {
    async handle(update: StatusUpdate): Promise<void> {
      updates.push(update);
      if (config.onStatusChange) {
        await config.onStatusChange(update);
      }
    },

    getUpdates(): StatusUpdate[] {
      return [...updates];
    },

    getUpdatesFor(notificationId: string): StatusUpdate[] {
      return updates.filter(u => u.notificationId === notificationId);
    },
  };
}
