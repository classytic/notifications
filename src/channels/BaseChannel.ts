/**
 * Base Channel
 * @module @classytic/notifications
 *
 * Abstract base class for notification channels.
 * Extend this for custom channels or implement the Channel interface directly.
 *
 * @example
 * ```typescript
 * import { BaseChannel } from '@classytic/notifications/channels';
 * import type { NotificationPayload, SendResult, ChannelConfig } from '@classytic/notifications';
 *
 * interface SlackConfig extends ChannelConfig {
 *   webhookUrl: string;
 *   defaultChannel: string;
 * }
 *
 * class SlackChannel extends BaseChannel<SlackConfig> {
 *   constructor(config: SlackConfig) {
 *     super({ name: 'slack', ...config });
 *   }
 *
 *   async send(payload: NotificationPayload): Promise<SendResult> {
 *     const res = await fetch(this.config.webhookUrl, {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ text: String(payload.data.message) }),
 *     });
 *     if (!res.ok) return { status: 'failed', channel: this.name, error: res.statusText };
 *     return { status: 'sent', channel: this.name };
 *   }
 * }
 * ```
 */

import type { Channel, ChannelConfig, NotificationPayload, SendResult } from '../types.js';

export abstract class BaseChannel<TConfig extends ChannelConfig = ChannelConfig> implements Channel {
  readonly name: string;
  protected config: TConfig;

  constructor(config: TConfig) {
    this.name = config.name ?? this.constructor.name;
    this.config = config;
  }

  /** Check if this channel should handle a given event */
  shouldHandle(event: string): boolean {
    if (this.config.enabled === false) return false;

    const events = this.config.events;
    if (!events || events.length === 0) return true;

    return events.some(pattern => {
      if (pattern === event) return true;
      // Support wildcard: 'user.*' matches 'user.created'
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        return event.startsWith(prefix + '.');
      }
      return false;
    });
  }

  /** Send notification - must be implemented by subclass */
  abstract send(payload: NotificationPayload): Promise<SendResult>;
}
