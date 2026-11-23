/**
 * The iOS `aps` dictionary, shared by the direct APNs provider and the `apns` block FCM forwards.
 * Generalised from a production incident-management app's `apsLevel`, where a P1 alert broke
 * through Focus (time-sensitive) and, on builds with Apple's entitlement, rang in silent mode.
 *
 * @module @classytic/notifications/push
 */

import type { PushInterruptionLevel, PushProviderMessage } from '../types.js';

export interface ApsOptions {
  /**
   * The iOS build carries Apple's critical-alerts entitlement. Without it a `critical` level is
   * downgraded to `time-sensitive`, because Apple rejects or silently drops critical alerts from
   * apps that lack the entitlement. Default false.
   */
  readonly allowCriticalAlerts?: boolean;
}

/** Whether a message shows anything (title or body). Data-only pushes do not. */
export function isVisible(message: Pick<PushProviderMessage, 'title' | 'body'>): boolean {
  return Boolean(message.title) || Boolean(message.body);
}

/** The effective interruption level after the entitlement check. */
export function effectiveLevel(
  level: PushInterruptionLevel | undefined,
  options: ApsOptions,
): PushInterruptionLevel | undefined {
  if (level === 'critical' && !options.allowCriticalAlerts) return 'time-sensitive';
  return level;
}

/**
 * Build `aps` for a message. Visible pushes get an `alert` and a sound (`default` unless the
 * message says otherwise; `null` = silent). Data-only pushes get only `content-available: 1`.
 */
export function buildAps(message: PushProviderMessage, options: ApsOptions): Record<string, unknown> {
  const visible = isVisible(message);
  const level = effectiveLevel(message.interruptionLevel, options);
  const aps: Record<string, unknown> = {};
  if (visible) {
    aps.alert = {
      ...(message.title ? { title: message.title } : {}),
      ...(message.body ? { body: message.body } : {}),
    };
    if (message.sound !== null) {
      const name = message.sound ?? 'default';
      aps.sound = level === 'critical' ? { critical: 1, name, volume: 1 } : name;
    }
    if (level) aps['interruption-level'] = level;
    if (message.imageUrl) aps['mutable-content'] = 1;
  }
  if (message.contentAvailable || !visible) aps['content-available'] = 1;
  if (message.threadId) aps['thread-id'] = message.threadId;
  if (message.badge !== undefined) aps.badge = message.badge;
  if (message.category) aps.category = message.category;
  return aps;
}

/** APNs header values derived from the message (shared with FCM's `apns.headers`). */
export function apnsHeaderValues(
  message: PushProviderMessage,
  nowMs: number,
): { pushType: 'alert' | 'background'; priority: '10' | '5'; expiration?: string } {
  const visible = isVisible(message);
  // Apple requires priority 5 for background pushes; a visible push defaults to 10 (immediate).
  const priority = !visible ? '5' : message.priority === 'normal' ? '5' : '10';
  return {
    pushType: visible ? 'alert' : 'background',
    priority,
    ...(message.ttlSeconds !== undefined
      ? { expiration: message.ttlSeconds === 0 ? '0' : String(Math.floor(nowMs / 1000) + message.ttlSeconds) }
      : {}),
  };
}

/** `apns-collapse-id` / FCM collapse keys are capped at 64 bytes; longer is a caller bug, not truncated. */
export function collapseKeyTooLong(key: string | undefined): boolean {
  return key !== undefined && Buffer.byteLength(key, 'utf8') > 64;
}
