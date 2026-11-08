# Channels and providers

All channels take `ChannelConfig`: `name`, `enabled`, `events` (glob list such as `['order.*']`; omitted means all), `retry`, `rateLimit: { maxPerWindow, windowMs }`. A channel may implement `canSend(payload)` to skip before spending a rate-limit token.

## Recipient and payload

`Recipient`: `id`, `email`, `phone`, `name`, `deviceToken`, `telegramChatId`, `metadata`.
`NotificationPayload`: `event`, `recipient`, `data`, `template`, `channels` (restrict), `metadata`, `subject` (`{ sourceModel, sourceId }`, indexed in delivery log), `idempotencyKey`, `delay` (ms, needs a queue).
`SendResult`: `status` (`sent`, `skipped`, `failed`), `channel`, `duration`, `error`, `retryable`, `providerMessageId`, `metadata`. `DispatchResult`: `event`, `results`, `sent`, `failed`, `skipped`, `duration`, `queued?`.

## Email (`EmailChannel`)

Config: `from`, `transport` (nodemailer options) or `transporter` (an instance), `defaults`, `allowSenderOverride`, `listUnsubscribe: { url, email }`. Skips when `recipient.email` is missing.
Template or `data` fields used: `subject`, `html`, `text`, `replyTo`, `cc`, `bcc`, `attachments` (`{ filename, content | path, contentType }`), `from` only with `allowSenderOverride`. Methods `verify()` and `close()`.
Nodemailer is imported lazily; without it the channel throws `ProviderNotInstalledError`.

## Email provider presets (`@classytic/notifications/providers`)

For "bring your own email" settings screens. One credential shape, many relays:

```ts
interface EmailCredentialData { provider: 'resend' | 'gmail' | 'sendgrid' | 'mailgun' | 'ses' | 'smtp'; fromEmail: string; fromName?: string; apiKey?: string; user?: string; password?: string; host?: string; port?: string | number; secure?: string | boolean; requireTLS?: string | boolean }
```

| Function | Purpose |
|---|---|
| `EMAIL_PRESETS`, `EMAIL_PROVIDER_OPTIONS` | host, port, TLS, user and password sources, `setupHint` per provider; options list for a dropdown |
| `getEmailCredentialSchema()` | union field list (`name`, `displayName`, `type`, `required`, `options`) to render the credential form; hide fields irrelevant to the chosen provider |
| `buildEmailTransport(cred)` | nodemailer transporter; throws a clear error for missing key, user or password |
| `buildFromHeader(cred)` | `"Name" <email>` or the bare address |
| `testEmailCredential(cred)` | opens the connection and authenticates: `{ status: 'OK' \| 'Error', message, data? }` |

Resend and SendGrid read `apiKey`; Gmail (app password), Mailgun and custom SMTP read `user` and `password`. Fixed-host presets ignore user `host` so a changed host cannot leak a provider key.
Custom SMTP (`authOptional` preset) with `user` and `password` both blank builds a transport without `auth`, for a relay that allow-lists sender addresses; one without the other still throws. `requireTLS` (boolean or `'true'`/`'false'`, `smtp` and `ses` only) refuses to send unless STARTTLS succeeds.
Store the credential encrypted; never log it.

## SMS and push (bring your own provider)

```ts
interface SmsProvider { send(m: { to: string; from: string; body: string }): Promise<{ sid: string }> }
interface PushProvider { send(m: { token: string; title: string; body: string; data?: Record<string, string>; imageUrl?: string; collapseKey?: string; threadId?: string; badge?: number }): Promise<{ messageId: string }> }
```

SMS body comes from `data.text`, then `data.message`, then `data.subject`; it needs `recipient.phone`. Push title comes from `data.title` or `data.subject`, body from `data.body`, `data.text` or `data.message`; it needs
`recipient.deviceToken`; missing title and body skips. Throw `PermanentDeliveryError` (or an error with `retryable: false`) from a provider for failures no retry fixes (unregistered token); the channel returns `failed` with `retryable: false`.
Copyable adapters for Twilio, SNS, Vonage, FCM, Expo, OneSignal and status mappers are in `examples/providers.ts` in the repository.

## Webhook, Telegram, console

- `WebhookChannel({ url, headers, secret, method: 'POST' | 'PUT', timeout })`: JSON body; with `secret`, header `X-Signature-256: sha256=<hmac>` over the body. Receivers must verify it in constant time.
- `TelegramChannel({ botToken, chatId, parseMode: 'HTML' | 'MarkdownV2', silent, timeout, apiBaseUrl })`: chat is `recipient.telegramChatId`, else the channel `chatId`; missing both skips.
- `ConsoleChannel({ events })`: logs; for development and tests.

## Custom channel

Extend `BaseChannel<Config>`, call `super({ name, ...config })`, implement `send(payload)`; return `{ status: 'failed', channel, error, retryable }` instead of throwing for expected failures. Optionally override `canSend` and `shouldHandle`.
Errors: `NotificationError`, `ChannelError(channelName, message)`, `ProviderNotInstalledError(pkg, installHint)`, `PermanentDeliveryError`.
