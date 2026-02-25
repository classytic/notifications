# @classytic/notifications

> Multi-channel notification system for TypeScript/Node.js

Pluggable channels, templates, retry with backoff, and user preferences. Zero required dependencies — bring your own providers.

## Features

- **Multi-Channel** — Email (Nodemailer — Gmail, SES, SMTP, any transport), Webhook, Console, or build your own
- **Zero Required Deps** — Nodemailer is an optional peer dependency, loaded lazily
- **Templates** — Plug any template engine (React Email, MJML, Handlebars, etc.)
- **Retry + Backoff** — Exponential, linear, or fixed backoff with jitter. Per-channel overrides
- **User Preferences** — Per-user, per-event, per-channel opt-in/out with quiet hours
- **Quiet Hours** — Timezone-aware quiet period enforcement (no external deps)
- **Idempotency** — Built-in deduplication with pluggable stores (memory, Redis, DB)
- **Lifecycle Events** — `before:send`, `after:send`, `send:success`, `send:failed`, `send:retry`
- **Hook Factories** — Generate event handlers for EventEmitter, MongoKit, or any hook system
- **Webhook Signing** — HMAC-SHA256 payload signing out of the box
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
import { EmailChannel, WebhookChannel, ConsoleChannel } from '@classytic/notifications/channels';

const notifications = new NotificationService({
  channels: [
    new EmailChannel({
      from: 'App <noreply@app.com>',
      transport: { host: 'smtp.gmail.com', port: 587, auth: { user, pass } },
    }),
    new WebhookChannel({
      url: 'https://hooks.slack.com/services/...',
      events: ['order.*'],
    }),
    new ConsoleChannel(), // dev/testing
  ],
  templates: async (id, data) => ({
    subject: `Notification: ${id}`,
    html: `<p>${JSON.stringify(data)}</p>`,
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

## Channels

### Built-in Channels

#### EmailChannel (Nodemailer)

Requires: `npm install nodemailer`

```typescript
import { EmailChannel } from '@classytic/notifications/channels';

// SMTP
const email = new EmailChannel({
  from: 'App <noreply@app.com>',
  transport: { host: 'smtp.gmail.com', port: 587, auth: { user, pass } },
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

#### WebhookChannel

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

#### ConsoleChannel

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

### Event Filtering

Channels only receive events matching their `events` whitelist. Supports wildcards:

```typescript
new WebhookChannel({
  url: '...',
  events: ['order.*'],        // matches order.created, order.completed, etc.
});

new ConsoleChannel({
  events: [],                  // empty = all events (default)
});
```

### Per-Channel Retry Override

Channels can override the global retry config, including disabling retry:

```typescript
const notifications = new NotificationService({
  retry: { maxAttempts: 3, backoff: 'exponential' }, // global default
  channels: [
    new EmailChannel({
      from: 'noreply@app.com',
      transport: { ... },
      retry: { maxAttempts: 5 },              // more retries for email
    }),
    new WebhookChannel({
      url: '...',
      retry: { maxAttempts: 1 },              // disable retry for webhooks
    }),
  ],
});
```

## Templates

Plug any template engine via a resolver function:

```typescript
const notifications = new NotificationService({
  templates: async (templateId, data) => {
    const templates: Record<string, { subject: string; html: string }> = {
      welcome: {
        subject: `Welcome ${data.name}!`,
        html: `<h1>Hello ${data.name}</h1>`,
      },
    };
    return templates[templateId] ?? { subject: templateId, text: JSON.stringify(data) };
  },
});

await notifications.send({
  event: 'user.created',
  recipient: { email: 'user@example.com' },
  data: { name: 'John' },
  template: 'welcome', // resolved before sending
});
```

Template values are merged into `payload.data`, with template values taking precedence.

## User Preferences

Filter channels per-user with a preference resolver:

```typescript
const notifications = new NotificationService({
  preferences: async (recipientId, event) => {
    const prefs = await db.getUserPrefs(recipientId);
    return {
      channels: { email: true, sms: false },        // opt-out of SMS
      events: { 'marketing.promo': false },          // opt-out of promos
      quiet: {                                        // quiet hours
        start: '22:00',
        end: '07:00',
        timezone: 'America/New_York',
      },
    };
  },
});
```

### Quiet Hours

Notifications are automatically skipped when the recipient is in their quiet period. Times use `HH:MM` format, timezone uses IANA names. Overnight ranges (e.g. 22:00–07:00) are supported.

```typescript
// Quiet hours are returned from the preference resolver
preferences: async (recipientId) => ({
  quiet: {
    start: '22:00',        // inclusive
    end: '07:00',          // exclusive
    timezone: 'Asia/Dhaka', // IANA timezone (defaults to UTC)
  },
});

// You can also use the utility directly
import { isQuietHours } from '@classytic/notifications/utils';

if (isQuietHours({ start: '22:00', end: '07:00', timezone: 'Asia/Dhaka' })) {
  console.log('Shhh!');
}
```

## Idempotency / Deduplication

Prevent duplicate notifications by providing an `idempotencyKey` on the payload. The key is only recorded after at least one channel succeeds.

```typescript
const notifications = new NotificationService({
  channels: [new EmailChannel({ ... })],
  idempotency: {},                             // uses MemoryIdempotencyStore, 24h TTL
});

await notifications.send({
  event: 'order.completed',
  recipient: { email: 'user@example.com' },
  data: { orderId: '123' },
  idempotencyKey: 'order-completed-123',       // duplicate sends are skipped
});

// Second send with same key → skipped (sent: 0, skipped: 1)
await notifications.send({
  event: 'order.completed',
  recipient: { email: 'user@example.com' },
  data: { orderId: '123' },
  idempotencyKey: 'order-completed-123',
});
```

### Custom Store + TTL

```typescript
import { MemoryIdempotencyStore } from '@classytic/notifications/utils';

// Custom TTL (1 hour)
const notifications = new NotificationService({
  idempotency: {
    ttl: 60 * 60 * 1000,  // 1 hour in ms (default: 24h)
  },
});

// Custom store (e.g. Redis for distributed systems)
import type { IdempotencyStore } from '@classytic/notifications/utils';

class RedisIdempotencyStore implements IdempotencyStore {
  async has(key: string): Promise<boolean> {
    return !!(await redis.exists(`idemp:${key}`));
  }
  async set(key: string, ttlMs: number): Promise<void> {
    await redis.set(`idemp:${key}`, '1', 'PX', ttlMs);
  }
}

const notifications = new NotificationService({
  idempotency: { store: new RedisIdempotencyStore() },
});
```

## Batch Sending

Send thousands of notifications with controlled concurrency using a worker-pool pattern:

```typescript
const payloads = students.map(s => ({
  event: 'birthday',
  recipient: { id: s.id, email: s.email },
  data: { name: s.name },
  template: 'birthday',
  idempotencyKey: `birthday-${s.id}-2024`,
}));

const batch = await notifications.sendBatch(payloads, {
  concurrency: 20,                          // max parallel sends (default: 10)
  onProgress: ({ completed, total }) => {
    console.log(`${completed}/${total}`);
  },
});

console.log(`Sent: ${batch.sent}, Failed: ${batch.failed}, Skipped: ${batch.skipped}`);
```

Each notification goes through the full `send()` pipeline (lifecycle events, templates, preferences, retry). Errors in individual notifications are caught and reported — they never abort the batch.

### Concurrency Utility

The underlying `pMap` concurrency pool is exported for reuse:

```typescript
import { pMap } from '@classytic/notifications/utils';

const results = await pMap(
  urls,
  async (url) => fetch(url).then(r => r.json()),
  { concurrency: 5 },
);
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

Jitter (+-25%) is applied automatically to prevent thundering herd.

## Lifecycle Events

```typescript
notifications.on('before:send', (payload) => {
  console.log('Sending:', payload.event);
});

notifications.on('after:send', (result) => {
  console.log(`Sent ${result.sent}/${result.results.length}`);
});

notifications.on('send:success', (result) => { /* ... */ });
notifications.on('send:failed', (result) => { /* ... */ });
notifications.on('send:retry', ({ channel, attempt, error }) => { /* ... */ });

// Remove listener
notifications.off('send:failed', handler);
```

**Lifecycle contract:**
- `before:send` is **fail-fast** — a throwing listener aborts the send and propagates the error. Use this for validation or rate limiting.
- `after:send`, `send:success`, `send:failed` are **safe** — listener errors are caught and logged, never masking the dispatch result.
- `send:retry` errors are caught and logged.

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
  {
    event: 'order.completed',
    getRecipient: (order) => ({ email: order.customer.email }),
    getData: (order) => ({ orderId: order.id, total: order.total }),
    template: 'order-confirmation',
    channels: ['email'],
  },
]);

// With EventEmitter
emitter.on('user.created', hooks['user.created'][0]);

// With MongoKit
repo.on('after:create', hooks['user.created'][0]);
```

Hooks are fire-and-forget: errors are logged but never thrown to avoid breaking the caller's flow.

### Merging Hooks

Combine hooks from multiple sources:

```typescript
import { mergeHooks } from '@classytic/notifications/utils';

const combined = mergeHooks(
  notifications.createHooks(userHookConfigs),
  notifications.createHooks(orderHookConfigs),
);
```

## Channel Management

```typescript
// Add/remove channels at runtime
notifications.addChannel(new ConsoleChannel());
notifications.removeChannel('console');

// Inspect registered channels
notifications.getChannel('email');      // Channel | undefined
notifications.getChannelNames();        // ['email', 'webhook']
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
| `createHooks(configs)` | Create event-specific hook handlers |
| `on(event, handler)` | Listen to lifecycle events |
| `off(event, handler)` | Remove a lifecycle listener |

### `BaseChannel<TConfig>`

Abstract base class for channels. Provides `shouldHandle(event)` with wildcard support.

### Exports

```typescript
// Core
import { NotificationService } from '@classytic/notifications';

// Channels
import { BaseChannel, EmailChannel, WebhookChannel, ConsoleChannel } from '@classytic/notifications/channels';

// Utilities
import { mergeHooks, withRetry, resolveRetryConfig, calculateDelay, Emitter } from '@classytic/notifications/utils';
import { NotificationError, ChannelError, ProviderNotInstalledError } from '@classytic/notifications/utils';
import { isQuietHours, MemoryIdempotencyStore, pMap } from '@classytic/notifications/utils';
import type { IdempotencyStore, PMapOptions, QuietHoursConfig } from '@classytic/notifications/utils';
```

## License

MIT
