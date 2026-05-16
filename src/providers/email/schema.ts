/**
 * Credential field schema for the email provider.
 *
 * Hosts that ship a dynamic credential form (driven by a provider's
 * `getCredentialSchema()`-style method) read this to render the right
 * fields. Returning the UNION of all provider-specific fields keeps the
 * form generic — the UI hides irrelevant fields based on the chosen
 * `provider`. Only relevant fields get saved into the encrypted blob.
 *
 * Shape is host-agnostic (no `@classytic/social` import). Hosts that
 * use the social registry's `CredentialField` type can structurally cast.
 */

import { EMAIL_PROVIDER_OPTIONS } from './presets.js';

export type EmailCredentialFieldType =
  | 'text'
  | 'password'
  | 'url'
  | 'select'
  | 'textarea';

export interface EmailCredentialField {
  name: string;
  displayName: string;
  type: EmailCredentialFieldType;
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: { label: string; value: string }[];
}

/** Union-of-fields schema — every field appears; the UI hides what's
 *  not relevant for the chosen `provider`. */
export function getEmailCredentialSchema(): EmailCredentialField[] {
  return [
    {
      name: 'provider',
      displayName: 'Provider',
      type: 'select',
      required: true,
      options: EMAIL_PROVIDER_OPTIONS,
      description: 'Which SMTP relay handles your sends.',
    },
    {
      name: 'fromEmail',
      displayName: 'From Email',
      type: 'text',
      required: true,
      placeholder: 'hello@yourdomain.com',
      description:
        'Must be verified with your provider — sends from unverified addresses are rejected.',
    },
    {
      name: 'fromName',
      displayName: 'From Name',
      type: 'text',
      required: false,
      placeholder: 'Your Brand',
      description: 'Optional. Shown as the sender name in inboxes.',
    },
    {
      name: 'apiKey',
      displayName: 'API Key',
      type: 'password',
      required: false,
      description: 'Resend or SendGrid only.',
    },
    {
      name: 'user',
      displayName: 'SMTP Username',
      type: 'text',
      required: false,
      description: 'Gmail address, Mailgun SMTP user, or custom SMTP user.',
    },
    {
      name: 'password',
      displayName: 'SMTP Password',
      type: 'password',
      required: false,
      description:
        'Gmail app password, Mailgun SMTP password, or custom SMTP password.',
    },
    {
      name: 'host',
      displayName: 'SMTP Host',
      type: 'text',
      required: false,
      placeholder: 'smtp.example.com',
      description: 'Custom SMTP only — preset hosts are filled automatically.',
    },
    {
      name: 'port',
      displayName: 'SMTP Port',
      type: 'text',
      required: false,
      placeholder: '587',
      description: 'Custom SMTP only.',
    },
    {
      name: 'secure',
      displayName: 'Secure (implicit TLS)',
      type: 'select',
      required: false,
      options: [
        { value: 'true', label: 'true (port 465 / implicit TLS)' },
        { value: 'false', label: 'false (port 587 / STARTTLS)' },
      ],
      description: 'Custom SMTP only.',
    },
  ];
}
