---
name: notifications
description: |
  @classytic/notifications — Multi-channel notification system for Node.js/TypeScript.
  Use when sending email (Nodemailer/SES/Gmail), webhook, Slack, or custom channel
  notifications with templates, retry, backoff, idempotency, preferences, or batch sending.
  Triggers: notification, email, smtp, nodemailer, ses, webhook, slack, push notification,
  multi-channel, send email, email template, retry backoff, idempotency, batch send,
  quiet hours, notification preferences, event-driven notifications.
version: "1.1.0"
license: MIT
metadata:
  author: Classytic
tags:
  - notifications
  - email
  - nodemailer
  - webhook
  - multi-channel
  - templates
  - retry
  - idempotency
  - typescript
  - zero-dependencies
progressive_disclosure:
  entry_point:
    summary: "Multi-channel notifications: Email, Webhook, Console + custom. Zero required deps."
    when_to_use: "Sending notifications via email/webhook/custom channels with templates, retry, and preferences"
    quick_start: "1. npm install @classytic/notifications 2. new NotificationService({ channels, templates }) 3. service.send({ event, recipient, data, template })"
  context_limit: 700
---

# @classytic/notifications

Multi-channel notification system with pluggable providers, templates, retry with backoff, and user preferences. Zero required dependencies — bring your own providers.

**Requires:** Node.js `>=18`

## Installation

```bash
npm install @classytic/notifications

# For EmailChannel only (optional peer dep):
npm install nodemailer
```

## Quick Start

```typescript
import { NotificationService, EmailChannel, ConsoleChannel } from '@classytic/notifications';

const notifications = new NotificationService({
  channels: [
    new EmailChannel({
      from: 'App <noreply@app.com>',
      transport: { host: 'smtp.gmail.com', port: 587, auth: { user, pass } },
    }),
    new ConsoleChannel(), // dev/testing — logs to console
  ],
  templates: (id, data) => ({
    subject: `Notification: ${id}`,
    html: `<p>Hello ${data.name}</p>`,
    text: `Hello ${data.name}`,
  }),
  retry: { maxAttempts: 3, backoff: 'exponential' },
});

await notifications.send({
  event: 'user.created',
  recipient: { email: 'user@example.com', name: 'John' },
  data: { name: 'John' },
  template: 'welcome',
});
```

## NotificationService API

| Method | Description |
|--------|-------------|
| `send(payload)` | Send to all matching channels |
| `sendBatch(payloads, opts?)` | Batch send with concurrency control |
| `addChannel(channel)` | Register channel at runtime |
| `removeChannel(name)` | Remove channel by name |
| `getChannel(name)` | Get channel by name |
| `getChannelNames()` | List registered channel names |
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
  data: Record<string, unknown>;           // Template data
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
  skipped: number;           // Skipped (dedup, prefs, quiet hours)
  duration: number;          // Wall-clock ms
}
```

## Channels

### EmailChannel (Nodemailer)

Requires peer dep: `npm install nodemailer`. Lazily imported — zero overhead if unused.

```typescript
import { EmailChannel } from '@classytic/notifications';

// SMTP
new EmailChannel({
  from: 'App <noreply@app.com>',
  transport: { host: 'smtp.gmail.com', port: 587, auth: { user, pass } },
});

// Gmail shorthand
new EmailChannel({
  from: 'noreply@app.com',
  transport: { service: 'gmail', auth: { user, pass } },
});

// Pre-created transporter (SES, custom)
import nodemailer from 'nodemailer';
new EmailChannel({
  from: 'noreply@app.com',
  transporter: nodemailer.createTransport({ /* SES config */ }),
});
```

**Email-specific payload fields** (set via template resolver or data): `subject`, `html`, `text`, `from` (override), `replyTo`, `cc`, `bcc`, `attachments`.

Methods: `verify()` (test SMTP connection), `close()` (cleanup).

### WebhookChannel

Zero dependencies — native `fetch`. Sends JSON payload with event, recipient, data, timestamp.

```typescript
import { WebhookChannel } from '@classytic/notifications';

// Slack webhook
new WebhookChannel({
  name: 'slack',
  url: 'https://hooks.slack.com/services/...',
  events: ['order.completed', 'user.created'],
});

// Signed webhook (HMAC-SHA256)
new WebhookChannel({
  url: 'https://api.partner.com/webhooks',
  secret: process.env.WEBHOOK_SECRET!,
  headers: { 'X-API-Key': process.env.PARTNER_KEY! },
  method: 'POST',        // or 'PUT'
  timeout: 5000,          // ms, default: 10000
});
```

Signature header: `X-Signature-256: sha256=<hex>`.

### ConsoleChannel

Logs notifications to console. Zero dependencies.

```typescript
import { ConsoleChannel } from '@classytic/notifications';

new ConsoleChannel();                              // all events
new ConsoleChannel({ events: ['user.*'] });        // scoped
```

### Custom Channels

Extend `BaseChannel` — implement one method:

```typescript
import { BaseChannel } from '@classytic/notifications';
import type { ChannelConfig, NotificationPayload, SendResult } from '@classytic/notifications';

interface SmsConfig extends ChannelConfig {
  from: string;
  apiKey: string;
}

class SmsChannel extends BaseChannel<SmsConfig> {
  constructor(config: SmsConfig) {
    super({ name: 'sms', ...config });
  }

  async send(payload: NotificationPayload): Promise<SendResult> {
    if (!payload.recipient.phone) {
      return { status: 'skipped', channel: this.name, error: 'No phone' };
    }
    // send SMS via your provider...
    return { status: 'sent', channel: this.name };
  }
}
```

### Event Filtering

Channels only handle events matching their `events` whitelist. Supports wildcards:

```typescript
new WebhookChannel({
  url: '...',
  events: ['order.*'],    // matches order.created, order.completed, etc.
});
// Empty events array (or omitted) = handle ALL events
```

### Per-Channel Retry Override

```typescript
new NotificationService({
  retry: { maxAttempts: 3, backoff: 'exponential' },   // global
  channels: [
    new EmailChannel({ ..., retry: { maxAttempts: 5 } }),       // more for email
    new WebhookChannel({ ..., retry: { maxAttempts: 1 } }),     // disable for webhooks
  ],
});
```

## Templates

Plug any template engine via a resolver function:

```typescript
const notifications = new NotificationService({
  templates: async (templateId, data) => {
    // Return { subject?, html?, text?, ...extra }
    // Extra keys are merged into payload.data
    const html = await renderReactEmail(templateId, data);
    return { subject: `Notification: ${templateId}`, html };
  },
});

await notifications.send({
  event: 'user.created',
  recipient: { email: 'user@example.com' },
  data: { name: 'John' },
  template: 'welcome',   // passed to resolver
});
```

Template result is merged into `payload.data` (template values take precedence) before sending to channels.

**Type signature:**
```typescript
type TemplateResolver = (
  templateId: string,
  data: Record<string, unknown>,
) => TemplateResult | Promise<TemplateResult>;

interface TemplateResult {
  subject?: string;
  html?: string;
  text?: string;
  [key: string]: unknown;
}
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

Jitter (+-25%) applied automatically to prevent thundering herd.

**Backoff calculation:**
- **Exponential**: `delay = initialDelay * 2^(attempt-1)`
- **Linear**: `delay = initialDelay * attempt`
- **Fixed**: `delay = initialDelay`

## Lifecycle Events

```typescript
notifications.on('before:send', (payload) => { /* validate, rate-limit */ });
notifications.on('after:send', (result) => { /* log dispatch result */ });
notifications.on('send:success', (result) => { /* metrics */ });
notifications.on('send:failed', (result) => { /* alert ops */ });
notifications.on('send:retry', ({ channel, attempt, error }) => { /* warn */ });
```

- `before:send` — **fail-fast**: throwing aborts the send
- `after:send` / `send:success` / `send:failed` — **safe**: errors logged, never mask result
- `send:retry` — errors caught and logged

## Subpath Imports

```typescript
// Main (everything)
import { NotificationService, EmailChannel, ... } from '@classytic/notifications';

// Channels only
import { BaseChannel, EmailChannel, WebhookChannel, ConsoleChannel } from '@classytic/notifications/channels';

// Utilities only
import { withRetry, pMap, isQuietHours, MemoryIdempotencyStore, mergeHooks } from '@classytic/notifications/utils';
import { NotificationError, ChannelError, ProviderNotInstalledError, Emitter } from '@classytic/notifications/utils';
import type { IdempotencyStore, QuietHoursConfig, PMapOptions } from '@classytic/notifications/utils';
```

## References (Progressive Disclosure)

- **[advanced](references/advanced.md)** — Batch sending, idempotency, user preferences, quiet hours, hook factories, channel management
