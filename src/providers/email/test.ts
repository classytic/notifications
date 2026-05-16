/**
 * Validate an email credential by building its transport and asking the
 * underlying SMTP server to verify the auth tuple. Used by hosts during
 * "Test Connection" flows.
 *
 * Returns a typed result rather than throwing — UI consumers usually
 * want to surface the message + status pair regardless of outcome.
 */

import { EMAIL_PRESETS } from './presets.js';
import {
  buildEmailTransport,
  type EmailCredentialData,
} from './transport.js';

export type EmailTestStatus = 'OK' | 'Error';

export interface EmailTestResult {
  status: EmailTestStatus;
  message: string;
  /** Set when status === 'OK'. */
  data?: {
    provider: EmailCredentialData['provider'];
    fromEmail: string;
  };
}

export async function testEmailCredential(
  data: EmailCredentialData,
): Promise<EmailTestResult> {
  if (!data.provider) {
    return { status: 'Error', message: 'Provider is required' };
  }
  if (!data.fromEmail) {
    return { status: 'Error', message: 'From email is required' };
  }
  if (!Object.keys(EMAIL_PRESETS).includes(data.provider)) {
    return { status: 'Error', message: `Unknown provider: ${data.provider}` };
  }

  let transport: Awaited<ReturnType<typeof buildEmailTransport>>;
  try {
    transport = await buildEmailTransport(data);
  } catch (err: any) {
    return {
      status: 'Error',
      message: err?.message ?? 'Failed to build SMTP transport',
    };
  }

  try {
    // `nodemailer`'s `verify()` opens a connection + completes the auth
    // handshake against the configured server, returning true on success.
    if (typeof transport.verify === 'function') {
      await transport.verify();
    }
    return {
      status: 'OK',
      message: `SMTP connection verified for ${data.fromEmail}`,
      data: {
        provider: data.provider,
        fromEmail: data.fromEmail,
      },
    };
  } catch (err: any) {
    return {
      status: 'Error',
      message: err?.message ?? 'SMTP verification failed',
    };
  } finally {
    // Verify-only transports get torn down — don't keep a pooled
    // connection open just because the test ran.
    if (typeof transport.close === 'function') {
      transport.close();
    }
  }
}
