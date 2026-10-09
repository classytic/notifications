/**
 * Telegram Channel
 * @module @classytic/notifications
 *
 * Sends a text message through the Telegram Bot API. Zero dependencies: one
 * `fetch` to `sendMessage`.
 *
 * Telegram is the simple messaging case: no template approval, no service
 * window, no business verification. A bot may message any chat it has been
 * added to, immediately, which makes it the natural channel for a team's own
 * alerts ("a new order is waiting for confirmation").
 *
 * ## Where a message goes
 *
 * `recipient.telegramChatId` when the recipient has one, else the channel's
 * default `chatId` (typically the team's group). Telegram addresses chats by
 * numeric id or `@channelname`; there is no phone-to-chat lookup, so a phone
 * number is never used as a destination.
 *
 * @example
 * ```typescript
 * import { TelegramChannel } from '@classytic/notifications/channels';
 *
 * const ops = new TelegramChannel({
 *   botToken: process.env.TELEGRAM_BOT_TOKEN!,
 *   chatId: process.env.TELEGRAM_CHAT_ID!,   // the team group
 *   events: ['order.placed'],
 * });
 * ```
 */

import { BaseChannel } from './BaseChannel.js';
import { ChannelError } from '../utils/errors.js';
import type { NotificationPayload, SendResult, TelegramChannelConfig } from '../types.js';

const DEFAULT_API = 'https://api.telegram.org';

interface BotApiResponse {
  ok?: boolean;
  description?: string;
  error_code?: number;
  result?: { message_id?: number };
}

export class TelegramChannel extends BaseChannel<TelegramChannelConfig> {
  constructor(config: TelegramChannelConfig) {
    if (!config.botToken) {
      throw new ChannelError(config.name ?? 'telegram', 'TelegramChannel requires a botToken.');
    }
    super({ name: 'telegram', ...config });
  }

  private destinationOf(payload: NotificationPayload): string | undefined {
    return payload.recipient.telegramChatId || this.config.chatId || undefined;
  }

  private textOf(payload: NotificationPayload): string {
    const { data } = payload;
    return (data.text as string) ?? (data.message as string) ?? (data.subject as string) ?? '';
  }

  /**
   * Deterministic skips, checked before the service spends a rate-limit token:
   * nowhere to send, or nothing to say.
   */
  canSend(payload: NotificationPayload): SendResult | null {
    if (!this.destinationOf(payload)) {
      return {
        status: 'skipped',
        channel: this.name,
        error: 'No Telegram chat id (recipient.telegramChatId or the channel chatId)',
      };
    }
    if (!this.textOf(payload)) {
      return {
        status: 'skipped',
        channel: this.name,
        error: 'No message body (data.text, data.message, or data.subject)',
      };
    }
    return null;
  }

  async send(payload: NotificationPayload): Promise<SendResult> {
    const skip = this.canSend(payload);
    if (skip) return skip;

    const body = {
      chat_id: this.destinationOf(payload),
      text: this.textOf(payload),
      ...(this.config.parseMode ? { parse_mode: this.config.parseMode } : {}),
      ...(this.config.silent ? { disable_notification: true } : {}),
      link_preview_options: { is_disabled: true },
    };

    let response: Response;
    try {
      // The token is part of the URL, so no error below ever includes the URL.
      response = await fetch(`${this.config.apiBaseUrl ?? DEFAULT_API}/bot${this.config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeout ?? 10_000),
      });
    } catch (err) {
      // Network failure or timeout: transient, so the service retries.
      const message = err instanceof Error ? err.message : String(err);
      throw new ChannelError(this.name, `Telegram unreachable: ${message}`, err instanceof Error ? err : undefined);
    }

    const json = (await response.json().catch(() => ({}))) as BotApiResponse;
    if (response.ok && json.ok) {
      const id = json.result?.message_id;
      return {
        status: 'sent',
        channel: this.name,
        ...(id !== undefined ? { providerMessageId: String(id) } : {}),
      };
    }

    const reason = `Telegram ${response.status}: ${json.description ?? response.statusText}`;
    // Rate limit and server errors pass; retry them.
    if (response.status === 429 || response.status >= 500) {
      throw new ChannelError(this.name, reason);
    }
    // A bad token, an unknown chat, a bot removed from the group: retrying sends
    // the same request to the same refusal.
    return { status: 'failed', channel: this.name, error: reason, retryable: false };
  }
}
