/**
 * Build a `nodemailer` SMTP transport from an `EmailCredentialData` blob.
 *
 * Dispatches on `data.provider` to the matching preset, then layers
 * user-supplied fields (apiKey / user / password) on top. For
 * `provider: 'smtp'` the host/port/secure tuple is also user-supplied.
 *
 * `nodemailer` is an optional peer dependency — the import is dynamic
 * so callers who never reach `buildEmailTransport()` don't pay the
 * install cost.
 */

import type { Transporter } from 'nodemailer';
import { EMAIL_PRESETS, type EmailProviderName } from './presets.js';

/**
 * Per-org credential blob — what the host stores (encrypted) and passes
 * back into `buildEmailTransport()` at send time.
 *
 * Only the fields matching `provider` are read; the rest are ignored so
 * a host can store the union shape (a single form with conditionally
 * relevant fields) without leaking unused values into the auth tuple.
 */
export interface EmailCredentialData {
  provider: EmailProviderName;
  fromEmail: string;
  fromName?: string;
  // Auth bits — relevance is provider-specific:
  apiKey?: string;
  user?: string;
  password?: string;
  // Custom SMTP overrides — ignored for non-`smtp` providers:
  host?: string;
  port?: string | number;
  secure?: string | boolean;
}

function resolveUser(data: EmailCredentialData, userSource: string): string {
  if (userSource.startsWith('literal:')) {
    return userSource.slice('literal:'.length);
  }
  if (userSource === 'user') {
    if (!data.user) {
      throw new Error('SMTP user is required for this provider');
    }
    return data.user;
  }
  throw new Error(`Unknown userSource: ${userSource}`);
}

function resolvePass(
  data: EmailCredentialData,
  passSource: 'apiKey' | 'password',
): string {
  const value = passSource === 'apiKey' ? data.apiKey : data.password;
  if (!value) {
    throw new Error(
      passSource === 'apiKey'
        ? 'API key is required for this provider'
        : 'Password is required for this provider',
    );
  }
  return value;
}

/**
 * Build a `nodemailer` `Transporter` from the credential blob.
 *
 * @throws `Error` when required fields are missing for the chosen provider.
 * @throws `Error` when `nodemailer` is not installed (optional peer).
 */
export async function buildEmailTransport(
  data: EmailCredentialData,
): Promise<Transporter> {
  const preset = EMAIL_PRESETS[data.provider];
  if (!preset) {
    throw new Error(`Unknown email provider: ${data.provider}`);
  }

  // Honor user-supplied host/port/secure for Custom SMTP (host: null)
  // AND for presets that opt in via `allowHostOverride` (SES — region
  // selection). For fixed-host presets (Resend, Gmail, SendGrid,
  // Mailgun) the preset wins to avoid "changed host, kept the API key"
  // footguns.
  const allowOverride = preset.host === null || preset.allowHostOverride === true;
  const overrideHost = data.host?.trim();
  const host = allowOverride && overrideHost ? overrideHost : preset.host;
  if (!host) {
    throw new Error('SMTP host is required');
  }

  const port = allowOverride && data.port !== undefined && data.port !== ''
    ? typeof data.port === 'number'
      ? data.port
      : parseInt(String(data.port), 10)
    : preset.port;

  // `data.secure` can be a real boolean OR the string `'true'`/`'false'`
  // (the form layer hands us strings). Narrow before comparing so TS
  // doesn't reject the mixed comparison.
  let secure = preset.secure;
  if (allowOverride && data.secure !== undefined && data.secure !== '') {
    if (typeof data.secure === 'boolean') {
      secure = data.secure;
    } else if (typeof data.secure === 'string') {
      secure = data.secure === 'true';
    }
  }

  let nodemailer: typeof import('nodemailer');
  try {
    nodemailer = await import('nodemailer');
  } catch {
    throw new Error(
      'nodemailer is required to build an email transport — install it: `npm install nodemailer`',
    );
  }

  // tsdown leaves dynamic imports as-is, and `nodemailer` has both an
  // ESM default export and a CJS `module.exports` shape. Pick whichever
  // is present so we work across packagers.
  const factory = (nodemailer as any).default ?? nodemailer;
  return factory.createTransport({
    host,
    port,
    secure,
    auth: {
      user: resolveUser(data, preset.userSource),
      pass: resolvePass(data, preset.passSource),
    },
  });
}

/**
 * Compose the RFC-5322 `From` header value from the credential blob.
 * Returns `"Display Name" <email@example.com>` when `fromName` is set,
 * otherwise just `email@example.com`.
 */
export function buildFromHeader(data: EmailCredentialData): string {
  const name = data.fromName?.trim();
  return name ? `"${name}" <${data.fromEmail}>` : data.fromEmail;
}
