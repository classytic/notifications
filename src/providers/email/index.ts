/**
 * Email provider primitives.
 *
 * Host integrations import these to build a "bring-your-own-email"
 * credential UI + send flow: one credential type with multi-provider
 * (Resend, Gmail, SendGrid, Mailgun, custom SMTP) under the hood.
 *
 * Pair with `EmailChannel` from `@classytic/notifications/channels`
 * for runtime dispatch.
 */

export {
  EMAIL_PRESETS,
  EMAIL_PROVIDER_OPTIONS,
  type EmailPreset,
  type EmailProviderName,
} from './presets.js';
export {
  buildEmailTransport,
  buildFromHeader,
  type EmailCredentialData,
} from './transport.js';
export {
  getEmailCredentialSchema,
  type EmailCredentialField,
  type EmailCredentialFieldType,
} from './schema.js';
export {
  testEmailCredential,
  type EmailTestResult,
  type EmailTestStatus,
} from './test.js';
