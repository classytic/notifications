# Changelog

All notable changes to `@classytic/notifications` will be documented in this file.

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
