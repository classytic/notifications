# @classytic/notifications

> Multi-channel notification system for TypeScript/Node.js

Pluggable channels, templates, retry with backoff, rate limiting, delivery tracking, and user preferences. Zero required dependencies — bring your own providers.

## Features

- **Multi-Channel** — Email, SMS, Push, Webhook, Console, or build your own
- **Zero Required Deps** — Nodemailer is the only optional peer dep; SMS/Push use BYOP (Bring Your Own Provider)
- **Rate Limiting** — Per-channel token bucket (e.g., Gmail 500/day, SendGrid 100/sec)
- **Delivery Tracking** — Built-in audit log for every send attempt (sent, skipped, failed)
- **Queue Adapter** — Crash-resilient delivery with pluggable queue backends
- **Templates** — Built-in `${var}` interpolation or plug any engine (React Email, MJML, etc.)
- **Retry + Backoff** — Exponential, linear, or fixed backoff with jitter. Per-channel overrides
- **User Preferences** — Per-user, per-event, per-channel opt-in/out with quiet hours
- **Idempotency** — Built-in deduplication with pluggable stores (memory, Redis, DB)
- **Lifecycle Events** — `before:send`, `after:send`, `send:success`, `send:failed`, `send:retry`, `send:rate_limited`, `send:queued`
- **Hook Factories** — Generate event handlers for EventEmitter, MongoKit, or any hook system
- **TypeScript** — Full type definitions, ESM-only

## Installation

```bash
npm install @classytic/notifications
```

**For EmailChannel** (optional — only if you use email):

```bash
npm install nodemailer
```

## Quick Start

```typescript
import { NotificationService } from '@classytic/notifications';
import { EmailChannel, SmsChannel, PushChannel, ConsoleChannel } from '@classytic/notifications/channels';
import { MemoryDeliveryLog, createSimpleResolver } from '@classytic/notifications/utils';

const notifications = new NotificationService({
  channels: [
    new EmailChannel({
      from: 'App <noreply@app.com>',
      transport: { host: 'smtp.gmail.com', port: 587, auth: { user, pass } },
      rateLimit: { maxPerWindow: 500, windowMs: 86_400_000 }, // Gmail 500/day
    }),
    new SmsChannel({
      from: '+15551234567',
      provider: {
        send: async ({ to, from, body }) => {
          const msg = await twilioClient.messages.create({ to, from, body });
          return { sid: msg.sid };
        },
      },
    }),
    new PushChannel({
      provider: {
        send: async ({ token, title, body, data }) => {
          const result = await admin.messaging().send({ token, notification: { title, body }, data });
          return { messageId: result };
        },
      },
    }),
    new ConsoleChannel(), // dev/testing
  ],
  templates: createSimpleResolver({
    welcome: {
      subject: 'Welcome, ${name}!',
      html: '<h1>Hi ${name}</h1><p>Thanks for joining.</p>',
    },
  }),
  retry: { maxAttempts: 3, backoff: 'exponential' },
  deliveryLog: new MemoryDeliveryLog(),
});

await notifications.send({
  event: 'user.created',
  recipient: { email: 'user@example.com', phone: '+15559876543', name: 'John' },
  data: { name: 'John' },
  template: 'welcome',
});
```

## Channels

### EmailChannel (Nodemailer)

Requires: `npm install nodemailer`

```typescript
import { EmailChannel } from '@classytic/notifications/channels';

// SMTP
const email = new EmailChannel({
  from: 'App <noreply@app.com>',
  transport: { host: 'smtp.gmail.com', port: 587, auth: { user, pass } },
  rateLimit: { maxPerWindow: 500, windowMs: 86_400_000 }, // Gmail 500/day
});

// Gmail shorthand
const gmail = new EmailChannel({
  from: 'noreply@app.com',
  transport: { service: 'gmail', auth: { user, pass } },
});

// Pre-created transporter (SES, custom)
import nodemailer from 'nodemailer';
const email = new EmailChannel({
  from: 'noreply@app.com',
  transporter: nodemailer.createTransport({ /* SES config */ }),
});
```

### SmsChannel (BYOP)

Zero dependencies — bring your own SMS SDK.

```typescript
import { SmsChannel } from '@classytic/notifications/channels';

// Twilio
import twilio from 'twilio';
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

const sms = new SmsChannel({
  from: '+15551234567',
  provider: {
    send: async ({ to, from, body }) => {
      const msg = await client.messages.create({ to, from, body });
      return { sid: msg.sid };
    },
  },
});

// AWS SNS
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
const sns = new SNSClient({ region: 'us-east-1' });

const snsSms = new SmsChannel({
  from: 'MyApp',
  provider: {
    send: async ({ to, body }) => {
      const res = await sns.send(new PublishCommand({ PhoneNumber: to, Message: body }));
      return { sid: res.MessageId ?? '' };
    },
  },
});
```

### PushChannel (BYOP)

Zero dependencies — bring your own push SDK.

```typescript
import { PushChannel } from '@classytic/notifications/channels';

// Firebase Cloud Messaging
import admin from 'firebase-admin';

const push = new PushChannel({
  provider: {
    send: async ({ token, title, body, data }) => {
      const result = await admin.messaging().send({
        token,
        notification: { title, body },
        data,
      });
      return { messageId: result };
    },
  },
});

// Expo Push
import { Expo } from 'expo-server-sdk';
const expo = new Expo();

const expoPush = new PushChannel({
  name: 'expo-push',
  provider: {
    send: async ({ token, title, body, data }) => {
      const [receipt] = await expo.sendPushNotificationsAsync([
        { to: token, title, body, data },
      ]);
      return { messageId: receipt.id };
    },
  },
});
```

### WebhookChannel

Zero dependencies — uses native `fetch`.

```typescript
import { WebhookChannel } from '@classytic/notifications/channels';

const slack = new WebhookChannel({
  url: 'https://hooks.slack.com/services/...',
  events: ['order.completed', 'user.created'],
});

// With HMAC-SHA256 signing
const signed = new WebhookChannel({
  url: 'https://api.partner.com/webhooks',
  secret: process.env.WEBHOOK_SECRET!,
  headers: { 'X-API-Key': process.env.PARTNER_KEY! },
  timeout: 5000,
});
```

### ConsoleChannel

Logs to console. Useful for development and testing.

```typescript
import { ConsoleChannel } from '@classytic/notifications/channels';

const dev = new ConsoleChannel();
const scoped = new ConsoleChannel({ events: ['user.*'] });
```

### Custom Channels

Extend `BaseChannel` or implement the `Channel` interface directly:

```typescript
import { BaseChannel } from '@classytic/notifications/channels';
import type { NotificationPayload, SendResult, ChannelConfig } from '@classytic/notifications';

interface SlackConfig extends ChannelConfig {
  webhookUrl: string;
}

class SlackChannel extends BaseChannel<SlackConfig> {
  constructor(config: SlackConfig) {
    super({ name: 'slack', ...config });
  }

  async send(payload: NotificationPayload): Promise<SendResult> {
    const res = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(payload.data.message) }),
    });
    if (!res.ok) return { status: 'failed', channel: this.name, error: res.statusText };
    return { status: 'sent', channel: this.name };
  }
}
```

## Rate Limiting

Prevent exceeding provider limits with per-channel rate limiting:

```typescript
new EmailChannel({
  from: 'noreply@app.com',
  transport: { service: 'gmail', auth: { user, pass } },
  rateLimit: {
    maxPerWindow: 500,        // max 500 emails
    windowMs: 86_400_000,     // per 24 hours
  },
});
```

Rate-limited sends return `status: 'skipped'` with `error: 'Rate limited'` and emit a `send:rate_limited` event. The built-in `MemoryRateLimitStore` is created automatically. For distributed systems, implement `RateLimitStore`:

```typescript
import type { RateLimitStore, RateLimitConfig } from '@classytic/notifications/utils';

class RedisRateLimitStore implements RateLimitStore {
  async consume(channel: string, config: RateLimitConfig): Promise<boolean> {
    // Sliding window rate limiter with Redis
  }
  async remaining(channel: string, config: RateLimitConfig): Promise<number> { /* ... */ }
  async reset(channel: string): Promise<void> { /* ... */ }
}

const service = new NotificationService({
  channels: [...],
  rateLimitStore: new RedisRateLimitStore(),
});
```

## Delivery Tracking

Every notification attempt — sent, skipped, or failed — is logged:

```typescript
import { MemoryDeliveryLog } from '@classytic/notifications/utils';

const log = new MemoryDeliveryLog();
const service = new NotificationService({
  channels: [...],
  deliveryLog: log,
});

// Query history
const entries = log.query({
  recipientId: 'u1',
  event: 'user.created',
  status: 'delivered',
  after: new Date('2026-01-01'),
  limit: 50,
});

// Get a specific entry
const entry = log.get(entries[0].id);
```

For production, implement `DeliveryLog` with your database:

```typescript
import type { DeliveryLog } from '@classytic/notifications/utils';

class MongoDeliveryLog implements DeliveryLog {
  async record(payload, dispatch) { /* insert to MongoDB */ }
  async query(filter) { /* query MongoDB */ }
  async get(id) { /* findById */ }
}
```

## Queue Adapter

For crash-resilient delivery, attach a queue. The service owns the queue — it calls `process()` on construction. When configured, `send()` enqueues and returns immediately:

```typescript
import { MemoryQueue } from '@classytic/notifications/utils';

const service = new NotificationService({
  channels: [...],
  queue: new MemoryQueue(),
});

// Sends are now queued and processed async
await service.send({ ... }); // Returns immediately with { queued: true }
```

> **Note:** If your app already has its own queue (BullMQ, SQS, etc.), don't pass it here. The service owns its queue. Instead, have your existing worker call `service.send()` directly when it picks up a job.

For production, implement `QueueAdapter` with BullMQ, Redis, or your database:

```typescript
import type { QueueAdapter } from '@classytic/notifications/utils';

class BullMQAdapter implements QueueAdapter {
  async enqueue(payload, options?) { /* add to BullMQ */ }
  async process(processor) { /* worker.on('job', ...) */ }
  async getJob(id) { /* ... */ }
  size() { /* ... */ }
  pause() { /* ... */ }
  resume() { /* ... */ }
  drain() { /* ... */ }
}
```

## Scheduled / Delayed Delivery

Add `delay` (milliseconds) to any payload. Requires a queue adapter:

```typescript
// Send reminder in 1 hour
await service.send({
  event: 'interview.reminder',
  recipient: { email: 'candidate@example.com' },
  data: { subject: 'Interview in 1 hour' },
  delay: 3_600_000,
});
```

Without a queue adapter, `delay` is ignored with a warning log.

> **For long-delay scheduling** (days/weeks), use a persistent queue backend (BullMQ with Redis) or a workflow engine like `@classytic/streamline` which survives process restarts.

## Channel Fallback

Try channels in priority order, stopping at the first success:

```typescript
import { withFallback } from '@classytic/notifications/utils';

// Try push first, fall back to SMS, then email
const result = await withFallback(service, payload, ['push', 'sms', 'email'], {
  onFallback: (failed, error, next) => {
    console.log(`${failed} failed (${error}), trying ${next}`);
  },
});
```

Works with both direct and queued delivery. In queue mode, the first accepted enqueue stops the fallback (no duplicate jobs).

## Status Webhook Handler

Ingest delivery status updates from providers (Twilio, SES, SendGrid, FCM):

```typescript
import { createStatusHandler } from '@classytic/notifications/utils';

const handler = createStatusHandler({
  onStatusChange: async (update) => {
    // Persist to your DB, metrics, delivery log, etc.
    await db.notificationStatuses.insert(update);
  },
});

// In your Express/Fastify route:
app.post('/webhooks/twilio', (req, res) => {
  handler.handle({
    provider: 'twilio',
    notificationId: req.body.MessageSid,
    channel: 'sms',
    status: mapTwilioStatus(req.body.MessageStatus), // from examples/providers.ts
    timestamp: new Date(),
    rawPayload: req.body,
  });
  res.sendStatus(200);
});
```

**Delivery statuses:** `queued` | `accepted` | `sent` | `delivered` | `undelivered` | `bounced` | `opened` | `clicked` | `complained` | `unsubscribed`

## Templates

### Built-in Simple Resolver

Zero-dependency `${var}` interpolation with nested access:

```typescript
import { createSimpleResolver } from '@classytic/notifications/utils';

const service = new NotificationService({
  templates: createSimpleResolver({
    welcome: {
      subject: 'Welcome, ${name}!',
      html: '<h1>Hi ${name}</h1><p>From ${company}.</p>',
    },
    'order-confirmation': {
      subject: 'Order #${orderId} confirmed',
      html: '<p>Hi ${user.name}, your ${total} order is confirmed.</p>',
    },
  }),
});
```

### Custom Template Engine

Plug any engine via the `TemplateResolver` interface:

```typescript
// React Email
import { render } from '@react-email/render';
import WelcomeEmail from './emails/welcome';

const service = new NotificationService({
  templates: async (id, data) => {
    if (id === 'welcome') {
      return { subject: `Welcome ${data.name}!`, html: render(WelcomeEmail(data)) };
    }
    throw new Error(`Unknown template: ${id}`);
  },
});
```

## User Preferences

Filter channels per-user with a preference resolver:

```typescript
const notifications = new NotificationService({
  preferences: async (recipientId, event) => {
    const prefs = await db.getUserPrefs(recipientId);
    return {
      channels: { email: true, sms: false },        // opt-out of SMS
      events: { 'marketing.promo': false },          // opt-out of promos
      quiet: {
        start: '22:00',
        end: '07:00',
        timezone: 'America/New_York',
      },
    };
  },
});
```

## Idempotency / Deduplication

Prevent duplicate notifications with idempotency keys:

```typescript
const notifications = new NotificationService({
  channels: [...],
  idempotency: {},  // uses MemoryIdempotencyStore, 24h TTL
});

await notifications.send({
  event: 'order.completed',
  recipient: { email: 'user@example.com' },
  data: { orderId: '123' },
  idempotencyKey: 'order-completed-123',  // duplicate sends are skipped
});
```

For distributed systems, implement `IdempotencyStore` with Redis:

```typescript
import type { IdempotencyStore } from '@classytic/notifications/utils';

class RedisIdempotencyStore implements IdempotencyStore {
  async has(key: string): Promise<boolean> {
    return !!(await redis.exists(`idemp:${key}`));
  }
  async set(key: string, ttlMs: number): Promise<void> {
    await redis.set(`idemp:${key}`, '1', 'PX', ttlMs);
  }
}
```

## Batch Sending

Send thousands of notifications with controlled concurrency:

```typescript
const batch = await notifications.sendBatch(payloads, {
  concurrency: 20,
  onProgress: ({ completed, total }) => console.log(`${completed}/${total}`),
});

console.log(`Sent: ${batch.sent}, Failed: ${batch.failed}, Skipped: ${batch.skipped}`);
```

## Retry + Backoff

```typescript
const notifications = new NotificationService({
  retry: {
    maxAttempts: 3,           // default: 1 (no retry)
    backoff: 'exponential',   // 'exponential' | 'linear' | 'fixed'
    initialDelay: 500,        // ms, default: 500
    maxDelay: 30_000,         // ms, default: 30000
  },
});
```

Jitter (+-25%) is applied automatically to prevent thundering herd. Per-channel overrides are supported.

## Lifecycle Events

```typescript
notifications.on('before:send', (payload) => { /* validation, rate limiting */ });
notifications.on('after:send', (result) => { /* always fires, even for skipped */ });
notifications.on('send:success', (result) => { /* at least one channel sent */ });
notifications.on('send:failed', (result) => { /* at least one channel failed */ });
notifications.on('send:retry', ({ channel, attempt, error }) => { /* ... */ });
notifications.on('send:rate_limited', ({ channel, event }) => { /* ... */ });
notifications.on('send:queued', ({ jobId, payload }) => { /* ... */ });
```

## Hook Factories

Generate event handlers for any hook/event system:

```typescript
const hooks = notifications.createHooks([
  {
    event: 'user.created',
    getRecipient: (user) => ({ email: user.email, name: user.name }),
    getData: (user) => ({ name: user.name }),
    template: 'welcome',
  },
]);

// With EventEmitter
emitter.on('user.created', hooks['user.created'][0]);
```

## API Reference

### `NotificationService`

| Method | Description |
|--------|-------------|
| `send(payload)` | Send notification to all matching channels |
| `sendBatch(payloads, options?)` | Send multiple notifications with concurrency control |
| `addChannel(channel)` | Register a channel at runtime |
| `removeChannel(name)` | Remove a channel by name |
| `getChannel(name)` | Get a channel by name |
| `getChannelNames()` | List all registered channel names |
| `getDeliveryLog()` | Get the delivery log instance |
| `createHooks(configs)` | Create event-specific hook handlers |
| `on(event, handler)` | Listen to lifecycle events |
| `off(event, handler)` | Remove a lifecycle listener |

### Pluggable Interfaces

| Interface | Purpose | Built-in |
|-----------|---------|----------|
| `SmsProvider` | SMS delivery | — (BYOP) |
| `PushProvider` | Push notification delivery | — (BYOP) |
| `TemplateResolver` | Template rendering | `createSimpleResolver()` |
| `RateLimitStore` | Rate limit state | `MemoryRateLimitStore` |
| `DeliveryLog` | Audit trail | `MemoryDeliveryLog` |
| `QueueAdapter` | Crash-resilient queue | `MemoryQueue` |
| `IdempotencyStore` | Deduplication | `MemoryIdempotencyStore` |
| `PreferenceResolver` | User preference filtering | — (BYOP) |

### Exports

```typescript
// Core
import { NotificationService } from '@classytic/notifications';

// Channels
import {
  BaseChannel, EmailChannel, WebhookChannel,
  ConsoleChannel, SmsChannel, PushChannel,
} from '@classytic/notifications/channels';

// Utilities
import {
  createSimpleResolver, withFallback, createStatusHandler,
  MemoryDeliveryLog, MemoryRateLimitStore, MemoryQueue,
  MemoryIdempotencyStore, mergeHooks, pMap,
  withRetry, Emitter, isQuietHours,
  NotificationError, ChannelError, ProviderNotInstalledError,
} from '@classytic/notifications/utils';

// Types
import type {
  SmsProvider, PushProvider, DeliveryLog, DeliveryStatus,
  StatusUpdate, StatusHandler, RateLimitStore, FallbackOptions,
  QueueAdapter, IdempotencyStore, TemplateResolver,
  Channel, ChannelConfig, NotificationPayload, SendResult,
  DispatchResult, BatchOptions, BatchResult,
} from '@classytic/notifications';
```

## License

MIT
