import { describe, it, expect, vi } from 'vitest';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import { ConsoleChannel } from '../src/channels/console.channel.js';
import { WebhookChannel } from '../src/channels/webhook.channel.js';
import { EmailChannel } from '../src/channels/email.channel.js';
import { PushChannel } from '../src/channels/push.channel.js';
import { SmsChannel } from '../src/channels/sms.channel.js';
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
    // The TYPED field. It lived in `metadata` — an untyped bag where every channel
    // spells the id differently, so a consumer had to know which channel produced the
    // result before it could correlate a bounce webhook back to this send.
    expect(result.providerMessageId).toBe('<abc@test>');
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

  it('ignores data.from by default (no sender override)', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<1>' });
    const ch = new EmailChannel({
      from: 'default@app.com',
      transporter: { sendMail: mockSendMail },
    });

    await ch.send({
      ...payload,
      data: { ...payload.data, from: 'spoofed@evil.com' },
    });

    // Without allowSenderOverride, the configured sender always wins —
    // prevents sender spoofing via the free-form data bag.
    expect(mockSendMail.mock.calls[0][0].from).toBe('default@app.com');
  });

  it('uses data.from over config.from only when allowSenderOverride is true', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<1>' });
    const ch = new EmailChannel({
      from: 'default@app.com',
      transporter: { sendMail: mockSendMail },
      allowSenderOverride: true,
    });

    await ch.send({
      ...payload,
      data: { ...payload.data, from: 'custom@app.com' },
    });

    expect(mockSendMail.mock.calls[0][0].from).toBe('custom@app.com');
  });

  it('falls back to config.from when allowSenderOverride is on but data.from is absent', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<1>' });
    const ch = new EmailChannel({
      from: 'default@app.com',
      transporter: { sendMail: mockSendMail },
      allowSenderOverride: true,
    });

    await ch.send(payload);

    expect(mockSendMail.mock.calls[0][0].from).toBe('default@app.com');
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

  it('defaults cannot override protected fields (to, from, subject)', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<1>' });
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: mockSendMail },
      defaults: {
        to: 'attacker@evil.com',
        from: 'spoofed@evil.com',
        subject: 'Malicious Subject',
        headers: { 'X-Safe': 'this-is-fine' },
      },
    });

    await ch.send(payload);

    const sentOptions = mockSendMail.mock.calls[0][0];
    // Protected fields must NOT be overridden by defaults
    expect(sentOptions.to).toBe('test@example.com');
    expect(sentOptions.from).toBe('noreply@app.com');
    expect(sentOptions.subject).toBe('Welcome');
    // Non-protected fields ARE applied
    expect(sentOptions.headers).toEqual({ 'X-Safe': 'this-is-fine' });
  });

  it('defaults cannot override html, text, bcc, cc, replyTo, attachments', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<1>' });
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: mockSendMail },
      defaults: {
        html: '<p>malicious html</p>',
        text: 'malicious text',
        bcc: 'spy@evil.com',
        cc: 'spy@evil.com',
        replyTo: 'trap@evil.com',
        attachments: [{ filename: 'virus.exe' }],
      },
    });

    await ch.send({
      ...payload,
      data: {
        ...payload.data,
        html: '<p>legit html</p>',
        text: 'legit text',
        replyTo: 'legit@app.com',
      },
    });

    const sentOptions = mockSendMail.mock.calls[0][0];
    expect(sentOptions.html).toBe('<p>legit html</p>');
    expect(sentOptions.text).toBe('legit text');
    expect(sentOptions.replyTo).toBe('legit@app.com');
    // These fields from defaults should be stripped
    expect(sentOptions.bcc).toBeUndefined();
    expect(sentOptions.cc).toBeUndefined();
    expect(sentOptions.attachments).toBeUndefined();
  });
});


// ===========================================================================
// providerMessageId — the cross-channel correlation contract
//
// The point of the field is that a consumer can join a delivery receipt back
// to its send WITHOUT knowing which channel produced the result. That property
// only holds if EVERY id-bearing channel populates it, so these cases assert
// the whole set rather than one channel: 2.3.0 added it to email alone, and a
// consumer reading `providerMessageId` silently got `undefined` for push and
// sms while the id sat in `metadata` under two different keys.
// ===========================================================================

describe('providerMessageId across channels', () => {
  const pushPayload: NotificationPayload = {
    event: 'user.created',
    recipient: { id: 'u1', deviceToken: 'tok_123', name: 'Test User' },
    data: { title: 'Welcome', body: 'Hello' },
  };
  const smsPayload: NotificationPayload = {
    event: 'user.created',
    recipient: { id: 'u1', phone: '+15551234567', name: 'Test User' },
    data: { text: 'Hello' },
  };

  it('EmailChannel reports the provider id under the typed field', async () => {
    const ch = new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: vi.fn().mockResolvedValue({ messageId: '<abc@test>' }) },
    });
    const result = await ch.send(payload);
    expect(result.providerMessageId).toBe('<abc@test>');
  });

  it('PushChannel reports the provider id under the typed field', async () => {
    const ch = new PushChannel({
      provider: { send: vi.fn().mockResolvedValue({ messageId: 'fcm_987' }) },
    });
    const result = await ch.send(pushPayload);
    expect(result.status).toBe('sent');
    expect(result.providerMessageId).toBe('fcm_987');
  });

  it('SmsChannel maps the provider-specific `sid` onto the typed field', async () => {
    // The case that justifies the field: the provider says `sid`, email says
    // `messageId`. One name out, whatever the vendor calls it.
    const ch = new SmsChannel({
      from: '+15550000000',
      provider: { send: vi.fn().mockResolvedValue({ sid: 'SM123' }) },
    });
    const result = await ch.send(smsPayload);
    expect(result.status).toBe('sent');
    expect(result.providerMessageId).toBe('SM123');
  });

  it('a consumer can read the id WITHOUT branching on channel', async () => {
    // The actual contract, stated as the thing it enables. If any id-bearing
    // channel regresses to metadata-only, this is what fails.
    const results = await Promise.all([
      new EmailChannel({
        from: 'noreply@app.com',
        transporter: { sendMail: vi.fn().mockResolvedValue({ messageId: 'M1' }) },
      }).send(payload),
      new PushChannel({ provider: { send: vi.fn().mockResolvedValue({ messageId: 'M2' }) } }).send(
        pushPayload,
      ),
      new SmsChannel({
        from: '+15550000000',
        provider: { send: vi.fn().mockResolvedValue({ sid: 'M3' }) },
      }).send(smsPayload),
    ]);
    expect(results.map((r) => r.providerMessageId)).toEqual(['M1', 'M2', 'M3']);
  });

  it('keeps the legacy metadata key on every id-bearing channel until 3.0.0', async () => {
    // 2.3.0 deleted email's `metadata.messageId` in a MINOR, so readers lost it
    // on a range-satisfying upgrade with no signal. All three now mirror the id
    // for the deprecation window; 3.0.0 drops it everywhere at once.
    const email = await new EmailChannel({
      from: 'noreply@app.com',
      transporter: { sendMail: vi.fn().mockResolvedValue({ messageId: 'M1' }) },
    }).send(payload);
    const push = await new PushChannel({
      provider: { send: vi.fn().mockResolvedValue({ messageId: 'M2' }) },
    }).send(pushPayload);
    const sms = await new SmsChannel({
      from: '+15550000000',
      provider: { send: vi.fn().mockResolvedValue({ sid: 'M3' }) },
    }).send(smsPayload);

    expect(email.metadata?.messageId).toBe('M1');
    expect(push.metadata?.messageId).toBe('M2');
    expect(sms.metadata?.sid).toBe('M3');
  });

  it('leaves it UNSET where the provider issues no id', async () => {
    // Absent must mean "no correlation is possible", not "unknown delivery".
    // A 2xx from an HTTP POST is not a message identifier; synthesising one
    // would make an unjoinable send look joinable.
    const console = await new ConsoleChannel().send(payload);
    expect(console.status).toBe('sent');
    expect(console.providerMessageId).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const webhook = await new WebhookChannel({ url: 'https://example.com/hook' }).send(payload);
    expect(webhook.status).toBe('sent');
    expect(webhook.providerMessageId).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
