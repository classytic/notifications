import { describe, it, expect } from 'vitest';
import { createSimpleResolver } from '../src/utils/template-engine.js';
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
