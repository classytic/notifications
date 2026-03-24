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

/**
 * Simple string interpolation resolver (zero dependencies).
 *
 * Replaces `${key}` patterns with values from the data object.
 * Supports nested access: `${user.name}`.
 *
 * For advanced templating (loops, conditionals, partials),
 * plug in any engine via the `TemplateResolver` interface.
 */
export function createSimpleResolver(templates: TemplateMap): TemplateResolver {
  return (templateId: string, data: Record<string, unknown>): TemplateResult => {
    const template = templates[templateId];
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }

    const result: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(template)) {
      if (typeof value === 'string') {
        result[field] = interpolate(value, data);
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

/** Replace ${key} patterns with values from data */
function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    const value = getNestedValue(data, key.trim());
    return value != null ? String(value) : '';
  });
}
