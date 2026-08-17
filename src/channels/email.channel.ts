/**
 * Email Channel (Nodemailer)
 * @module @classytic/notifications
 *
 * Sends email notifications via Nodemailer.
 * Supports any Nodemailer transport: SMTP, SES, Gmail, custom.
 *
 * Requires peer dependency: npm install nodemailer @types/nodemailer
 *
 * @example
 * ```typescript
 * import { EmailChannel } from '@classytic/notifications/channels';
 *
 * // Option 1: SMTP transport options
 * const email = new EmailChannel({
 *   from: 'App <noreply@app.com>',
 *   transport: {
 *     host: 'smtp.gmail.com',
 *     port: 587,
 *     auth: { user: 'user@gmail.com', pass: 'app-password' },
 *   },
 * });
 *
 * // Option 2: Gmail service shorthand
 * const gmail = new EmailChannel({
 *   from: 'noreply@app.com',
 *   transport: { service: 'gmail', auth: { user: '...', pass: '...' } },
 * });
 *
 * // Option 3: Pre-created transporter (SES, custom)
 * import nodemailer from 'nodemailer';
 * import aws from '@aws-sdk/client-ses';
 * const ses = new aws.SES({ region: 'us-east-1' });
 * const email = new EmailChannel({
 *   from: 'noreply@app.com',
 *   transporter: nodemailer.createTransport({ SES: { ses, aws } }),
 * });
 * ```
 */

import { BaseChannel } from './BaseChannel.js';
import { ProviderNotInstalledError, ChannelError } from '../utils/errors.js';
import type {
  EmailChannelConfig,
  NotificationPayload,
  SendResult,
  NodemailerTransporter,
} from '../types.js';

export class EmailChannel extends BaseChannel<EmailChannelConfig> {
  private transporter: NodemailerTransporter | null = null;

  constructor(config: EmailChannelConfig) {
    super({ name: 'email', ...config });
  }

  /** Lazily initialize the Nodemailer transporter */
  private async getTransporter(): Promise<NodemailerTransporter> {
    if (this.transporter) return this.transporter;

    // User passed a pre-created transporter
    if (this.config.transporter) {
      this.transporter = this.config.transporter;
      return this.transporter;
    }

    // Create from transport options
    if (!this.config.transport) {
      throw new ChannelError(this.name, 'Either transport options or a transporter instance is required');
    }

    try {
      const nodemailer = await import('nodemailer');
      this.transporter = nodemailer.default.createTransport(
        this.config.transport as Record<string, unknown>,
      ) as unknown as NodemailerTransporter;
      return this.transporter;
    } catch {
      throw new ProviderNotInstalledError('nodemailer', 'npm install nodemailer');
    }
  }

  /** Fields that defaults must never override */
  private static readonly PROTECTED_FIELDS = new Set([
    'to', 'from', 'subject', 'html', 'text', 'cc', 'bcc', 'replyTo', 'attachments',
  ]);

  /**
   * Pre-flight check called by the service before consuming a rate-limit
   * token. Returning a skip result here avoids burning quota on payloads
   * that obviously can't deliver (e.g., a mixed-channel batch where the
   * recipient has a phone but no email).
   */
  canSend(payload: NotificationPayload): SendResult | null {
    if (!payload.recipient.email) {
      return { status: 'skipped', channel: this.name, error: 'No recipient email' };
    }
    return null;
  }

  async send(payload: NotificationPayload): Promise<SendResult> {
    const { recipient, data } = payload;

    if (!recipient.email) {
      return { status: 'skipped', channel: this.name, error: 'No recipient email' };
    }

    const transporter = await this.getTransporter();

    // Defaults go first — per-send fields always win.
    // Protected fields (to, from, subject, etc.) are stripped from defaults
    // to prevent accidental misdirection of emails.
    const safeDefaults: Record<string, unknown> = {};
    if (this.config.defaults) {
      for (const [key, value] of Object.entries(this.config.defaults)) {
        if (!EmailChannel.PROTECTED_FIELDS.has(key)) {
          safeDefaults[key] = value;
        }
      }
    }

    // Per-send `from` override is gated behind `allowSenderOverride` (default
    // off) to prevent sender spoofing via the free-form `data` bag.
    const sender =
      this.config.allowSenderOverride && typeof data.from === 'string'
        ? data.from
        : this.config.from;

    const mailOptions: Record<string, unknown> = {
      ...safeDefaults,
      from: sender,
      to: recipient.email,
      subject: data.subject as string ?? '',
    };

    if (data.html) mailOptions.html = data.html;
    if (data.text) mailOptions.text = data.text;
    if (data.replyTo) mailOptions.replyTo = data.replyTo;
    if (data.cc) mailOptions.cc = data.cc;
    if (data.bcc) mailOptions.bcc = data.bcc;
    if (data.attachments) mailOptions.attachments = data.attachments;

    // RFC 8058 List-Unsubscribe headers (CAN-SPAM / CASL / Google+Yahoo 2024).
    // Per-send `listUnsubscribeUrl` in payload.data overrides the channel default
    // so each subscriber can get their own token-based unsubscribe link.
    const unsubUrl = (data.listUnsubscribeUrl as string | undefined) ?? this.config.listUnsubscribe?.url;
    const unsubEmail = (data.listUnsubscribeEmail as string | undefined) ?? this.config.listUnsubscribe?.email;
    if (unsubUrl || unsubEmail) {
      const parts: string[] = [];
      if (unsubUrl) parts.push(`<${unsubUrl}>`);
      if (unsubEmail) parts.push(`<mailto:${unsubEmail}>`);
      const existingHeaders = (mailOptions.headers as Record<string, string> | undefined) ?? {};
      mailOptions.headers = {
        ...existingHeaders,
        'List-Unsubscribe': parts.join(', '),
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }

    try {
      const result = await transporter.sendMail(mailOptions);
      return {
        status: 'sent',
        channel: this.name,
        /**
         * The TYPED field, not `metadata.messageId`.
         *
         * This id is what a bounce or complaint webhook arrives under, so it is the
         * only thing joining this send to what actually happened to the mail. It sat
         * in the untyped `metadata` bag, where every channel spells it differently
         * and a consumer has to know which channel produced the result before it can
         * find the id — which is why `SendResult.providerMessageId` exists.
         */
        providerMessageId: result.messageId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ChannelError(this.name, message, err instanceof Error ? err : undefined);
    }
  }

  /** Verify the SMTP connection (useful for health checks) */
  async verify(): Promise<boolean> {
    const transporter = await this.getTransporter();
    if (transporter.verify) {
      return transporter.verify();
    }
    return true;
  }

  /** Close the transporter connection */
  close(): void {
    if (this.transporter?.close) {
      this.transporter.close();
    }
    this.transporter = null;
  }
}
