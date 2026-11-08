---
name: notifications
description: Multi-channel delivery layer - NotificationService with email (nodemailer), SMS and push (bring your own provider), webhook, Telegram, console channels, retry, rate limits, idempotency, delivery log, queue, templates, email provider presets. Use when sending messages from Node. Triggers - notifications, NotificationService, EmailChannel, PushChannel, SmsChannel, buildEmailTransport.
metadata:
  minVersion: "2.7.0"
  package: "@classytic/notifications"
  peers: "nodemailer >=6 (EmailChannel and email providers only); node >=18"
  scope: "channels and providers. Rule engines, in-app feeds and approval inboxes are skill arc-notifications."
---

# @classytic/notifications

`NotificationService` fans one payload out to matching channels with retry, rate limits, idempotency, preferences, quiet hours, delivery log and optional queue. Channels are small classes; SMS and push take YOUR provider object. Zero required dependencies.

## Do not hand-roll

| Need | Use |
|---|---|
| Send one event to several channels | `NotificationService.send` |
| SMTP email | `EmailChannel` (`/channels`) |
| Resend, Gmail, SendGrid, Mailgun, SES, custom SMTP from stored credentials | `buildEmailTransport`, `EMAIL_PRESETS` (`/providers`) |
| Credential form fields for an email provider | `getEmailCredentialSchema` |
| "Test connection" for an email credential | `testEmailCredential` |
| From header with display name | `buildFromHeader` |
| SMS or push through Twilio, FCM, Expo | `SmsChannel`, `PushChannel` with a provider object |
| Webhook with HMAC signature | `WebhookChannel` |
| Telegram bot message | `TelegramChannel` |
| Custom channel | extend `BaseChannel` |
| Retry with backoff and jitter | `retry` config, `withRetry` |
| Stop retrying a hard failure | `PermanentDeliveryError` or `retryable: false` |
| Exactly-once per key across processes | `idempotencyKey`, `RedisIdempotencyStore` |
| Per-channel rate limit | `rateLimit` on the channel, `MemoryRateLimitStore` |
| Audit trail of attempts | `deliveryLog`, `MemoryDeliveryLog` |
| Crash-resilient and delayed sends | `queue`, `MemoryQueue`, payload `delay` |
| Templates with `${name}` | `createSimpleResolver` or your own `TemplateResolver` |
| Try push, then sms, then email | `withFallback` |
| Provider delivery receipts | `createStatusHandler` |
| Quiet hours and user opt-outs | `preferences` resolver, `isQuietHours` |
| Many recipients | `sendBatch`, `pMap` |
| Bind domain events to sends | `service.createHooks`, `mergeHooks` |

## Golden path

```ts
import { NotificationService } from '@classytic/notifications';
import { EmailChannel, PushChannel } from '@classytic/notifications/channels';
import { MemoryDeliveryLog, RedisIdempotencyStore, createSimpleResolver } from '@classytic/notifications/utils';

const service = new NotificationService({
  channels: [
    new EmailChannel({ from: 'App <noreply@example.com>', transport: { host, port: 587, auth: { user, pass } }, rateLimit: { maxPerWindow: 500, windowMs: 86_400_000 } }),
    new PushChannel({ provider: { send: async ({ token, title, body, data }) => ({ messageId: await fcm.send({ token, notification: { title, body }, data }) }) } }),
  ],
  templates: createSimpleResolver({ welcome: { subject: 'Welcome, ${name}', html: '<p>Hi ${name}</p>' } }),
  retry: { maxAttempts: 3, backoff: 'exponential' },
  idempotency: { store: new RedisIdempotencyStore({ client: redis }) },
  deliveryLog: new MemoryDeliveryLog(),   // production: your database implementing DeliveryLog
});

const result = await service.send({ event: 'user.created', recipient: { id, email, deviceToken, name }, data: { name }, template: 'welcome', idempotencyKey: `welcome:${id}` });
// result: { sent, failed, skipped, results[], duration, queued? }
```

Stored email credential to transport:

```ts
import { buildEmailTransport, buildFromHeader, testEmailCredential } from '@classytic/notifications/providers';
const check = await testEmailCredential(cred);                 // { status: 'OK' | 'Error', message }
const channel = new EmailChannel({ from: buildFromHeader(cred), transporter: await buildEmailTransport(cred) });
```

Custom channel:

```ts
class SlackChannel extends BaseChannel<SlackConfig> {
  constructor(config: SlackConfig) { super({ name: 'slack', ...config }); }
  async send(payload: NotificationPayload): Promise<SendResult> { /* return { status, channel: this.name } */ }
}
```

## Gotchas

- `send` never throws for delivery failures; read `result.failed` and `result.results[].error`. `before:send` listeners that throw DO abort the send.
- Skips (idempotent duplicate, opt-out, quiet hours, rate limit, channel not matching `events`) count in `skipped`, not `failed`.
- With a `queue`, `send` returns `{ queued: true }` at once; `delay` needs a queue and is ignored without one.
- Idempotency stores with `claim`/`release` (memory, Redis) give atomic dedup; success keeps the key for `ttl` (24 h), zero sent releases it.
- Retry applies per channel; results with `retryable: false` stop after one attempt.
- Push `data` values must be strings; `collapseKey`, `threadId`, `badge` ride in `payload.data`.
- `EmailChannel.defaults` cannot override `to`, `from`, `subject`, body, `cc`, `bcc`, attachments (misdirection guard); set `allowSenderOverride` to let a payload choose `from`.
- Email provider presets with fixed hosts ignore user `host`/`port`; only `smtp` and `ses` accept overrides. Custom SMTP with user and password both blank has no auth.
- Telegram needs `recipient.telegramChatId` or a channel `chatId`.
- `PreferenceResolver` is keyed by `recipient.id`; no id means no preference check.

## Never

- Call SDKs for email, SMS or push directly from request handlers.
- Hand-write retry loops or dedup tables; use the service config.
- Log recipient addresses or tokens in the delivery log metadata without need.

## References

- `references/channels-providers.md`: read for each channel's config and payload fields, provider interfaces, email presets, webhooks.
- `references/service-features.md`: read for batch, preferences, quiet hours, hooks, queue, idempotency, lifecycle events, delivery log, status webhooks.
- Rule-driven notifications, in-app feed and approval inbox: skill `arc-notifications`.
