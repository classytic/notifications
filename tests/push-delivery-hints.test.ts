import { describe, it, expect, vi } from 'vitest';
import { PushChannel } from '../src/channels/push.channel.js';
import { NotificationService } from '../src/NotificationService.js';
import type { NotificationPayload, PushProvider } from '../src/types.js';

type PushMessage = Parameters<PushProvider['send']>[0];

const payload = (data: Record<string, unknown>): NotificationPayload => ({
  event: 'message_received',
  recipient: { id: 'u1', deviceToken: 'tok-1' },
  data: { title: 'New message', body: '', pushData: { type: 'message_received' }, ...data },
});

describe('PushChannel delivery hints (collapseKey, threadId, badge)', () => {
  it('forwards well-typed hints from the payload data to the provider', async () => {
    const send = vi.fn<(m: PushMessage) => Promise<{ messageId: string }>>().mockResolvedValue({ messageId: 'p1' });
    const ch = new PushChannel({ provider: { send } });
    const result = await ch.send(payload({ collapseKey: 'conv:c1', threadId: 'c1', badge: 3 }));
    expect(result.status).toBe('sent');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'tok-1', collapseKey: 'conv:c1', threadId: 'c1', badge: 3 }),
    );
  });

  it('omits absent or malformed hints (no undefined keys)', async () => {
    const send = vi.fn<(m: PushMessage) => Promise<{ messageId: string }>>().mockResolvedValue({ messageId: 'p2' });
    const ch = new PushChannel({ provider: { send } });
    await ch.send(payload({}));
    await ch.send(payload({ collapseKey: '', threadId: 42, badge: -1 }));
    await ch.send(payload({ badge: 1.5 }));
    for (const [message] of send.mock.calls) {
      expect(message).not.toHaveProperty('collapseKey');
      expect(message).not.toHaveProperty('threadId');
      expect(message).not.toHaveProperty('badge');
    }
  });

  it('a zero badge is forwarded (clears the icon badge)', async () => {
    const send = vi.fn<(m: PushMessage) => Promise<{ messageId: string }>>().mockResolvedValue({ messageId: 'p3' });
    await new PushChannel({ provider: { send } }).send(payload({ badge: 0 }));
    expect(send.mock.calls[0]?.[0]).toMatchObject({ badge: 0 });
  });

  it('reaches the provider through NotificationService.send', async () => {
    const send = vi.fn<(m: PushMessage) => Promise<{ messageId: string }>>().mockResolvedValue({ messageId: 'p4' });
    const service = new NotificationService({ channels: [new PushChannel({ provider: { send } })] });
    await service.send(payload({ collapseKey: 'conv:c9', threadId: 'c9' }));
    expect(send.mock.calls[0]?.[0]).toMatchObject({ collapseKey: 'conv:c9', threadId: 'c9' });
  });
});
