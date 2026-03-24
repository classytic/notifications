---
name: notifications
description: |
  @classytic/notifications — Multi-channel notification system for Node.js/TypeScript.
  Use when sending email (Nodemailer/SES/Gmail), SMS (Twilio/SNS/Vonage), push (FCM/Expo/OneSignal),
  webhook, or custom channel notifications with rate limiting, delivery tracking, queue adapters,
  templates, retry, backoff, idempotency, preferences, or batch sending.
  Triggers: notification, email, smtp, nodemailer, ses, webhook, slack, push notification, sms,
  twilio, fcm, expo, multi-channel, send email, email template, retry backoff, idempotency,
  batch send, quiet hours, rate limit, delivery log, audit trail, queue, notification preferences,
  event-driven notifications.
version: "2.0.0"
license: MIT
metadata:
  author: Classytic
tags:
  - notifications
  - email
  - sms
  - push
  - nodemailer
  - webhook
  - multi-channel
  - rate-limiting
  - delivery-tracking
  - queue
  - templates
  - retry
  - idempotency
  - typescript
  - zero-dependencies
progressive_disclosure:
  entry_point:
    summary: "Multi-channel notifications: Email, SMS, Push, Webhook, Console + custom. Rate limiting, delivery tracking, queue adapters. Zero required deps."
    when_to_use: "Sending notifications via email/SMS/push/webhook with rate limits, delivery tracking, templates, retry, and preferences"
    quick_start: "1. npm install @classytic/notifications 2. new NotificationService({ channels, templates, deliveryLog }) 3. service.send({ event, recipient, data, template })"
  context_limit: 700
---

# @classytic/notifications

Multi-channel notification system with pluggable providers, rate limiting, delivery tracking, queue adapters, templates, retry with backoff, and user preferences. Zero required dependencies — bring your own providers.

**Requires:** Node.js `>=18`

## Installation

```bash
npm install @classytic/notifications

# For EmailChannel only (optional peer dep):
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
    welcome: { subject: 'Welcome, ${name}!', html: '<h1>Hi ${name}</h1>' },
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

## NotificationService API

| Method | Description |
|--------|-------------|
| `send(payload)` | Send to all matching channels (or enqueue if queue is configured) |
| `sendBatch(payloads, opts?)` | Batch send with concurrency control |
| `addChannel(channel)` | Register channel at runtime |
| `removeChannel(name)` | Remove channel by name |
| `getChannel(name)` | Get channel by name |
| `getChannelNames()` | List registered channel names |
| `getDeliveryLog()` | Get the delivery log instance |
| `createHooks(configs)` | Create event-specific hook handlers |
| `on(event, handler)` | Listen to lifecycle events |
| `off(event, handler)` | Remove listener |

### Constructor Config

```typescript
new NotificationService({
  channels?: Channel[];                    // Registered channels
  templates?: TemplateResolver;            // Template resolution function
  retry?: RetryConfig;                     // Global retry (channels can override)
  preferences?: PreferenceResolver;        // Per-user filtering
  logger?: Logger;                         // Pluggable logger (default: silent)
  idempotency?: {                          // Deduplication
    store?: IdempotencyStore;              // Default: MemoryIdempotencyStore
    ttl?: number;                          // Default: 86400000 (24h)
  };
  deliveryLog?: DeliveryLog;              // Audit trail (default: none)
  rateLimitStore?: RateLimitStore;        // Custom rate limit backend (auto-created if channels use rateLimit)
  queue?: QueueAdapter;                   // Crash-resilient delivery (default: none)
});
```

### send() Payload

```typescript
await notifications.send({
  event: string;                           // Event name (e.g. 'user.created')
  recipient: {                             // Who receives it
    id?: string;
    email?: string;
    phone?: string;
    name?: string;
    deviceToken?: string;
    metadata?: Record<string, unknown>;
  };
  data: Record<string, unknown>;           // Template data + channel-specific fields
  template?: string;                       // Template ID to resolve
  channels?: string[];                     // Target specific channels (omit = all)
  idempotencyKey?: string;                 // Deduplication key
  metadata?: Record<string, unknown>;      // Passed through to results
});
```

### send() Result — DispatchResult

```typescript
{
  event: string;
  results: SendResult[];     // Per-channel results
  sent: number;              // Successful sends
  failed: number;            // Failed sends
  skipped: number;           // Skipped (dedup, prefs, quiet hours, rate limited)
  duration: number;          // Wall-clock ms
}
```

## Channels

### EmailChannel (Nodemailer)

Requires peer dep: `npm install nodemailer`. Lazily imported — zero overhead if unused.

```typescript
import { EmailChannel } from '@classytic/notifications/channels';

new EmailChannel({
  from: 'App <noreply@app.com>',
  transport: { host: 'smtp.gmail.com', port: 587, auth: { user, pass } },
  rateLimit: { maxPerWindow: 500, windowMs: 86_400_000 }, // Gmail 500/day
});
```

**Email-specific payload fields** (set via template resolver or data): `subject`, `html`, `text`, `from` (override), `replyTo`, `cc`, `bcc`, `attachments`.

**Security:** `config.defaults` can never override protected fields (`to`, `from`, `subject`, `html`, `text`, `cc`, `bcc`, `replyTo`, `attachments`) to prevent email misdirection.

Methods: `verify()` (test SMTP connection), `close()` (cleanup).

### SmsChannel (BYOP)

Zero dependencies — bring your own SMS SDK.

```typescript
import { SmsChannel } from '@classytic/notifications/channels';

const sms = new SmsChannel({
  from: '+15551234567',
  provider: {
    send: async ({ to, from, body }) => {
      const msg = await twilioClient.messages.create({ to, from, body });
      return { sid: msg.sid };
    },
  },
});
```

**Provider interface:**
```typescript
interface SmsProvider {
  send(message: { to: string; from: string; body: string }): Promise<{ sid: string }>;
}
```

Body resolved from: `data.text` > `data.message` > `data.subject`.

### PushChannel (BYOP)

Zero dependencies — bring your own push SDK (FCM, Expo, OneSignal, APNs).

```typescript
import { PushChannel } from '@classytic/notifications/channels';

const push = new PushChannel({
  provider: {
    send: async ({ token, title, body, data }) => {
      const result = await admin.messaging().send({ token, notification: { title, body }, data });
      return { messageId: result };
    },
  },
});
```

**Provider interface:**
```typescript
interface PushProvider {
  send(message: {
    token: string; title: string; body: string;
    data?: Record<string, string>; imageUrl?: string;
  }): Promise<{ messageId: string }>;
}
```

### WebhookChannel

Zero dependencies — native `fetch`. HMAC-SHA256 payload signing.

```typescript
import { WebhookChannel } from '@classytic/notifications/channels';

new WebhookChannel({
  url: 'https://hooks.slack.com/services/...',
  secret: process.env.WEBHOOK_SECRET!,       // optional HMAC signing
  events: ['order.*'],
});
```

### ConsoleChannel

Logs notifications to console. Zero dependencies.

```typescript
new ConsoleChannel();                              // all events
new ConsoleChannel({ events: ['user.*'] });        // scoped
```

### Custom Channels

Extend `BaseChannel` — implement one method:

```typescript
import { BaseChannel } from '@classytic/notifications/channels';
import type { ChannelConfig, NotificationPayload, SendResult } from '@classytic/notifications';

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

Per-channel token bucket via `rateLimit` on any `ChannelConfig`:

```typescript
new EmailChannel({
  from: 'noreply@app.com',
  transport: { ... },
  rateLimit: { maxPerWindow: 500, windowMs: 86_400_000 }, // 500 per day
});
```

Rate-limited sends return `status: 'skipped'` with `error: 'Rate limited'`. Emits `send:rate_limited` event.

For distributed systems, implement `RateLimitStore`:
```typescript
import type { RateLimitStore, RateLimitConfig } from '@classytic/notifications/utils';

class RedisRateLimitStore implements RateLimitStore {
  async consume(channel: string, config: RateLimitConfig): Promise<boolean> { /* ... */ }
  async remaining(channel: string, config: RateLimitConfig): Promise<number> { /* ... */ }
  async reset(channel: string): Promise<void> { /* ... */ }
}
```

## Delivery Tracking

Every notification attempt (sent, skipped, failed) is logged:

```typescript
import { MemoryDeliveryLog } from '@classytic/notifications/utils';

const log = new MemoryDeliveryLog();
const service = new NotificationService({ channels: [...], deliveryLog: log });

// Query history
const entries = log.query({ recipientId: 'u1', status: 'delivered', limit: 50 });
```

For production, implement `DeliveryLog` with your database.

## Queue Adapter

Crash-resilient delivery. The service owns the queue — it calls `process()` on construction. When configured, `send()` enqueues and returns `{ queued: true }`:

```typescript
import { MemoryQueue } from '@classytic/notifications/utils';

const service = new NotificationService({
  channels: [...],
  queue: new MemoryQueue(),
});

await service.send({ ... }); // Returns immediately with { queued: true }
```

> If your app already has its own queue, don't pass it here. Have your existing worker call `service.send()` directly.

For production, implement `QueueAdapter` with BullMQ or your database.

## Scheduled / Delayed Delivery

Add `delay` to any payload (requires queue adapter):

```typescript
await service.send({
  event: 'reminder.appointment',
  recipient: { email: 'user@example.com' },
  data: { subject: 'Appointment tomorrow' },
  delay: 3_600_000, // send in 1 hour
});
```

Without a queue adapter, `delay` is ignored with a warning log.

## Channel Fallback

Try channels in priority order, stopping at the first success:

```typescript
import { withFallback } from '@classytic/notifications/utils';

const result = await withFallback(service, payload, ['push', 'sms', 'email'], {
  onFallback: (failed, error, next) => {
    console.log(`${failed} failed (${error}), trying ${next}`);
  },
});
```

## Status Webhook Handler

Ingest delivery status updates from providers:

```typescript
import { createStatusHandler } from '@classytic/notifications/utils';

const handler = createStatusHandler({
  onStatusChange: (update) => {
    console.log(`${update.provider} ${update.notificationId}: ${update.status}`);
  },
});

// In your route handler:
handler.handle({
  provider: 'twilio',
  notificationId: req.body.MessageSid,
  channel: 'sms',
  status: mapTwilioStatus(req.body.MessageStatus), // from examples/providers.ts
  timestamp: new Date(),
  rawPayload: req.body,
});
```

**Delivery statuses:** `queued`, `accepted`, `sent`, `delivered`, `undelivered`, `bounced`, `opened`, `clicked`, `complained`, `unsubscribed`.

## Templates

### Built-in Simple Resolver (zero deps)

```typescript
import { createSimpleResolver } from '@classytic/notifications/utils';

const service = new NotificationService({
  templates: createSimpleResolver({
    welcome: { subject: 'Welcome, ${name}!', html: '<h1>Hi ${name}</h1>' },
    order: { subject: 'Order #${orderId}', html: '<p>Hi ${user.name}</p>' },
  }),
});
```

Supports nested access: `${user.name}`.

### Custom Template Engine

Plug any engine via `TemplateResolver`:

```typescript
templates: async (id, data) => {
  const html = await renderReactEmail(id, data);
  return { subject: `Notification: ${id}`, html };
},
```

## Retry + Backoff

```typescript
{
  maxAttempts: 3,           // default: 1 (no retry)
  backoff: 'exponential',   // 'exponential' | 'linear' | 'fixed'
  initialDelay: 500,        // ms, default: 500
  maxDelay: 30_000,         // ms, default: 30000
}
```

Jitter (+-25%) applied automatically. Per-channel overrides supported.

## Lifecycle Events

```typescript
notifications.on('before:send', (payload) => { /* validate */ });
notifications.on('after:send', (result) => { /* always fires, even for skipped */ });
notifications.on('send:success', (result) => { /* at least one channel sent */ });
notifications.on('send:failed', (result) => { /* at least one channel failed */ });
notifications.on('send:retry', ({ channel, attempt, error }) => { /* warn */ });
notifications.on('send:rate_limited', ({ channel, event }) => { /* monitor */ });
notifications.on('send:queued', ({ jobId, payload }) => { /* track */ });
```

- `before:send` — **fail-fast**: throwing aborts the send
- `after:send` / `send:success` / `send:failed` — **safe**: errors logged, never mask result
- All outcomes (including skips) emit `after:send` for audit completeness

## Pluggable Interfaces

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

## Subpath Imports

```typescript
// Main (everything)
import { NotificationService, EmailChannel, SmsChannel, PushChannel, ... } from '@classytic/notifications';

// Channels only
import { BaseChannel, EmailChannel, WebhookChannel, ConsoleChannel, SmsChannel, PushChannel } from '@classytic/notifications/channels';

// Utilities only
import {
  createSimpleResolver, MemoryDeliveryLog, MemoryRateLimitStore, MemoryQueue,
  MemoryIdempotencyStore, mergeHooks, pMap, withRetry, Emitter, isQuietHours,
  withFallback, createStatusHandler,
  NotificationError, ChannelError, ProviderNotInstalledError,
} from '@classytic/notifications/utils';

import type {
  DeliveryLog, DeliveryStatus, StatusUpdate, StatusHandler,
  RateLimitStore, QueueAdapter, IdempotencyStore,
  FallbackOptions, QuietHoursConfig, PMapOptions,
} from '@classytic/notifications/utils';
```

## Provider Adapter Examples

Copy-pasteable adapters for common providers are in [`examples/providers.ts`](../../examples/providers.ts):

- **SMS:** `createTwilioSmsProvider()`, `createSnsSmsProvider()`, `createVonageSmsProvider()`
- **Push:** `createFcmPushProvider()`, `createExpoPushProvider()`, `createOneSignalPushProvider()`
- **Status mappers:** `mapTwilioStatus()`, `mapSesStatus()`, `mapSendGridStatus()`

## References (Progressive Disclosure)

- **[advanced](references/advanced.md)** — Batch sending, idempotency, user preferences, quiet hours, hook factories, channel management, full send lifecycle
- **[observability](references/observability.md)** — Metrics, tracing, logging patterns, health checks, alerting rules, ops runbook
