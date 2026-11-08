# Service features

## Constructor

`new NotificationService({ channels, templates, retry, preferences, logger, idempotency: { store, ttl, leaseMs }, deliveryLog, rateLimitStore, queue, queueFailureMode })`.
Methods: `send`, `sendBatch`, `addChannel`, `removeChannel`, `getChannel`, `getChannelNames`, `getDeliveryLog`, `createHooks`, `on`, `off`.

Pipeline: `before:send` -> idempotency claim -> template -> channel filter (`channels`, `events`) -> preferences and quiet hours -> rate limit -> send with retry -> delivery log -> `after:send`.

## Batch

```ts
const out = await service.sendBatch(payloads, { concurrency: 10, onProgress: ({ completed, total, result }) => {} });
// { total, sent, failed, skipped, duration, results: DispatchResult[] }
```

`pMap(items, fn, { concurrency })` is the underlying bounded map.

## Idempotency

`idempotencyKey` on the payload. Default `MemoryIdempotencyStore` (single process). Use `RedisIdempotencyStore({ client, prefix })` across processes; `client` is any structural `RedisIdempotencyClient` (ioredis fits).
Stores implementing `claim(key, leaseMs)` and `release(key)` give atomic dedup; the lease (`leaseMs`, default 5 minutes) bounds how long a crashed sender holds a key. Success keeps the key for `ttl` (default 24 h); zero sent or a thrown error releases it.
Stores with only `has`/`set` still work but are check-then-act.

## Rate limiting

`rateLimit: { maxPerWindow, windowMs }` per channel, token bucket in `MemoryRateLimitStore`. Distributed: implement `RateLimitStore` (`consume`, `remaining`, `reset`) and pass `rateLimitStore`.
A limited send is `skipped` with `error: 'Rate limited'` and emits `send:rate_limited`.

## Delivery log

Every attempt is recorded (`delivered`, `partial`, `failed`, `skipped`). `MemoryDeliveryLog` is for tests; production implements `DeliveryLog` over a database. Query fields: `recipientId`, `recipientEmail`, `event`, `subject`,
`channel`, `status`, `after`, `before`, `limit`. A store must serve `subject` queries from an index. Pass `subject: { sourceModel, sourceId }` on the payload to link entries to a business document.

## Queue and delay

`queue: new MemoryQueue()` or your `QueueAdapter` (`enqueue`, `process`, `getJob`, `size`, `pause`, `resume`, `drain`). The service registers its processor on construction; `send` returns `{ queued: true }`.
`delay` (ms) schedules the job. `queueFailureMode`: `'throw-on-total-failure'` (default; the job retries) or `'always-complete'`. If your app already has a worker, skip `queue` and call `service.send` from the worker.

## Preferences and quiet hours

```ts
preferences: async (recipientId, event) => ({ channels: { sms: false }, events: { 'marketing.*': false }, quiet: { start: '22:00', end: '07:00', timezone: 'Asia/Dhaka' } })
```

Opt-outs and quiet hours skip delivery; `isQuietHours({ start, end, timezone })` is the pure check (overnight ranges supported, `Intl` based). Preference lookup failures fail open (logged, delivery proceeds).

## Retry

`retry: { maxAttempts, backoff: 'exponential' | 'linear' | 'fixed', initialDelay, maxDelay }`, jitter of 25 percent. Per-channel `retry` overrides. Default is one attempt. `send:retry` fires per retry.

## Templates

`createSimpleResolver({ id: { subject, html, text } })` interpolates `${a.b}` (HTML-escaped in html fields). Any `TemplateResolver` `(id, data) => TemplateResult | Promise<TemplateResult>` works (React Email, MJML).

## Fallback

`withFallback(service, payload, ['push', 'sms', 'email'], { onFallback(failedChannel, error, nextChannel) {} })` stops at the first success.

## Hooks

```ts
const hooks = service.createHooks([{ event: 'order.completed', getRecipient: (o) => ({ email: o.email }), getData: (o) => ({ id: o.id }), template: 'order', channels: ['email'] }]);
emitter.on('order.completed', hooks['order.completed'][0]);   // or a repository after:create hook
```

Hooks are fire and forget (errors logged). Combine maps with `mergeHooks(a, b)`.

## Lifecycle events

`service.on(name, handler)`: `before:send` (throwing aborts), `after:send` (always, including skips), `send:success`, `send:failed`, `send:retry`, `send:rate_limited`, `send:queued`. Listener errors after the send are logged, never mask the result.

## Status webhooks

`createStatusHandler({ onStatusChange })` normalizes provider receipts: `handler.handle({ provider, notificationId, channel, status, timestamp, rawPayload })`. Statuses: `queued accepted sent delivered undelivered bounced opened clicked complained unsubscribed`.
Write a small mapper per provider; persist in `onStatusChange`.

## Operations

Track per channel: sent, failed, skipped, retry count, duration (from `after:send`). Alert on failed-rate and queue depth (`queue.size()`). Health: `EmailChannel.verify()`. Unfamiliar skips: read `result.results[].error`
(`Rate limited`, `No recipient email`, quiet hours, opt-out).
