import { describe, it, expect, vi } from 'vitest';
import { SmsChannel } from '../src/channels/sms.channel.js';
import { PushChannel } from '../src/channels/push.channel.js';
import type { NotificationPayload, SmsProvider, PushProvider } from '../src/types.js';

// ===========================================================================
// Test Helpers
// ===========================================================================

const smsPayload: NotificationPayload = {
  event: 'otp.send',
  recipient: { id: 'u1', phone: '+15559876543' },
  data: { text: 'Your code is 1234' },
};

const pushPayload: NotificationPayload = {
  event: 'order.shipped',
  recipient: { id: 'u1', deviceToken: 'fcm-token-123' },
  data: { title: 'Order Shipped!', body: 'Your order is on the way.' },
};

// ===========================================================================
// SmsChannel
// ===========================================================================

describe('SmsChannel', () => {
  it('sends via custom provider', async () => {
    const provider: SmsProvider = {
      send: vi.fn().mockResolvedValue({ sid: 'msg-123' }),
    };

    const ch = new SmsChannel({ from: '+15551234567', provider });
    const result = await ch.send(smsPayload);

    expect(result.status).toBe('sent');
    expect(result.metadata?.sid).toBe('msg-123');
    expect(provider.send).toHaveBeenCalledWith({
      to: '+15559876543',
      from: '+15551234567',
      body: 'Your code is 1234',
    });
  });

  it('skips when no phone number', async () => {
    const provider: SmsProvider = { send: vi.fn() };
    const ch = new SmsChannel({ from: '+15551234567', provider });

    const result = await ch.send({
      ...smsPayload,
      recipient: { id: 'u1' },
    });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('No recipient phone');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('skips when no message body', async () => {
    const provider: SmsProvider = { send: vi.fn() };
    const ch = new SmsChannel({ from: '+15551234567', provider });

    const result = await ch.send({
      ...smsPayload,
      data: {},
    });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('No message body');
  });

  it('uses data.message as fallback body', async () => {
    const provider: SmsProvider = {
      send: vi.fn().mockResolvedValue({ sid: 'ok' }),
    };
    const ch = new SmsChannel({ from: '+15551234567', provider });

    await ch.send({
      ...smsPayload,
      data: { message: 'Hello from message' },
    });

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Hello from message' }),
    );
  });

  it('uses data.subject as last-resort body', async () => {
    const provider: SmsProvider = {
      send: vi.fn().mockResolvedValue({ sid: 'ok' }),
    };
    const ch = new SmsChannel({ from: '+15551234567', provider });

    await ch.send({
      ...smsPayload,
      data: { subject: 'Subject fallback' },
    });

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Subject fallback' }),
    );
  });

  it('allows overriding from number via data.from', async () => {
    const provider: SmsProvider = {
      send: vi.fn().mockResolvedValue({ sid: 'ok' }),
    };
    const ch = new SmsChannel({ from: '+15551234567', provider });

    await ch.send({
      ...smsPayload,
      data: { text: 'Hi', from: '+10000000000' },
    });

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ from: '+10000000000' }),
    );
  });

  it('throws ChannelError on provider failure', async () => {
    const provider: SmsProvider = {
      send: vi.fn().mockRejectedValue(new Error('Twilio error')),
    };
    const ch = new SmsChannel({ from: '+15551234567', provider });

    await expect(ch.send(smsPayload)).rejects.toThrow('Twilio error');
  });

  it('throws at construction when no provider', () => {
    expect(() => new SmsChannel({ from: '+15551234567' } as any)).toThrow(
      'SmsChannel requires a provider',
    );
  });

  it('has correct default name', () => {
    const ch = new SmsChannel({
      from: '+15551234567',
      provider: { send: async () => ({ sid: '' }) },
    });
    expect(ch.name).toBe('sms');
  });

  it('supports custom channel name', () => {
    const ch = new SmsChannel({
      name: 'twilio-sms',
      from: '+15551234567',
      provider: { send: async () => ({ sid: '' }) },
    });
    expect(ch.name).toBe('twilio-sms');
  });

  it('respects event filtering', () => {
    const ch = new SmsChannel({
      from: '+15551234567',
      events: ['otp.*'],
      provider: { send: async () => ({ sid: '' }) },
    });

    expect(ch.shouldHandle('otp.send')).toBe(true);
    expect(ch.shouldHandle('order.completed')).toBe(false);
  });
});

// ===========================================================================
// PushChannel
// ===========================================================================

describe('PushChannel', () => {
  it('sends via custom provider', async () => {
    const provider: PushProvider = {
      send: vi.fn().mockResolvedValue({ messageId: 'push-123' }),
    };

    const ch = new PushChannel({ provider });
    const result = await ch.send(pushPayload);

    expect(result.status).toBe('sent');
    expect(result.metadata?.messageId).toBe('push-123');
    expect(provider.send).toHaveBeenCalledWith({
      token: 'fcm-token-123',
      title: 'Order Shipped!',
      body: 'Your order is on the way.',
      data: undefined,
      imageUrl: undefined,
    });
  });

  it('skips when no deviceToken', async () => {
    const provider: PushProvider = { send: vi.fn() };
    const ch = new PushChannel({ provider });

    const result = await ch.send({
      ...pushPayload,
      recipient: { id: 'u1' },
    });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('No recipient deviceToken');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('skips when no title or body', async () => {
    const provider: PushProvider = { send: vi.fn() };
    const ch = new PushChannel({ provider });

    const result = await ch.send({
      ...pushPayload,
      data: {},
    });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('No title or body');
  });

  it('uses data.subject and data.text as fallbacks', async () => {
    const provider: PushProvider = {
      send: vi.fn().mockResolvedValue({ messageId: 'ok' }),
    };
    const ch = new PushChannel({ provider });

    await ch.send({
      ...pushPayload,
      data: { subject: 'Subject Title', text: 'Text Body' },
    });

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Subject Title', body: 'Text Body' }),
    );
  });

  it('passes pushData and imageUrl', async () => {
    const provider: PushProvider = {
      send: vi.fn().mockResolvedValue({ messageId: 'ok' }),
    };
    const ch = new PushChannel({ provider });

    await ch.send({
      ...pushPayload,
      data: {
        title: 'Hi',
        body: 'Hello',
        pushData: { orderId: '123' },
        imageUrl: 'https://example.com/img.png',
      },
    });

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { orderId: '123' },
        imageUrl: 'https://example.com/img.png',
      }),
    );
  });

  it('throws ChannelError on provider failure', async () => {
    const provider: PushProvider = {
      send: vi.fn().mockRejectedValue(new Error('FCM error')),
    };
    const ch = new PushChannel({ provider });

    await expect(ch.send(pushPayload)).rejects.toThrow('FCM error');
  });

  it('throws at construction when no provider', () => {
    expect(() => new PushChannel({} as any)).toThrow(
      'PushChannel requires a provider',
    );
  });

  it('has correct default name', () => {
    const ch = new PushChannel({
      provider: { send: async () => ({ messageId: '' }) },
    });
    expect(ch.name).toBe('push');
  });
});
