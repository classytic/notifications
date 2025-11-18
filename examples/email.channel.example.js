/**
 * Email Channel Example
 * Copy to your project and customize
 */

import { NotificationChannel } from '@classytic/notifications';

export class EmailChannel extends NotificationChannel {
  constructor(config = {}) {
    super(config);
    this.emailService = config.emailService;  // Your email service (Nodemailer, SendGrid, etc.)
    this.templates = config.templates || {};
  }

  async send({ event, recipient, data }) {
    if (!recipient.email) {
      return { status: 'skipped', reason: 'no_email' };
    }

    try {
      const template = this.templates[event];
      if (!template) {
        console.warn(`[EmailChannel] No template for event: ${event}`);
        return { status: 'skipped', reason: 'no_template' };
      }

      const { subject, html, text } = template(data);

      await this.emailService.send({
        to: recipient.email,
        subject,
        html,
        text,
      });

      return { status: 'sent', email: recipient.email };
    } catch (error) {
      console.error(`[EmailChannel] Failed:`, error.message);
      throw error;
    }
  }

  getSupportedEvents() {
    // Only send emails for whitelisted events (spam prevention)
    return this.config.events || [];
  }
}

