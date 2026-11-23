/**
 * Content-free pushes, for apps whose data may not leave a jurisdiction. FCM and APNs process
 * every push on servers outside the host's control, so a residency-sensitive push carries only
 * a TYPE and opaque ids (plus, optionally, a generic title already localized on the server); the
 * app opens the screen for the type and fetches the content from the host's own API.
 *
 * Two pieces, generalised from a production incident-management app:
 *   - `createContentFreeBuilder` builds such a message and REFUSES anything else (unknown key,
 *     non-id value, unknown type).
 *   - `contentFreeOnly` wraps any provider so a message with a body or disallowed data cannot
 *     be sent through it at all: the transport-level guarantee, independent of call sites.
 *
 * @module @classytic/notifications/push
 */

import type { PushProvider, PushProviderMessage } from '../types.js';
import { PushRejectedError } from './errors.js';

/** Opaque id: letters, digits, `_`, `-`, 1 to 64 characters. */
export const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ContentFreeOptions {
  /** Data keys a push may carry besides `type` (ids and enums, never personal data). */
  readonly allowedKeys: readonly string[];
  /** Allowed `type` values. Omit to accept any value matching `valuePattern`. */
  readonly types?: readonly string[];
  /** Pattern every data value must match. Default {@link OPAQUE_ID}. */
  readonly valuePattern?: RegExp;
}

/** What the builder returns: spread it into a `PushProviderMessage` with the device token. */
export interface ContentFreeMessage {
  readonly title: string;
  readonly body: '';
  readonly data: Record<string, string>;
  /** True when there is no title: a data-only (background) push. */
  readonly contentAvailable: boolean;
}

function check(options: ContentFreeOptions, data: Record<string, unknown>): Record<string, string> {
  const pattern = options.valuePattern ?? OPAQUE_ID;
  const allowed = new Set(['type', ...options.allowedKeys]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) {
      throw new PushRejectedError('router', 0, 'content-not-allowed', `data.${key} is not allowed in a content-free push`);
    }
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new PushRejectedError('router', 0, 'content-not-allowed', `data.${key} must be an opaque id`);
    }
    out[key] = value;
  }
  if (!out.type) throw new PushRejectedError('router', 0, 'content-not-allowed', 'data.type is required');
  if (options.types && !options.types.includes(out.type)) {
    throw new PushRejectedError('router', 0, 'content-not-allowed', 'data.type is not a known push type');
  }
  return out;
}

/**
 * Build content-free messages. `title` should be GENERIC ("New task offered to you"), already in
 * the device's language; omit it for a silent data-only push.
 */
export function createContentFreeBuilder(options: ContentFreeOptions) {
  return (input: { type: string; refs?: Record<string, string | undefined>; title?: string }): ContentFreeMessage => {
    const data = check(options, { ...(input.refs ?? {}), type: input.type });
    const title = input.title ?? '';
    return { title, body: '', data, contentAvailable: title === '' };
  };
}

/**
 * Wrap a provider so ONLY content-free messages pass: empty body, no image, data limited to the
 * allowed keys and opaque values. Anything else is a permanent `PushRejectedError` before any
 * network call.
 */
export function contentFreeOnly(provider: PushProvider, options: ContentFreeOptions): PushProvider {
  return {
    async send(message: PushProviderMessage) {
      if (message.body) {
        throw new PushRejectedError('router', 0, 'content-not-allowed', 'a content-free push has no body');
      }
      if (message.imageUrl) {
        throw new PushRejectedError('router', 0, 'content-not-allowed', 'a content-free push has no image');
      }
      const data = check(options, message.data ?? {});
      return provider.send({ ...message, data });
    },
    ...(provider.close ? { close: () => provider.close?.() } : {}),
  };
}
