/**
 * FCM HTTP v1 provider — no SDK. `fetch` + `node:crypto`:
 *
 *   1. A service-account JWT (RS256) is exchanged at Google's token endpoint for an OAuth2 access
 *      token, cached until 60 s before expiry. Concurrent sends share ONE in-flight refresh.
 *   2. `POST /v1/projects/{projectId}/messages:send` with that token.
 *
 * Error mapping (status / FCM `errorCode` → outcome):
 *
 *   UNREGISTERED (404)                               InvalidPushTokenError `unregistered` + onInvalidToken
 *   INVALID_ARGUMENT naming the token (400)          InvalidPushTokenError `invalid-token` + onInvalidToken
 *   INVALID_ARGUMENT about the payload (400)         PushRejectedError (device kept)
 *   SENDER_ID_MISMATCH (403)                         PushRejectedError (device kept: a project mix-up
 *                                                    must not wipe every device row)
 *   THIRD_PARTY_AUTH_ERROR (401)                     PushRejectedError (APNs key in Firebase is wrong)
 *   401 UNAUTHENTICATED                              fresh access token, ONE immediate retry, then
 *                                                    PushCredentialsError
 *   403 PERMISSION_DENIED                            PushCredentialsError
 *   QUOTA_EXCEEDED (429), UNAVAILABLE (503),
 *   INTERNAL (500), other 5xx, network, timeout      TransientPushError (+ Retry-After, cool-down)
 *   other 4xx                                        PushRejectedError
 *
 * @module @classytic/notifications/push
 */

import type { KeyObject } from 'node:crypto';
import type { PushProvider, PushProviderMessage } from '../types.js';
import { apnsHeaderValues, buildAps, collapseKeyTooLong, isVisible, type ApsOptions } from './aps.js';
import {
  createCredentialResolver,
  GOOGLE_TOKEN_URI,
  importPushKey,
  validateFcmCredentials,
  type CredentialsSource,
  type FcmCredentials,
  type ResolvedCredentials,
} from './credentials.js';
import {
  InvalidPushTokenError,
  PushCredentialsError,
  PushRejectedError,
  TransientPushError,
  type InvalidTokenReason,
} from './errors.js';
import {
  createCooldown,
  createGate,
  failureEvent,
  parseRetryAfter,
  reportInvalid,
  tokenHash,
  tokenSuffix,
  type InvalidTokenHandler,
  type PushDeliveryEvent,
  type PushDeliveryListener,
} from './internal.js';
import { signJwt } from './jwt.js';

export const FCM_ENDPOINT = 'https://fcm.googleapis.com';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface FcmProviderOptions extends ApsOptions {
  /** Service-account credentials, or a function returning the current ones (re-read per send). */
  readonly credentials: CredentialsSource<FcmCredentials>;
  /** Dead-token hook (delete the device row). */
  readonly onInvalidToken?: InvalidTokenHandler;
  /** One structured, redacted event per send (opt-in delivery log / metrics). */
  readonly onDelivery?: PushDeliveryListener;
  /** FCM origin. Default `https://fcm.googleapis.com` (tests point it at a local server). */
  readonly endpoint?: string;
  /** Request timeout per HTTP call. Default 10 000 ms. */
  readonly timeoutMs?: number;
  /** Max sends in flight from this provider instance. Default 100. */
  readonly maxConcurrency?: number;
  /** Ask FCM to validate without delivering (`validate_only`). For a "send test" dry run. */
  readonly validateOnly?: boolean;
  /** Injected `fetch` (tests, proxies). Default `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Clock (ms). Default `Date.now`. */
  readonly now?: () => number;
}

interface AccessToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly fingerprint: string;
}

/** FCM data rules: string values only, no reserved keys. */
const RESERVED_DATA_KEY = /^(from|notification|message_type)$|^(google|gcm)/i;
const TOKEN_SHAPE = /^[^\s]{1,4096}$/;

/** Build the FCM v1 `message` object. Exported for tests and for hosts that inspect payloads. */
export function buildFcmMessage(message: PushProviderMessage, options: ApsOptions, nowMs: number): Record<string, unknown> {
  const visible = isVisible(message);
  const headers = apnsHeaderValues(message, nowMs);
  const priority = message.priority ?? (visible ? 'high' : 'normal');
  const android: Record<string, unknown> = { priority: priority === 'high' ? 'HIGH' : 'NORMAL' };
  if (message.ttlSeconds !== undefined) android.ttl = `${message.ttlSeconds}s`;
  if (message.collapseKey) android.collapseKey = message.collapseKey;
  if (visible) {
    const notification: Record<string, unknown> = {};
    if (message.collapseKey) notification.tag = message.collapseKey;
    if (message.badge !== undefined) notification.notificationCount = message.badge;
    if (message.channelId) notification.channelId = message.channelId;
    if (message.sound !== null) notification.sound = message.sound ?? 'default';
    if (message.category) notification.clickAction = message.category;
    if (Object.keys(notification).length) android.notification = notification;
  }
  const apnsHeaders: Record<string, string> = {
    'apns-priority': headers.priority,
    'apns-push-type': headers.pushType,
    ...(message.collapseKey ? { 'apns-collapse-id': message.collapseKey } : {}),
    ...(headers.expiration !== undefined ? { 'apns-expiration': headers.expiration } : {}),
  };
  return {
    token: message.token,
    ...(visible
      ? {
          notification: {
            ...(message.title ? { title: message.title } : {}),
            ...(message.body ? { body: message.body } : {}),
            ...(message.imageUrl ? { image: message.imageUrl } : {}),
          },
        }
      : {}),
    ...(message.data && Object.keys(message.data).length ? { data: message.data } : {}),
    android,
    apns: { headers: apnsHeaders, payload: { aps: buildAps(message, options) } },
  };
}

function checkMessage(message: PushProviderMessage): void {
  if (typeof message.token !== 'string' || !TOKEN_SHAPE.test(message.token)) {
    throw new PushRejectedError('fcm', 0, 'invalid-token-format', 'token must be a non-empty string without spaces');
  }
  if (collapseKeyTooLong(message.collapseKey)) {
    throw new PushRejectedError('fcm', 0, 'collapse-key-too-long', 'collapseKey exceeds 64 bytes');
  }
  for (const [key, value] of Object.entries(message.data ?? {})) {
    if (typeof value !== 'string') throw new PushRejectedError('fcm', 0, 'invalid-data', `data.${key} must be a string`);
    if (RESERVED_DATA_KEY.test(key)) throw new PushRejectedError('fcm', 0, 'invalid-data', `data.${key} is reserved by FCM`);
  }
}

interface FcmErrorBody {
  status?: string;
  errorCode?: string;
  tokenNamed: boolean;
  /** A per-device quota ("Device message rate exceeded"): must not cool down the whole provider. */
  perDevice: boolean;
}

/** Pull the codes out of an FCM error body; the free-text message is inspected, never kept. */
function parseFcmError(text: string): FcmErrorBody {
  try {
    const parsed = JSON.parse(text) as {
      error?: {
        status?: string;
        message?: string;
        details?: Array<{ '@type'?: string; errorCode?: string; fieldViolations?: Array<{ field?: string }> }>;
      };
    };
    const err = parsed.error ?? {};
    let errorCode: string | undefined;
    let tokenNamed = typeof err.message === 'string' && /registration token/i.test(err.message);
    for (const detail of err.details ?? []) {
      if (typeof detail.errorCode === 'string') errorCode = detail.errorCode;
      if (detail.fieldViolations?.some((v) => v.field === 'message.token')) tokenNamed = true;
    }
    const perDevice = typeof err.message === 'string' && /device/i.test(err.message);
    return {
      ...(err.status ? { status: err.status } : {}),
      ...(errorCode ? { errorCode } : {}),
      tokenNamed,
      perDevice,
    };
  } catch {
    return { tokenNamed: false, perDevice: false };
  }
}

export function fcmProvider(options: FcmProviderOptions): PushProvider {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('fcmProvider: no fetch implementation (Node 18+ or options.fetch)');
  const endpoint = (options.endpoint ?? FCM_ENDPOINT).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const gate = createGate(options.maxConcurrency ?? 100);
  const cooldown = createCooldown(now);

  let access: AccessToken | undefined;
  let refreshing: { fingerprint: string; promise: Promise<AccessToken> } | undefined;

  const resolver = createCredentialResolver<FcmCredentials, KeyObject>(
    'fcm',
    options.credentials,
    validateFcmCredentials,
    (creds) => importPushKey('fcm', creds.privateKey),
    () => {
      // Rotated service account: the old access token belongs to the old identity.
      access = undefined;
    },
  );

  const emit = (event: Omit<PushDeliveryEvent, 'provider' | 'tokenSuffix' | 'tokenHash'>, token: string) => {
    if (!options.onDelivery) return;
    try {
      options.onDelivery({ provider: 'fcm', tokenSuffix: tokenSuffix(token), tokenHash: tokenHash(token), ...event });
    } catch {
      // A broken listener must not fail a delivered push.
    }
  };

  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = (err as { name?: string })?.name === 'TimeoutError';
      throw new TransientPushError('fcm', 0, timedOut ? 'timeout' : 'network', {
        ...(err instanceof Error ? { cause: err } : {}),
      });
    }
  }

  async function fetchAccessToken(resolved: ResolvedCredentials<FcmCredentials, KeyObject>): Promise<AccessToken> {
    const { creds, derived: key } = resolved;
    const tokenUri = creds.tokenUri ?? GOOGLE_TOKEN_URI;
    const iat = Math.floor(now() / 1000);
    const assertion = signJwt(
      'RS256',
      key,
      { iss: creds.clientEmail, scope: FCM_SCOPE, aud: tokenUri, iat, exp: iat + 3600 },
      { typ: 'JWT', ...(creds.privateKeyId ? { kid: creds.privateKeyId } : {}) },
    );
    const res = await request(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now());
        throw new TransientPushError('fcm', res.status, 'token-endpoint', retryAfterMs !== undefined ? { retryAfterMs } : {});
      }
      let code = 'refused';
      try {
        code = String((JSON.parse(text) as { error?: string }).error ?? code);
      } catch {
        // keep generic
      }
      throw new PushCredentialsError('fcm', `token endpoint refused the service account (${res.status} ${code})`);
    }
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new TransientPushError('fcm', res.status, 'token-endpoint-malformed');
    }
    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      throw new TransientPushError('fcm', res.status, 'token-endpoint-malformed');
    }
    const expiresIn = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 3600;
    return { token: parsed.access_token, expiresAt: now() + expiresIn * 1000, fingerprint: resolved.fingerprint };
  }

  /** Cached token, or ONE shared refresh for every concurrent caller. */
  async function accessToken(resolved: ResolvedCredentials<FcmCredentials, KeyObject>, force: boolean): Promise<string> {
    if (!force && access && access.fingerprint === resolved.fingerprint && now() < access.expiresAt - 60_000) {
      return access.token;
    }
    if (refreshing && refreshing.fingerprint === resolved.fingerprint) return (await refreshing.promise).token;
    const promise = fetchAccessToken(resolved);
    const entry = { fingerprint: resolved.fingerprint, promise };
    refreshing = entry;
    try {
      const fresh = await promise;
      access = fresh;
      return fresh.token;
    } finally {
      if (refreshing === entry) refreshing = undefined;
    }
  }

  async function invalid(token: string, reason: InvalidTokenReason, status: number): Promise<never> {
    await reportInvalid(options.onInvalidToken, token, reason);
    throw new InvalidPushTokenError('fcm', reason, status, tokenSuffix(token));
  }

  async function sendOnce(message: PushProviderMessage, started: number): Promise<{ messageId: string }> {
    const waitMs = cooldown.remaining();
    if (waitMs > 0) throw new TransientPushError('fcm', 429, 'cooling-down', { retryAfterMs: waitMs });

    const resolved = await resolver.resolve();
    const body = JSON.stringify({
      ...(options.validateOnly ? { validate_only: true } : {}),
      message: buildFcmMessage(message, options, now()),
    });
    // FCM enforces its 4 KB payload limit itself (400 INVALID_ARGUMENT → PushRejectedError).
    const url = `${endpoint}/v1/projects/${encodeURIComponent(resolved.creds.projectId)}/messages:send`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const bearer = await accessToken(resolved, attempt > 0);
      const res = await request(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json; charset=utf-8' },
        body,
      });
      const text = await res.text();
      if (res.ok) {
        let messageId = 'fcm';
        try {
          messageId = String((JSON.parse(text) as { name?: unknown }).name ?? messageId);
        } catch {
          // 200 without a parseable body is still delivered.
        }
        emit(
          { outcome: 'sent', status: res.status, messageId, latencyMs: now() - started, ...platformOf(message) },
          message.token,
        );
        return { messageId };
      }

      const err = parseFcmError(text);
      const reason = err.errorCode ?? err.status ?? String(res.status);

      if (res.status === 401 && err.errorCode !== 'THIRD_PARTY_AUTH_ERROR') {
        // Our access token was refused (revoked, clock skew). Refresh once, then give up.
        access = undefined;
        if (attempt === 0) continue;
        throw new PushCredentialsError('fcm', 'access token refused twice (401 UNAUTHENTICATED)');
      }
      if (err.errorCode === 'UNREGISTERED' || (res.status === 404 && err.status === 'NOT_FOUND')) {
        return invalid(message.token, 'unregistered', res.status);
      }
      if ((err.errorCode === 'INVALID_ARGUMENT' || err.status === 'INVALID_ARGUMENT') && err.tokenNamed) {
        return invalid(message.token, 'invalid-token', res.status);
      }
      if (res.status === 403 && err.errorCode !== 'SENDER_ID_MISMATCH') {
        throw new PushCredentialsError('fcm', `service account lacks permission to send (403 ${reason})`);
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now());
        if (retryAfterMs !== undefined && !err.perDevice) cooldown.hold(retryAfterMs);
        throw new TransientPushError('fcm', res.status, reason, retryAfterMs !== undefined ? { retryAfterMs } : {});
      }
      throw new PushRejectedError('fcm', res.status, reason);
    }
    /* c8 ignore next */
    throw new TransientPushError('fcm', 0, 'unreachable');
  }

  return {
    async send(message) {
      const started = now();
      try {
        checkMessage(message);
        return await gate(() => sendOnce(message, started));
      } catch (err) {
        emit({ ...failureEvent(err), latencyMs: now() - started, ...platformOf(message) }, message.token);
        throw err;
      }
    },
  };
}

function platformOf(message: PushProviderMessage): { platform?: PushProviderMessage['platform'] } {
  return message.platform ? { platform: message.platform } : {};
}
