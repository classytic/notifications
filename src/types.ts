/**
 * @classytic/notifications - Type Definitions
 *
 * Multi-channel notification system with pluggable providers
 *
 * @module @classytic/notifications
 */

// ============================================================================
// Core Types
// ============================================================================

/** Notification recipient */
export interface Recipient {
  id?: string;
  email?: string;
  phone?: string;
  name?: string;
  deviceToken?: string;
  metadata?: Record<string, unknown>;
}

/** Notification payload sent through the service */
export interface NotificationPayload {
  /** Event name that triggered this notification */
  event: string;
  /** Recipient information */
  recipient: Recipient;
  /** Data for templates and channels */
  data: Record<string, unknown>;
  /** Template ID to resolve before sending */
  template?: string;
  /** Target specific channels by name (omit to send to all matching) */
  channels?: string[];
  /** Arbitrary metadata (passed through to results) */
  metadata?: Record<string, unknown>;
  /** Idempotency key — duplicate sends with the same key are skipped */
  idempotencyKey?: string;
}

/** Result from a single channel send */
export interface SendResult {
  status: 'sent' | 'skipped' | 'failed';
  channel: string;
  duration?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/** Result from dispatching to all channels */
export interface DispatchResult {
  event: string;
  results: SendResult[];
  sent: number;
  failed: number;
  skipped: number;
  duration: number;
}

// ============================================================================
// Channel Types
// ============================================================================

/** Base channel configuration */
export interface ChannelConfig {
  /** Channel name (defaults to class name) */
  name?: string;
  /** Enable/disable this channel */
  enabled?: boolean;
  /** Event whitelist (empty = handle all events) */
  events?: string[];
  /** Per-channel retry override */
  retry?: RetryConfig;
}

/** Channel interface - implement this for custom channels */
export interface Channel {
  readonly name: string;
  shouldHandle(event: string): boolean;
  send(payload: NotificationPayload): Promise<SendResult>;
}

// ============================================================================
// Email Channel Types
// ============================================================================

/** SMTP / Nodemailer transport options */
export interface SmtpTransportOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  auth?: {
    user: string;
    pass: string;
  };
  /** Nodemailer service shorthand (e.g. 'gmail', 'outlook') */
  service?: string;
  [key: string]: unknown;
}

/** Email attachment */
export interface EmailAttachment {
  filename: string;
  content?: string | Buffer;
  path?: string;
  contentType?: string;
}

/** EmailChannel configuration */
export interface EmailChannelConfig extends ChannelConfig {
  /** Sender address (e.g. 'App <noreply@app.com>') */
  from: string;
  /** SMTP transport options (creates a Nodemailer transporter) */
  transport?: SmtpTransportOptions;
  /** Pre-created Nodemailer transporter (for SES, custom transports) */
  transporter?: NodemailerTransporter;
  /** Default mail options merged into every send */
  defaults?: Record<string, unknown>;
}

/** Minimal Nodemailer transporter interface (avoids hard dep) */
export interface NodemailerTransporter {
  sendMail(options: Record<string, unknown>): Promise<{ messageId: string; [key: string]: unknown }>;
  verify?(): Promise<boolean>;
  close?(): void;
}

// ============================================================================
// Webhook Channel Types
// ============================================================================

/** WebhookChannel configuration */
export interface WebhookChannelConfig extends ChannelConfig {
  /** Webhook URL */
  url: string;
  /** Custom headers */
  headers?: Record<string, string>;
  /** HMAC secret for signing payloads */
  secret?: string;
  /** HTTP method (default: POST) */
  method?: 'POST' | 'PUT';
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
}

// ============================================================================
// Template Types
// ============================================================================

/** Resolved template content */
export interface TemplateResult {
  subject?: string;
  html?: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Template resolver function
 * Plug any template engine: React Email, MJML, Handlebars, etc.
 */
export type TemplateResolver = (
  templateId: string,
  data: Record<string, unknown>,
) => TemplateResult | Promise<TemplateResult>;

// ============================================================================
// Retry Types
// ============================================================================

/** Retry configuration */
export interface RetryConfig {
  /** Max send attempts (default: 1 = no retry) */
  maxAttempts?: number;
  /** Backoff strategy (default: 'exponential') */
  backoff?: 'fixed' | 'exponential' | 'linear';
  /** Initial delay in ms (default: 500) */
  initialDelay?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelay?: number;
}

/** Internal resolved retry config with defaults applied */
export interface ResolvedRetryConfig {
  maxAttempts: number;
  backoff: 'fixed' | 'exponential' | 'linear';
  initialDelay: number;
  maxDelay: number;
}

// ============================================================================
// Preference Types
// ============================================================================

/** Per-user notification preferences */
export interface NotificationPreferences {
  /** Channel opt-in/out: { email: true, sms: false } */
  channels?: Record<string, boolean>;
  /** Event opt-in/out: { 'marketing.promo': false } */
  events?: Record<string, boolean>;
  /** Quiet hours */
  quiet?: {
    start?: string;
    end?: string;
    timezone?: string;
  };
}

/**
 * Preference resolver function
 * Load from DB, cache, or config
 */
export type PreferenceResolver = (
  recipientId: string,
  event: string,
) => NotificationPreferences | Promise<NotificationPreferences | null> | null;

// ============================================================================
// Logger Types
// ============================================================================

/** Pluggable logger interface (compatible with console, pino, winston) */
export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
}

// ============================================================================
// Service Types
// ============================================================================

/** NotificationService configuration */
export interface NotificationServiceConfig {
  /** Registered channels */
  channels?: Channel[];
  /** Template resolver (plug any engine) */
  templates?: TemplateResolver;
  /** Global retry config (channels can override) */
  retry?: RetryConfig;
  /** Preference resolver for per-user filtering */
  preferences?: PreferenceResolver;
  /** Logger (default: silent) */
  logger?: Logger;
  /** Idempotency / deduplication config */
  idempotency?: {
    /** Store implementation (default: MemoryIdempotencyStore) */
    store?: import('./utils/idempotency.js').IdempotencyStore;
    /** TTL in milliseconds (default: 86400000 = 24h) */
    ttl?: number;
  };
}

/** Service lifecycle events */
export type ServiceEvent =
  | 'before:send'
  | 'after:send'
  | 'send:success'
  | 'send:failed'
  | 'send:retry';

/** Event handler function */
export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

// ============================================================================
// Hook Types (for framework integration)
// ============================================================================

/** Hook config for creating event-specific handlers */
export interface NotificationHookConfig<T = unknown> {
  /** Event name */
  event: string;
  /** Target specific channels */
  channels?: string[];
  /** Extract recipient from event data */
  getRecipient: (eventData: T) => Recipient | Promise<Recipient | null> | null;
  /** Extract notification data from event data */
  getData: (eventData: T) => Record<string, unknown>;
  /** Template to resolve */
  template?: string;
  /** Enable/disable */
  enabled?: boolean;
}

/** Hook handler function */
export type HookHandler = (eventData: unknown) => Promise<DispatchResult | undefined>;

/** Map of event name to hook handler arrays */
export type HookMap = Record<string, HookHandler[]>;

// ============================================================================
// Batch Types
// ============================================================================

/** Options for batch sending */
export interface BatchOptions {
  /** Max concurrent notification sends (default: 10) */
  concurrency?: number;
  /** Called after each notification completes */
  onProgress?: (progress: BatchProgress) => void;
}

/** Progress info emitted during batch sending */
export interface BatchProgress {
  /** Number of notifications completed so far */
  completed: number;
  /** Total number of notifications in the batch */
  total: number;
  /** Result of the just-completed notification */
  result: DispatchResult;
}

/** Aggregated result from sending a batch of notifications */
export interface BatchResult {
  /** Total notifications in the batch */
  total: number;
  /** Total successful channel sends across all notifications */
  sent: number;
  /** Total failed channel sends across all notifications */
  failed: number;
  /** Total skipped sends (quiet hours, dedup, preferences) */
  skipped: number;
  /** Total wall-clock duration in ms */
  duration: number;
  /** Per-notification dispatch results (same order as input) */
  results: DispatchResult[];
}
