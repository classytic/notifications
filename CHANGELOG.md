# Changelog

All notable changes to `@classytic/notifications` will be documented in this file.

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
