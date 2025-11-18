/**
 * Type definitions for @classytic/notifications
 * Multi-channel notification system for event-driven applications
 */

// ============ CORE TYPES ============

/**
 * Notification recipient information
 */
export interface NotificationRecipient {
  /** Recipient ID */
  id?: string | any;
  /** Recipient email address */
  email?: string;
  /** Recipient phone number */
  phone?: string;
  /** Recipient name */
  name?: string;
  /** Additional recipient data */
  [key: string]: any;
}

/**
 * Notification data passed to channels
 */
export interface NotificationData {
  /** Subject/title of notification */
  subject?: string;
  /** Message body */
  message?: string;
  /** Template ID or name */
  template?: string;
  /** Template variables */
  templateData?: Record<string, any>;
  /** Additional custom data */
  [key: string]: any;
}

/**
 * Notification object sent to channels
 */
export interface Notification {
  /** Event name that triggered the notification */
  event: string;
  /** Recipient information */
  recipient: NotificationRecipient;
  /** Notification data */
  data: NotificationData;
}

/**
 * Notification send result
 */
export interface NotificationResult {
  /** Send status */
  status: 'sent' | 'skipped' | 'failed';
  /** Channel name */
  channel?: string;
  /** Error message if failed */
  error?: string;
  /** Additional result data */
  [key: string]: any;
}

/**
 * Channel capabilities
 */
export interface ChannelCapabilities {
  /** Supports batch sending */
  supportsBatch: boolean;
  /** Supports scheduled sending */
  supportsScheduling: boolean;
  /** Supports file attachments */
  supportsAttachments: boolean;
}

// ============ NOTIFICATION CHANNEL ============

/**
 * Notification channel configuration
 */
export interface NotificationChannelConfig {
  /** Channel name */
  name?: string;
  /** Enable/disable channel */
  enabled?: boolean;
  /** Events this channel should handle (empty = all events) */
  events?: string[];
  /** Additional configuration */
  [key: string]: any;
}

/**
 * Notification Channel Base Class
 * Abstract base class for all notification channels
 */
export class NotificationChannel {
  /** Channel configuration */
  config: NotificationChannelConfig;
  /** Whether channel is enabled */
  enabled: boolean;
  /** Channel name */
  name: string;

  /**
   * Create notification channel
   * @param config Channel configuration
   */
  constructor(config?: NotificationChannelConfig);

  /**
   * Send notification (must be implemented by subclass)
   * @param notification Notification to send
   * @returns Send result
   */
  send(notification: Notification): Promise<NotificationResult>;

  /**
   * Get events this channel handles
   * @returns Event names (empty array = handle all events)
   */
  getSupportedEvents(): string[];

  /**
   * Check if this channel should handle this event
   * @param event Event name
   * @returns True if channel should handle event
   */
  shouldHandle(event: string): boolean;

  /**
   * Get channel capabilities
   * @returns Channel capabilities
   */
  getCapabilities(): ChannelCapabilities;
}

// ============ DISPATCHER ============

/**
 * Recipient resolver function
 * Extracts recipient information from event data
 */
export type RecipientResolver = (eventData: any) => Promise<NotificationRecipient | null> | NotificationRecipient | null;

/**
 * Data extractor function
 * Extracts notification data from event data
 */
export type DataExtractor = (eventData: any) => NotificationData;

/**
 * Dispatch result
 */
export interface DispatchResult {
  /** Number of channels that successfully sent */
  sent: number;
  /** Number of channels that failed */
  failed?: number;
  /** Total channels attempted */
  total?: number;
  /** List of channel names */
  channels?: string[];
  /** Whether sending was skipped */
  skipped?: boolean;
  /** Reason for skip */
  reason?: string;
  /** Error message */
  error?: string;
}

/**
 * Notification dispatcher function
 */
export type Dispatcher = (
  event: string,
  eventData: any,
  recipientResolver: RecipientResolver,
  dataExtractor: DataExtractor
) => Promise<DispatchResult>;

/**
 * Create notification dispatcher
 * Routes notifications to appropriate channels
 * @param channels Registered notification channels
 * @returns Dispatcher function
 */
export function createDispatcher(channels?: NotificationChannel[]): Dispatcher;

// ============ FACTORY ============

/**
 * Notification handler configuration
 */
export interface NotificationHandlerConfig {
  /** Event name this handler responds to */
  event: string;
  /** Notification channels to use */
  channels?: NotificationChannel[];
  /** Function to extract recipient from event data */
  getRecipient: RecipientResolver;
  /** Function to extract template data from event data */
  getTemplateData: DataExtractor;
  /** Enable/disable this notification handler */
  enabled?: boolean;
}

/**
 * Notification handler function
 */
export type NotificationHandler = (eventData: any) => Promise<void>;

/**
 * Create notification handler for an event
 * @param config Handler configuration
 * @returns Async handler function
 */
export function createNotificationHandler(config: NotificationHandlerConfig): NotificationHandler;

/**
 * Map of event names to handler arrays
 */
export type NotificationHandlers = Record<string, NotificationHandler[]>;

/**
 * Create multiple notification handlers
 * @param configs Array of handler configurations
 * @param channels Registered notification channels
 * @returns Map of event → handler arrays
 */
export function createNotificationHandlers(
  configs: NotificationHandlerConfig[],
  channels?: NotificationChannel[]
): NotificationHandlers;

// ============ UTILITIES ============

/**
 * Hook configuration object
 * Maps event names to handler functions or arrays of handlers
 */
export type HookConfig = Record<string, NotificationHandler | NotificationHandler[]>;

/**
 * Merge multiple hook configurations
 * Each event can have multiple handlers from different sources
 * @param hookConfigs Hook configuration objects to merge
 * @returns Merged hooks with all handlers combined
 *
 * @example
 * const hooks = mergeHooks(
 *   { 'user.created': [handler1] },
 *   { 'user.created': [handler2], 'user.deleted': [handler3] }
 * );
 * // Result: { 'user.created': [handler1, handler2], 'user.deleted': [handler3] }
 */
export function mergeHooks(...hookConfigs: HookConfig[]): Record<string, NotificationHandler[]>;

// ============ DEFAULT EXPORT ============

declare const _default: {
  NotificationChannel: typeof NotificationChannel;
  createDispatcher: typeof createDispatcher;
  createNotificationHandlers: typeof createNotificationHandlers;
  mergeHooks: typeof mergeHooks;
};

export default _default;
