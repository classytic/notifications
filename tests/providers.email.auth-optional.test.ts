/**
 * Custom SMTP without authentication, and `requireTLS`.
 *
 * An IP-allow-listed relay (an enterprise mail gateway that accepts mail
 * from known addresses) takes no SMTP AUTH. For `provider: 'smtp'` both
 * `user` and `password` blank builds a transport without `auth`; one
 * without the other stays an error. Presets keep requiring their key.
 *
 * `requireTLS` (boolean or the form strings `'true'` / `'false'`) makes
 * nodemailer refuse to send unless STARTTLS succeeds, for hosts where the
 * administrator may override the host (`smtp`, `ses`).
 */

import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMAIL_PRESETS,
  buildEmailTransport,
  getEmailCredentialSchema,
  testEmailCredential,
  type EmailCredentialData,
} from '../src/providers/index.js';

const relay = (extra: Partial<EmailCredentialData> = {}): EmailCredentialData => ({
  provider: 'smtp',
  fromEmail: 'ops@example.com',
  host: 'relay.example.com',
  port: '25',
  secure: 'false',
  ...extra,
});

describe('buildEmailTransport: custom SMTP without authentication', () => {
  it('builds a transport with no auth when user and password are both absent', async () => {
    const t: any = await buildEmailTransport(relay());
    expect(t.options.host).toBe('relay.example.com');
    expect(t.options.port).toBe(25);
    expect(t.options.auth).toBeUndefined();
  });

  it('treats blank and whitespace-only user and password as absent', async () => {
    const t: any = await buildEmailTransport(relay({ user: '', password: '  ' }));
    expect(t.options.auth).toBeUndefined();
  });

  it('still refuses a user without a password', async () => {
    await expect(buildEmailTransport(relay({ user: 'relay' }))).rejects.toThrow(/Password is required/);
  });

  it('still refuses a password without a user', async () => {
    await expect(buildEmailTransport(relay({ password: 'secret' }))).rejects.toThrow(/SMTP user is required/);
  });

  it('keeps auth when both are given', async () => {
    const t: any = await buildEmailTransport(relay({ user: 'relay', password: 'secret' }));
    expect(t.options.auth).toEqual({ user: 'relay', pass: 'secret' });
  });

  it.each(['gmail', 'mailgun', 'ses'] as const)('a %s preset still requires its credentials', async (provider) => {
    await expect(buildEmailTransport({ provider, fromEmail: 'ops@example.com' })).rejects.toThrow(/required/);
  });

  it('marks only the custom SMTP preset as auth-optional', () => {
    expect(EMAIL_PRESETS.smtp.authOptional).toBe(true);
    for (const name of ['resend', 'gmail', 'sendgrid', 'mailgun', 'ses'] as const) {
      expect(EMAIL_PRESETS[name].authOptional).not.toBe(true);
    }
  });
});

describe('buildEmailTransport: requireTLS', () => {
  it.each([
    [true, true],
    ['true', true],
    [false, false],
    ['false', false],
  ] as const)('passes requireTLS %s through as %s', async (requireTLS, expected) => {
    const t: any = await buildEmailTransport(relay({ requireTLS }));
    expect(t.options.requireTLS).toBe(expected);
  });

  it('leaves requireTLS unset when absent or blank', async () => {
    expect('requireTLS' in (await buildEmailTransport(relay())as any).options).toBe(false);
    expect('requireTLS' in (await buildEmailTransport(relay({ requireTLS: '' })) as any).options).toBe(false);
  });

  it('honours requireTLS for SES (host override allowed)', async () => {
    const t: any = await buildEmailTransport({ provider: 'ses', fromEmail: 'a@example.com', user: 'u', password: 'p', requireTLS: 'true' });
    expect(t.options.requireTLS).toBe(true);
  });

  it('ignores requireTLS for a fixed-host preset', async () => {
    const t: any = await buildEmailTransport({ provider: 'resend', fromEmail: 'a@example.com', apiKey: 're_x', requireTLS: true });
    expect('requireTLS' in t.options).toBe(false);
  });
});

describe('getEmailCredentialSchema: requireTLS and optional relay auth', () => {
  const byName = Object.fromEntries(getEmailCredentialSchema().map((f) => [f.name, f]));

  it('offers requireTLS as an optional true/false select', () => {
    expect(byName.requireTLS?.type).toBe('select');
    expect(byName.requireTLS?.required).toBe(false);
    expect(byName.requireTLS?.options?.map((o) => o.value)).toEqual(['true', 'false']);
  });

  it('keeps user and password optional and says a relay may leave both blank', () => {
    expect(byName.user?.required).toBe(false);
    expect(byName.password?.required).toBe(false);
    expect(byName.user?.description).toMatch(/blank/i);
    expect(byName.password?.description).toMatch(/blank/i);
  });
});

/**
 * A minimal SMTP server: greets, answers EHLO with the configured
 * extensions, records every command. Enough for nodemailer's `verify()`.
 */
function fakeSmtp(extensions: string[]) {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 fake.relay ESMTP\r\n');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        commands.push(line);
        const verb = line.split(' ')[0]?.toUpperCase();
        if (verb === 'EHLO') {
          const lines = ['fake.relay', ...extensions];
          socket.write(lines.map((l, i) => `250${i === lines.length - 1 ? ' ' : '-'}${l}`).join('\r\n') + '\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
        } else if (verb === 'NOOP' || verb === 'RSET') {
          socket.write('250 ok\r\n');
        } else {
          socket.write('502 not implemented\r\n');
        }
      }
    });
  });
  return {
    commands,
    async start(): Promise<number> {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return (server.address() as AddressInfo).port;
    },
    async stop(): Promise<void> {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('testEmailCredential against an SMTP relay without AUTH', () => {
  const smtp = fakeSmtp(['PIPELINING', '8BITMIME']);
  let port = 0;
  beforeAll(async () => {
    port = await smtp.start();
  });
  afterAll(async () => {
    await smtp.stop();
  });

  it('verifies an auth-less relay and never sends AUTH', async () => {
    smtp.commands.length = 0;
    const result = await testEmailCredential(relay({ host: '127.0.0.1', port }));
    expect(result.status).toBe('OK');
    expect(smtp.commands.some((c) => /^AUTH/i.test(c))).toBe(false);
  });

  it('fails verification when requireTLS is set and the relay offers no STARTTLS', async () => {
    const result = await testEmailCredential(relay({ host: '127.0.0.1', port, requireTLS: 'true' }));
    expect(result.status).toBe('Error');
  });
});
