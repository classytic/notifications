# Changelog

All notable changes to `@classytic/notifications` will be documented in this file.

## [Unreleased] (suggested 2.9.0, minor: additive only)

### Added: `@classytic/notifications/push`, FCM HTTP v1 and APNs HTTP/2 with no SDK

Generalised from the push stack of a production incident-management app (FCM through
`firebase-admin` there; here straight HTTP v1). Node built-ins only (`node:crypto`, `node:http2`,
`fetch`), so the "zero required dependencies" promise holds. A new subpath and tsdown entry: the root
entry never loads `node:http2`.

- `fcmProvider(options)`: service-account JWT (RS256) exchanged for an OAuth2 access token, cached
  until 60 s before expiry, ONE shared refresh for concurrent sends; a 401 refreshes and retries once.
- `apnsProvider(options)`: ES256 provider token reused for `tokenTtlMs` (default 50 min, validated to
  Apple's 20 to 60 min window), one HTTP/2 session per host reused and reopened after GOAWAY / close /
  error, ref'd only while streams are in flight; sandbox / production host from
  `credentials.environment`; `apns-push-type`, `apns-priority`, `apns-topic`, `apns-expiration`,
  `apns-collapse-id`; interruption levels with `critical` only when `allowCriticalAlerts`.
- `pushRouter({ android, ios, web, defaultPlatform })`: dispatch on `message.platform`; a platform
  with no provider is a `PushRejectedError` (`platform-disabled`), never a dead token.
- Dead tokens: FCM `UNREGISTERED` / `INVALID_ARGUMENT` naming the token and APNs 410 /
  `BadDeviceToken` throw `InvalidPushTokenError` (`reason`) after calling `onInvalidToken(token, reason)`.
  `SENDER_ID_MISMATCH` and `DeviceTokenNotForTopic` are `PushRejectedError` and keep the device (a
  configuration mix-up must not wipe every device row).
- Transient errors (429, 5xx, timeout, network) are `TransientPushError` with `retryAfterMs` from
  `Retry-After`; a provider-wide 429 / 503 with `Retry-After` pauses that provider instance (fails fast)
  until the time passes; a per-device 429 does not.
- `PushCredentialsError` for missing / malformed / refused credentials, naming fields only.
- Credentials as a value or a function (`CredentialsSource`), re-resolved per send; a changed `version`
  (or field fingerprint) re-imports the key and drops cached tokens. `parseFcmServiceAccount`,
  `validateFcmCredentials`, `validateApnsCredentials`.
- Content-free pushes: `createContentFreeBuilder` and the `contentFreeOnly` provider guard.
- `onDelivery` structured events (`PushDeliveryEvent`): token suffix + hash, status, reason, latency.
- `maxConcurrency` per provider instance (FCM 100, APNs 500 by default).

### Added: delivery hints and data-only pushes on the root `PushProvider`

- `PushProviderMessage` (named, exported) gains optional `platform`, `priority`, `ttlSeconds`,
  `interruptionLevel`, `contentAvailable`, `sound`, `channelId`, `category`; `PushProvider` gains an
  optional `close()`. `PushChannel` forwards each from `payload.data`.
- `PushChannel` sends a data-only push (no title, no body) only when `data.contentAvailable` or
  `data.dataOnly` is `true`; without the flag such a send is still skipped, as before.

### Added: `Retry-After` in `withRetry`

`withRetry` (and so `NotificationService`) waits at least an error's `retryAfterMs` (found on the error
or its `cause` chain, `retryAfterHint`); a hint above `maxDelay` stops retrying instead of shortening the
wait. Errors without the field back off exactly as before.

Pinned by `tests/push-fcm.test.ts`, `tests/push-apns.test.ts` (local fake FCM over HTTP and APNs over
h2c, generated keys, no network), `tests/push-router-payload.test.ts`, `tests/types/push-contract.ts`.
Design notes: `DESIGN.md`.

## [2.8.0] — 2026-11-09

### Added: custom SMTP without authentication, and `requireTLS`

An IP-allow-listed relay (an enterprise mail gateway that accepts mail from known addresses and takes
no SMTP AUTH) could not be configured: `buildEmailTransport` always required `user` and `password`.

- `EmailPreset.authOptional` (set on `smtp` only). For such a preset, `user` and `password` both blank
  (absent, empty or whitespace) builds the transport without `auth`. One without the other still
  throws the same "SMTP user is required" / "Password is required" error. Every other preset keeps
  requiring its key.
- `EmailCredentialData.requireTLS?: string | boolean` (boolean or the form strings `'true'` / `'false'`,
  like `secure`; blank leaves it unset): passed to nodemailer as `requireTLS`, so the transport refuses
  to send unless STARTTLS succeeds. Read only where the host may be overridden (`smtp`, `ses`).
- `getEmailCredentialSchema()` adds an optional `requireTLS` select; the `user` and `password`
  descriptions say a relay may leave both blank.

Additive: a credential that worked before builds the same transport (no `requireTLS` key unless set).
Pinned by `tests/providers.email.auth-optional.test.ts` (including `testEmailCredential` against a fake
SMTP server: no `AUTH` command; `requireTLS` with no STARTTLS offered fails verification).

FLOW OCC adoption: `@spinekit/integrations`' email provider passes `requireTLS` through and lets the
administrator leave both fields blank for FLOW ICT's allow-listed relay (gap G-W1-INT-4).

## [2.7.0] — 2026-10-18

### Added — push delivery hints: `collapseKey`, `threadId`, `badge`

`PushProvider.send` receives three optional fields, read by `PushChannel` from the payload data
(`data.collapseKey`, `data.threadId`, `data.badge`): a replace-in-place key (a newer push with the
same key replaces the older one instead of stacking; FCM `android.collapseKey` + `notification.tag`,
APNs `apns-collapse-id`), a tray grouping id (APNs `thread-id`), and the app badge count. Only
well-typed values are forwarded (non-empty strings, a non-negative integer badge). Additive:
providers that ignore them deliver as before.

### Added — atomic idempotency claims + `RedisIdempotencyStore`

`IdempotencyStore` gains an optional `claim(key, leaseMs)` / `release(key)` pair. When the
store has it, `NotificationService` claims the key before delivery instead of `has()`, so
concurrent or redelivered sends with the same `idempotencyKey` deliver once, across
processes. Success upgrades the claim to the full `ttl`; zero sent (or a thrown pipeline
error) releases it so a retry can deliver. New `idempotency.leaseMs` (default 5 min) bounds
how long a crashed sender holds a key. `MemoryIdempotencyStore` implements the pair, so
in-process concurrent duplicates are now also deduplicated. Stores without `claim` keep
the old `has` / `set` behaviour.

`RedisIdempotencyStore({ client, prefix? })` is `SET NX PX` over a structurally typed
client (`RedisIdempotencyClient`); ioredis fits as is, no Redis dependency.

### Added — `PermanentDeliveryError` for push providers

A `PushProvider` can throw `PermanentDeliveryError` (or any error with `retryable: false`) for a
failure no retry fixes, such as an unregistered device token. `PushChannel` then returns `failed`
with `retryable: false` instead of throwing a `ChannelError`.

### Fixed — `retryable: false` results were still retried

The service turned a non-retryable result into a sentinel error, but `withRetry` retried every
error, so a hard failure still used all `maxAttempts` (with backoff) before being reported.
`withRetry` takes an optional `shouldRetry(error)` (additive fourth argument) and the service
uses it, so non-retryable results stop after the first attempt.

### Fixed — channels assignable to `Channel` under `exactOptionalPropertyTypes`

`Channel.rateLimit` / `Channel.retry` are now `?: T | undefined`, matching `BaseChannel`'s
getters. Strict hosts no longer need `as Channel` on `new PushChannel(...)` (or any built-in
channel). Guarded by `tests/types/channel-contract.ts`, compiled with
`exactOptionalPropertyTypes: true` against the built declarations in `npm run typecheck`.

## [2.6.0] — 2026-10-09

### Added — `TelegramChannel`

A Bot API channel over native `fetch`, no dependency. Sends to `recipient.telegramChatId`
(new optional field on `Recipient`), else the channel's default `chatId`. Text comes from
`data.text` / `data.message` / `data.subject`, like `SmsChannel`, with the same `canSend`
pre-check, so a payload with no destination or no text is skipped before it spends a
rate-limit token.

Failures are classified: a Bot API refusal (bad token, unknown chat, bot removed) returns
`failed` with `retryable: false`; 429, 5xx and network errors throw a `ChannelError`, which
the service retries. The token is part of the request URL, so no error message includes the
URL. `providerMessageId` is Telegram's `message_id`.

## [2.5.0] — 2026-08-26

### Fixed — send-failure log now walks the `cause` chain

A real incident — `"Unsupported state or unable to authenticate data"` logged six
times per order with no frame, no layer — took an afternoon to trace because the
delivery log and the logger both recorded only `err.message`. Several components in
the path decrypt something, so the message fit all of them equally.

The fix splits the two concerns:

- **`result.error`** (persisted, operator-facing) — still the bare message. A stack
  in an audit record is noise; raw vendor text in a persisted field violates the
  house rule on normalised stored errors.
- **`logger.error`** — now walks the `cause` chain (up to depth 4) and appends the
  first four stack frames of each `Error` node. An adapter that wraps a provider
  error puts the real origin in `cause`; printing only the outer message hid the
  layer you actually needed.

The split is covered by `tests/send-failure-diagnostics.test.ts`.

## [2.4.0] - 2026-08-17

### Fixed — `providerMessageId` now works the way 2.3.0 claimed

2.3.0 introduced `SendResult.providerMessageId` as the cross-channel correlation
key but populated it on **email only**, so the property it exists to provide did not
hold: a consumer reading `providerMessageId` got a value for email and `undefined`
for push and sms, and still had to know which channel produced the result before it
could find the id in the untyped `metadata` bag. A half-migrated contract is worse
than none — it reads as available and silently isn't.

- **`PushChannel` sets `providerMessageId`** (from the provider's `messageId`).
- **`SmsChannel` sets `providerMessageId`** (from the provider's `sid`). This is the
  case that motivates the field: three vendors, three spellings (`messageId`, `id`,
  `sid`), one concept.
- `WebhookChannel` and `ConsoleChannel` deliberately leave it **unset** — a 2xx from
  an HTTP POST is not a message identifier, and synthesising one would make an
  unjoinable send look joinable. Absent means "no correlation is possible", never
  "delivery unknown".

### Fixed — restores `metadata.messageId` on `EmailChannel`

2.3.0 deleted it in the same MINOR that added `providerMessageId`, so anyone reading
`metadata.messageId` lost it on a range-satisfying `^2.2.0` upgrade with nothing to
signal the change. The removal was right in direction and wrong in timing. It is
back for a deprecation window.

**All three id-bearing channels now mirror their provider id under both names** —
`providerMessageId` (read this) and the legacy `metadata` key (`messageId` for
email/push, `sid` for sms). **3.0.0 removes the legacy keys from every channel at
once**, as one deliberate break rather than three accidental ones.

Pinned by `tests/channels.test.ts` → `providerMessageId across channels`, including
a case that asserts a consumer can read the id **without branching on channel** —
the actual contract, so a channel regressing to metadata-only fails there.

## [2.3.0] - 2026-08-16

Recorded retroactively; this release shipped without a changelog entry.

### Added

- **`SendResult.providerMessageId`** — the typed cross-channel correlation key, so a
  delivery receipt (SES bounce, SMS DLR, push feedback) can be joined back to the
  send that produced it.
- **`SendResult.subject`** + `NotificationSubject` (`{ sourceModel, sourceId }`) —
  the business document a notification concerns, so "show me every message we sent
  about invoice X" stops being a scan over an unindexed `metadata` blob.

### Changed — BREAKING, shipped as a minor

- `EmailChannel` stopped emitting `metadata.messageId`. Readers of that key broke on
  upgrade with no signal. **Restored in 2.4.0**; upgrade straight to 2.4.0.
- Only `EmailChannel` populated `providerMessageId`; push and sms did not. **Fixed
  in 2.4.0.**

## [2.2.0] - 2026-06-03

- `SendResult.retryable?: boolean` — when `false`, service short-circuits `withRetry` immediately (permanent failures: bad credentials, invalid address, hard bounce, 4xx)
- `Channel.rateLimit` / `Channel.retry` promoted to first-class interface properties; `BaseChannel` exposes both from config via getters (removes internal casts)
- `EmailChannel.allowSenderOverride` — opt-in per-send `data.from` override (default `false`; guards multi-tenant sender-spoofing footgun)
- `EmailChannel` RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` header injection
- `interpolateHtml` + `InterpolateOptions` / `SimpleResolverOptions` exported from main entry
- Retry-layer clarification comment: queue retry × channel retry compose multiplicatively; docs advise setting one to 1 when the other owns durability
- Rate-limit token accounting clarified: one token per `sendToChannel` call; retries inside `withRetry` do not each consume a token

## [2.1.0] - 2026-05-17

### Added

- **Email provider abstraction** at the new `@classytic/notifications/providers`
  subpath export — for multi-tenant hosts that need to store an SMTP
  credential per organization and route sends through it:
  - `EMAIL_PRESETS` / `EMAIL_PROVIDER_OPTIONS` — Resend, Gmail (App
    Password), SendGrid, Mailgun, AWS SES (SMTP), and Custom SMTP. Every
    preset is SMTP-based; the table captures host / port / secure /
    userSource / passSource and leaves the secret bits to the
    credential blob.
  - `buildEmailTransport(data)` — turns an `EmailCredentialData` blob
    into a `nodemailer.Transporter`. Dynamic `import('nodemailer')` so
    the peer stays optional.
  - `buildFromHeader(data)` — formats `"Brand" <hello@…>` (or bare
    email).
  - `getEmailCredentialSchema()` — union-of-fields form schema; the UI
    hides irrelevant fields based on the selected provider.
  - `testEmailCredential(data)` — opens an SMTP connection and runs
    `verify()`. Returns `{ status: 'OK' | 'Error', message }` instead
    of throwing.
- SES preset opts into `allowHostOverride` so callers can target a
  non-default region by supplying
  `host: 'email-smtp.<region>.amazonaws.com'`. Fixed-host presets
  (Resend / Gmail / SendGrid / Mailgun) deliberately ignore host
  overrides to prevent "changed host, kept the API key" footguns.
- **`Channel.canSend(payload)` pre-flight hook (optional).** Channels
  can return a `SendResult` (typically `{ status: 'skipped' }`) before
  the service consumes a rate-limit token. Built-in `EmailChannel`,
  `SmsChannel`, and `PushChannel` implement it to skip when the
  recipient field for that channel is missing — preventing a mixed-
  channel batch from burning, say, email quota on a payload that was
  never going to deliver email. Channels that omit `canSend` keep
  working exactly as before.
- **`queueFailureMode` config knob** on `NotificationService`. Controls
  how the queue processor signals failure to the queue adapter:
  - `'throw-on-total-failure'` (new default) — when
    `sent === 0 && failed > 0`, the processor throws so the queue
    marks the job failed and its retry policy kicks in. Partial
    successes resolve normally so a retry can't double-send the
    channels that already delivered.
  - `'always-complete'` — legacy behavior preserved for hosts whose
    delivery log is the source of truth for failures.

### Changed

- **Queue jobs no longer silently complete on total dispatch failure.**
  Previously, the queue processor swallowed `DispatchResult` and
  resolved every job, so `MemoryQueue` (or a BullMQ adapter) would
  mark a job completed even when every channel raised. The processor
  now propagates total failure under the default `queueFailureMode`.
  Opt back into the old behavior with
  `queueFailureMode: 'always-complete'`.
- **Rate-limit tokens are no longer consumed for deterministic skips.**
  `sendToChannel` calls `channel.canSend?.(payload)` before
  `rateLimitStore.consume()`. This fixes a quota-exhaustion footgun
  where a payload addressing an email recipient with no `phone` would
  still decrement the SMS channel's quota.
- `package.json` adds a `typesVersions` map so node10-style resolvers
  find subpath declarations (`./channels`, `./providers`, `./utils`).

### Test infrastructure

- Live network tests now live behind a dedicated
  `vitest.live.config.ts` and the `npm run test:live` script. The
  default `npm test` glob no longer includes `*.live.test.ts`, so a
  fresh checkout — even with the workspace `.env.dev` mounted —
  cannot accidentally trigger real SMTP sends.
- `prepublishOnly` and `release` now run `npm test` (unit suite) in
  addition to the build + typecheck.
- New live "send" suite (`EMAIL_LIVE_SEND_TO=<inbox>`) actually invokes
  `nodemailer.sendMail` for each provider with creds in the
  environment, so deliverability can be smoke-tested before publish.
  The send gate is intentionally NOT placed in shared env files —
  export it per-shell.
- `tests/setup-env.ts` auto-loads workspace `../.env.dev` plus
  package-local `.env` / `.env.test` / `.env.test.local`; shell vars
  always win.

### Dependencies

- `nodemailer >=6` remains the only optional peer dependency.

## [2.0.0] - 2026-03-24

### Added

- `SmsChannel` and `PushChannel` with bring-your-own-provider integrations
- Rate limiting, delivery logging, and queue-backed delivery
- Built-in template resolver via `createSimpleResolver()`
- Channel fallback with `withFallback()`
- Delayed delivery via `payload.delay`
- Status webhook helper via `createStatusHandler()`
- Provider adapter examples and observability notes
- `DispatchResult.queued` plus `send:rate_limited` and `send:queued` events

### Changed

- Skipped notifications now go through delivery logging and lifecycle events
- `EmailChannel` now protects critical mail fields from being overridden by defaults
- `pMap()` now validates invalid concurrency values
- `MemoryQueue.drain()` now cancels delayed jobs correctly
- `WebhookChannel` now uses a static `node:crypto` import
- Queue processing is owned by the service when a queue adapter is attached
- `withFallback()` now works correctly with queued delivery
- Bumped `tsdown` to v0.21.4

### Removed

- `batchBcc` from `EmailChannelConfig`
- `priority` from `QueueEnqueueOptions`

### Dependencies

- `nodemailer >=6` remains the only optional peer dependency

## [1.1.0] - 2026-02-24

### Added

- **EmailChannel** — Send email notifications via Nodemailer (SMTP, Gmail, SES, any transport)
  - Lazy nodemailer import (zero overhead if unused)
  - Pre-created transporter support for SES and custom transports
  - `verify()` method for SMTP connection health checks
  - `close()` method for graceful shutdown
  - Attachments, CC/BCC, reply-to, custom `from` per-send
- **EmailChannel types** — `EmailChannelConfig`, `SmtpTransportOptions`, `EmailAttachment`, `NodemailerTransporter`
- **`QuietHoursConfig` type export** — Now available for consumers using `isQuietHours()` directly

## [1.0.0] - 2026-02-20

### Added

- **NotificationService** — Central orchestrator with send, batch send, hook factories, and lifecycle events
- **WebhookChannel** — HTTP POST/PUT with HMAC-SHA256 signing, custom headers, timeout (zero deps, native fetch)
- **ConsoleChannel** — Logs to console for development and testing
- **BaseChannel** — Abstract base class with event filtering and wildcard support (`user.*`)
- **Templates** — Pluggable template resolver (React Email, MJML, Handlebars, etc.)
- **Retry + Backoff** — Exponential, linear, or fixed backoff with jitter; per-channel overrides
- **User Preferences** — Per-user, per-event, per-channel opt-in/out with quiet hours
- **Quiet Hours** — Timezone-aware quiet period enforcement via `Intl.DateTimeFormat` (zero deps)
- **Idempotency** — Built-in deduplication with pluggable stores (memory default, Redis/DB via interface)
- **Batch Sending** — Worker-pool concurrency (`pMap`) with progress callback
- **Lifecycle Events** — `before:send` (fail-fast), `after:send`, `send:success`, `send:failed`, `send:retry`
- **Hook Factories** — `createHooks()` + `mergeHooks()` for EventEmitter/MongoKit/custom integration
- **Error Classes** — `NotificationError`, `ChannelError`, `ProviderNotInstalledError`
- **Utilities** — `withRetry`, `calculateDelay`, `resolveRetryConfig`, `Emitter`, `pMap`, `isQuietHours`, `MemoryIdempotencyStore`
- Full TypeScript types with ESM-only output
- Zero required dependencies (nodemailer is optional peer)
