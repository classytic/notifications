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

The underlying `pMap` is exported for reuse:

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

**Important:** Preferences are only evaluated when `recipient.id` is provided. If no `id`, preferences are skipped.

### Preference Resolution Flow

1. If `prefs.quiet` is set and `isQuietHours()` returns true → skip ALL channels
2. If `prefs.channels` is set → filter out opted-out channels (`false`)
3. If `prefs.events[event]` is `false` → skip entirely

### PreferenceResolver Type

```typescript
type PreferenceResolver = (
  recipientId: string,
  event: string,
) => NotificationPreferences | Promise<NotificationPreferences | null> | null;

interface NotificationPreferences {
  channels?: Record<string, boolean>;
  events?: Record<string, boolean>;
  quiet?: QuietHoursConfig;
}
```

## Quiet Hours

Timezone-aware quiet period enforcement. Uses `Intl.DateTimeFormat` (zero deps). Overnight ranges supported (e.g., 22:00–07:00).

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
    channels: ['email'],       // only email for this event
    enabled: true,             // can disable without removing
  },
]);

// Plug into EventEmitter
emitter.on('user.created', hooks['user.created'][0]);

// Plug into MongoKit
repo.on('after:create', hooks['user.created'][0]);
```

Hooks are fire-and-forget: errors logged, never thrown. If `getRecipient` returns `null`, the notification is skipped.

### Merging Hooks

Combine hooks from multiple sources:

```typescript
import { mergeHooks } from '@classytic/notifications/utils';

const combined = mergeHooks(
  notifications.createHooks(userHookConfigs),
  notifications.createHooks(orderHookConfigs),
);
```

### Hook Config Type

```typescript
interface NotificationHookConfig<T = unknown> {
  event: string;
  channels?: string[];
  getRecipient: (eventData: T) => Recipient | Promise<Recipient | null> | null;
  getData: (eventData: T) => Record<string, unknown>;
  template?: string;
  enabled?: boolean;            // default: true
}
```

## Channel Management

```typescript
// Runtime add/remove
notifications.addChannel(new ConsoleChannel());
notifications.removeChannel('console');

// Inspect
notifications.getChannel('email');      // Channel | undefined
notifications.getChannelNames();        // ['email', 'webhook']
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
    debug?(message, ...args) { /* ... */ },  // optional
  },
});

// Or pass your Fastify/Pino logger directly
new NotificationService({ logger: app.log });
```

Default: silent (no output).

## Full Send Lifecycle

1. Emit `before:send` (awaited, fail-fast — throwing aborts)
2. Idempotency check (skip if duplicate key seen)
3. Template resolution (merge result into payload.data)
4. Channel filtering (event match + target list)
5. Preference filtering (channel opt-out, event opt-out)
6. Quiet hours check (skip if in quiet period)
7. Send to all matching channels in parallel (with retry)
8. Record idempotency key (only if sent > 0)
9. Emit `after:send` (safe)
10. Emit `send:success` or `send:failed` (safe)
