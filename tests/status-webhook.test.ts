import { describe, it, expect, vi } from 'vitest';
import { createStatusHandler } from '../src/utils/status-webhook.js';
import type { StatusUpdate } from '../src/utils/status-webhook.js';

// ===========================================================================
// Test Helpers
// ===========================================================================

const makeUpdate = (overrides?: Partial<StatusUpdate>): StatusUpdate => ({
  provider: 'twilio',
  notificationId: 'msg-123',
  channel: 'sms',
  status: 'delivered',
  timestamp: new Date(),
  ...overrides,
});

// ===========================================================================
// createStatusHandler
// ===========================================================================

describe('createStatusHandler', () => {
  it('records status updates', async () => {
    const handler = createStatusHandler();
    await handler.handle(makeUpdate());

    expect(handler.getUpdates()).toHaveLength(1);
    expect(handler.getUpdates()[0].status).toBe('delivered');
  });

  it('calls onStatusChange callback', async () => {
    const onStatusChange = vi.fn();
    const handler = createStatusHandler({ onStatusChange });

    const update = makeUpdate();
    await handler.handle(update);

    expect(onStatusChange).toHaveBeenCalledWith(update);
  });

  it('supports async onStatusChange', async () => {
    const log: string[] = [];
    const handler = createStatusHandler({
      onStatusChange: async (update) => {
        await new Promise(r => setTimeout(r, 5));
        log.push(update.status);
      },
    });

    await handler.handle(makeUpdate({ status: 'delivered' }));
    expect(log).toEqual(['delivered']);
  });

  it('tracks multiple updates for same notification', async () => {
    const handler = createStatusHandler();

    await handler.handle(makeUpdate({ notificationId: 'msg-1', status: 'queued' }));
    await handler.handle(makeUpdate({ notificationId: 'msg-1', status: 'sent' }));
    await handler.handle(makeUpdate({ notificationId: 'msg-1', status: 'delivered' }));

    const updates = handler.getUpdatesFor('msg-1');
    expect(updates).toHaveLength(3);
    expect(updates.map(u => u.status)).toEqual(['queued', 'sent', 'delivered']);
  });

  it('filters updates by notificationId', async () => {
    const handler = createStatusHandler();

    await handler.handle(makeUpdate({ notificationId: 'msg-1' }));
    await handler.handle(makeUpdate({ notificationId: 'msg-2' }));
    await handler.handle(makeUpdate({ notificationId: 'msg-1' }));

    expect(handler.getUpdatesFor('msg-1')).toHaveLength(2);
    expect(handler.getUpdatesFor('msg-2')).toHaveLength(1);
    expect(handler.getUpdatesFor('msg-3')).toHaveLength(0);
  });

  it('returns copies from getUpdates (immutable)', async () => {
    const handler = createStatusHandler();
    await handler.handle(makeUpdate());

    const updates1 = handler.getUpdates();
    const updates2 = handler.getUpdates();
    expect(updates1).not.toBe(updates2);
    expect(updates1).toEqual(updates2);
  });

  it('works without onStatusChange callback', async () => {
    const handler = createStatusHandler();
    // Should not throw
    await handler.handle(makeUpdate());
    expect(handler.getUpdates()).toHaveLength(1);
  });

  it('handles all delivery status types', async () => {
    const handler = createStatusHandler();
    const statuses = [
      'queued', 'accepted', 'sent', 'delivered', 'undelivered',
      'bounced', 'opened', 'clicked', 'complained', 'unsubscribed',
    ] as const;

    for (const status of statuses) {
      await handler.handle(makeUpdate({ status, notificationId: `msg-${status}` }));
    }

    expect(handler.getUpdates()).toHaveLength(10);
  });

  it('preserves rawPayload and error fields', async () => {
    const handler = createStatusHandler();

    await handler.handle(makeUpdate({
      status: 'bounced',
      error: 'Mailbox full',
      rawPayload: { bounce_type: 'hard' },
      recipient: 'user@example.com',
    }));

    const update = handler.getUpdates()[0];
    expect(update.error).toBe('Mailbox full');
    expect(update.rawPayload).toEqual({ bounce_type: 'hard' });
    expect(update.recipient).toBe('user@example.com');
  });
});
