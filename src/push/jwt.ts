/**
 * Compact JWS signing over `node:crypto` (no library): RS256 for Google's OAuth2 service-account
 * grant, ES256 for APNs provider tokens. Only signing lives here; providers never verify tokens.
 *
 * @module @classytic/notifications/push
 */

import { createHash, sign, type KeyObject } from 'node:crypto';

export type JwtAlgorithm = 'RS256' | 'ES256';

const b64url = (input: string | Buffer): string => Buffer.from(input).toString('base64url');

/**
 * Sign `header.claims` with `key`. ES256 signatures are emitted in the JOSE `r||s` form
 * (`ieee-p1363`), which is what Apple requires; DER would be rejected.
 */
export function signJwt(
  alg: JwtAlgorithm,
  key: KeyObject,
  claims: Record<string, unknown>,
  headerExtra: Record<string, unknown> = {},
): string {
  // No implicit `typ`: Apple documents the APNs header as exactly `{ alg, kid }`.
  const header = b64url(JSON.stringify({ alg, ...headerExtra }));
  const body = b64url(JSON.stringify(claims));
  const input = Buffer.from(`${header}.${body}`);
  const signature =
    alg === 'ES256'
      ? sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' })
      : sign('sha256', input, key);
  return `${header}.${body}.${b64url(signature)}`;
}

/** Short, non-reversible fingerprint (hex) of any string: for cache keys and safe log fields. */
export function fingerprint(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}
