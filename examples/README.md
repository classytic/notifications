# Channel Examples

Copy these to your project and customize.

## Available Examples

### Email Channel
- `email.channel.example.js` - Works with Nodemailer, SendGrid, AWS SES
- Requires: email service, templates
- Use for: Payment confirmations, important updates

### Push Channel
- `push.channel.example.js` - Works with Firebase FCM, OneSignal, Pusher
- Requires: push service, device tokens
- Use for: Real-time alerts, urgent notifications

### Slack Channel
- `slack.channel.example.js` - Webhook-based team alerts
- Requires: Slack webhook URL
- Use for: Admin alerts, error notifications

## Usage

1. Copy channel to your project
2. Install dependencies (nodemailer, firebase-admin, etc.)
3. Customize templates/formatting
4. Register in your notification config

```javascript
import { EmailChannel } from './channels/email.channel.js';
import { createNotificationHandlers } from '@classytic/notifications';

const channels = [
  new EmailChannel({
    enabled: true,
    emailService: yourEmailService,
    templates: yourTemplates,
    events: ['payment.verified', 'payment.failed'],
  }),
];

const handlers = createNotificationHandlers(configs, channels);
```

## Creating Custom Channels

```javascript
import { NotificationChannel } from '@classytic/notifications';

class MyChannel extends NotificationChannel {
  async send({ event, recipient, data }) {
    // Your implementation
    return { status: 'sent' };
  }

  getSupportedEvents() {
    return this.config.events || [];
  }
}
```

See package README for full documentation.

