/**
 * Console Channel
 * @module @classytic/notifications
 *
 * Logs notifications to the console. Useful for development and testing.
 * Zero dependencies.
 *
 * @example
 * ```typescript
 * import { ConsoleChannel } from '@classytic/notifications/channels';
 *
 * const dev = new ConsoleChannel(); // logs all events
 * const scoped = new ConsoleChannel({ events: ['user.*'] }); // only user events
 * ```
 */

import { BaseChannel } from './BaseChannel.js';
import type { ChannelConfig, NotificationPayload, SendResult } from '../types.js';

export class ConsoleChannel extends BaseChannel<ChannelConfig> {
  constructor(config: ChannelConfig = {}) {
    super({ name: 'console', ...config });
  }

  async send(payload: NotificationPayload): Promise<SendResult> {
    const output = {
      event: payload.event,
      recipient: payload.recipient,
      data: payload.data,
      template: payload.template,
      timestamp: new Date().toISOString(),
    };

    console.log(`[notification] ${payload.event}`, JSON.stringify(output, null, 2));

    return { status: 'sent', channel: this.name };
  }
}
