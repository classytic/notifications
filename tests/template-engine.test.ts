import { describe, it, expect } from 'vitest';
import { createSimpleResolver, interpolateHtml } from '../src/utils/template-engine.js';
import type { TemplateMap } from '../src/utils/template-engine.js';

// ===========================================================================
// Simple Template Resolver
// ===========================================================================

describe('createSimpleResolver', () => {
  const templates: TemplateMap = {
    welcome: {
      subject: 'Welcome, ${name}!',
      html: '<h1>Hi ${name}</h1><p>Thanks for joining ${company}.</p>',
      text: 'Hi ${name}, thanks for joining ${company}.',
    },
    minimal: {
      subject: 'Hello',
    },
    nested: {
      subject: '${user.name} from ${user.company}',
    },
  };

  const resolver = createSimpleResolver(templates);

  it('interpolates simple variables', () => {
    const result = resolver('welcome', { name: 'John', company: 'Acme' });

    expect(result.subject).toBe('Welcome, John!');
    expect(result.html).toBe('<h1>Hi John</h1><p>Thanks for joining Acme.</p>');
    expect(result.text).toBe('Hi John, thanks for joining Acme.');
  });

  it('handles missing variables as empty string', () => {
    const result = resolver('welcome', { name: 'John' });

    expect(result.subject).toBe('Welcome, John!');
    expect(result.html).toContain('Thanks for joining .');
  });

  it('handles templates with no variables', () => {
    const result = resolver('minimal', {});
    expect(result.subject).toBe('Hello');
  });

  it('supports nested property access', () => {
    const result = resolver('nested', {
      user: { name: 'Alice', company: 'Widgets Inc' },
    });
    expect(result.subject).toBe('Alice from Widgets Inc');
  });

  it('throws for unknown template', () => {
    expect(() => resolver('nonexistent', {})).toThrow('Template "nonexistent" not found');
  });

  it('handles numeric and boolean values', () => {
    const tmpl: TemplateMap = {
      test: { subject: 'Count: ${count}, Active: ${active}' },
    };
    const result = createSimpleResolver(tmpl)('test', { count: 42, active: true });
    expect(result.subject).toBe('Count: 42, Active: true');
  });

  it('handles null/undefined nested paths gracefully', () => {
    const result = resolver('nested', { user: null });
    expect(result.subject).toBe(' from ');
  });

  // ── Safe-by-default HTML escaping ───────────────────────────────────────

  it('escapes interpolated values in the html field by default', () => {
    const r = createSimpleResolver({
      welcome: { html: '<p>Hi ${name}</p>' },
    });
    const result = r('welcome', { name: '<script>alert("xss")</script>' });
    expect(result.html).toBe('<p>Hi &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>');
    expect(result.html).not.toContain('<script>');
  });

  it('does not escape the html template skeleton, only the values', () => {
    const r = createSimpleResolver({
      welcome: { html: '<h1>Hi ${name}</h1>' },
    });
    expect(r('welcome', { name: 'Alice & Bob' }).html).toBe('<h1>Hi Alice &amp; Bob</h1>');
  });

  it('does NOT escape subject or text fields (not HTML contexts)', () => {
    const r = createSimpleResolver({
      welcome: {
        subject: 'Hi ${name}',
        text: 'Hello ${name}',
        html: '<p>${name}</p>',
      },
    });
    const result = r('welcome', { name: 'A & B <tag>' });
    expect(result.subject).toBe('Hi A & B <tag>');
    expect(result.text).toBe('Hello A & B <tag>');
    expect(result.html).toBe('<p>A &amp; B &lt;tag&gt;</p>');
  });

  it('escape: false opts out of html escaping (trusted HTML)', () => {
    const r = createSimpleResolver(
      { welcome: { html: '<p>${content}</p>' } },
      { escape: false },
    );
    expect(r('welcome', { content: '<b>Bold</b>' }).html).toBe('<p><b>Bold</b></p>');
  });
});

// ===========================================================================
// interpolateHtml — {{var}} Handlebars-style interpolation
// ===========================================================================

describe('interpolateHtml', () => {
  it('substitutes simple {{key}} placeholders', () => {
    expect(interpolateHtml('<p>Hi {{name}}</p>', { name: 'Alice' }))
      .toBe('<p>Hi Alice</p>');
  });

  it('trims whitespace in {{ key }} placeholders', () => {
    expect(interpolateHtml('Hello {{ firstName }} {{ lastName }}', {
      firstName: 'John', lastName: 'Doe',
    })).toBe('Hello John Doe');
  });

  it('supports nested property access', () => {
    expect(interpolateHtml('{{contact.email}}', {
      contact: { email: 'a@b.com' },
    })).toBe('a@b.com');
  });

  it('replaces missing vars with empty string by default', () => {
    expect(interpolateHtml('Hi {{firstName}}', {})).toBe('Hi ');
  });

  it('converts numeric and boolean values to string', () => {
    expect(interpolateHtml('Count: {{n}}, Active: {{flag}}', {
      n: 42, flag: true,
    })).toBe('Count: 42, Active: true');
  });

  // ── HTML escaping (default: on) ─────────────────────────────────────────

  it('escapes & < > " \' ` by default to prevent XSS', () => {
    const result = interpolateHtml('<p>{{val}}</p>', {
      val: '<script>alert("xss")</script>',
    });
    expect(result).toBe('<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>');
    expect(result).not.toContain('<script>');
  });

  it('escapes ampersands', () => {
    expect(interpolateHtml('{{company}}', { company: 'A & B' }))
      .toBe('A &amp; B');
  });

  it('escapes single quotes and backticks', () => {
    expect(interpolateHtml('{{val}}', { val: "it's `ok`" }))
      .toBe('it&#x27;s &#x60;ok&#x60;');
  });

  it('does not double-escape HTML in template skeleton (only values)', () => {
    const result = interpolateHtml('<p class="x">Hi {{name}}</p>', { name: 'Alice' });
    // The skeleton HTML must remain untouched
    expect(result).toBe('<p class="x">Hi Alice</p>');
  });

  it('escape: false passes values through verbatim', () => {
    const result = interpolateHtml('{{html}}', {
      html: '<b>Bold</b>',
    }, { escape: false });
    expect(result).toBe('<b>Bold</b>');
  });

  // ── Strict mode ──────────────────────────────────────────────────────────

  it('strict: true throws on missing variable', () => {
    expect(() => interpolateHtml('Hi {{name}}', {}, { strict: true }))
      .toThrow('Template variable "name" is not defined');
  });

  it('strict: true throws on missing nested variable', () => {
    expect(() => interpolateHtml('{{a.b.c}}', { a: {} }, { strict: true }))
      .toThrow('Template variable "a.b.c" is not defined');
  });

  it('strict: true does not throw when all vars are present', () => {
    expect(() => interpolateHtml('{{x}}', { x: 'ok' }, { strict: true }))
      .not.toThrow();
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it('handles template with no placeholders', () => {
    expect(interpolateHtml('<p>static</p>', {})).toBe('<p>static</p>');
  });

  it('handles empty template', () => {
    expect(interpolateHtml('', { name: 'Alice' })).toBe('');
  });

  it('handles multiple occurrences of the same key', () => {
    expect(interpolateHtml('{{n}} + {{n}} = ?', { n: '1' })).toBe('1 + 1 = ?');
  });

  it('null value renders as empty string (not "null")', () => {
    expect(interpolateHtml('{{x}}', { x: null as unknown as string })).toBe('');
  });

  it('undefined value renders as empty string (not "undefined")', () => {
    expect(interpolateHtml('{{x}}', { x: undefined as unknown as string })).toBe('');
  });
});

// ===========================================================================
// Integration with NotificationService
// ===========================================================================

describe('Template Resolver - Service Integration', () => {
  it('works as a template resolver in NotificationService', async () => {
    const { NotificationService } = await import('../src/NotificationService.js');
    const { BaseChannel } = await import('../src/channels/BaseChannel.js');

    class MockChannel extends BaseChannel {
      lastPayload?: any;
      constructor() { super({ name: 'mock' }); }
      async send(p: any) {
        this.lastPayload = p;
        return { status: 'sent' as const, channel: this.name };
      }
    }

    const ch = new MockChannel();
    const resolver = createSimpleResolver({
      welcome: {
        subject: 'Welcome ${name}!',
        html: '<p>Hi ${name}</p>',
      },
    });

    const service = new NotificationService({
      channels: [ch],
      templates: resolver,
    });

    await service.send({
      event: 'test',
      recipient: { email: 'test@test.com' },
      data: { name: 'Alice' },
      template: 'welcome',
    });

    expect(ch.lastPayload.data.subject).toBe('Welcome Alice!');
    expect(ch.lastPayload.data.html).toBe('<p>Hi Alice</p>');
  });
});
