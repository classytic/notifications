/**
 * Email provider presets — Resend, Gmail, SendGrid, Mailgun, custom SMTP.
 *
 * Every provider that ships today exposes an SMTP gateway, so the table
 * here captures the constants (host / port / secure / user-source /
 * pass-source) and leaves the variable bits (api key, app password) to
 * the credential's `data` blob. `buildEmailTransport` reads the preset,
 * fills in the auth tuple, and builds a `nodemailer` transport.
 *
 * Adding a new SMTP-based provider is one entry below. Non-SMTP API
 * providers (Postmark API, SES API) would branch in `buildEmailTransport`
 * BEFORE the SMTP fallback — none are shipped yet.
 */

export type EmailProviderName =
  | 'resend'
  | 'gmail'
  | 'sendgrid'
  | 'mailgun'
  | 'ses'
  | 'smtp';

export interface EmailPreset {
  /** Display label for the credential card / dropdown. */
  displayName: string;
  /** One-line description shown next to the option. */
  description: string;
  /** SMTP host. `null` ⇒ user-supplied (custom SMTP). */
  host: string | null;
  /** SMTP port. */
  port: number;
  /** TLS — `true` = implicit TLS, `false` = STARTTLS. */
  secure: boolean;
  /**
   * Where the SMTP `user` comes from:
   *   - `literal:<value>` — fixed for this provider (Resend → `resend`, SendGrid → `apikey`)
   *   - `user` — read `credential.data.user` (Gmail, Mailgun, custom SMTP)
   */
  userSource: string;
  /**
   * Where the SMTP `pass` comes from:
   *   - `apiKey` — read `credential.data.apiKey` (Resend, SendGrid)
   *   - `password` — read `credential.data.password` (Gmail, Mailgun, SMTP)
   */
  passSource: 'apiKey' | 'password';
  /**
   * Allow user-supplied `data.host` / `data.port` / `data.secure` to
   * override the preset defaults. `true` for providers like SES where
   * the region picks the host (`email-smtp.{region}.amazonaws.com`).
   * `false` for fixed-host providers (Resend, Gmail, SendGrid, Mailgun)
   * — prevents "changed host, kept the Resend key" footguns.
   */
  allowHostOverride?: boolean;
  /** Setup instructions surfaced in the Integrations UI. */
  setupHint: string;
}

export const EMAIL_PRESETS: Record<EmailProviderName, EmailPreset> = {
  resend: {
    displayName: 'Resend',
    description: 'Transactional + broadcast email via Resend SMTP relay.',
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    userSource: 'literal:resend',
    passSource: 'apiKey',
    setupHint:
      'Verify your sending domain in resend.com → Domains. Create an API key (full access) and paste it below.',
  },
  gmail: {
    displayName: 'Gmail (App Password)',
    description: 'Send via a personal Gmail account using a 16-character app password.',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    userSource: 'user',
    passSource: 'password',
    setupHint:
      'Enable 2-Step Verification, then generate an App Password at myaccount.google.com/apppasswords. The from-address must match the Gmail account.',
  },
  sendgrid: {
    displayName: 'SendGrid',
    description: 'SendGrid SMTP relay (username is literally "apikey").',
    host: 'smtp.sendgrid.net',
    port: 587,
    secure: false,
    userSource: 'literal:apikey',
    passSource: 'apiKey',
    setupHint:
      'Verify your sending domain in app.sendgrid.com → Sender Authentication. Create an API key with Mail Send permission.',
  },
  mailgun: {
    displayName: 'Mailgun',
    description: 'Mailgun SMTP relay using per-domain SMTP credentials.',
    host: 'smtp.mailgun.org',
    port: 465,
    secure: true,
    userSource: 'user',
    passSource: 'password',
    setupHint:
      'Verify your sending domain in app.mailgun.com. The SMTP credentials shown on the domain page (user + password) go below — these are NOT your account password.',
  },
  ses: {
    displayName: 'AWS SES (SMTP)',
    description: 'Amazon SES via SMTP. Host defaults to us-east-1; override for other regions.',
    host: 'email-smtp.us-east-1.amazonaws.com',
    port: 465,
    secure: true,
    userSource: 'user',
    passSource: 'password',
    allowHostOverride: true,
    setupHint:
      'In the SES console (your region), Account dashboard → SMTP settings → Create SMTP credentials. The IAM user gets an SMTP username and password — those go below (NOT your AWS access key). To use a non-default region, set host to email-smtp.<region>.amazonaws.com.',
  },
  smtp: {
    displayName: 'Custom SMTP',
    description: 'Any SMTP relay — supply host, port, user, and password manually.',
    host: null,
    port: 587,
    secure: false,
    userSource: 'user',
    passSource: 'password',
    setupHint:
      'Use for SMTP servers without a preset. Standard auth-SMTP only — no OAuth-XOAUTH2.',
  },
};

/** Convenience dropdown options for the credential UI. */
export const EMAIL_PROVIDER_OPTIONS = (
  Object.keys(EMAIL_PRESETS) as EmailProviderName[]
).map((name) => ({
  value: name,
  label: EMAIL_PRESETS[name].displayName,
}));
