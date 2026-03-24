# Observability & Operations Guide

## Metrics to Track

### Core Metrics

| Metric | Source | What to alert on |
|--------|--------|-----------------|
| `notifications.sent` | `send:success` event | Sudden drop = provider issue |
| `notifications.failed` | `send:failed` event | Spike = investigate immediately |
| `notifications.skipped` | `after:send` (skipped > 0) | High rate = preferences misconfigured |
| `notifications.rate_limited` | `send:rate_limited` event | Sustained = increase limits or add channels |
| `notifications.queued` | `send:queued` event | Growing backlog = processing too slow |
| `notifications.duration_ms` | `after:send` result.duration | P99 spike = provider latency |

### Per-Channel Metrics

```typescript
notifications.on('after:send', (result) => {
  for (const r of result.results) {
    metrics.increment(`notification.channel.${r.channel}.${r.status}`);
    if (r.duration) {
      metrics.histogram(`notification.channel.${r.channel}.duration_ms`, r.duration);
    }
  }
});

notifications.on('send:rate_limited', ({ channel }) => {
  metrics.increment(`notification.channel.${channel}.rate_limited`);
});
```

### Delivery Funnel

Track the full lifecycle via status webhook:

```
queued → accepted → sent → delivered → opened → clicked
                         ↘ bounced
                         ↘ undelivered
                         ↘ complained
```

```typescript
const handler = createStatusHandler({
  onStatusChange: (update) => {
    metrics.increment(`notification.delivery.${update.provider}.${update.status}`);
  },
});
```

## OpenTelemetry Integration

Wrap the service for distributed tracing:

```typescript
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('notifications');

notifications.on('before:send', (payload) => {
  const span = tracer.startSpan('notification.send', {
    attributes: {
      'notification.event': payload.event,
      'notification.recipient_id': payload.recipient.id,
      'notification.channels': payload.channels?.join(',') ?? 'all',
    },
  });
  // Store span in payload metadata for after:send
  payload.metadata = { ...payload.metadata, _span: span };
});

notifications.on('after:send', (result) => {
  const span = (result as any)._span;
  if (span) {
    span.setAttributes({
      'notification.sent': result.sent,
      'notification.failed': result.failed,
      'notification.skipped': result.skipped,
      'notification.duration_ms': result.duration,
    });
    if (result.failed > 0) {
      span.setStatus({ code: 2, message: 'Partial or full failure' });
    }
    span.end();
  }
});
```

## Logging Patterns

### Structured Logging with Pino

```typescript
import pino from 'pino';

const logger = pino({ level: 'info' });

const service = new NotificationService({
  channels: [...],
  logger: {
    info: (msg, ...args) => logger.info({ args }, msg),
    warn: (msg, ...args) => logger.warn({ args }, msg),
    error: (msg, ...args) => logger.error({ args }, msg),
    debug: (msg, ...args) => logger.debug({ args }, msg),
  },
});
```

### Audit Trail Queries

```typescript
const log = service.getDeliveryLog();

// Failed deliveries in the last hour
const failures = log.query({
  status: 'failed',
  after: new Date(Date.now() - 3_600_000),
});

// Everything sent to a specific user
const userHistory = log.query({ recipientId: 'u1' });

// Channel-specific issues
const smsFails = log.query({ channel: 'sms', status: 'failed' });
```

## Health Checks

```typescript
// Email SMTP health
const emailChannel = service.getChannel('email') as EmailChannel;
const smtpHealthy = await emailChannel.verify();

// Queue depth
const queueSize = await queue.size();
if (queueSize > 1000) {
  alert('Notification queue backlog exceeds 1000');
}

// Rate limit headroom
const remaining = rateLimitStore.remaining('email', { maxPerWindow: 500, windowMs: 86_400_000 });
if (remaining < 50) {
  alert('Email rate limit nearly exhausted');
}
```

## Alerting Rules

| Alert | Condition | Action |
|-------|-----------|--------|
| High failure rate | `failed / (sent + failed) > 0.1` over 5 min | Check provider status, review errors |
| Queue backlog | `queue.size() > 1000` | Scale workers, check processing speed |
| Rate limit exhausted | `remaining < 10%` of window | Add capacity, prioritize critical sends |
| Delivery bounce spike | `bounced` status > 5% of sent | Review recipient list quality |
| Channel completely down | 0 sends on a channel for 15 min | Failover to backup channel |

## Ops Runbook

### Notification not received

1. Check delivery log: `log.query({ recipientId, event })`
2. Check if skipped (quiet hours, preferences, idempotency)
3. Check if rate limited (look for `send:rate_limited` events)
4. Check provider status via status webhook updates
5. Check queue depth if using queue adapter

### High latency

1. Check `result.duration` in `after:send` events
2. Identify slow channel via per-channel duration metrics
3. Check provider latency (SMTP connection time, API response time)
4. Consider reducing batch concurrency to avoid provider throttling

### Queue growing

1. Check worker error rate (failing jobs retry and re-queue)
2. Check if queue is paused
3. Check if processor is attached (`queue.process(...)`)
4. Consider increasing `MemoryQueue` concurrency
