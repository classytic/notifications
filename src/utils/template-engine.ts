/**
 * Built-in Template Resolver
 * @module @classytic/notifications/utils
 *
 * Zero-dependency string interpolation for notification templates.
 * For advanced templating (React Email, MJML, etc.), use the
 * `TemplateResolver` interface directly.
 *
 * @example
 * ```typescript
 * import { NotificationService } from '@classytic/notifications';
 * import { createSimpleResolver } from '@classytic/notifications/utils';
 *
 * const service = new NotificationService({
 *   templates: createSimpleResolver({
 *     'welcome': {
 *       subject: 'Welcome, ${name}!',
 *       html: '<h1>Hi ${name}</h1><p>Thanks for joining ${company}.</p>',
 *       text: 'Hi ${name}, thanks for joining ${company}.',
 *     },
 *     'order-confirmation': {
 *       subject: 'Order #${orderId} confirmed',
 *       html: '<p>Hi ${user.name}, your order of ${total} is confirmed.</p>',
 *     },
 *   }),
 * });
 *
 * // Or plug in any engine via TemplateResolver:
 * import { render } from '@react-email/render';
 * import WelcomeEmail from './emails/welcome';
 *
 * const service2 = new NotificationService({
 *   templates: async (id, data) => {
 *     if (id === 'welcome') {
 *       return { subject: `Welcome ${data.name}!`, html: render(WelcomeEmail(data)) };
 *     }
 *     throw new Error(`Unknown template: ${id}`);
 *   },
 * });
 * ```
 */

import type { TemplateResult, TemplateResolver } from '../types.js';

/** Template definition with subject, html, and text fields */
export interface TemplateDefinition {
  subject?: string;
  html?: string;
  text?: string;
  [key: string]: string | undefined;
}

/** Map of template ID to template definition */
export type TemplateMap = Record<string, TemplateDefinition>;

/** Options for `createSimpleResolver` */
export interface SimpleResolverOptions {
  /**
   * HTML-escape interpolated values in the `html` field. Default `true`.
   *
   * Interpolated *values* are escaped (`&`, `<`, `>`, `"`, `'`, `` ` ``);
   * the template skeleton is left untouched, so `<h1>Hi ${name}</h1>` keeps
   * its tags while a malicious `${name}` like `<script>…` is neutralised.
   * This is safe-by-default — most callers feed user-controlled data
   * (names, order details) straight into an email `html` body.
   *
   * The `subject` and `text` fields are NEVER HTML-escaped (they are not
   * HTML contexts — escaping would corrupt plain text into `&amp;` noise).
   *
   * Set `false` only when the `html` values are already trusted HTML
   * fragments (e.g. pre-sanitised rich content you intentionally inline).
   */
  escape?: boolean;
}

/**
 * Simple string interpolation resolver (zero dependencies).
 *
 * Replaces `${key}` patterns with values from the data object.
 * Supports nested access: `${user.name}`.
 *
 * **Safe by default:** values interpolated into the `html` field are
 * HTML-escaped to prevent injection/XSS from user-controlled data. Pass
 * `{ escape: false }` to opt out for pre-trusted HTML. The `subject` and
 * `text` fields are never escaped.
 *
 * For advanced templating (loops, conditionals, partials),
 * plug in any engine via the `TemplateResolver` interface.
 */
export function createSimpleResolver(
  templates: TemplateMap,
  options: SimpleResolverOptions = {},
): TemplateResolver {
  const escapeHtmlField = options.escape ?? true;

  return (templateId: string, data: Record<string, unknown>): TemplateResult => {
    const template = templates[templateId];
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }

    const result: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(template)) {
      if (typeof value === 'string') {
        // Only the `html` field is an HTML sink — escape values there.
        const escape = escapeHtmlField && field === 'html';
        result[field] = interpolate(value, data, escape);
      }
    }
    return result as TemplateResult;
  };
}

/** Resolve nested property access like "user.name" */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current != null && typeof current === 'object') {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Replace `${key}` patterns with values from data.
 * When `escape` is true, substituted values are HTML-escaped (the template
 * skeleton is never escaped — only the interpolated value).
 */
function interpolate(
  template: string,
  data: Record<string, unknown>,
  escape = false,
): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    const value = getNestedValue(data, key.trim());
    if (value == null) return '';
    const str = String(value);
    return escape ? escapeHtml(str) : str;
  });
}

/** Options for `interpolateHtml` */
export interface InterpolateOptions {
  /**
   * Escape HTML entities in substituted values.
   * Default `true` — safe for HTML email bodies. Set `false` only
   * when the template is plain text or values are already trusted HTML.
   *
   * Escapes: `&`, `<`, `>`, `"`, `'`, `` ` ``.
   */
  escape?: boolean;
  /**
   * Throw when a placeholder references a key that is absent from `vars`.
   * Default `false` — missing keys are replaced with an empty string.
   * Enable in CI / tests to catch typos in template definitions.
   */
  strict?: boolean;
}

/**
 * Interpolate `{{key}}` / `{{ key }}` placeholders (Handlebars/Mustache style).
 *
 * Supports nested access: `{{ contact.email }}`.
 * Values are HTML-escaped by default — safe to use with untrusted contact data.
 * Use `escape: false` only for plain-text subjects or pre-sanitised HTML fragments.
 *
 * @example
 * interpolateHtml('<p>Hi {{firstName}},</p>', { firstName: 'Alice' })
 * // → '<p>Hi Alice,</p>'
 *
 * interpolateHtml('Hello {{ contact.email }}', { contact: { email: 'a@b.com' } })
 * // → 'Hello a@b.com'
 *
 * // Strict mode: throws on missing keys (useful in tests)
 * interpolateHtml('Hi {{name}}', {}, { strict: true })
 * // → throws Error: Template variable "name" is not defined
 *
 * // Raw HTML values (opt out of escaping)
 * interpolateHtml('<p>{{content}}</p>', { content: '<b>Bold</b>' }, { escape: false })
 * // → '<p><b>Bold</b></p>'
 */
export function interpolateHtml(
  template: string,
  vars: Record<string, unknown>,
  options: InterpolateOptions = {},
): string {
  const { escape: shouldEscape = true, strict = false } = options;
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, key: string) => {
    const trimmed = key.trim();
    const value = getNestedValue(vars, trimmed);
    if (value == null) {
      if (strict) {
        throw new Error(`Template variable "${trimmed}" is not defined`);
      }
      return '';
    }
    const str = String(value);
    return shouldEscape ? escapeHtml(str) : str;
  });
}

/** Escape HTML entities to prevent XSS when interpolating untrusted values. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/`/g, '&#x60;');
}
