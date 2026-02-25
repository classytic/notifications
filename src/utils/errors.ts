/**
 * Notification Errors
 * @module @classytic/notifications
 */

export class NotificationError extends Error {
  readonly code: string;
  readonly channel?: string;
  readonly cause?: Error;

  constructor(message: string, options?: { code?: string; channel?: string; cause?: Error }) {
    super(message);
    this.name = 'NotificationError';
    this.code = options?.code ?? 'NOTIFICATION_ERROR';
    this.channel = options?.channel;
    this.cause = options?.cause;
  }
}

export class ChannelError extends NotificationError {
  constructor(channel: string, message: string, cause?: Error) {
    super(`[${channel}] ${message}`, { code: 'CHANNEL_ERROR', channel, cause });
    this.name = 'ChannelError';
  }
}

export class ProviderNotInstalledError extends NotificationError {
  constructor(provider: string, installCmd: string) {
    super(
      `${provider} is required but not installed. Install it: ${installCmd}`,
      { code: 'PROVIDER_NOT_INSTALLED' },
    );
    this.name = 'ProviderNotInstalledError';
  }
}
