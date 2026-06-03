/**
 * Regression coverage for the two semantics changes in 2.1.0:
 *
 *   1. `canSend()` pre-flight runs BEFORE rate-limit consume, so a
 *      no-recipient skip doesn't burn quota in mixed-channel batches.
 *
 *   2. Queue processor surfaces total-dispatch failure to the queue
 *      adapter (the MemoryQueue marks the job failed and the queue
 *      retry policy kicks in). Partial success resolves normally.
 *
 * These behaviors are exposed via the public API only — no internal
 * imports — so they keep working if the implementation moves around.
 */

import { describe, it, expect, vi } from 'vitest';
import { NotificationService } from '../src/index.js';
import { EmailChannel, SmsChannel } from '../src/channels/index.js';
import { MemoryQueue, MemoryRateLimitStore } from '../src/utils/index.js';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import type {
  Channel,
  ChannelConfig,
  NotificationPayload,
  SendResult,
} from '../src/types.js';

// ─── canSend short-circuit ────────────────────────────────────────────────

describe('canSend pre-flight', () => {
  it('EmailChannel exposes canSend and reports no-email skips synchronously', () => {
    const email = new EmailChannel({
      from: 'noreply@app.com',
      transport: { host: 'smtp.example.com', port: 587, auth: { user: 'u', pass: 'p' } },
    });
    const skip = email.canSend!({
      event: 'evt',
      recipient: {},
      data: {},
    });
    expect(skip?.status).toBe('skipped');
    expect(skip?.error).toMatch(/No recipient email/);

    const proceed = email.canSend!({
      event: 'evt',
      recipient: { email: 'a@b.c' },
      data: {},
    });
    expect(proceed).toBeNull();
  });

  it('SmsChannel canSend skips when phone OR body is missing', () => {
    const sms = new SmsChannel({
      from: '+10000000000',
      provider: { send: async () => ({ sid: 'sid_x' }) },
    });
    expect(sms.canSend!({ event: 'evt', recipient: {}, data: { text: 'hi' } })?.status).toBe(
      'skipped',
    );
    expect(
      sms.canSend!({ event: 'evt', recipient: { phone: '+11' }, data: {} })?.status,
    ).toBe('skipped');
    expect(
      sms.canSend!({ event: 'evt', recipient: { phone: '+11' }, data: { text: 'hi' } }),
    ).toBeNull();
  });

  it('rate-limit quota is NOT consumed when canSend returns a skip', async () => {
    const provider = vi.fn(async () => ({ sid: 'sid_x' }));
    const sms = new SmsChannel({
      from: '+15550000000',
      provider: { send: provider },
      // 1 send per window — if we burned a token on a skipped payload,
      // the second (valid) send below would be rate-limited.
      rateLimit: { maxPerWindow: 1, windowMs: 60_000 },
    });

    const store = new MemoryRateLimitStore();
    const consumeSpy = vi.spyOn(store, 'consume');
    const service = new NotificationService({ channels: [sms], rateLimitStore: store });

    // Payload has no phone — canSend should short-circuit BEFORE store.consume.
    const skipped = await service.send({
      event: 'evt',
      recipient: { email: 'no-phone@example.com' },
      data: { text: 'hello' },
    });
    expect(skipped.skipped).toBe(1);
    expect(skipped.sent).toBe(0);
    expect(consumeSpy).not.toHaveBeenCalled();

    // The quota of 1 is still intact — a real send should now succeed.
    const sent = await service.send({
      event: 'evt',
      recipient: { phone: '+15551234567' },
      data: { text: 'hello' },
    });
    expect(sent.sent).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(consumeSpy).toHaveBeenCalledTimes(1);
  });

  it('a throwing canSend falls through to send() instead of aborting', async () => {
    class BadCanSend extends BaseChannel<ChannelConfig & { name: string }> {
      constructor() {
        super({ name: 'bad' });
      }
      canSend(): SendResult | null {
        throw new Error('canSend blew up');
      }
      async send(): Promise<SendResult> {
        return { status: 'sent', channel: this.name };
      }
    }

    const service = new NotificationService({ channels: [new BadCanSend()] });
    const result = await service.send({
      event: 'evt',
      recipient: { email: 'a@b.c' },
      data: {},
    });
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('channels WITHOUT canSend keep working unchanged (backward compatible)', async () => {
    const legacyChannel: Channel = {
      name: 'legacy',
      shouldHandle: () => true,
      send: async () => ({ status: 'sent', channel: 'legacy' }),
      // intentionally NO canSend
    };
    const service = new NotificationService({ channels: [legacyChannel] });
    const r = await service.send({
      event: 'evt',
      recipient: { email: 'a@b.c' },
      data: {},
    });
    expect(r.sent).toBe(1);
  });
});

// ─── Queue total-failure semantics ────────────────────────────────────────

describe('queue processor failure semantics', () => {
  function makeFailingChannel(): Channel {
    return {
      name: 'always-fails',
      shouldHandle: () => true,
      send: async () => {
        throw new Error('upstream 500');
      },
    };
  }

  function makeSucceedingChannel(): Channel {
    return {
      name: 'always-sends',
      shouldHandle: () => true,
      send: async () => ({ status: 'sent', channel: 'always-sends' }),
    };
  }

  async function waitForJob(queue: MemoryQueue, jobId: string, ms = 1500): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const job = queue.getJob(jobId);
      if (job && job.status !== 'pending' && job.status !== 'processing') return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('default mode: total failure marks the queue job failed (after retries)', async () => {
    const queue = new MemoryQueue({ concurrency: 1, retryDelay: 0 });
    const service = new NotificationService({
      channels: [makeFailingChannel()],
      queue,
      // Disable retry entirely so the test runs fast and the job hits
      // its terminal state on first attempt.
      retry: { maxAttempts: 1 },
    });
    const dispatch = await service.send({
      event: 'evt',
      recipient: { email: 'a@b.c' },
      data: {},
    });
    expect(dispatch.queued).toBe(true);

    const jobs = queue.getAllJobs();
    expect(jobs).toHaveLength(1);
    await waitForJob(queue, jobs[0]!.id);
    const job = queue.getJob(jobs[0]!.id)!;

    // With queue maxAttempts=3 (MemoryQueue default), the processor
    // throws on every dispatch, so the job exhausts attempts and lands
    // on `failed`.
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Queued dispatch.*failed on every channel/);
  });

  it('partial success does NOT throw — job completes (avoids double-send on retry)', async () => {
    const queue = new MemoryQueue({ concurrency: 1, retryDelay: 0 });
    const service = new NotificationService({
      channels: [makeSucceedingChannel(), makeFailingChannel()],
      queue,
      retry: { maxAttempts: 1 },
    });

    await service.send({
      event: 'evt',
      recipient: { email: 'a@b.c' },
      data: {},
    });

    const jobs = queue.getAllJobs();
    await waitForJob(queue, jobs[0]!.id);
    const job = queue.getJob(jobs[0]!.id)!;
    expect(job.status).toBe('completed');
  });

  it('always-complete mode preserves legacy behavior (no throw on total failure)', async () => {
    const queue = new MemoryQueue({ concurrency: 1, retryDelay: 0 });
    const service = new NotificationService({
      channels: [makeFailingChannel()],
      queue,
      queueFailureMode: 'always-complete',
      retry: { maxAttempts: 1 },
    });

    await service.send({
      event: 'evt',
      recipient: { email: 'a@b.c' },
      data: {},
    });

    const jobs = queue.getAllJobs();
    await waitForJob(queue, jobs[0]!.id);
    const job = queue.getJob(jobs[0]!.id)!;
    expect(job.status).toBe('completed');
  });
});
