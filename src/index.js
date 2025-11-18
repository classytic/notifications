/**
 * @classytic/notifications
 * Multi-Channel Notification System
 * 
 * Framework-agnostic notification system with pluggable channels
 * Works with any event system (hooks, EventEmitter, custom)
 * 
 * @version 1.0.0
 * @author Classytic
 * @license MIT
 */

// ============ CORE ============
export { NotificationChannel } from './core/channel.js';
export { createDispatcher } from './core/dispatcher.js';
export { 
  createNotificationHandler, 
  createNotificationHandlers 
} from './core/factory.js';

// ============ UTILITIES ============
export { mergeHooks } from './utils/merge-hooks.js';

// ============ DEFAULT EXPORT ============
import { NotificationChannel as _NotificationChannel } from './core/channel.js';
import { createDispatcher as _createDispatcher } from './core/dispatcher.js';
import { createNotificationHandlers as _createNotificationHandlers } from './core/factory.js';
import { mergeHooks as _mergeHooks } from './utils/merge-hooks.js';

export default {
  NotificationChannel: _NotificationChannel,
  createDispatcher: _createDispatcher,
  createNotificationHandlers: _createNotificationHandlers,
  mergeHooks: _mergeHooks,
};

