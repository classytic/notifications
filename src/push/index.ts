/**
 * `@classytic/notifications/push` — mobile push transports with zero dependencies (node built-ins
 * only): FCM HTTP v1, APNs over HTTP/2, a per-platform router, and content-free payload helpers.
 *
 * Each export is a plain `PushProvider`, so it plugs into the existing `PushChannel` (or any
 * channel that calls `provider.send`).
 *
 * @example
 * ```ts
 * import { PushChannel } from '@classytic/notifications';
 * import { apnsProvider, fcmProvider, pushRouter } from '@classytic/notifications/push';
 *
 * const dropToken = (token: string) => devices.deleteOne({ token });
 * const push = pushRouter({
 *   android: fcmProvider({ credentials: () => vault.fcm(), onInvalidToken: dropToken }),
 *   ios: apnsProvider({ credentials: () => vault.apns(), onInvalidToken: dropToken }),
 * });
 * const channel = new PushChannel({ provider: push });
 * // send with data.platform = 'android' | 'ios'
 * ```
 *
 * @module @classytic/notifications/push
 */

export { fcmProvider, buildFcmMessage, FCM_ENDPOINT, FCM_SCOPE } from './fcm.js';
export type { FcmProviderOptions } from './fcm.js';

export { apnsProvider, buildApnsPayload, APNS_HOSTS, APNS_TOKEN_TTL_MS } from './apns.js';
export type { ApnsProviderOptions, ApnsSession } from './apns.js';

export { pushRouter } from './router.js';
export type { PushRouter, PushRouterOptions } from './router.js';

export { createContentFreeBuilder, contentFreeOnly, OPAQUE_ID } from './payload.js';
export type { ContentFreeMessage, ContentFreeOptions } from './payload.js';

export {
  parseFcmServiceAccount,
  validateFcmCredentials,
  validateApnsCredentials,
  credentialsFingerprint,
  normalizePem,
  GOOGLE_TOKEN_URI,
} from './credentials.js';
export type { ApnsCredentials, CredentialsSource, FcmCredentials } from './credentials.js';

export {
  InvalidPushTokenError,
  PushRejectedError,
  PushCredentialsError,
  TransientPushError,
  isInvalidPushTokenError,
} from './errors.js';
export type { InvalidTokenReason, PushProviderName } from './errors.js';

export { PUSH_RETRY_DEFAULTS, planPushRetry, pushRetryDelay, pushRetryFloorMs } from './retry.js';
export type { PushRetryDecision, PushRetryDelayOptions, PushRetryInput } from './retry.js';

export { tokenSuffix, tokenHash, parseRetryAfter } from './internal.js';
export type { InvalidTokenHandler, PushDeliveryEvent, PushDeliveryListener } from './internal.js';

export { signJwt, fingerprint } from './jwt.js';
export type { JwtAlgorithm } from './jwt.js';

export { buildAps, effectiveLevel } from './aps.js';
export type { ApsOptions } from './aps.js';

export type {
  PushProvider,
  PushProviderMessage,
  PushPlatform,
  PushInterruptionLevel,
} from '../types.js';
