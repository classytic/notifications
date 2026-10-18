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

/**
 * Thrown by a provider for a failure no retry can fix (unregistered device token, invalid
 * recipient). Channels that honour it (PushChannel) return `failed` with `retryable: false`, so
 * the service does not retry. Detected structurally (`retryable === false`), so a provider may
 * also throw any error carrying that flag.
 */
export class PermanentDeliveryError extends NotificationError {
  readonly retryable = false as const;

  constructor(message: string, options?: { code?: string; channel?: string; cause?: Error }) {
    super(message, { ...options, code: options?.code ?? 'PERMANENT_DELIVERY' });
    this.name = 'PermanentDeliveryError';
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
