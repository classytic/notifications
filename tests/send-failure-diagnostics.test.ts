/**
 * A failed send must record a diagnosable ORIGIN in the log, while the
 * PERSISTED result stays a clean message.
 *
 * ## Why this exists
 *
 * The delivery log stored `err.message` and nothing else. A real incident
 * recorded `"Unsupported state or unable to authenticate data"` — Node's
 * AES-GCM authentication failure — against a channel, six times per order, and
 * that string was the entire evidence trail. It named no frame, no cause, and
 * no layer, and several components in the path decrypt something, so it fit all
 * of them equally. Tracing it took an afternoon and several wrong conclusions.
 *
 * The split this pins:
 *   - `result.error` stays the bare message. It is an operator-facing audit
 *     field; a stack there is noise, and raw vendor text in a persisted field
 *     is what the house rule about normalising stored errors exists to stop.
 *   - the LOG carries the stack and the `cause` chain, because an adapter that
 *     wraps a provider error puts the real origin in `cause` and printing only
 *     the outer message hides the layer you actually need.
 */

import { describe, expect, it } from 'vitest';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import { NotificationService } from '../src/NotificationService.js';
import type { Channel, Logger, NotificationPayload, SendResult } from '../src/types.js';

function capturingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: (m: string) => {
        errors.push(m);
      },
    },
  };
}

/**
 * A channel that fails the way the real incident did.
 *
 * Extends `BaseChannel` rather than being a bare object literal: the service
 * calls `shouldHandle()` before `send()`, so a hand-rolled stub silently
 * fails to be a channel at all.
 */
class ThrowingChannel extends BaseChannel {
  constructor(private readonly err: unknown) {
    super({ name: 'telegram' });
  }
  async send(_p: NotificationPayload): Promise<SendResult> {
    throw this.err;
  }
}
const throwingChannel = (err: unknown): Channel => new ThrowingChannel(err) as unknown as Channel;

async function sendVia(channel: Channel, logger: Logger) {
  const svc = new NotificationService({ channels: [channel], logger } as never);
  return (await svc.send({
    event: 'probe.event',
    recipient: { id: 'r1', email: 'r1@example.test' },
    channels: ['telegram'],
    data: { subject: 's', text: 'b' },
  } as never)) as unknown as { results?: SendResult[] };
}

describe('a failed send is diagnosable', () => {
  it('logs the STACK, not just the message', async () => {
    const { logger, errors } = capturingLogger();
    const err = new Error('Unsupported state or unable to authenticate data');
    await sendVia(throwingChannel(err), logger);

    const line = errors.join('\n');
    expect(line, 'the message must still be there').toContain('Unsupported state or unable to authenticate data');
    expect(line, 'and at least one stack frame').toMatch(/\n\s+at\s/);
  });

  it('walks the CAUSE chain — the wrapped origin is the useful part', async () => {
    // An adapter wrapping a provider error is the normal shape. Logging only
    // the outer message reports the wrapper and hides what actually failed.
    const { logger, errors } = capturingLogger();
    const root = new Error('root: bad auth tag');
    const wrapped = new Error('channel send failed', { cause: root });
    await sendVia(throwingChannel(wrapped), logger);

    const line = errors.join('\n');
    expect(line).toContain('channel send failed');
    expect(line, 'the ROOT cause must appear').toContain('root: bad auth tag');
    expect(line).toMatch(/cause\[1\]/);
  });

  it('does NOT put the stack into the persisted result', async () => {
    // `result.error` is the audit field. Keeping it a clean message is the
    // other half of the split — the detail belongs in the log.
    const { logger } = capturingLogger();
    const res = await sendVia(throwingChannel(new Error('boom')), logger);
    const failed = res.results?.find((r) => r.status === 'failed');
    expect(failed?.error).toBe('boom');
    expect(failed?.error ?? '', 'no stack frames in the stored field').not.toMatch(/\n\s+at\s/);
  });

  it('survives a non-Error throw without losing the log line', async () => {
    const { logger, errors } = capturingLogger();
    await sendVia(throwingChannel('a bare string'), logger);
    expect(errors.join('\n')).toContain('a bare string');
  });
});
