import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryQueue } from '../src/utils/queue.js';
import { NotificationService } from '../src/NotificationService.js';
import { BaseChannel } from '../src/channels/BaseChannel.js';
import type { NotificationPayload, SendResult, ChannelConfig } from '../src/types.js';

// ===========================================================================
// Test Helpers
// ===========================================================================

class MockChannel extends BaseChannel {
  sent: NotificationPayload[] = [];
  constructor(config: ChannelConfig = {}) {
    super({ name: 'mock', ...config });
  }
  async send(p: NotificationPayload): Promise<SendResult> {
    this.sent.push(p);
    return { status: 'sent', channel: this.name };
  }
}

const makePayload = (overrides?: Partial<NotificationPayload>): NotificationPayload => ({
  event: 'user.created',
  recipient: { id: 'u1', email: 'test@example.com' },
  data: { subject: 'Test' },
  ...overrides,
});

// ===========================================================================
// MemoryQueue
// ===========================================================================

describe('MemoryQueue', () => {
  let queue: MemoryQueue;

  beforeEach(() => {
    queue = new MemoryQueue();
  });

  it('enqueues and returns a job ID', () => {
    const id = queue.enqueue(makePayload());
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('processes jobs when processor is attached', async () => {
    const processed: NotificationPayload[] = [];

    queue.process(async (payload) => {
      processed.push(payload);
    });

    queue.enqueue(makePayload({ event: 'a' }));
    queue.enqueue(makePayload({ event: 'b' }));

    // Wait for async processing
    await new Promise(r => setTimeout(r, 50));

    expect(processed).toHaveLength(2);
    expect(processed[0].event).toBe('a');
    expect(processed[1].event).toBe('b');
  });

  it('tracks job status', async () => {
    const processed = new Promise<void>(resolve => {
      queue.process(async () => {
        resolve();
      });
    });

    const id = queue.enqueue(makePayload());
    await processed;
    // Wait for status update
    await new Promise(r => setTimeout(r, 10));

    const job = queue.getJob(id);
    expect(job).toBeTruthy();
    expect(job!.status).toBe('completed');
    expect(job!.attempts).toBe(1);
  });

  it('retries failed jobs up to maxAttempts', async () => {
    let attempts = 0;

    queue.process(async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
    });

    queue.enqueue(makePayload(), { maxAttempts: 3 });

    // Wait for retries
    await new Promise(r => setTimeout(r, 200));

    expect(attempts).toBe(3);
  });

  it('marks job as failed after exhausting attempts', async () => {
    queue.process(async () => {
      throw new Error('always fails');
    });

    const id = queue.enqueue(makePayload(), { maxAttempts: 2 });

    await new Promise(r => setTimeout(r, 200));

    const job = queue.getJob(id);
    expect(job!.status).toBe('failed');
    expect(job!.error).toBe('always fails');
    expect(job!.attempts).toBe(2);
  });

  it('pauses and resumes processing', async () => {
    const processed: string[] = [];

    queue.process(async (payload) => {
      processed.push(payload.event);
    });

    queue.pause();
    queue.enqueue(makePayload({ event: 'paused' }));

    await new Promise(r => setTimeout(r, 50));
    expect(processed).toHaveLength(0);

    queue.resume();
    await new Promise(r => setTimeout(r, 50));
    expect(processed).toHaveLength(1);
    expect(processed[0]).toBe('paused');
  });

  it('drains pending jobs', () => {
    queue.enqueue(makePayload());
    queue.enqueue(makePayload());
    expect(queue.size()).toBeGreaterThan(0);

    queue.drain();
    // Pending should be 0 (draining marks them completed)
    const jobs = queue.getAllJobs();
    const pending = jobs.filter(j => j.status === 'pending');
    expect(pending).toHaveLength(0);
  });

  it('clears all jobs', () => {
    queue.enqueue(makePayload());
    queue.enqueue(makePayload());
    expect(queue.size()).toBe(2);

    queue.clear();
    expect(queue.size()).toBe(0);
    expect(queue.getAllJobs()).toHaveLength(0);
  });

  it('returns null for unknown job ID', () => {
    expect(queue.getJob('nonexistent')).toBeNull();
  });

  it('reports queue size', () => {
    queue.enqueue(makePayload());
    queue.enqueue(makePayload());
    // Without a processor, jobs stay pending
    expect(queue.size()).toBe(2);
  });

  it('drain() cancels delayed jobs that have not yet fired', async () => {
    const processed: string[] = [];
    queue.process(async (payload) => {
      processed.push(payload.event);
    });

    // Enqueue with a long delay
    const id = queue.enqueue(makePayload({ event: 'delayed' }), { delay: 200 });

    // Drain immediately — should cancel the delayed timer
    queue.drain();

    // Wait past the delay
    await new Promise(r => setTimeout(r, 300));

    // The delayed job should NOT have been processed
    expect(processed).toHaveLength(0);
    const job = queue.getJob(id);
    expect(job!.status).toBe('completed');
  });

  it('supports delayed enqueueing', async () => {
    const processed: string[] = [];
    queue.process(async (payload) => {
      processed.push(payload.event);
    });

    queue.enqueue(makePayload({ event: 'delayed' }), { delay: 50 });

    await new Promise(r => setTimeout(r, 20));
    expect(processed).toHaveLength(0);

    await new Promise(r => setTimeout(r, 50));
    expect(processed).toHaveLength(1);
  });
});

// ===========================================================================
// Queue in NotificationService
// ===========================================================================

describe('NotificationService - Queue', () => {
  it('enqueues instead of sending directly when queue is configured', async () => {
    const queue = new MemoryQueue();
    const ch = new MockChannel({ name: 'email' });

    const service = new NotificationService({
      channels: [ch],
      queue,
    });

    const result = await service.send(makePayload());

    // Should return immediately with no sends
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);

    // But the queue should process it asynchronously
    await new Promise(r => setTimeout(r, 100));
    expect(ch.sent).toHaveLength(1);
  });

  it('passes payload.delay to queue enqueue options', async () => {
    const queue = new MemoryQueue();
    const ch = new MockChannel({ name: 'email' });

    const service = new NotificationService({
      channels: [ch],
      queue,
    });

    await service.send(makePayload({ delay: 100 }));

    // Should not be processed yet (delayed)
    expect(ch.sent).toHaveLength(0);

    // Wait for delay + processing
    await new Promise(r => setTimeout(r, 200));
    expect(ch.sent).toHaveLength(1);
  });

  it('warns and sends immediately when delay is used without queue', async () => {
    const ch = new MockChannel({ name: 'email' });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const service = new NotificationService({
      channels: [ch],
      logger,
    });

    const result = await service.send(makePayload({ delay: 5000 }));

    // Sends immediately (no queue)
    expect(result.sent).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('queue adapter'));
  });

  it('emits send:queued event', async () => {
    const queue = new MemoryQueue();
    const queuedHandler = vi.fn();

    const service = new NotificationService({ queue });
    service.on('send:queued', queuedHandler);

    await service.send(makePayload());

    expect(queuedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: expect.any(String),
        payload: expect.objectContaining({ event: 'user.created' }),
      }),
    );
  });
});
