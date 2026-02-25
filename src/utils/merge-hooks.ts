/**
 * Hook Merging Utility
 * @module @classytic/notifications
 *
 * Merges multiple hook configurations into a single map
 *
 * @example
 * ```typescript
 * const hooks = mergeHooks(
 *   { 'user.created': [handler1] },
 *   { 'user.created': [handler2], 'user.deleted': [handler3] }
 * );
 * // Result: { 'user.created': [handler1, handler2], 'user.deleted': [handler3] }
 * ```
 */

import type { HookHandler, HookMap } from '../types.js';

type HookInput = Record<string, HookHandler | HookHandler[]>;

export function mergeHooks(...hookConfigs: (HookInput | null | undefined)[]): HookMap {
  const merged: HookMap = {};

  for (const config of hookConfigs) {
    if (!config || typeof config !== 'object') continue;

    for (const [event, handlers] of Object.entries(config)) {
      if (!merged[event]) {
        merged[event] = [];
      }
      const handlerArray = Array.isArray(handlers) ? handlers : [handlers];
      merged[event].push(...handlerArray);
    }
  }

  return merged;
}
