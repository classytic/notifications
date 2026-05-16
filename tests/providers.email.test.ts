/**
 * Email provider primitives — fast unit tests that don't touch SMTP.
 *
 * The transport's `verify()` call needs a real server, so that path is
 * covered by `tests/providers.email.live.test.ts` (skipped unless the
 * `.env.test`-driven `EMAIL_LIVE_TEST=1` flag is set + credentials are
 * supplied).
 */

import { describe, it, expect } from 'vitest';
import {
  EMAIL_PRESETS,
  EMAIL_PROVIDER_OPTIONS,
  buildEmailTransport,
  buildFromHeader,
  getEmailCredentialSchema,
  testEmailCredential,
  type EmailCredentialData,
  type EmailProviderName,
} from '../src/providers/index.js';

describe('EMAIL_PRESETS', () => {
  it('lists every supported provider with a stable shape', () => {
    const names = Object.keys(EMAIL_PRESETS) as EmailProviderName[];
    expect(names).toEqual([
      'resend',
      'gmail',
      'sendgrid',
      'mailgun',
      'ses',
      'smtp',
    ]);
    for (const name of names) {
      const preset = EMAIL_PRESETS[name];
      expect(preset.displayName).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.setupHint).toBeTruthy();
      expect(typeof preset.port).toBe('number');
      expect(typeof preset.secure).toBe('boolean');
      expect(['apiKey', 'password']).toContain(preset.passSource);
      if (name === 'smtp') {
        expect(preset.host).toBeNull();
      } else {
        expect(preset.host).toBeTruthy();
      }
    }
  });

  it('Resend uses literal:resend user + apiKey pass', () => {
    expect(EMAIL_PRESETS.resend.userSource).toBe('literal:resend');
    expect(EMAIL_PRESETS.resend.passSource).toBe('apiKey');
    expect(EMAIL_PRESETS.resend.host).toBe('smtp.resend.com');
    expect(EMAIL_PRESETS.resend.port).toBe(465);
    expect(EMAIL_PRESETS.resend.secure).toBe(true);
  });

  it('SendGrid uses literal:apikey + apiKey pass', () => {
    expect(EMAIL_PRESETS.sendgrid.userSource).toBe('literal:apikey');
    expect(EMAIL_PRESETS.sendgrid.passSource).toBe('apiKey');
    expect(EMAIL_PRESETS.sendgrid.host).toBe('smtp.sendgrid.net');
    expect(EMAIL_PRESETS.sendgrid.port).toBe(587);
    expect(EMAIL_PRESETS.sendgrid.secure).toBe(false);
  });

  it('Gmail / Mailgun / SES / SMTP read user + password from the credential blob', () => {
    for (const name of ['gmail', 'mailgun', 'ses', 'smtp'] as const) {
      expect(EMAIL_PRESETS[name].userSource).toBe('user');
      expect(EMAIL_PRESETS[name].passSource).toBe('password');
    }
  });

  it('SES defaults to us-east-1 and allows host override for other regions', () => {
    expect(EMAIL_PRESETS.ses.host).toBe('email-smtp.us-east-1.amazonaws.com');
    expect(EMAIL_PRESETS.ses.port).toBe(465);
    expect(EMAIL_PRESETS.ses.secure).toBe(true);
    expect(EMAIL_PRESETS.ses.allowHostOverride).toBe(true);
  });
});

describe('EMAIL_PROVIDER_OPTIONS', () => {
  it('mirrors the preset table in dropdown shape', () => {
    expect(EMAIL_PROVIDER_OPTIONS).toHaveLength(Object.keys(EMAIL_PRESETS).length);
    for (const opt of EMAIL_PROVIDER_OPTIONS) {
      expect(opt.value).toBeTruthy();
      expect(opt.label).toBe(EMAIL_PRESETS[opt.value as EmailProviderName].displayName);
    }
  });
});

describe('getEmailCredentialSchema', () => {
  const schema = getEmailCredentialSchema();
  const byName = Object.fromEntries(schema.map((f) => [f.name, f]));

  it('marks provider + fromEmail as required, others optional', () => {
    expect(byName.provider?.required).toBe(true);
    expect(byName.fromEmail?.required).toBe(true);
    expect(byName.fromName?.required).toBe(false);
    expect(byName.apiKey?.required).toBe(false);
  });

  it('renders provider as a select with the full options list', () => {
    expect(byName.provider?.type).toBe('select');
    expect(byName.provider?.options).toHaveLength(EMAIL_PROVIDER_OPTIONS.length);
  });

  it('renders password fields with `type: password` (so the UI masks them)', () => {
    expect(byName.apiKey?.type).toBe('password');
    expect(byName.password?.type).toBe('password');
  });
});

describe('buildFromHeader', () => {
  it('returns bare email when fromName is absent', () => {
    expect(
      buildFromHeader({
        provider: 'resend',
        fromEmail: 'hello@example.com',
      } as EmailCredentialData),
    ).toBe('hello@example.com');
  });

  it('wraps with display name when fromName is present', () => {
    expect(
      buildFromHeader({
        provider: 'resend',
        fromEmail: 'hello@example.com',
        fromName: 'Acme',
      } as EmailCredentialData),
    ).toBe('"Acme" <hello@example.com>');
  });

  it('trims whitespace from fromName', () => {
    expect(
      buildFromHeader({
        provider: 'resend',
        fromEmail: 'hello@example.com',
        fromName: '   ',
      } as EmailCredentialData),
    ).toBe('hello@example.com');
  });
});

describe('buildEmailTransport', () => {
  it('builds a Resend transport with literal user + api-key pass', async () => {
    const t: any = await buildEmailTransport({
      provider: 'resend',
      fromEmail: 'hello@example.com',
      apiKey: 're_test_abc',
    });
    expect(t.options.host).toBe('smtp.resend.com');
    expect(t.options.port).toBe(465);
    expect(t.options.secure).toBe(true);
    expect(t.options.auth.user).toBe('resend');
    expect(t.options.auth.pass).toBe('re_test_abc');
  });

  it('builds a SendGrid transport with literal user `apikey`', async () => {
    const t: any = await buildEmailTransport({
      provider: 'sendgrid',
      fromEmail: 'hello@example.com',
      apiKey: 'SG.test',
    });
    expect(t.options.host).toBe('smtp.sendgrid.net');
    expect(t.options.auth.user).toBe('apikey');
    expect(t.options.auth.pass).toBe('SG.test');
  });

  it('builds a Gmail transport using user + app password', async () => {
    const t: any = await buildEmailTransport({
      provider: 'gmail',
      fromEmail: 'hello@example.com',
      user: 'me@gmail.com',
      password: 'app-password',
    });
    expect(t.options.host).toBe('smtp.gmail.com');
    expect(t.options.auth.user).toBe('me@gmail.com');
    expect(t.options.auth.pass).toBe('app-password');
  });

  it('builds a custom SMTP transport with overrides honored', async () => {
    const t: any = await buildEmailTransport({
      provider: 'smtp',
      fromEmail: 'hello@example.com',
      host: 'smtp.mailtrap.io',
      port: '2525',
      secure: 'false',
      user: 'mailtrap-user',
      password: 'mailtrap-pass',
    });
    expect(t.options.host).toBe('smtp.mailtrap.io');
    expect(t.options.port).toBe(2525);
    expect(t.options.secure).toBe(false);
    expect(t.options.auth.user).toBe('mailtrap-user');
    expect(t.options.auth.pass).toBe('mailtrap-pass');
  });

  it('builds an SES transport using user-supplied SMTP credentials at the default host', async () => {
    const t: any = await buildEmailTransport({
      provider: 'ses',
      fromEmail: 'hello@example.com',
      user: 'AKIAFAKE',
      password: 'BFakeSecret',
    });
    expect(t.options.host).toBe('email-smtp.us-east-1.amazonaws.com');
    expect(t.options.port).toBe(465);
    expect(t.options.secure).toBe(true);
    expect(t.options.auth.user).toBe('AKIAFAKE');
    expect(t.options.auth.pass).toBe('BFakeSecret');
  });

  it('honors host override for SES (region selection)', async () => {
    const t: any = await buildEmailTransport({
      provider: 'ses',
      fromEmail: 'hello@example.com',
      user: 'AKIAFAKE',
      password: 'BFakeSecret',
      host: 'email-smtp.eu-west-1.amazonaws.com',
    });
    expect(t.options.host).toBe('email-smtp.eu-west-1.amazonaws.com');
  });

  it('ignores host override for fixed-host presets (Resend)', async () => {
    const t: any = await buildEmailTransport({
      provider: 'resend',
      fromEmail: 'hello@example.com',
      apiKey: 're_test',
      host: 'evil.example.com',
    });
    expect(t.options.host).toBe('smtp.resend.com');
  });

  it('coerces secure="true" string to boolean for custom SMTP', async () => {
    const t: any = await buildEmailTransport({
      provider: 'smtp',
      fromEmail: 'hello@example.com',
      host: 'smtp.example.com',
      port: '465',
      secure: 'true',
      user: 'user',
      password: 'pass',
    });
    expect(t.options.secure).toBe(true);
  });

  it('throws when API key is missing for Resend', async () => {
    await expect(
      buildEmailTransport({
        provider: 'resend',
        fromEmail: 'hello@example.com',
      } as EmailCredentialData),
    ).rejects.toThrow(/API key is required/);
  });

  it('throws when password is missing for Gmail', async () => {
    await expect(
      buildEmailTransport({
        provider: 'gmail',
        fromEmail: 'hello@example.com',
        user: 'me@gmail.com',
      } as EmailCredentialData),
    ).rejects.toThrow(/Password is required/);
  });

  it('throws when user is missing for Gmail / Mailgun / SMTP', async () => {
    await expect(
      buildEmailTransport({
        provider: 'gmail',
        fromEmail: 'hello@example.com',
        password: 'pass',
      } as EmailCredentialData),
    ).rejects.toThrow(/SMTP user is required/);
  });

  it('throws when host is missing for custom SMTP', async () => {
    await expect(
      buildEmailTransport({
        provider: 'smtp',
        fromEmail: 'hello@example.com',
        user: 'u',
        password: 'p',
      } as EmailCredentialData),
    ).rejects.toThrow(/SMTP host is required/);
  });

  it('throws on unknown provider', async () => {
    await expect(
      buildEmailTransport({
        provider: 'fake' as EmailProviderName,
        fromEmail: 'hello@example.com',
      } as EmailCredentialData),
    ).rejects.toThrow(/Unknown email provider/);
  });
});

describe('testEmailCredential — validation paths', () => {
  it('rejects missing provider', async () => {
    const result = await testEmailCredential({} as EmailCredentialData);
    expect(result.status).toBe('Error');
    expect(result.message).toMatch(/Provider is required/);
  });

  it('rejects missing fromEmail', async () => {
    const result = await testEmailCredential({
      provider: 'resend',
    } as EmailCredentialData);
    expect(result.status).toBe('Error');
    expect(result.message).toMatch(/From email is required/);
  });

  it('rejects unknown provider', async () => {
    const result = await testEmailCredential({
      provider: 'fake',
      fromEmail: 'hello@example.com',
    } as EmailCredentialData);
    expect(result.status).toBe('Error');
    expect(result.message).toMatch(/Unknown provider/);
  });

  it('surfaces transport-build errors as Error status (no throw)', async () => {
    const result = await testEmailCredential({
      provider: 'resend',
      fromEmail: 'hello@example.com',
      // apiKey omitted → buildEmailTransport throws → testEmailCredential
      // catches and returns the message.
    } as EmailCredentialData);
    expect(result.status).toBe('Error');
    expect(result.message).toMatch(/API key is required/);
  });
});
