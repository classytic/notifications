/**
 * Notification Factory
 * @classytic/notifications
 * 
 * Creates notification handlers from configurations
 * Pattern: Factory + Builder
 */

import { createDispatcher } from './dispatcher.js';

/**
 * Create notification handler for an event
 * 
 * @param {Object} config
 * @param {string} config.event - Event name
 * @param {Array<NotificationChannel>} config.channels - Notification channels
 * @param {Function} config.getRecipient - Extract recipient from event data
 * @param {Function} config.getTemplateData - Extract data for templates
 * @param {boolean} config.enabled - Enable/disable this notification
 * @returns {Function} Async handler function
 */
export function createNotificationHandler(config) {
  const {
    event,
    channels = [],
    getRecipient,
    getTemplateData,
    enabled = true,
  } = config;

  if (!event) {
    throw new Error('Event name is required');
  }

  if (!getRecipient || typeof getRecipient !== 'function') {
    throw new Error('getRecipient function is required');
  }

  if (!getTemplateData || typeof getTemplateData !== 'function') {
    throw new Error('getTemplateData function is required');
  }

  const dispatcher = createDispatcher(channels);

  return async (eventData) => {
    if (!enabled) return;

    try {
      await dispatcher(event, eventData, getRecipient, getTemplateData);
    } catch (error) {
      // Fire-and-forget: log but don't throw
      console.error(`[Notification] ${event} failed:`, error.message);
    }
  };
}

/**
 * Create multiple notification handlers
 * 
 * @param {Array} configs - Notification configurations
 * @param {Array<NotificationChannel>} channels - Registered channels
 * @returns {Object} Map of event → [handlers]
 */
export function createNotificationHandlers(configs, channels = []) {
  if (!Array.isArray(configs)) {
    throw new Error('Configs must be an array');
  }

  const handlers = {};

  configs.forEach(config => {
    if (!config.event) {
      throw new Error('Each config must have an event property');
    }

    if (!handlers[config.event]) {
      handlers[config.event] = [];
    }

    const handler = createNotificationHandler({
      ...config,
      channels,
    });

    handlers[config.event].push(handler);
  });

  return handlers;
}

export default { createNotificationHandler, createNotificationHandlers };

