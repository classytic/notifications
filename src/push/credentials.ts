/**
 * Push credentials: shapes, validation, and the per-provider resolver.
 *
 * Providers never read the environment. The host passes `credentials` as a value or a FUNCTION;
 * the function is called on every send (make it cheap: return a cached object) and its result is
 * compared by `version` (or, without one, by a fingerprint of the fields). A change re-validates,
 * re-imports the key, and drops cached access/provider tokens, so a rotated key applies on the
 * next send without a restart.
 *
 * Validation errors name FIELDS, never values. Key material lives only in memory: the PEM string
 * the source returned and the `KeyObject` imported from it.
 *
 * @module @classytic/notifications/push
 */

import { createPrivateKey, type KeyObject } from 'node:crypto';
import { PushCredentialsError, TransientPushError, type PushProviderName } from './errors.js';
import { fingerprint } from './jwt.js';

/** A credential value, or a (possibly async) function returning the current one. */
export type CredentialsSource<T> = T | (() => T | Promise<T>);

/** Google service-account credentials for FCM HTTP v1. */
export interface FcmCredentials {
  /** Firebase / Google Cloud project id (`project_id`). */
  projectId: string;
  /** Service-account email (`client_email`). */
  clientEmail: string;
  /** PKCS#8 RSA private key, PEM (`private_key`). Literal `\n` escapes are accepted. */
  privateKey: string;
  /** `private_key_id`: sent as the JWT `kid` when present. */
  privateKeyId?: string;
  /** OAuth2 token endpoint (`token_uri`). Default `https://oauth2.googleapis.com/token`. */
  tokenUri?: string;
  /** Opaque version/etag. When it changes, the provider re-imports the key. */
  version?: string;
}

/** APNs token-based authentication (`.p8` signing key). */
export interface ApnsCredentials {
  /** 10-character key id from the Apple developer account. */
  keyId: string;
  /** 10-character team id. */
  teamId: string;
  /** The `.p8` file contents (PKCS#8 EC P-256 private key, PEM). Literal `\n` escapes are accepted. */
  privateKey: string;
  /** The app's bundle id, sent as `apns-topic`. */
  bundleId: string;
  /** Which APNs host: `production` (default) or `sandbox` (development builds). */
  environment?: 'production' | 'sandbox';
  /** Opaque version/etag. When it changes, the provider re-signs and reconnects if the host moved. */
  version?: string;
}

export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const APPLE_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,155}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-:.]{3,62}$/;

function str(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** `\n` escapes (an env var or a JSON copy) become real newlines; surrounding space is dropped. */
export function normalizePem(pem: string): string {
  return pem.replace(/\\n/g, '\n').trim();
}

function importKey(provider: PushProviderName, pem: string): KeyObject {
  try {
    return createPrivateKey(normalizePem(pem));
  } catch {
    // Node's message can quote the input; ours names only the field.
    throw new PushCredentialsError(provider, 'privateKey is not a readable PEM private key');
  }
}

/**
 * Accept a Google service-account file in any of the forms hosts store it: the JSON object
 * (snake_case as downloaded, or camelCase), its JSON text, or the base64 of that text.
 */
export function parseFcmServiceAccount(
  input: string | Record<string, unknown>,
  version?: string,
): FcmCredentials {
  let obj: Record<string, unknown>;
  if (typeof input === 'string') {
    const text = input.trim().startsWith('{') ? input : Buffer.from(input.trim(), 'base64').toString('utf8');
    try {
      obj = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new PushCredentialsError('fcm', 'service account is neither JSON nor base64 of JSON');
    }
  } else {
    obj = input;
  }
  if (obj === null || typeof obj !== 'object') {
    throw new PushCredentialsError('fcm', 'service account must be an object');
  }
  const projectId = str(obj, 'projectId', 'project_id');
  const clientEmail = str(obj, 'clientEmail', 'client_email');
  const privateKey = str(obj, 'privateKey', 'private_key');
  const privateKeyId = str(obj, 'privateKeyId', 'private_key_id');
  const tokenUri = str(obj, 'tokenUri', 'token_uri');
  const v = version ?? str(obj, 'version');
  return validateFcmCredentials({
    projectId: projectId ?? '',
    clientEmail: clientEmail ?? '',
    privateKey: privateKey ?? '',
    ...(privateKeyId ? { privateKeyId } : {}),
    ...(tokenUri ? { tokenUri } : {}),
    ...(v ? { version: v } : {}),
  });
}

/** Check shape and key type; returns a normalized copy. Throws {@link PushCredentialsError}. */
export function validateFcmCredentials(creds: FcmCredentials): FcmCredentials {
  if (creds === null || typeof creds !== 'object') {
    throw new PushCredentialsError('fcm', 'credentials must be an object');
  }
  const missing = (['projectId', 'clientEmail', 'privateKey'] as const).filter(
    (k) => typeof creds[k] !== 'string' || creds[k].trim() === '',
  );
  if (missing.length) throw new PushCredentialsError('fcm', `missing ${missing.join(', ')}`);
  if (!PROJECT_ID.test(creds.projectId)) throw new PushCredentialsError('fcm', 'projectId is malformed');
  if (!EMAIL.test(creds.clientEmail)) throw new PushCredentialsError('fcm', 'clientEmail is malformed');
  if (creds.tokenUri !== undefined && !/^https?:\/\//.test(creds.tokenUri)) {
    throw new PushCredentialsError('fcm', 'tokenUri must be an http(s) URL');
  }
  const key = importKey('fcm', creds.privateKey);
  if (key.asymmetricKeyType !== 'rsa') {
    throw new PushCredentialsError('fcm', 'privateKey must be an RSA key (service-account private_key)');
  }
  return { ...creds, privateKey: normalizePem(creds.privateKey) };
}

/** Check shape and key type (EC P-256); returns a normalized copy. Throws {@link PushCredentialsError}. */
export function validateApnsCredentials(creds: ApnsCredentials): ApnsCredentials {
  if (creds === null || typeof creds !== 'object') {
    throw new PushCredentialsError('apns', 'credentials must be an object');
  }
  const missing = (['keyId', 'teamId', 'privateKey', 'bundleId'] as const).filter(
    (k) => typeof creds[k] !== 'string' || creds[k].trim() === '',
  );
  if (missing.length) throw new PushCredentialsError('apns', `missing ${missing.join(', ')}`);
  if (!APPLE_ID.test(creds.keyId)) throw new PushCredentialsError('apns', 'keyId must be 10 characters (A-Z, 0-9)');
  if (!APPLE_ID.test(creds.teamId)) throw new PushCredentialsError('apns', 'teamId must be 10 characters (A-Z, 0-9)');
  if (!BUNDLE_ID.test(creds.bundleId)) throw new PushCredentialsError('apns', 'bundleId is malformed');
  if (creds.environment !== undefined && creds.environment !== 'production' && creds.environment !== 'sandbox') {
    throw new PushCredentialsError('apns', 'environment must be "production" or "sandbox"');
  }
  const key = importKey('apns', creds.privateKey);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new PushCredentialsError('apns', 'privateKey must be an EC P-256 key (the .p8 file)');
  }
  return { ...creds, privateKey: normalizePem(creds.privateKey) };
}

/** A stable cache key for a credential value: its `version`, else a hash of every field. */
export function credentialsFingerprint(creds: object): string {
  const version = (creds as { version?: unknown }).version;
  if (typeof version === 'string' && version !== '') return `v:${version}`;
  const entries = Object.entries(creds as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `h:${fingerprint(JSON.stringify(entries), 32)}`;
}

/** Credentials plus what a provider derived from them (an imported key), cached together. */
export interface ResolvedCredentials<T, D> {
  readonly creds: T;
  readonly derived: D;
  readonly fingerprint: string;
}

/**
 * Resolve-per-send, derive-on-change. `onRotate` runs when the fingerprint moves (drop cached
 * tokens, reconnect). A source that throws something other than a credentials error (the
 * integrations store is down) surfaces as retryable.
 */
export function createCredentialResolver<T extends object, D>(
  provider: PushProviderName,
  source: CredentialsSource<T>,
  validate: (creds: T) => T,
  derive: (creds: T) => D,
  onRotate?: (next: ResolvedCredentials<T, D>, previous: ResolvedCredentials<T, D> | undefined) => void,
): { resolve(): Promise<ResolvedCredentials<T, D>> } {
  if (source === null || source === undefined) {
    throw new PushCredentialsError(provider, 'credentials option is required');
  }
  let current: ResolvedCredentials<T, D> | undefined;
  return {
    async resolve() {
      let raw: T;
      try {
        raw = typeof source === 'function' ? await (source as () => T | Promise<T>)() : source;
      } catch (err) {
        if (err instanceof PushCredentialsError || (err as { retryable?: unknown })?.retryable === false) throw err;
        throw new TransientPushError(provider, 0, 'credentials-unavailable', {
          ...(err instanceof Error ? { cause: err } : {}),
        });
      }
      if (raw === null || typeof raw !== 'object') {
        throw new PushCredentialsError(provider, 'credentials source returned nothing');
      }
      const fp = credentialsFingerprint(raw);
      if (current && current.fingerprint === fp) return current;
      const creds = validate(raw);
      const next: ResolvedCredentials<T, D> = { creds, derived: derive(creds), fingerprint: fp };
      const previous = current;
      current = next;
      onRotate?.(next, previous);
      return next;
    },
  };
}

export { importKey as importPushKey };
