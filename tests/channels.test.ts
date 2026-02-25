import { describe, it, expect, vi } from 'vitest';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import { ConsoleChannel } from '../src/channels/console.channel.js';
import { WebhookChannel } from '../src/channels/webhook.channel.js';
import { EmailChannel } from '../src/channels/email.channel.js';
import type { NotificationPayload, SendResult, ChannelConfig } from '../src/types.js';

// ===========================================================================
// Test Helpers
// ===========================================================================

const payload: NotificationPayload = {
  event: 'user.created',
  recipient: { id: 'u1', email: 'test@example.com', name: 'Test User' },
  data: { subject: 'Welcome', html: '<p>Hello</p>', text: 'Hello' },
};

class MockChannel extends BaseChannel {
  sent: NotificationPayload[] = [];
  constructor(config: ChannelConfig = {}) {
    super({ name: 'mock', ...config });
  }
  async send(p: NotificationPayload): Promise<SendResult> {
    this.sent.push(p);
    return { status: 'sent', channel: this.name };
  }
}

// ===========================================================================
// BaseChannel
// ===========================================================================

describe('BaseChannel', () => {
  it('handles all events when no whitelist', () => {
    const ch = new MockChannel();
    expect(ch.shouldHandle('any.event')).toBe(true);
    expect(ch.shouldHandle('other')).toBe(true);
  });

  it('filters events by whitelist', () => {
    const ch = new MockChannel({ events: ['user.created', 'order.completed'] });
    expect(ch.shouldHandle('user.created')).toBe(true);
    expect(ch.shouldHandle('order.completed')).toBe(true);
    expect(ch.shouldHandle('user.deleted')).toBe(false);
  });

  it('supports wildcard patterns (user.*)', () => {
    const ch = new MockChannel({ events: ['user.*'] });
    expect(ch.shouldHandle('user.created')).toBe(true);
    expect(ch.shouldHandle('user.deleted')).toBe(true);
    expect(ch.shouldHandle('order.created')).toBe(false);
  });

  it('disables channel when enabled=false', () => {
    const ch = new MockChannel({ enabled: false, events: ['user.created'] });
    expect(ch.shouldHandle('user.created')).toBe(false);
  });

  it('uses custom name when provided', () => {
    const ch = new MockChannel({ name: 'my-channel' });
    expect(ch.name).toBe('my-channel');
  });

  it('defaults to class name when no name provided', () => {
    const ch = new MockChannel();
    expect(ch.name).toBe('mock');
  });

  it('handles empty events array (all events)', () => {
    const ch = new MockChannel({ events: [] });
    expect(ch.shouldHandle('anything')).toBe(true);
  });

  it('wildcard does not match exact prefix without dot', () => {
    const ch = new MockChannel({ events: ['user.*'] });
    // 'user' alone (no dot-suffix) should not match 'user.*'
    expect(ch.shouldHandle('user')).toBe(false);
    expect(ch.shouldHandle('users.list')).toBe(false);
  });
});

// ===========================================================================
// ConsoleChannel
// ===========================================================================

describe('ConsoleChannel', () => {
  it('logs to console and returns sent', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ch = new ConsoleChannel();

    const result = await ch.send(payload);

    expect(result.status).toBe('sent');
    expect(result.channel).toBe('console');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('includes event name in log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ch = new ConsoleChannel();

    await ch.send(payload);

    expect(spy.mock.calls[0][0]).toContain('user.created');
    spy.mockRestore();
  });

  it('respects event filtering', () => {
    const ch = new ConsoleChannel({ events: ['order.*'] });
    expect(ch.shouldHandle('user.created')).toBe(false);
    expect(ch.shouldHandle('order.completed')).toBe(true);
  });
});

// ===========================================================================
// WebhookChannel
// ===========================================================================

describe('WebhookChannel', () => {
  it('sends POST request to URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    vi.stubGlobal('fetch', mockFetch);

    const ch = new WebhookChannel({ url: 'https://example.com/hook' });
    const result = await ch.send(payload);

    expect(result.status).toBe('sent');
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body.event).toBe('user.created');
    expect(body.recipient.email).toBe('test@example.com');

    vi.unstubAllGlobals();
  });

  it('includes custom headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const ch = new WebhookChannel({
      url: 'https://example.com/hook',
      headers: { 'X-API-Key': 'secret123' },
    });
    await ch.send(payload);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['X-API-Key']).toBe('secret123');

    vi.unstubAllGlobals();
  });

  it('signs payload with HMAC when secret provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const ch = new WebhookChannel({
      url: 'https://example.com/hook',
      secret: 'my-secret',
    });
    await ch.send(payload);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['X-Signature-256']).toBeDefined();
    expect(headers['X-Signature-256']).toMatch(/^sha256=[a-f0-9]+$/);

    vi.unstubAllGlobals();
  });

  it('throws on non-OK response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    vi.stubGlobal('fetch', mockFetch);

    const ch = new WebhookChannel({ url: 'https://example.com/hook' });

    await expect(ch.send(payload)).rejects.toThrow('HTTP 500');

    vi.unstubAllGlobals();
  });

  it('uses PUT method when configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const ch = new WebhookChannel({
      url: 'https://example.com/hook',
      method: 'PUT',
    });
    await ch.send(payload);

    expect(mockFetch.mock.calls[0][1].method).toBe('PUT');

    vi.unstubAllGlobals();
  });

  it('wraps network errors in ChannelError', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', mockFetch);

    const ch = new WebhookChannel({ url: 'https://example.com/hook' });

    await expect(ch.send(payload)).rejects.toThrow('fetch failed');

    vi.unstubAllGlobals();
  });

  it('wraps non-Error thrown values in ChannelError', async () => {
    const mockFetch = vi.fn().mockRejectedValue('network down');
    vi.stubGlobal('fetch', mockFetch);

    const ch = new WebhookChannel({ url: 'https://example.com/hook' });

    await expect(ch.send(payload)).rejects.toThrow('network down');

    vi.unstubAllGlobals();
  });

  it('includes metadata in webhook payload', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const ch = new WebhookChannel({ url: 'https://example.com/hook' });
    await ch.send({ ...payload, metadata: { source: 'test' } });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.metadata).toEqual({ source: 'test' });
    expect(body.timestamp).toBeDefined();

    vi.unstubAllGlobals();
  });
});

// ===========================================================================
// EmailChannel
// ===========================================================================

describe('EmailChannel', () => {
  it('sends email via transporter', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<abc@test>' });
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: mockSendMail },
    });

    const result = await ch.send(payload);

    expect(result.status).toBe('sent');
    expect(result.metadata?.messageId).toBe('<abc@test>');
    expect(mockSendMail).toHaveBeenCalledOnce();

    const mailOpts = mockSendMail.mock.calls[0][0];
    expect(mailOpts.from).toBe('noreply@app.com');
    expect(mailOpts.to).toBe('test@example.com');
    expect(mailOpts.subject).toBe('Welcome');
    expect(mailOpts.html).toBe('<p>Hello</p>');
  });

  it('skips when no recipient email', async () => {
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: vi.fn() },
    });

    const result = await ch.send({
      ...payload,
      recipient: { id: 'u1', name: 'No Email' },
    });

    expect(result.status).toBe('skipped');
  });

  it('throws ChannelError on send failure', async () => {
    const mockSendMail = vi.fn().mockRejectedValue(new Error('SMTP timeout'));
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: mockSendMail },
    });

    await expect(ch.send(payload)).rejects.toThrow('SMTP timeout');
  });

  it('passes attachments and cc/bcc', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<123>' });
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: mockSendMail },
    });

    await ch.send({
      ...payload,
      data: {
        ...payload.data,
        cc: 'cc@example.com',
        bcc: ['bcc1@example.com'],
        attachments: [{ filename: 'test.txt', content: 'hello' }],
      },
    });

    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.cc).toBe('cc@example.com');
    expect(opts.bcc).toEqual(['bcc1@example.com']);
    expect(opts.attachments).toHaveLength(1);
  });

  it('verifies transporter connection', async () => {
    const mockVerify = vi.fn().mockResolvedValue(true);
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: vi.fn(), verify: mockVerify },
    });

    const ok = await ch.verify();
    expect(ok).toBe(true);
    expect(mockVerify).toHaveBeenCalledOnce();
  });

  it('verify returns true when transporter has no verify method', async () => {
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: vi.fn() },
    });

    const ok = await ch.verify();
    expect(ok).toBe(true);
  });

  it('throws when neither transport nor transporter is provided', async () => {
    const ch = new EmailChannel({ from: 'noreply@app.com' });

    await expect(ch.send(payload)).rejects.toThrow(
      'Either transport options or a transporter instance is required',
    );
  });

  it('creates transporter from transport options via nodemailer', async () => {
    // nodemailer is installed as devDep, so dynamic import works
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transport: { host: 'localhost', port: 2525 },
    });

    // The transporter will be created, but sendMail will fail (no actual SMTP)
    // This tests the dynamic import + createTransport path (lines 72-77)
    await expect(ch.send(payload)).rejects.toThrow();
  });

  it('close() resets the transporter', async () => {
    const mockClose = vi.fn();
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: vi.fn().mockResolvedValue({ messageId: '<1>' }), close: mockClose },
    });

    // Send once to initialize
    await ch.send(payload);
    ch.close();

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('close() works when transporter has no close method', () => {
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: vi.fn() },
    });

    // Should not throw
    ch.close();
  });

  it('close() works when no transporter initialized', () => {
    const ch = new EmailChannel({ from: 'noreply@app.com' });
    // Should not throw
    ch.close();
  });

  it('handles non-Error thrown by sendMail', async () => {
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: vi.fn().mockRejectedValue('string error') },
    });

    await expect(ch.send(payload)).rejects.toThrow('string error');
  });

  it('uses data.from over config.from when provided', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<1>' });
    const ch = new EmailChannel({
      from: 'default@app.com',
      transporter: { sendMail: mockSendMail },
    });

    await ch.send({
      ...payload,
      data: { ...payload.data, from: 'custom@app.com' },
    });

    expect(mockSendMail.mock.calls[0][0].from).toBe('custom@app.com');
  });

  it('passes replyTo from data', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<1>' });
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: mockSendMail },
    });

    await ch.send({
      ...payload,
      data: { ...payload.data, replyTo: 'reply@app.com' },
    });

    expect(mockSendMail.mock.calls[0][0].replyTo).toBe('reply@app.com');
  });

  it('merges config.defaults into mail options', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<1>' });
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: mockSendMail },
      defaults: { headers: { 'X-Custom': 'value' } },
    });

    await ch.send(payload);

    expect(mockSendMail.mock.calls[0][0].headers).toEqual({ 'X-Custom': 'value' });
  });
});

