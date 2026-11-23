# Push transports: design notes (`@classytic/notifications/push`)

Scope: the FCM HTTP v1 provider, the APNs HTTP/2 provider, the platform router and the content-free
helpers added in the unreleased minor (suggested 2.9.0). The arc wiring (devices, stored credentials,
channel, admin resource) lives in `@classytic/arc-notifications/push`; its `DESIGN.md` covers that layer.

Source: generalised from the push stack of a production incident-management app
(`apps/server/src/modules/notify/` there). What changed on the way is listed at the end.

## 1. Stateless vs stored

Providers hold **no durable state**. In memory, per provider instance (so per process):

| Cached | Lifetime | Why it is safe to lose |
|---|---|---|
| Imported `KeyObject` | until the credentials fingerprint changes | re-imported from the next `credentials()` value |
| FCM OAuth2 access token | until 60 s before `expires_in` | one token request rebuilds it |
| APNs provider JWT | `tokenTtlMs` (50 min) | re-signed locally, no network |
| APNs HTTP/2 session | until GOAWAY / close / error / `close()` | reopened on the next send |
| Cool-down deadline | until `Retry-After` passes | worst case one extra 429 |

Nothing touches disk. Nothing requires sticky routing: two instances each hold their own token and
session, which both Google and Apple expect (Apple asks for a few long-lived connections, not one).

What the HOST must persist (not this package): device tokens (to know where to send and to delete dead
ones), credentials (env, or encrypted at rest; arc-notifications provides the store), and optionally a
delivery log. What must never be persisted by anyone: raw keys in logs, full device tokens in logs,
payload text of content-free pushes.

## 2. Credentials

- **A function, never env.** `credentials: T | () => T | Promise<T>`. The provider calls it on every
  send and compares a fingerprint: `version` when set, else a sha256 of the sorted fields. Same
  fingerprint: reuse the imported key and tokens. Different: validate, re-import, drop the cached
  access token / JWT (and close APNs sessions to a host no longer used). A rotated key therefore
  applies on the next send, with no restart and no timer.
- The function should be cheap (return a cached object). `fromIntegrations` in arc-notifications caches
  for 30 s and tags `version` with the record version, so the fingerprint is a string compare.
- A source that throws a non-credentials error (the store is down) surfaces as `TransientPushError`
  (`credentials-unavailable`): retryable. A `PushCredentialsError` (not configured, malformed) is
  permanent.
- Validation imports the key with `createPrivateKey` and checks its type (RSA for FCM, EC P-256 for
  APNs) and the id formats. Node's own parse error is discarded because it can quote input.

## 3. Failure algorithm

**Classification first, retry second.** Every provider answer maps to exactly one of four errors
(table in the README). Only `TransientPushError` is retryable; the other three carry
`retryable: false`, which `PushChannel` turns into `{ status: 'failed', retryable: false }` so the
service makes one attempt.

- **Retry/backoff**: the service's existing `withRetry` (exponential, plus/minus 25 % jitter) does the
  retrying. Providers do not loop, with two exceptions that are not retries of the same request but
  repairs of our own state: FCM 401 (refresh the access token, resend once) and APNs 403
  `ExpiredProviderToken` / `InvalidProviderToken` (re-sign, resend once). A second refusal is a
  `PushCredentialsError`.
- **Retry-After**: providers parse it (delta-seconds or HTTP-date, capped at one hour) into
  `retryAfterMs`. `withRetry` now waits at least that long; when the hint exceeds `maxDelay` it stops
  instead of shortening the wait, leaving the retry to the host's queue. Hammering a provider that said
  "not before T" is exactly what the header forbids.
- **Provider floors (2.10, ADR 0001 section 5.3 in arc-ecosystem)**: every `TransientPushError` carries
  `retryFloorMs` from one table (`PUSH_RETRY_DEFAULTS`, `pushRetryFloorMs`): FCM 10 s for 5xx /
  network ("first retry at least 10 s", Scale FCM), FCM 429 60 s ("Retry-After, else 60 s"; ErrorCode:
  1 minute initial delay for quota), APNs 5xx 15 min ("After 15 minutes, you can retry"), APNs 429 60 s
  (our value), network / unknown 10 s (our value). The constructor fills it, so every throw site (and
  any future one) gets it; a site may override. `withRetry` treats it like `Retry-After`.
- **Scheduling, not sleeping**: `pushRetryDelay` = `max(Retry-After, floor) x 2^(n-1)`, capped at 60 min
  of growth (a floor above the cap still wins), plus 0 to 20 % jitter that only ADDS, so no jittered
  value undercuts a provider minimum. `planPushRetry` stops on a permanent error, after 5 attempts,
  past FCM's 60 min continuous-failure window, or when the next attempt would land at or after the
  notification's `expiresAt`. Both are pure; the caller enqueues the next attempt
  (arc-notifications' `push.device` job). In-process sleeps were rejected in ADR 0001 section 13: they
  hold a worker for minutes and cannot honour 15 min floors.
- **Cool-down, not a circuit breaker.** After a provider-wide 429 or a 5xx that carried `Retry-After`,
  the provider instance fails fast (retryable, with the remaining wait) until the deadline, without a
  network call. A per-device 429 (FCM "Device message rate exceeded", APNs `TooManyRequests`) does not
  pause the provider: it would block every other user's pushes. A full breaker was rejected: it would
  open on the package's own guess of "unhealthy" (a run of per-token failures looks like an outage), its
  state would differ per instance anyway, and the queue plus Retry-After already give back-pressure.
- **Concurrency**: `maxConcurrency` per provider instance (FCM 100 in-flight requests, APNs 500 streams;
  Apple allows about 1000 per connection). FCM HTTP v1 has no multicast and its batch endpoint is
  retired, so "batching" is bounded parallelism; the device fan-out channel in arc-notifications adds a
  per-recipient limit on top.
- **Idempotency**: neither provider is idempotent on the wire. At-least-once event delivery is made
  safe one level up: the service's `idempotencyKey` (atomic claim in `RedisIdempotencyStore` across
  processes), suffixed per recipient by arc-notifications' triggers, and (2.10) per channel:
  `${key}:${channel}` is claimed before the template renders and recorded only for channels that
  sent, so a failed push beside a delivered in-app row is retried and the in-app row is not written
  twice. 2.9 recorded the whole payload key as soon as any channel sent (`scope: 'payload'` keeps
  that). Per DEVICE deduplication is arc-notifications' (`push:<org>:<key>:<user>:<deviceKey>`).
- **Timeouts**: 10 s per HTTP call (FCM: `AbortSignal.timeout`; APNs: stream timeout + cancel). A
  timeout is transient.

## 4. Logging and redaction

- Error messages are built from status fields only: provider name, HTTP status, the provider's reason
  code, and the last 6 characters of the token. FCM and APNs error bodies are parsed for codes and then
  dropped, because they can echo the token. Credentials never appear in any message; validation
  errors name fields.
- `onDelivery` is the opt-in structured log: `{ provider, platform, outcome, status, reason,
  messageId, tokenSuffix, tokenHash (sha256 prefix), latencyMs, retryAfterMs }`. Safe to persist; joins
  rows for one device without storing its token. No title, body or data.
- The service's delivery log records `SendResult`s, whose `error` is the redacted message above.

## 5. Security

- **TLS**: Node defaults (certificate verification on) for both `fetch` and `http2.connect`. A
  plaintext APNs host is refused unless `allowPlaintext` is set (tests against a local h2c server).
  `connectOptions` exists for a test CA or a proxy, not for disabling verification.
- **Keys in memory**: the PEM string the source returned and the imported `KeyObject`; nothing is
  written out, nothing is put on `globalThis`. A rotation replaces both.
- **Token refresh timing**: FCM 60 s before expiry; APNs 50 min, inside Apple's 20 to 60 min rule (more
  often than every 20 min risks `TooManyProviderTokenUpdates`).
- **Input validation before the network**: token shape (APNs: hex only, so the `:path` cannot be
  injected), collapse key at most 64 bytes (rejected, not truncated: truncation can merge two keys),
  FCM data values must be strings and not reserved keys, `data.aps` refused, APNs payload at most
  4096 bytes.
- **Dead-token caution**: `invalid-token` / `bad-device-token` also fire for a token from another
  project or APNs environment. The hook gets the `reason`, so a host unsure its config matches the app
  build can delete only on `unregistered`.

## 6. Backward compatibility

- Root exports unchanged in shape. `PushProviderMessage` and three union types are new exports; the
  inline message type became that named interface with only OPTIONAL additions, and `close()` on
  `PushProvider` is optional, so a 2.8 provider (narrower parameter, no `close`) still type-checks
  (`tests/types/push-contract.ts`).
- `PushChannel` behaviour is unchanged unless a payload opts in: new hints are read only when
  well-typed; a title-less send is still skipped unless `data.contentAvailable` / `data.dataOnly` is
  `true`.
- `withRetry` changes only for errors that carry `retryAfterMs` (no previous error did).
- Everything else is behind the new `./push` subpath. Suggested version: **2.9.0 (minor)**. Not
  published.

### 2.10 (unreleased)

- Additive: `TransientPushError.retryFloorMs`, `retryFloorHint`, `PUSH_RETRY_DEFAULTS`,
  `pushRetryFloorMs`, `pushRetryDelay`, `planPushRetry`, `idempotency.scope`.
- Behaviour changes, both toward the providers' and the ADR's rules: (1) per-channel idempotency is
  the default (keys gain a `:<channel>` suffix; a 2.9 key does not dedupe a post-upgrade redelivery;
  with a queue, a retryable failed channel beside a sent one now re-runs the job); (2) `withRetry`
  waits at least a push error's floor, so an FCM 5xx is retried in process after 10 s instead of
  0.5 s, and not at all in process when `maxDelay` is below the floor.

## 7. What changed from the source app

| Source app | Here | Why |
|---|---|---|
| FCM via `firebase-admin` (lazy import) | FCM HTTP v1 over `fetch` | zero dependencies; one less 20 MB SDK |
| Application Default Credentials when no key | not supported | ADC needs the metadata server; pass credentials explicitly |
| `DeviceTokenNotForTopic` deletes the device | rejected, device kept | a wrong bundle id would delete every iOS device |
| `apns-collapse-id` sliced to 64 chars | rejected over 64 bytes | slicing can merge distinct keys and split a UTF-8 character |
| `critical` derived from `data.class === 'critical'` | `interruptionLevel` field | generic; the app maps its own classes |
| Key material from fixed env names | `credentials` function | env or database, rotation without restart |
| No Retry-After handling | honoured, plus per-provider cool-down | provider etiquette |

The source app's migration path is in `@classytic/arc-notifications`' `MIGRATION.md`.
