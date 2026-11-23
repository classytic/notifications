/**
 * APNs provider — HTTP/2 with token-based auth, no library. `node:http2` + `node:crypto`:
 *
 *   - Provider token: ES256 JWT `{ alg, kid } . { iss: teamId, iat }`, signed with the `.p8` key,
 *     reused for `tokenTtlMs` (default 50 min; Apple accepts 20 to 60) and re-signed early when
 *     the credentials rotate or Apple answers `ExpiredProviderToken`.
 *   - One HTTP/2 session per APNs host, reused for every send (Apple asks for long-lived
 *     connections), dropped on GOAWAY / close / error and reopened on the next send. The session
 *     is ref'd only while streams are in flight, so an idle provider never holds the process open.
 *   - TLS uses Node's defaults (certificate verification on). A plaintext host is refused unless
 *     `allowPlaintext` is set, which exists for tests against a local h2c server only.
 *
 * Error mapping (status / Apple `reason` → outcome):
 *
 *   410 Unregistered                           InvalidPushTokenError `unregistered` + onInvalidToken
 *   400 BadDeviceToken                         InvalidPushTokenError `bad-device-token` + onInvalidToken
 *   400 DeviceTokenNotForTopic, BadTopic, ...  PushRejectedError (device kept: a wrong bundle id
 *                                              must not wipe every iOS device row)
 *   403 ExpiredProviderToken /                 new JWT, ONE immediate retry, then PushCredentialsError
 *       InvalidProviderToken
 *   403 other                                  PushCredentialsError
 *   413 PayloadTooLarge, 404, 405, other 4xx   PushRejectedError
 *   429 TooManyProviderTokenUpdates            TransientPushError + provider cool-down
 *   429 TooManyRequests (one device)           TransientPushError (no global cool-down)
 *   500, 503, stream/session errors, timeout   TransientPushError (+ Retry-After)
 *
 * @module @classytic/notifications/push
 */

import type { KeyObject } from 'node:crypto';
import http2 from 'node:http2';
import type { PushProvider, PushProviderMessage } from '../types.js';
import { apnsHeaderValues, buildAps, collapseKeyTooLong, type ApsOptions } from './aps.js';
import {
  createCredentialResolver,
  importPushKey,
  validateApnsCredentials,
  type ApnsCredentials,
  type CredentialsSource,
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

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

/** Default provider-token lifetime: inside Apple's 20 to 60 minute window with margin. */
export const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;
const MIN_TTL_MS = 20 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 4096;
const DEVICE_TOKEN = /^[0-9a-fA-F]{16,400}$/;

/** The part of `http2.ClientHttp2Session` the provider uses (injectable for tests). */
export interface ApnsSession {
  request(headers: http2.OutgoingHttpHeaders): http2.ClientHttp2Stream;
  close(): void;
  ref(): void;
  unref(): void;
  readonly closed: boolean;
  readonly destroyed: boolean;
  on(event: 'error' | 'goaway' | 'close', listener: (...args: unknown[]) => void): unknown;
}

export interface ApnsProviderOptions extends ApsOptions {
  /** Signing key + ids + bundle id + environment, or a function returning the current ones. */
  readonly credentials: CredentialsSource<ApnsCredentials>;
  /** Dead-token hook (delete the device row). */
  readonly onInvalidToken?: InvalidTokenHandler;
  /** One structured, redacted event per send (opt-in delivery log / metrics). */
  readonly onDelivery?: PushDeliveryListener;
  /** Provider-token reuse window. Default 50 min; must be within 20 to 60 min. */
  readonly tokenTtlMs?: number;
  /** Per-request timeout. Default 10 000 ms. */
  readonly requestTimeoutMs?: number;
  /** Max streams in flight from this provider instance. Default 500 (Apple allows ~1000 per connection). */
  readonly maxConcurrency?: number;
  /** Override the APNs origin (tests). Wins over `credentials.environment`. */
  readonly host?: string;
  /** Permit an `http://` (h2c) host. Tests only. */
  readonly allowPlaintext?: boolean;
  /** Extra TLS / session options for `http2.connect` (a test CA, a proxy agent). */
  readonly connectOptions?: http2.SecureClientSessionOptions;
  /** Injected connector (tests). Default `http2.connect`. */
  readonly connect?: (authority: string, options?: http2.SecureClientSessionOptions) => ApnsSession;
  /** Clock (ms). Default `Date.now`. */
  readonly now?: () => number;
}

interface ProviderToken {
  readonly token: string;
  readonly issuedAt: number;
  readonly fingerprint: string;
}

interface ApnsResponse {
  readonly status: number;
  readonly apnsId?: string;
  readonly reason?: string;
  readonly retryAfter?: string | string[];
}

/** The APNs JSON payload for a message. Exported for tests and payload inspection. */
export function buildApnsPayload(message: PushProviderMessage, options: ApsOptions): Record<string, unknown> {
  const custom: Record<string, unknown> = { ...(message.data ?? {}) };
  if (message.imageUrl) custom.imageUrl = message.imageUrl;
  return { ...custom, aps: buildAps(message, options) };
}

export function apnsProvider(options: ApnsProviderOptions): PushProvider & { close(): Promise<void> } {
  const now = options.now ?? Date.now;
  const tokenTtlMs = options.tokenTtlMs ?? APNS_TOKEN_TTL_MS;
  if (tokenTtlMs < MIN_TTL_MS || tokenTtlMs >= MAX_TTL_MS) {
    throw new Error('apnsProvider: tokenTtlMs must be at least 20 minutes and under 60 minutes (Apple)');
  }
  if (options.host && !options.host.startsWith('https://') && !options.allowPlaintext) {
    throw new Error('apnsProvider: host must be https:// (allowPlaintext is for tests only)');
  }
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  const gate = createGate(options.maxConcurrency ?? 500);
  const cooldown = createCooldown(now);
  const connect =
    options.connect ??
    ((authority: string, connectOptions?: http2.SecureClientSessionOptions) =>
      http2.connect(authority, connectOptions) as unknown as ApnsSession);

  let providerToken: ProviderToken | undefined;
  const sessions = new Map<string, { session: ApnsSession; active: number }>();

  const resolver = createCredentialResolver<ApnsCredentials, KeyObject>(
    'apns',
    options.credentials,
    validateApnsCredentials,
    (creds) => importPushKey('apns', creds.privateKey),
    (next) => {
      providerToken = undefined;
      // A moved environment means a different host: close sessions to hosts no longer used.
      const keep = authorityOf(next.creds);
      for (const [authority, entry] of sessions) {
        if (authority !== keep) {
          sessions.delete(authority);
          entry.session.close();
        }
      }
    },
  );

  function authorityOf(creds: ApnsCredentials): string {
    return options.host ?? APNS_HOSTS[creds.environment ?? 'production'];
  }

  function bearer(resolved: ResolvedCredentials<ApnsCredentials, KeyObject>, force: boolean): string {
    const t = now();
    if (
      !force &&
      providerToken &&
      providerToken.fingerprint === resolved.fingerprint &&
      t - providerToken.issuedAt < tokenTtlMs
    ) {
      return providerToken.token;
    }
    const token = signJwt(
      'ES256',
      resolved.derived,
      { iss: resolved.creds.teamId, iat: Math.floor(t / 1000) },
      { kid: resolved.creds.keyId },
    );
    providerToken = { token, issuedAt: t, fingerprint: resolved.fingerprint };
    return token;
  }

  function sessionFor(authority: string): { session: ApnsSession; active: number } {
    const existing = sessions.get(authority);
    if (existing && !existing.session.closed && !existing.session.destroyed) return existing;
    const session = connect(authority, options.connectOptions);
    const entry = { session, active: 0 };
    const drop = () => {
      if (sessions.get(authority) === entry) sessions.delete(authority);
    };
    session.on('error', drop);
    session.on('goaway', drop);
    session.on('close', drop);
    session.unref();
    sessions.set(authority, entry);
    return entry;
  }

  function post(authority: string, headers: http2.OutgoingHttpHeaders, body: string): Promise<ApnsResponse> {
    return new Promise<ApnsResponse>((resolve, reject) => {
      let entry: { session: ApnsSession; active: number };
      let stream: http2.ClientHttp2Stream;
      try {
        entry = sessionFor(authority);
        stream = entry.session.request(headers);
      } catch (err) {
        reject(new TransientPushError('apns', 0, 'network', err instanceof Error ? { cause: err } : {}));
        return;
      }
      // Hold the process open only while a stream is in flight.
      if (entry.active++ === 0) entry.session.ref();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (--entry.active === 0 && !entry.session.destroyed) entry.session.unref();
        fn();
      };
      let status = 0;
      let apnsId: string | undefined;
      let retryAfter: string | string[] | undefined;
      let raw = '';
      stream.setEncoding('utf8');
      stream.setTimeout(timeoutMs, () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        finish(() => reject(new TransientPushError('apns', 0, 'timeout')));
      });
      stream.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
        const id = h['apns-id'];
        apnsId = Array.isArray(id) ? id[0] : id;
        retryAfter = h['retry-after'];
      });
      stream.on('data', (chunk: string) => {
        // Apple's error bodies are tiny; cap to avoid buffering a hostile stream.
        if (raw.length < 4096) raw += chunk;
      });
      stream.on('error', (err: Error) => {
        finish(() => reject(new TransientPushError('apns', 0, 'network', { cause: err })));
      });
      stream.on('end', () => {
        let reason: string | undefined;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { reason?: unknown };
            if (typeof parsed.reason === 'string') reason = parsed.reason;
          } catch {
            reason = undefined;
          }
        }
        finish(() =>
          resolve({
            status,
            ...(apnsId ? { apnsId } : {}),
            ...(reason ? { reason } : {}),
            ...(retryAfter !== undefined ? { retryAfter } : {}),
          }),
        );
      });
      stream.end(body);
    });
  }

  const emit = (event: Omit<PushDeliveryEvent, 'provider' | 'tokenSuffix' | 'tokenHash'>, token: string) => {
    if (!options.onDelivery) return;
    try {
      options.onDelivery({ provider: 'apns', tokenSuffix: tokenSuffix(token), tokenHash: tokenHash(token), ...event });
    } catch {
      // A broken listener must not fail a delivered push.
    }
  };

  async function invalid(token: string, reason: InvalidTokenReason, status: number): Promise<never> {
    await reportInvalid(options.onInvalidToken, token, reason);
    throw new InvalidPushTokenError('apns', reason, status, tokenSuffix(token));
  }

  function checkMessage(message: PushProviderMessage): string {
    if (typeof message.token !== 'string' || !DEVICE_TOKEN.test(message.token)) {
      throw new PushRejectedError('apns', 0, 'invalid-token-format', 'APNs device tokens are hex strings');
    }
    if (collapseKeyTooLong(message.collapseKey)) {
      throw new PushRejectedError('apns', 0, 'collapse-key-too-long', 'collapseKey exceeds 64 bytes');
    }
    if (message.data && 'aps' in message.data) {
      throw new PushRejectedError('apns', 0, 'invalid-data', 'data.aps is reserved by APNs');
    }
    const body = JSON.stringify(buildApnsPayload(message, options));
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new PushRejectedError('apns', 0, 'payload-too-large', 'payload exceeds 4096 bytes');
    }
    return body;
  }

  async function sendOnce(message: PushProviderMessage, body: string, started: number): Promise<{ messageId: string }> {
    const waitMs = cooldown.remaining();
    if (waitMs > 0) throw new TransientPushError('apns', 429, 'cooling-down', { retryAfterMs: waitMs });

    const resolved = await resolver.resolve();
    const authority = authorityOf(resolved.creds);
    const values = apnsHeaderValues(message, now());

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await post(
        authority,
        {
          ':method': 'POST',
          ':path': `/3/device/${message.token}`,
          authorization: `bearer ${bearer(resolved, attempt > 0)}`,
          'apns-topic': resolved.creds.bundleId,
          'apns-push-type': values.pushType,
          'apns-priority': values.priority,
          ...(values.expiration !== undefined ? { 'apns-expiration': values.expiration } : {}),
          ...(message.collapseKey ? { 'apns-collapse-id': message.collapseKey } : {}),
          'content-type': 'application/json',
        },
        body,
      );

      if (res.status === 200) {
        const messageId = res.apnsId ?? 'apns';
        emit(
          {
            outcome: 'sent',
            status: 200,
            messageId,
            latencyMs: now() - started,
            ...(message.platform ? { platform: message.platform } : {}),
          },
          message.token,
        );
        return { messageId };
      }

      const reason = res.reason ?? String(res.status);
      if (res.status === 410 || res.reason === 'Unregistered') return invalid(message.token, 'unregistered', res.status);
      if (res.reason === 'BadDeviceToken') return invalid(message.token, 'bad-device-token', res.status);
      if (res.status === 403) {
        if (res.reason === 'ExpiredProviderToken' || res.reason === 'InvalidProviderToken') {
          providerToken = undefined;
          if (attempt === 0) continue;
        }
        throw new PushCredentialsError('apns', `Apple refused the provider token (403 ${reason})`);
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfterMs = parseRetryAfter(res.retryAfter, now());
        // TooManyRequests is about ONE device token; only provider-wide answers pause the provider.
        if (res.reason === 'TooManyProviderTokenUpdates') cooldown.hold(retryAfterMs ?? 60_000);
        else if (res.status >= 500 && retryAfterMs !== undefined) cooldown.hold(retryAfterMs);
        throw new TransientPushError('apns', res.status, reason, retryAfterMs !== undefined ? { retryAfterMs } : {});
      }
      throw new PushRejectedError('apns', res.status, reason);
    }
    /* c8 ignore next */
    throw new TransientPushError('apns', 0, 'unreachable');
  }

  return {
    async send(message) {
      const started = now();
      try {
        const body = checkMessage(message);
        return await gate(() => sendOnce(message, body, started));
      } catch (err) {
        emit(
          {
            ...failureEvent(err),
            latencyMs: now() - started,
            ...(message.platform ? { platform: message.platform } : {}),
          },
          message.token,
        );
        throw err;
      }
    },
    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(
        open.map(
          ({ session }) =>
            new Promise<void>((resolve) => {
              if (session.closed || session.destroyed) return resolve();
              session.on('close', () => resolve());
              session.close();
            }),
        ),
      );
    },
  };
}
