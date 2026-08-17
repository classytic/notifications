/**
 * Push Notification Channel
 * @module @classytic/notifications
 *
 * Sends push notifications via any provider: FCM, Expo, OneSignal, APNs, etc.
 * Zero dependencies — bring your own push provider.
 *
 * @example
 * ```typescript
 * import { PushChannel } from '@classytic/notifications/channels';
 *
 * // FCM via Firebase Admin (you manage the SDK)
 * import admin from 'firebase-admin';
 * admin.initializeApp({ ... });
 *
 * const push = new PushChannel({
 *   provider: {
 *     send: async ({ token, title, body, data }) => {
 *       const result = await admin.messaging().send({
 *         token,
 *         notification: { title, body },
 *         data,
 *       });
 *       return { messageId: result };
 *     },
 *   },
 * });
 *
 * // Expo Push
 * import { Expo } from 'expo-server-sdk';
 * const expo = new Expo();
 *
 * const expoPush = new PushChannel({
 *   name: 'expo-push',
 *   provider: {
 *     send: async ({ token, title, body, data }) => {
 *       const [receipt] = await expo.sendPushNotificationsAsync([
 *         { to: token, title, body, data },
 *       ]);
 *       return { messageId: receipt.id };
 *     },
 *   },
 * });
 *
 * // Simple fetch-based (OneSignal, custom backend, etc.)
 * const customPush = new PushChannel({
 *   provider: {
 *     send: async ({ token, title, body, data }) => {
 *       const res = await fetch('https://api.push-service.com/send', {
 *         method: 'POST',
 *         headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ...' },
 *         body: JSON.stringify({ token, title, body, data }),
 *       });
 *       return { messageId: await res.text() };
 *     },
 *   },
 * });
 * ```
 */

import { BaseChannel } from './BaseChannel.js';
import { ChannelError } from '../utils/errors.js';
import type { NotificationPayload, SendResult } from '../types.js';
import type { PushChannelConfig, PushProvider } from '../types.js';

export class PushChannel extends BaseChannel<PushChannelConfig> {
  private provider: PushProvider;

  constructor(config: PushChannelConfig) {
    if (!config.provider) {
      throw new ChannelError(
        config.name ?? 'push',
        'PushChannel requires a provider. Pass any push SDK (FCM, Expo, OneSignal, APNs) via the provider option.',
      );
    }
    super({ name: 'push', ...config });
    this.provider = config.provider;
  }

  /**
   * Pre-flight check called by the service before consuming a rate-limit
   * token. Skip when there's no device token or no displayable content.
   */
  canSend(payload: NotificationPayload): SendResult | null {
    if (!payload.recipient.deviceToken) {
      return { status: 'skipped', channel: this.name, error: 'No recipient deviceToken' };
    }
    const title = (payload.data.title as string) ?? (payload.data.subject as string) ?? '';
    const body =
      (payload.data.body as string) ??
      (payload.data.text as string) ??
      (payload.data.message as string) ??
      '';
    if (!title && !body) {
      return {
        status: 'skipped',
        channel: this.name,
        error: 'No title or body (data.title, data.body)',
      };
    }
    return null;
  }

  async send(payload: NotificationPayload): Promise<SendResult> {
    const { recipient, data } = payload;

    if (!recipient.deviceToken) {
      return { status: 'skipped', channel: this.name, error: 'No recipient deviceToken' };
    }

    const title = (data.title as string) ?? (data.subject as string) ?? '';
    const body = (data.body as string) ?? (data.text as string) ?? (data.message as string) ?? '';

    if (!title && !body) {
      return { status: 'skipped', channel: this.name, error: 'No title or body (data.title, data.body)' };
    }

    try {
      const result = await this.provider.send({
        token: recipient.deviceToken,
        title,
        body,
        data: data.pushData as Record<string, string>,
        imageUrl: data.imageUrl as string,
      });

      return {
        status: 'sent',
        channel: this.name,
        /**
         * The TYPED correlation key — same contract email publishes. A push
         * receipt (FCM/APNs feedback, an Expo receipt lookup) arrives naming
         * this id, and until it was here a consumer had to know the result
         * came from THIS channel before it could find it under the untyped
         * key `metadata.messageId`.
         */
        providerMessageId: result.messageId,
        /**
         * Kept for one release alongside the typed field. Dropping it here
         * would be a silent removal in a MINOR — exactly what 2.3.0 did to
         * email's `metadata.messageId`, breaking readers with no signal.
         * Removed in 3.0.0, from every channel at once.
         *
         * @deprecated read `providerMessageId`; removed in 3.0.0
         */
        metadata: { messageId: result.messageId },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ChannelError(this.name, message, err instanceof Error ? err : undefined);
    }
  }
}
