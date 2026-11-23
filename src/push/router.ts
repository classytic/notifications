/**
 * `pushRouter` — one `PushProvider` that dispatches on `message.platform`, so an Android FCM
 * token never reaches APNs and an APNs token never reaches FCM. Generalised from a production
 * per-platform channel split; a single router keeps ONE channel name for triggers to target.
 *
 * A platform with no provider is a permanent rejection (`PushRejectedError`,
 * `platform-disabled`), not a dead token: the device row is kept for when the platform is
 * switched on (an Android-only production with iOS off).
 *
 * @module @classytic/notifications/push
 */

import type { PushPlatform, PushProvider } from '../types.js';
import { PushRejectedError } from './errors.js';

export interface PushRouterOptions {
  readonly android?: PushProvider;
  readonly ios?: PushProvider;
  readonly web?: PushProvider;
  /** Used when a message carries no `platform`. Omit to reject such messages. */
  readonly defaultPlatform?: PushPlatform;
}

export interface PushRouter extends PushProvider {
  /** Platforms with a provider. */
  readonly platforms: readonly PushPlatform[];
  /** Close every distinct provider that has `close()` (APNs sessions). */
  close(): Promise<void>;
}

export function pushRouter(options: PushRouterOptions): PushRouter {
  const table: Partial<Record<PushPlatform, PushProvider>> = {
    ...(options.android ? { android: options.android } : {}),
    ...(options.ios ? { ios: options.ios } : {}),
    ...(options.web ? { web: options.web } : {}),
  };
  const platforms = Object.keys(table) as PushPlatform[];
  if (platforms.length === 0) throw new Error('pushRouter: configure at least one platform provider');

  return {
    platforms,
    async send(message) {
      const platform = message.platform ?? options.defaultPlatform;
      if (!platform) {
        throw new PushRejectedError('router', 0, 'platform-missing', 'message.platform is required');
      }
      const provider = table[platform];
      if (!provider) {
        throw new PushRejectedError('router', 0, 'platform-disabled', `no provider for ${platform}`);
      }
      return provider.send(message.platform ? message : { ...message, platform });
    },
    async close() {
      // One provider may serve two platforms (FCM for Android and iOS): close it once.
      const distinct = new Set(Object.values(table));
      await Promise.all([...distinct].map((p) => p.close?.()));
    },
  };
}
