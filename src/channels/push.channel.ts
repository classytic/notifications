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
        metadata: { messageId: result.messageId },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ChannelError(this.name, message, err instanceof Error ? err : undefined);
    }
  }
}
