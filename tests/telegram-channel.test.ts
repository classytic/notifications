import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from '../src/channels/telegram.channel.js';
import { NotificationService } from '../src/NotificationService.js';
import { ChannelError } from '../src/utils/errors.js';
import type { NotificationPayload } from '../src/types.js';

const TOKEN = '123456:SECRET-token';

const payload: NotificationPayload = {
  event: 'order.placed',
  recipient: { id: 'ops' },
  data: { text: 'New order ORD-2026-0007' },
};

function mockFetch(status: number, json: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TelegramChannel', () => {
  it('requires a bot token', () => {
    expect(() => new TelegramChannel({ botToken: '' })).toThrow(/botToken/);
  });

  it('sends to the default chat and returns the message id', async () => {
    const fetchFn = mockFetch(200, { ok: true, result: { message_id: 42 } });
    const ch = new TelegramChannel({ botToken: TOKEN, chatId: '-100123' });

    const result = await ch.send(payload);

    expect(result).toMatchObject({ status: 'sent', channel: 'telegram', providerMessageId: '42' });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(init.body))).toMatchObject({ chat_id: '-100123', text: 'New order ORD-2026-0007' });
  });

  it("prefers the recipient's own chat id", async () => {
    const fetchFn = mockFetch(200, { ok: true, result: { message_id: 1 } });
    const ch = new TelegramChannel({ botToken: TOKEN, chatId: '-100123' });

    await ch.send({ ...payload, recipient: { telegramChatId: '555' } });

    expect(JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body)).chat_id).toBe('555');
  });

  it('passes parse mode and silent delivery through', async () => {
    const fetchFn = mockFetch(200, { ok: true, result: { message_id: 1 } });
    const ch = new TelegramChannel({ botToken: TOKEN, chatId: '1', parseMode: 'HTML', silent: true });

    await ch.send(payload);

    expect(JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({
      parse_mode: 'HTML',
      disable_notification: true,
    });
  });

  it('skips with no chat id, and never sends', async () => {
    const fetchFn = mockFetch(200, { ok: true });
    const ch = new TelegramChannel({ botToken: TOKEN });

    expect(ch.canSend(payload)).toMatchObject({ status: 'skipped' });
    expect((await ch.send(payload)).status).toBe('skipped');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips with no text', async () => {
    const ch = new TelegramChannel({ botToken: TOKEN, chatId: '1' });
    expect(ch.canSend({ ...payload, data: {} })).toMatchObject({ status: 'skipped' });
  });

  it('a refusal (bad chat, bad token) fails without retry, and never leaks the token', async () => {
    mockFetch(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    const ch = new TelegramChannel({ botToken: TOKEN, chatId: '1' });

    const result = await ch.send(payload);

    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.error).toContain('chat not found');
    expect(result.error).not.toContain('SECRET');
  });

  it('a rate limit or server error throws, so the service retries', async () => {
    mockFetch(429, { ok: false, description: 'Too Many Requests: retry after 3' });
    const ch = new TelegramChannel({ botToken: TOKEN, chatId: '1' });
    await expect(ch.send(payload)).rejects.toBeInstanceOf(ChannelError);

    mockFetch(502, { ok: false, description: 'Bad Gateway' });
    await expect(ch.send(payload)).rejects.toThrow(/502/);
  });

  it('a network failure throws without the token in the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const ch = new TelegramChannel({ botToken: TOKEN, chatId: '1' });

    const err = await ch.send(payload).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect((err as Error).message).not.toContain('SECRET');
  });

  it('runs through the service like any channel, filtered by event', async () => {
    mockFetch(200, { ok: true, result: { message_id: 7 } });
    const service = new NotificationService({
      channels: [new TelegramChannel({ botToken: TOKEN, chatId: '1', events: ['order.*'] })],
    });

    const sent = await service.send(payload);
    const ignored = await service.send({ ...payload, event: 'user.created' });

    expect(sent.results[0]).toMatchObject({ status: 'sent', providerMessageId: '7' });
    expect(ignored.results).toHaveLength(0);
  });
});
