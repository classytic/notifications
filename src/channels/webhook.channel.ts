/**
 * Webhook Channel
 * @module @classytic/notifications
 *
 * Sends notifications via HTTP POST/PUT to any URL.
 * Supports HMAC-SHA256 payload signing for security.
 * Zero dependencies - uses native fetch.
 *
 * @example
 * ```typescript
 * import { WebhookChannel } from '@classytic/notifications/channels';
 *
 * // Slack webhook
 * const slack = new WebhookChannel({
 *   name: 'slack',
 *   url: 'https://hooks.slack.com/services/...',
 *   events: ['order.completed', 'user.created'],
 * });
 *
 * // Signed webhook
 * const hook = new WebhookChannel({
 *   url: 'https://api.partner.com/webhooks',
 *   secret: process.env.WEBHOOK_SECRET!,
 *   headers: { 'X-API-Key': process.env.PARTNER_KEY! },
 * });
 * ```
 */

import { BaseChannel } from './BaseChannel.js';
import { ChannelError } from '../utils/errors.js';
import type { WebhookChannelConfig, NotificationPayload, SendResult } from '../types.js';

export class WebhookChannel extends BaseChannel<WebhookChannelConfig> {
  constructor(config: WebhookChannelConfig) {
    super({ name: 'webhook', ...config });
  }

  async send(payload: NotificationPayload): Promise<SendResult> {
    const body = JSON.stringify({
      event: payload.event,
      recipient: payload.recipient,
      data: payload.data,
      metadata: payload.metadata,
      timestamp: new Date().toISOString(),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };

    // HMAC-SHA256 signature
    if (this.config.secret) {
      const crypto = await import('node:crypto');
      const signature = crypto
        .createHmac('sha256', this.config.secret)
        .update(body)
        .digest('hex');
      headers['X-Signature-256'] = `sha256=${signature}`;
    }

    try {
      const response = await fetch(this.config.url, {
        method: this.config.method ?? 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.config.timeout ?? 10_000),
      });

      if (!response.ok) {
        throw new ChannelError(
          this.name,
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      return { status: 'sent', channel: this.name };
    } catch (err) {
      if (err instanceof ChannelError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ChannelError(this.name, message, err instanceof Error ? err : undefined);
    }
  }
}
