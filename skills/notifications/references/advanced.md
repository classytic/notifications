# Advanced Features

## Batch Sending

Send thousands of notifications with controlled concurrency using a worker-pool pattern. Each notification goes through the full `send()` pipeline (lifecycle, templates, preferences, retry). Errors in individual notifications are caught and reported — they never abort the batch.

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

### BatchResult

```typescript
interface BatchResult {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  duration: number;          // wall-clock ms
  results: DispatchResult[]; // per-notification, same order as input
}
```

### Concurrency Utility

The underlying `pMap` is exported for reuse. Validates concurrency input — throws `RangeError` for `concurrency < 1` or non-integer values.

```typescript
import { pMap } from '@classytic/notifications/utils';

const results = await pMap(
  urls,
  async (url) => fetch(url).then(r => r.json()),
  { concurrency: 5 },
);
```

Worker-pool pattern: N workers pull from a shared queue, keeping the pipeline full at all times. Results maintain input order.

## Idempotency / Deduplication

Prevent duplicate notifications by providing an `idempotencyKey`. The key is only recorded after at least one channel succeeds.

```typescript
const notifications = new NotificationService({
  channels: [new EmailChannel({ ... })],
  idempotency: {},                             // MemoryIdempotencyStore, 24h TTL
});

await notifications.send({
  event: 'order.completed',
  recipient: { email: 'user@example.com' },
  data: { orderId: '123' },
  idempotencyKey: 'order-completed-123',       // duplicate sends → skipped
});
```

### Custom Store + TTL

```typescript
// Custom TTL
new NotificationService({
  idempotency: { ttl: 60 * 60 * 1000 },       // 1 hour (default: 24h)
});

// Custom store (Redis for distributed systems)
import type { IdempotencyStore } from '@classytic/notifications/utils';

class RedisIdempotencyStore implements IdempotencyStore {
  async has(key: string): Promise<boolean> {
    return !!(await redis.exists(`idemp:${key}`));
  }
  async set(key: string, ttlMs: number): Promise<void> {
    await redis.set(`idemp:${key}`, '1', 'PX', ttlMs);
  }
}

new NotificationService({
  idempotency: { store: new RedisIdempotencyStore() },
});
```

### IdempotencyStore Interface

```typescript
interface IdempotencyStore {
  has(key: string): boolean | Promise<boolean>;
  set(key: string, ttlMs: number): void | Promise<void>;
}
```

The built-in `MemoryIdempotencyStore` uses an in-memory Map with TTL and lazy cleanup every 100 writes. Suitable for single-process; use Redis/DB for distributed.

## Rate Limiting Details

Per-channel token bucket algorithm. Prevents exceeding provider limits (Gmail 500/day, SendGrid per-second, etc.).

```typescript
// Any channel can have rate limiting
new EmailChannel({
  from: 'noreply@app.com',
  transport: { ... },
  rateLimit: { maxPerWindow: 500, windowMs: 86_400_000 },
});

new SmsChannel({
  from: '+15551234567',
  provider: { ... },
  rateLimit: { maxPerWindow: 100, windowMs: 60_000 }, // 100/minute
});
```

When rate limited: `status: 'skipped'`, `error: 'Rate limited'`, `send:rate_limited` event emitted.

### RateLimitStore Interface

```typescript
interface RateLimitStore {
  consume(channelName: string, config: RateLimitConfig): boolean | Promise<boolean>;
  remaining(channelName: string, config: RateLimitConfig): number | Promise<number>;
  reset(channelName: string): void | Promise<void>;
}
```

Built-in `MemoryRateLimitStore` uses sliding window. Auto-created when any channel has `rateLimit` config. For distributed, implement with Redis.

## Delivery Tracking Details

Every send attempt is logged — including skips (idempotency, quiet hours, preferences).

```typescript
import { MemoryDeliveryLog } from '@classytic/notifications/utils';

const log = new MemoryDeliveryLog({ maxEntries: 10_000 }); // evicts oldest when full
const service = new NotificationService({ channels: [...], deliveryLog: log });

// Query with filters
const entries = log.query({
  recipientId: 'u1',
  recipientEmail: 'user@example.com',
  event: 'order.completed',
  channel: 'email',
  status: 'delivered',           // 'delivered' | 'partial' | 'failed'
  after: new Date('2026-01-01'),
  before: new Date(),
  limit: 100,
});

// Get by ID
const entry = log.get(entries[0].id);
```

### DeliveryLog Interface

```typescript
interface DeliveryLog {
  record(payload: NotificationPayload, dispatch: DispatchResult): void | Promise<void>;
  query(filter: DeliveryLogQuery): DeliveryLogEntry[] | Promise<DeliveryLogEntry[]>;
  get(id: string): DeliveryLogEntry | null | Promise<DeliveryLogEntry | null>;
}
```

### DeliveryLogEntry

```typescript
interface DeliveryLogEntry {
  id: string;
  timestamp: Date;
  event: string;
  recipientId?: string;
  recipientEmail?: string;
  channels: string[];
  results: SendResult[];
  status: 'delivered' | 'partial' | 'failed';
  duration: number;
  metadata?: Record<string, unknown>;
}
```

## Queue Adapter Details

Crash-resilient delivery. The service owns the queue — it calls `process()` on construction. When configured, `send()` enqueues and returns `{ queued: true }`.

**Ownership model:** The service owns its queue. If your app already has a queue (BullMQ, SQS, etc.), don't pass it here — have your existing worker call `service.send()` directly when it picks up a job.

```typescript
import { MemoryQueue } from '@classytic/notifications/utils';

const queue = new MemoryQueue({ concurrency: 5 });
const service = new NotificationService({ channels: [...], queue });

// Jobs are processed asynchronously
const result = await service.send({ ... }); // returns { queued: true }

// Delayed delivery
await service.send({ ..., delay: 3_600_000 }); // send in 1 hour

// Queue management
queue.pause();
queue.resume();
queue.drain();  // cancels all pending jobs (including delayed timers)
```

### QueueAdapter Interface

```typescript
interface QueueAdapter {
  enqueue(payload: NotificationPayload, options?: QueueEnqueueOptions): string | Promise<string>;
  process(processor: QueueProcessor): void | Promise<void>;
  getJob(id: string): QueueJob | null | Promise<QueueJob | null>;
  size(): number | Promise<number>;
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
  drain(): void | Promise<void>;
}

interface QueueEnqueueOptions {
  delay?: number;        // delay before processing (ms)
  maxAttempts?: number;  // default: 3
}
```

`MemoryQueue` retries failed jobs up to `maxAttempts`. For production, implement with BullMQ or your database.

## User Preferences

Filter channels per-user with a preference resolver:

```typescript
const notifications = new NotificationService({
  preferences: async (recipientId, event) => {
    const prefs = await db.getUserPrefs(recipientId);
    return {
      channels: { email: true, sms: false },        // opt-out of SMS
      events: { 'marketing.promo': false },          // opt-out of promos
      quiet: {
        start: '22:00',
        end: '07:00',
        timezone: 'America/New_York',
      },
    };
  },
});
```

**Important:** Preferences are only evaluated when `recipient.id` is provided.

### Preference Resolution Flow

1. If `prefs.quiet` is set and `isQuietHours()` returns true -> skip ALL channels
2. If `prefs.channels` is set -> filter out opted-out channels (`false`)
3. If `prefs.events[event]` is `false` -> skip entirely
4. All skipped outcomes are logged to delivery log and emit `after:send`

## Quiet Hours

Timezone-aware quiet period enforcement. Uses `Intl.DateTimeFormat` (zero deps). Overnight ranges supported (e.g., 22:00-07:00).

```typescript
// Via preferences (automatic)
preferences: async (recipientId) => ({
  quiet: {
    start: '22:00',             // HH:MM, inclusive
    end: '07:00',               // HH:MM, exclusive
    timezone: 'Asia/Dhaka',     // IANA timezone (default: UTC)
  },
});

// Direct utility usage
import { isQuietHours } from '@classytic/notifications/utils';

if (isQuietHours({ start: '22:00', end: '07:00', timezone: 'Asia/Dhaka' })) {
  console.log('Quiet hours active');
}
```

## Hook Factories

Generate event handlers for any hook/event system (EventEmitter, MongoKit, custom):

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
    enabled: true,
  },
]);

// Plug into EventEmitter
emitter.on('user.created', hooks['user.created'][0]);

// Plug into MongoKit
repo.on('after:create', hooks['user.created'][0]);
```

Hooks are fire-and-forget: errors logged, never thrown.

### Merging Hooks

```typescript
import { mergeHooks } from '@classytic/notifications/utils';

const combined = mergeHooks(
  notifications.createHooks(userHookConfigs),
  notifications.createHooks(orderHookConfigs),
);
```

## Channel Management

```typescript
notifications.addChannel(new ConsoleChannel());
notifications.removeChannel('console');
notifications.getChannel('email');      // Channel | undefined
notifications.getChannelNames();        // ['email', 'sms', 'push']
```

## Error Classes

```typescript
import { NotificationError, ChannelError, ProviderNotInstalledError } from '@classytic/notifications/utils';

// NotificationError — base error with code, channel, cause
// ChannelError — prefixes message with channel name
// ProviderNotInstalledError — thrown when optional dep missing (e.g., nodemailer)
```

## Logger

Plug any logger compatible with console/pino/winston:

```typescript
new NotificationService({
  logger: {
    info(message, ...args) { /* ... */ },
    warn(message, ...args) { /* ... */ },
    error(message, ...args) { /* ... */ },
    debug?(message, ...args) { /* ... */ },
  },
});
```

Default: silent (no output).

## Full Send Lifecycle

1. Emit `before:send` (awaited, fail-fast — throwing aborts)
2. Idempotency check (skip if duplicate key seen)
3. Template resolution (merge result into payload.data)
4. Channel filtering (event match + target list)
5. Preference filtering (channel opt-out, event opt-out)
6. Quiet hours check (skip if in quiet period)
7. Rate limit check per channel (skip if over limit)
8. Send to all matching channels in parallel (with retry)
9. Record idempotency key (only if sent > 0)
10. **Finalize** (all outcomes, including skips):
    - Record to delivery log
    - Emit `after:send`
    - Emit `send:success` or `send:failed`
