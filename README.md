# @classytic/notifications

> Multi-channel notification system for event-driven applications

Framework-agnostic, pluggable notification dispatcher with zero dependencies. Send notifications to Email, Push, SMS, In-App, Slack, or any custom channel from a single event.

## Features

- ✅ **Multi-Channel** - Email, Push, SMS, In-App, Slack, Discord, etc.
- ✅ **Framework-Agnostic** - Works with Express, Fastify, NestJS, Next.js
- ✅ **Zero Dependencies** - Pure JavaScript, no external deps
- ✅ **Event-Driven** - Integrate with any event system (hooks, EventEmitter)
- ✅ **Pluggable** - Add custom channels by extending base class
- ✅ **Spam Prevention** - Per-channel event whitelists
- ✅ **Fire-and-Forget** - Non-blocking, error-safe
- ✅ **TypeScript Ready** - Full type definitions (coming soon)

## Installation

```bash
npm install @classytic/notifications
```

## Quick Start

### 1. Create a Channel

```javascript
import { NotificationChannel } from '@classytic/notifications';

class EmailChannel extends NotificationChannel {
  async send({ event, recipient, data }) {
    if (!recipient.email) {
      return { status: 'skipped', reason: 'no_email' };
    }

    await yourEmailService.send({
      to: recipient.email,
      subject: `Event: ${event}`,
      body: `Amount: ${data.amount}`,
    });

    return { status: 'sent' };
  }

  getSupportedEvents() {
    // Whitelist events (empty = all events)
    return ['payment.verified', 'payment.failed'];
  }
}
```

### 2. Configure Notifications

```javascript
import { createNotificationHandlers } from '@classytic/notifications';

const channels = [
  new EmailChannel({ enabled: true }),
];

const configs = [
  {
    event: 'payment.verified',
    enabled: true,
    getRecipient: async ({ transaction }) => ({ 
      email: transaction.customerEmail 
    }),
    getTemplateData: ({ transaction }) => ({ 
      amount: transaction.amount 
    }),
  },
];

const handlers = createNotificationHandlers(configs, channels);
```

### 3. Use with Your Event System

**With @classytic/revenue:**
```javascript
import { createRevenue } from '@classytic/revenue';
import { mergeHooks } from '@classytic/notifications';

const revenue = createRevenue({
  hooks: mergeHooks(
    loggingHooks,
    createNotificationHandlers(configs, channels)
  ),
});
```

**With EventEmitter:**
```javascript
import EventEmitter from 'events';

const emitter = new EventEmitter();

Object.entries(handlers).forEach(([event, fns]) => {
  fns.forEach(fn => emitter.on(event, fn));
});

emitter.emit('payment.verified', { transaction });
```

**With Custom Hooks:**
```javascript
const hooks = createNotificationHandlers(configs, channels);

// Later in your code:
for (const handler of hooks['payment.verified']) {
  await handler(eventData);
}
```

## API Reference

### NotificationChannel

Base class for all channels.

```javascript
class MyChannel extends NotificationChannel {
  async send({ event, recipient, data }) {
    // Implement notification logic
    return { status: 'sent' };
  }

  getSupportedEvents() {
    return ['event1', 'event2']; // Or [] for all events
  }
}
```

### createDispatcher(channels)

Creates dispatcher function.

```javascript
const dispatcher = createDispatcher([emailChannel, pushChannel]);
await dispatcher(event, eventData, recipientResolver, dataExtractor);
```

### createNotificationHandlers(configs, channels)

Creates notification handlers from configurations.

```javascript
const handlers = createNotificationHandlers(
  [{ event: 'user.created', getRecipient: ..., getTemplateData: ... }],
  [new EmailChannel()]
);
// Returns: { 'user.created': [Function] }
```

### mergeHooks(...hookConfigs)

Merges multiple hook configurations.

```javascript
const combined = mergeHooks(
  { 'event1': [handler1] },
  { 'event1': [handler2], 'event2': [handler3] }
);
// Returns: { 'event1': [handler1, handler2], 'event2': [handler3] }
```

## Built-in Channels

This library provides the **core system only**. Channels are intentionally kept separate for flexibility.

**Reference implementations:**
- Email (Nodemailer, SendGrid, AWS SES)
- Push (Firebase, OneSignal, Pusher)
- SMS (Twilio, AWS SNS, Vonage)
- In-App (Database storage)
- Slack/Discord (Webhooks)

See `/examples` directory for channel implementations.

## Advanced Usage

### Spam Prevention

```javascript
new EmailChannel({
  enabled: true,
  events: [
    'payment.verified',  // ✅ Send
    'payment.failed',    // ✅ Send
    // 'user.login',     // ❌ Don't send (too frequent)
  ],
})
```

### Multi-Provider Setup

```javascript
const channels = [
  new EmailChannel({ events: ['payment.verified', 'payment.failed'] }),
  new PushChannel({ events: ['payment.verified'] }),  // Real-time only
  new InAppChannel({ events: [] }),  // All events (history)
  new SlackChannel({ events: ['payment.failed'] }),  // Admin alerts
];
```

### Conditional Sending

```javascript
{
  event: 'payment.verified',
  enabled: process.env.NODE_ENV === 'production',
  getRecipient: async ({ transaction }) => {
    // Custom logic
    if (transaction.amount < 1000) return null;  // Skip small transactions
    return getCustomer(transaction.customerId);
  },
}
```

## Examples

See `examples/` directory for:
- Email channel (Nodemailer)
- Push channel (Firebase)
- SMS channel (Twilio)
- Slack channel (Webhooks)
- In-app notifications (MongoDB)

## Framework Integration

### Express
```javascript
app.post('/webhook', async (req, res) => {
  const handlers = notificationHandlers['payment.verified'];
  for (const handler of handlers) {
    await handler(req.body);
  }
  res.json({ success: true });
});
```

### Fastify
```javascript
fastify.post('/webhook', async (request, reply) => {
  const handlers = notificationHandlers['payment.verified'];
  for (const handler of handlers) {
    await handler(request.body);
  }
  reply.send({ success: true });
});
```

### NestJS
```javascript
@Post('webhook')
async handleWebhook(@Body() data) {
  const handlers = this.notificationHandlers['payment.verified'];
  for (const handler of handlers) {
    await handler(data);
  }
}
```

## Design Philosophy

- **KISS** - Simple core, powerful extensions
- **DRY** - One dispatcher, many channels
- **YAGNI** - No unused features
- **Open/Closed** - Open for extension, closed for modification

## License

MIT © Classytic

## Related Packages

- `@classytic/revenue` - Revenue management system (perfect pair)
- `@classytic/mongokit` - MongoDB repository pattern

