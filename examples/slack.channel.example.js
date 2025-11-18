/**
 * Slack Channel Example
 * Webhook-based notifications for team alerts
 */

import { NotificationChannel } from '@classytic/notifications';

export class SlackChannel extends NotificationChannel {
  constructor(config = {}) {
    super(config);
    this.webhookUrl = config.webhookUrl;
  }

  async send({ event, data }) {
    if (!this.webhookUrl) {
      return { status: 'skipped', reason: 'no_webhook_url' };
    }

    try {
      const message = this.formatMessage(event, data);

      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });

      return { status: 'sent' };
    } catch (error) {
      console.error(`[SlackChannel] Failed:`, error.message);
      throw error;
    }
  }

  getSupportedEvents() {
    // Admin alerts only (payment failures, critical errors)
    return this.config.events || ['payment.failed'];
  }

  formatMessage(event, data) {
    return {
      text: `[${event}]`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${event}*\nAmount: ${data.amount} ${data.currency}`,
          },
        },
      ],
    };
  }
}

