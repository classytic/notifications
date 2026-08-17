/**
 * SMS Channel
 * @module @classytic/notifications
 *
 * Sends SMS notifications via any provider.
 * Zero dependencies — bring your own SMS SDK.
 *
 * @example
 * ```typescript
 * import { SmsChannel } from '@classytic/notifications/channels';
 *
 * // Twilio (you manage the SDK)
 * import twilio from 'twilio';
 * const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
 *
 * const sms = new SmsChannel({
 *   from: '+15551234567',
 *   provider: {
 *     send: async ({ to, from, body }) => {
 *       const msg = await client.messages.create({ to, from, body });
 *       return { sid: msg.sid };
 *     },
 *   },
 * });
 *
 * // AWS SNS
 * import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
 * const sns = new SNSClient({ region: 'us-east-1' });
 *
 * const snsSms = new SmsChannel({
 *   from: 'MyApp',
 *   provider: {
 *     send: async ({ to, body }) => {
 *       const res = await sns.send(new PublishCommand({
 *         PhoneNumber: to, Message: body,
 *       }));
 *       return { sid: res.MessageId ?? '' };
 *     },
 *   },
 * });
 *
 * // Simple fetch-based (Vonage, MessageBird, etc.)
 * const customSms = new SmsChannel({
 *   from: '+15551234567',
 *   provider: {
 *     send: async ({ to, from, body }) => {
 *       const res = await fetch('https://api.sms-provider.com/send', {
 *         method: 'POST',
 *         headers: { 'Content-Type': 'application/json', 'X-API-Key': '...' },
 *         body: JSON.stringify({ to, from, body }),
 *       });
 *       return { sid: await res.text() };
 *     },
 *   },
 * });
 * ```
 */

import { BaseChannel } from './BaseChannel.js';
import { ChannelError } from '../utils/errors.js';
import type { NotificationPayload, SendResult } from '../types.js';
import type { SmsChannelConfig, SmsProvider } from '../types.js';

export class SmsChannel extends BaseChannel<SmsChannelConfig> {
  private provider: SmsProvider;

  constructor(config: SmsChannelConfig) {
    if (!config.provider) {
      throw new ChannelError(
        config.name ?? 'sms',
        'SmsChannel requires a provider. Pass any SMS SDK (Twilio, SNS, Vonage, etc.) via the provider option.',
      );
    }
    super({ name: 'sms', ...config });
    this.provider = config.provider;
  }

  /**
   * Pre-flight check called by the service before consuming a rate-limit
   * token. Skip if the payload lacks a recipient phone OR a body — these
   * skips are deterministic and shouldn't burn SMS quota.
   */
  canSend(payload: NotificationPayload): SendResult | null {
    if (!payload.recipient.phone) {
      return { status: 'skipped', channel: this.name, error: 'No recipient phone number' };
    }
    const body =
      (payload.data.text as string) ??
      (payload.data.message as string) ??
      (payload.data.subject as string) ??
      '';
    if (!body) {
      return {
        status: 'skipped',
        channel: this.name,
        error: 'No message body (data.text, data.message, or data.subject)',
      };
    }
    return null;
  }

  async send(payload: NotificationPayload): Promise<SendResult> {
    const { recipient, data } = payload;

    if (!recipient.phone) {
      return { status: 'skipped', channel: this.name, error: 'No recipient phone number' };
    }

    const body = (data.text as string) ?? (data.message as string) ?? (data.subject as string) ?? '';

    if (!body) {
      return { status: 'skipped', channel: this.name, error: 'No message body (data.text, data.message, or data.subject)' };
    }

    try {
      const result = await this.provider.send({
        to: recipient.phone,
        from: (data.from as string) ?? this.config.from,
        body,
      });

      return {
        status: 'sent',
        channel: this.name,
        /**
         * The TYPED correlation key. SMS is the case that makes the argument:
         * the provider calls it `sid`, email calls it `messageId`, push calls
         * it `messageId` — three spellings for one concept, so a delivery
         * receipt (a DLR) could only be joined back to its send by code that
         * already knew which channel had produced the result. That is the
         * exact coupling `SendResult.providerMessageId` removes.
         */
        providerMessageId: result.sid,
        /**
         * Kept for one release alongside the typed field. Dropping it here
         * would be a silent removal in a MINOR — exactly what 2.3.0 did to
         * email's `metadata.messageId`, breaking readers with no signal.
         * Removed in 3.0.0, from every channel at once.
         *
         * @deprecated read `providerMessageId`; removed in 3.0.0
         */
        metadata: { sid: result.sid },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ChannelError(this.name, message, err instanceof Error ? err : undefined);
    }
  }
}
