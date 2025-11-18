/**
 * Notification Channel Base Class
 * @classytic/notifications
 * 
 * Abstract base class for all notification channels
 * Inspired by: AWS SNS, Twilio Notify, Firebase Cloud Messaging
 */

export class NotificationChannel {
  constructor(config = {}) {
    this.config = config;
    this.enabled = config.enabled !== false;
    this.name = config.name || this.constructor.name;
  }

  /**
   * Send notification
   * Must be implemented by subclass
   * 
   * @param {Object} notification
   * @param {string} notification.event - Event name
   * @param {Object} notification.recipient - Recipient info
   * @param {Object} notification.data - Notification data
   * @returns {Promise<Object>} { status: 'sent' | 'skipped' | 'failed', ... }
   */
  async send(notification) {
    throw new Error(`${this.name}.send() must be implemented`);
  }

  /**
   * Get events this channel handles
   * Return empty array to handle all events
   * 
   * @returns {Array<string>} Event names
   */
  getSupportedEvents() {
    return this.config.events || [];
  }

  /**
   * Check if this channel should handle this event
   * 
   * @param {string} event - Event name
   * @returns {boolean}
   */
  shouldHandle(event) {
    if (!this.enabled) return false;
    
    const supported = this.getSupportedEvents();
    
    // Empty array = handle all events
    if (supported.length === 0) return true;
    
    return supported.includes(event);
  }

  /**
   * Get channel capabilities
   * @returns {Object} Capabilities
   */
  getCapabilities() {
    return {
      supportsBatch: false,
      supportsScheduling: false,
      supportsAttachments: false,
    };
  }
}

export default NotificationChannel;

