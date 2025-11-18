/**
 * Hook Merging Utility
 * @classytic/notifications
 * 
 * Merges multiple hook configurations into single object
 */

/**
 * Merge multiple hook configurations
 * Each event can have multiple handlers from different sources
 * 
 * @param {...Object} hookConfigs - Hook configuration objects
 * @returns {Object} Merged hooks
 * 
 * @example
 * const hooks = mergeHooks(
 *   { 'user.created': [handler1] },
 *   { 'user.created': [handler2], 'user.deleted': [handler3] }
 * );
 * // Result: { 'user.created': [handler1, handler2], 'user.deleted': [handler3] }
 */
export function mergeHooks(...hookConfigs) {
  const merged = {};

  hookConfigs.forEach(config => {
    if (!config || typeof config !== 'object') {
      return;
    }

    Object.entries(config).forEach(([event, handlers]) => {
      if (!merged[event]) {
        merged[event] = [];
      }

      // Ensure handlers is an array
      const handlerArray = Array.isArray(handlers) ? handlers : [handlers];
      merged[event].push(...handlerArray);
    });
  });

  return merged;
}

export default mergeHooks;

