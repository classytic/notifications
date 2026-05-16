/**
 * Live email-provider smoke tests.
 *
 * ⚠ NOT RUN BY DEFAULT. `vitest.config.ts` excludes `*.live.test.ts`
 * from `npm test` so a fresh checkout — or a CI run with `.env.dev`
 * mounted — never accidentally hits real SMTP servers. Opt in with:
 *
 *     npm run test:live
 *
 * Two suites, each independently gated:
 *
 * 1. `EMAIL_LIVE_TEST=1` — fast `verify()` handshake (no send). Use this
 *    to confirm an SMTP credential authenticates against the real server.
 *
 * 2. `EMAIL_LIVE_SEND_TO=<inbox>` — actually delivers a one-line message
 *    to the given inbox via `nodemailer.sendMail`. Use this to confirm
 *    end-to-end deliverability (verify can succeed while the From
 *    identity is unverified / the IAM user lacks `ses:SendEmail`, etc.).
 *
 *    **Keep `EMAIL_LIVE_SEND_TO` out of shared `.env.dev` files.** Export
 *    it in your shell or put it in `.env.test.local` (gitignored) so
 *    CI / teammates never trigger a real send by importing the workspace
 *    env:
 *
 *        EMAIL_LIVE_SEND_TO=you@example.com npm run test:live
 *
 * Each block uses `it.runIf(...)` against the provider-specific env vars
 * so you only need creds for the providers you actually want to test.
 *
 * Example env:
 *
 *   EMAIL_LIVE_TEST=1
 *   EMAIL_LIVE_SEND_TO=you@gmail.com   # opt-in to real sends
 *
 *   # Resend
 *   RESEND_API_KEY=re_xxx
 *   RESEND_FROM_EMAIL=hello@yourdomain.com
 *   RESEND_FROM_NAME=Your Brand
 *
 *   # AWS SES (SMTP)
 *   SES_SMTP_USER=AKIA...                          # IAM SMTP username
 *   SES_SMTP_PASS=BAxxx                            # IAM SMTP password
 *   SES_FROM_EMAIL=support@yourdomain.com          # verified identity
 *   SES_SMTP_HOST=email-smtp.us-east-1.amazonaws.com   # optional, defaults shown
 *   SES_SMTP_PORT=465
 *   SES_SMTP_SECURE=true
 *
 *   # Gmail (App Password)
 *   GMAIL_USER=you@gmail.com
 *   GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
 *
 *   # SendGrid
 *   SENDGRID_API_KEY=SG.xxx
 *   SENDGRID_FROM=hello@yourdomain.com
 *
 *   # Mailgun
 *   MAILGUN_SMTP_USER=postmaster@mg.yourdomain.com
 *   MAILGUN_SMTP_PASSWORD=xxx
 *   MAILGUN_FROM=hello@yourdomain.com
 *
 *   # Custom SMTP (e.g., Mailtrap)
 *   SMTP_HOST=sandbox.smtp.mailtrap.io
 *   SMTP_PORT=2525
 *   SMTP_SECURE=false
 *   SMTP_USER=xxx
 *   SMTP_PASSWORD=xxx
 *   SMTP_FROM=test@example.com
 */

import { describe, it, expect } from 'vitest';
import {
  buildEmailTransport,
  buildFromHeader,
  testEmailCredential,
  type EmailCredentialData,
} from '../src/providers/index.js';

const LIVE_VERIFY = process.env.EMAIL_LIVE_TEST === '1';
const LIVE_SEND_TO = process.env.EMAIL_LIVE_SEND_TO?.trim();
const liveVerifyDescribe = LIVE_VERIFY ? describe : describe.skip;
const liveSendDescribe = LIVE_SEND_TO ? describe : describe.skip;

interface ProviderSpec {
  name: string;
  hasCreds: () => boolean;
  build: () => EmailCredentialData;
}

const PROVIDERS: ProviderSpec[] = [
  {
    name: 'Resend',
    hasCreds: () => !!process.env.RESEND_API_KEY,
    build: () => ({
      provider: 'resend',
      fromEmail:
        process.env.RESEND_FROM_EMAIL ??
        process.env.RESEND_FROM ??
        'test@example.com',
      fromName: process.env.RESEND_FROM_NAME,
      apiKey: process.env.RESEND_API_KEY!,
    }),
  },
  {
    name: 'AWS SES',
    hasCreds: () => !!process.env.SES_SMTP_USER && !!process.env.SES_SMTP_PASS,
    build: () => ({
      provider: 'ses',
      fromEmail: process.env.SES_FROM_EMAIL ?? 'test@example.com',
      fromName: process.env.SES_FROM_NAME,
      user: process.env.SES_SMTP_USER!,
      password: process.env.SES_SMTP_PASS!,
      host: process.env.SES_SMTP_HOST,
      port: process.env.SES_SMTP_PORT,
      secure: process.env.SES_SMTP_SECURE,
    }),
  },
  {
    name: 'Gmail (App Password)',
    hasCreds: () =>
      !!process.env.GMAIL_USER && !!process.env.GMAIL_APP_PASSWORD,
    build: () => ({
      provider: 'gmail',
      fromEmail: process.env.GMAIL_USER!,
      user: process.env.GMAIL_USER!,
      password: process.env.GMAIL_APP_PASSWORD!,
    }),
  },
  {
    name: 'SendGrid',
    hasCreds: () => !!process.env.SENDGRID_API_KEY,
    build: () => ({
      provider: 'sendgrid',
      fromEmail: process.env.SENDGRID_FROM ?? 'test@example.com',
      apiKey: process.env.SENDGRID_API_KEY!,
    }),
  },
  {
    name: 'Mailgun',
    hasCreds: () =>
      !!process.env.MAILGUN_SMTP_USER && !!process.env.MAILGUN_SMTP_PASSWORD,
    build: () => ({
      provider: 'mailgun',
      fromEmail: process.env.MAILGUN_FROM ?? 'test@example.com',
      user: process.env.MAILGUN_SMTP_USER!,
      password: process.env.MAILGUN_SMTP_PASSWORD!,
    }),
  },
  {
    name: 'Custom SMTP',
    hasCreds: () => !!process.env.SMTP_HOST && !!process.env.SMTP_USER,
    build: () => ({
      provider: 'smtp',
      fromEmail: process.env.SMTP_FROM ?? 'test@example.com',
      host: process.env.SMTP_HOST!,
      port: process.env.SMTP_PORT ?? '587',
      secure: process.env.SMTP_SECURE ?? 'false',
      user: process.env.SMTP_USER!,
      password: process.env.SMTP_PASSWORD!,
    }),
  },
];

// ─── Suite 1: SMTP verify() handshake ────────────────────────────────────

liveVerifyDescribe('Live SMTP verification (EMAIL_LIVE_TEST=1)', () => {
  for (const provider of PROVIDERS) {
    it.runIf(provider.hasCreds())(
      `verifies ${provider.name}`,
      async () => {
        const result = await testEmailCredential(provider.build());
        expect(result.status, result.message).toBe('OK');
      },
      20_000,
    );
  }
});

// ─── Suite 2: Real send via nodemailer.sendMail ──────────────────────────

liveSendDescribe(
  `Live email send (EMAIL_LIVE_SEND_TO=${LIVE_SEND_TO})`,
  () => {
    for (const provider of PROVIDERS) {
      it.runIf(provider.hasCreds())(
        `sends from ${provider.name}`,
        async () => {
          const data = provider.build();
          const transport = await buildEmailTransport(data);
          try {
            const info: any = await (transport as any).sendMail({
              from: buildFromHeader(data),
              to: LIVE_SEND_TO,
              subject: `[notifications live] ${provider.name} → ${LIVE_SEND_TO}`,
              text: `Live send smoke test from @classytic/notifications via ${provider.name}. If you received this, the provider works end-to-end.`,
              html: `<p>Live send smoke test from <code>@classytic/notifications</code> via <strong>${provider.name}</strong>.</p><p>If you received this, the provider works end-to-end.</p>`,
            });
            expect(info?.messageId, 'sendMail returned no messageId').toBeTruthy();
            // Surface a useful breadcrumb when running locally.
            // eslint-disable-next-line no-console
            console.log(`✉  ${provider.name} sent: ${info.messageId}`);
          } finally {
            if (typeof (transport as any).close === 'function') {
              (transport as any).close();
            }
          }
        },
        30_000,
      );
    }
  },
);
