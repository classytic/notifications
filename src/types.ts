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
/**
 * A reference to the business document a notification concerns.
 *
 * Deliberately the same `{ sourceModel, sourceId }` shape as
 * `@classytic/primitives`' `ExternalRef` — declared structurally here rather than
 * imported, because this kernel takes no dependency on primitives. A host that
 * uses `ExternalRef` can pass it straight through.
 */
export interface NotificationSubject {
  /** Owning model name, stated by the owning package (e.g. 'Invoice'). */
  sourceModel: string;
  /** The document id. */
  sourceId: string;
}

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
  /**
   * The BUSINESS DOCUMENT this notification is about — `{ sourceModel, sourceId }`,
   * the `ExternalRef` shape used across the platform for cross-collection refs.
   *
   * Distinct from `event` (what happened) and from `metadata` (a free-form bag):
   * this is the correlation key that answers "show me every message we sent about
   * invoice X". Without it that question is a collection scan over an unindexed
   * `metadata` blob, so in practice nothing asks it — a document screen cannot
   * show its own send history, and a support agent cannot answer "did the customer
   * ever receive it?".
   *
   * Optional: a broadcast to a segment is about no single document, and a
   * `subject` invented for it would be a lie.
   */
  subject?: NotificationSubject;
  /** Idempotency key — duplicate sends with the same key are skipped */
  idempotencyKey?: string;
  /** Delay delivery by this many milliseconds (requires queue adapter) */
  delay?: number;
}

/** Result from a single channel send */
export interface SendResult {
  status: 'sent' | 'skipped' | 'failed';
  channel: string;
  duration?: number;
  error?: string;
  /**
   * When `false`, the service will NOT retry this result even if the global
   * `retry.maxAttempts > 1`. Use for permanent failures: invalid recipient
   * address, bad credentials, hard bounce, 4xx from provider.
   *
   * Unset / `true` means the failure is transient and should be retried.
   */
  retryable?: boolean;
  /**
   * The PROVIDER's id for the message it accepted — the correlation key.
   *
   * Delivery is asynchronous everywhere it matters: a gateway accepts a message and
   * reports what happened to it later, over a webhook (WhatsApp `statuses[]`, an SES
   * bounce, an SMS DLR). That callback identifies the message by the id it issued at
   * send time, so without this the two halves cannot be joined — a receipt arrives
   * naming a message nothing here can find, and `status: 'sent'` stays the last word
   * on a message that was never delivered.
   *
   * FIRST-CLASS rather than another key in `metadata`: a correlation identifier that
   * every asynchronous channel needs is a contract, and in an untyped bag each
   * channel spells it differently (`messageId`, `id`, `sid`) until the consumer has
   * to know which channel it is looking at.
   *
   * Optional because it is genuinely absent for synchronous channels (in-app feed) and
   * for providers that acknowledge without issuing an id. Absent means "no correlation
   * is possible", NOT "delivery unknown" — a consumer must not infer failure from it.
   */
  providerMessageId?: string;
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
  /** True when the notification was enqueued (not yet processed) */
  queued?: boolean;
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
  /** Per-channel rate limiting (e.g., Gmail 500/day) */
  rateLimit?: import('./utils/rate-limiter.js').RateLimitConfig;
}

/** Channel interface - implement this for custom channels */
export interface Channel {
  readonly name: string;
  /**
   * Optional per-channel rate limit, read by the service before sending.
   * `BaseChannel` exposes this from `config.rateLimit`; custom channels that
   * implement `Channel` directly should surface it here so the service
   * applies the limit (otherwise the channel is treated as unlimited).
   */
  readonly rateLimit?: import('./utils/rate-limiter.js').RateLimitConfig;
  /**
   * Optional per-channel retry override, read by the service. When unset the
   * service's global retry config applies. `BaseChannel` exposes this from
   * `config.retry`.
   */
  readonly retry?: RetryConfig;
  shouldHandle(event: string): boolean;
  send(payload: NotificationPayload): Promise<SendResult>;
  /**
   * Optional pre-flight check. Return a `SendResult` (typically with
   * `status: 'skipped'`) to short-circuit before the service consumes a
   * rate-limit token or starts the retry loop. Return `null` to proceed.
   *
   * Built-in channels use this to skip when the payload obviously can't
   * be delivered (no `recipient.email` for `EmailChannel`, no
   * `recipient.phone` for `SmsChannel`, etc.) so a mixed-channel batch
   * doesn't burn the quota of one channel because another channel's
   * recipient field is missing.
   */
  canSend?(payload: NotificationPayload): SendResult | null;
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
  /**
   * Allow a per-send `payload.data.from` to override the channel's `from`
   * address. Default `false` (safe).
   *
   * The `data` bag is frequently populated from template output and
   * upstream/user-controlled input, so honouring `data.from` unconditionally
   * is a sender-spoofing footgun in multi-tenant systems. Keep this `false`
   * unless you fully control `data.from` and genuinely need per-send senders
   * (e.g. sending on behalf of verified sub-accounts).
   */
  allowSenderOverride?: boolean;
  /**
   * RFC 8058 `List-Unsubscribe` header injection.
   *
   * When set, every outbound email receives:
   *   `List-Unsubscribe: <https://…/unsubscribe>, <mailto:…>`
   *   `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
   *
   * Gmail, Outlook and Yahoo surface the one-click unsubscribe button
   * when these headers are present. Required by CAN-SPAM, CASL, and the
   * 2024 Google/Yahoo bulk-sender requirements for marketing email.
   *
   * Per-send values (from `payload.data.listUnsubscribeUrl`) override this
   * channel-level default, allowing subscriber-specific unsubscribe links.
   */
  listUnsubscribe?: {
    /** HTTPS URL that handles the one-click POST (RFC 8058 §3.2) */
    url?: string;
    /** Mailto address for clients that don't support HTTP unsubscribe */
    email?: string;
  };
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
// SMS Channel Types
// ============================================================================

/** SMS provider interface (Twilio or custom) */
export interface SmsProvider {
  send(message: { to: string; from: string; body: string }): Promise<{ sid: string }>;
}

/** SmsChannel configuration — bring your own SMS SDK */
export interface SmsChannelConfig extends ChannelConfig {
  /** Sender phone number or sender ID (E.164 format: +15551234567) */
  from: string;
  /** SMS provider implementation (Twilio, SNS, Vonage, etc.) */
  provider: SmsProvider;
}

// ============================================================================
// Push Notification Channel Types
// ============================================================================

/** Push notification provider interface (FCM or custom) */
export interface PushProvider {
  send(message: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
    imageUrl?: string;
  }): Promise<{ messageId: string }>;
}

/** PushChannel configuration — bring your own push SDK */
export interface PushChannelConfig extends ChannelConfig {
  /** Push provider implementation (FCM, Expo, OneSignal, APNs, etc.) */
  provider: PushProvider;
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
  /** Delivery log for audit trail — records every send attempt */
  deliveryLog?: import('./utils/delivery-log.js').DeliveryLog;
  /** Rate limit store (default: MemoryRateLimitStore when channels use rateLimit) */
  rateLimitStore?: import('./utils/rate-limiter.js').RateLimitStore;
  /** Queue adapter for crash-resilient delivery. Service owns the queue. */
  queue?: import('./utils/queue.js').QueueAdapter;
  /**
   * How the queue processor signals failure back to the queue adapter.
   *
   *   - `'throw-on-total-failure'` (default) — the processor throws
   *     when a dispatch had `sent === 0 && failed > 0`, so the queue
   *     marks the job failed (and retries up to `maxAttempts`). Partial
   *     successes (some channels sent) resolve normally to avoid
   *     double-sending the channels that already succeeded.
   *   - `'always-complete'` — legacy behavior. The processor never
   *     throws; queued jobs always resolve as completed, regardless of
   *     channel outcome. Keep this if your delivery log is the source
   *     of truth for failures and you don't want queue-level retries.
   */
  queueFailureMode?: 'throw-on-total-failure' | 'always-complete';
}

/** Service lifecycle events */
export type ServiceEvent =
  | 'before:send'
  | 'after:send'
  | 'send:success'
  | 'send:failed'
  | 'send:retry'
  | 'send:rate_limited'
  | 'send:queued';

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
