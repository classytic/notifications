/**
 * Push Notification Channel Example
 * Works with Firebase FCM, OneSignal, Pusher, etc.
 */

import { NotificationChannel } from '@classytic/notifications';

export class PushChannel extends NotificationChannel {
  constructor(config = {}) {
    super(config);
    this.pushService = config.pushService;  // Firebase, OneSignal, etc.
  }

  async send({ event, recipient, data }) {
    if (!recipient.deviceTokens || !recipient.deviceTokens.length) {
      return { status: 'skipped', reason: 'no_device_tokens' };
    }

    try {
      await this.pushService.send({
        tokens: recipient.deviceTokens,
        notification: {
          title: this.getTitle(event),
          body: this.getBody(event, data),
        },
        data,
      });

      return { status: 'sent', devices: recipient.deviceTokens.length };
    } catch (error) {
      console.error(`[PushChannel] Failed:`, error.message);
      throw error;
    }
  }

  getSupportedEvents() {
    // Real-time events only
    return this.config.events || [];
  }

  getTitle(event) {
    const titles = {
      'payment.verified': 'Payment Confirmed',
      'payment.failed': 'Payment Failed',
    };
    return titles[event] || 'Notification';
  }

  getBody(event, data) {
    return `Amount: ${data.amount} ${data.currency}`;
  }
}

