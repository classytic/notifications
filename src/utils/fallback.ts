/**
 * Channel Fallback Strategy
 * @module @classytic/notifications/utils
 *
 * Try channels in priority order, stopping at the first success.
 * Example: try push -> SMS -> email.
 *
 * Compatible with both direct and queued delivery:
 * - Direct: stops when `result.sent > 0`
 * - Queued: stops when the notification is accepted by the queue
 *   (result has no failures and no results — meaning it was enqueued)
 *
 * @example
 * ```typescript
 * import { NotificationService } from '@classytic/notifications';
 * import { EmailChannel, SmsChannel, PushChannel } from '@classytic/notifications/channels';
 * import { withFallback } from '@classytic/notifications/utils';
 *
 * const service = new NotificationService({
 *   channels: [
 *     new PushChannel({ provider: pushProvider }),
 *     new SmsChannel({ from: '+1555...', provider: smsProvider }),
 *     new EmailChannel({ from: 'noreply@app.com', transport: { ... } }),
 *   ],
 * });
 *
 * // Try push first, fall back to SMS, then email
 * const result = await withFallback(service, payload, ['push', 'sms', 'email']);
 * ```
 */

import type { NotificationPayload, DispatchResult } from '../types.js';

/** Service-like object that can send to specific channels */
interface Sendable {
  send(payload: NotificationPayload): Promise<DispatchResult>;
}

/** Options for fallback behavior */
export interface FallbackOptions {
  /** Called when a channel fails and falls through to the next */
  onFallback?: (failedChannel: string, error: string, nextChannel: string) => void;
}

/**
 * A dispatch was accepted — either sent directly or enqueued.
 *
 * Direct mode: `sent > 0` means at least one channel delivered.
 * Queue mode: `queued === true` means the job was accepted by the queue.
 */
function wasAccepted(result: DispatchResult): boolean {
  return result.sent > 0 || result.queued === true;
}

/**
 * Try channels in priority order, stopping at the first successful delivery.
 *
 * Sends to one channel at a time. If it fails or is skipped (rate limited,
 * no recipient field, etc.), tries the next channel in the list.
 * Returns the result from the first channel that succeeds, or the
 * last channel's result if all fail.
 *
 * Works with both direct and queued delivery modes.
 *
 * @param service - NotificationService instance
 * @param payload - Notification payload (channels field is overridden per attempt)
 * @param channelOrder - Channel names in priority order (e.g., ['push', 'sms', 'email'])
 * @param options - Fallback behavior options
 * @returns DispatchResult from the first accepted channel, or last failure
 */
export async function withFallback(
  service: Sendable,
  payload: NotificationPayload,
  channelOrder: string[],
  options?: FallbackOptions,
): Promise<DispatchResult> {
  if (channelOrder.length === 0) {
    return {
      event: payload.event,
      results: [],
      sent: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
    };
  }

  let lastResult: DispatchResult | undefined;

  for (let i = 0; i < channelOrder.length; i++) {
    const channelName = channelOrder[i];
    const result = await service.send({
      ...payload,
      channels: [channelName],
    });

    if (wasAccepted(result)) {
      return result;
    }

    lastResult = result;

    // Notify about fallback
    if (i < channelOrder.length - 1 && options?.onFallback) {
      const error = result.results[0]?.error ?? 'No successful delivery';
      options.onFallback(channelName, error, channelOrder[i + 1]);
    }
  }

  return lastResult!;
}
