/**
 * @classytic/notifications - Tests
 * Simple integration tests
 */

import { NotificationChannel, createNotificationHandlers, createDispatcher, mergeHooks } from '../src/index.js';

// Test utilities
function test(name, fn) {
  return async () => {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (error) {
      console.error(`❌ ${name}`);
      console.error(`   ${error.message}`);
      process.exit(1);
    }
  };
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Mock channel
class MockChannel extends NotificationChannel {
  constructor(config = {}) {
    super(config);
    this.sent = [];
  }

  async send(notification) {
    this.sent.push(notification);
    return { status: 'sent' };
  }

  getSupportedEvents() {
    return this.config.events || [];
  }
}

console.log('\n🧪 Testing @classytic/notifications\n');

// Test: Channel filters events correctly
await test('Channel filters events by whitelist', async () => {
  const channel = new MockChannel({ events: ['event1', 'event2'] });

  assertEquals(channel.shouldHandle('event1'), true, 'Should handle whitelisted event');
  assertEquals(channel.shouldHandle('event3'), false, 'Should not handle non-whitelisted event');
})();

// Test: Channel handles all events when whitelist empty
await test('Channel handles all events when whitelist empty', async () => {
  const channel = new MockChannel({ events: [] });

  assertEquals(channel.shouldHandle('any.event'), true, 'Should handle any event');
})();

// Test: Disabled channel doesn't handle any events
await test('Disabled channel skips all events', async () => {
  const channel = new MockChannel({ enabled: false, events: ['event1'] });

  assertEquals(channel.shouldHandle('event1'), false, 'Disabled channel should skip events');
})();

// Test: Dispatcher sends to active channels only
await test('Dispatcher sends to active channels only', async () => {
  const activeChannel = new MockChannel({ events: ['test.event'] });
  const disabledChannel = new MockChannel({ enabled: false, events: ['test.event'] });
  const wrongEventChannel = new MockChannel({ events: ['other.event'] });

  const dispatcher = createDispatcher([activeChannel, disabledChannel, wrongEventChannel]);

  const result = await dispatcher(
    'test.event',
    { data: 'test' },
    async () => ({ id: 'user1' }),
    () => ({ message: 'test' })
  );

  assertEquals(result.sent, 1, 'Should send to 1 channel');
  assertEquals(result.total, 1, 'Should have 1 active channel');
  assertEquals(activeChannel.sent.length, 1, 'Active channel should receive notification');
})();

// Test: Dispatcher handles missing recipient
await test('Dispatcher skips when no recipient', async () => {
  const channel = new MockChannel({ events: ['test.event'] });
  const dispatcher = createDispatcher([channel]);

  const result = await dispatcher(
    'test.event',
    { data: 'test' },
    async () => null,  // No recipient
    () => ({ message: 'test' })
  );

  assertEquals(result.skipped, true, 'Should skip when no recipient');
  assertEquals(channel.sent.length, 0, 'Channel should not receive notification');
})();

// Test: createNotificationHandlers creates handlers
await test('createNotificationHandlers creates handlers for events', async () => {
  const channel = new MockChannel({ events: ['test.event'] });

  const handlers = createNotificationHandlers(
    [
      {
        event: 'test.event',
        getRecipient: async () => ({ id: 'user1' }),
        getTemplateData: () => ({ message: 'test' }),
      },
    ],
    [channel]
  );

  assertEquals(!!handlers['test.event'], true, 'Should create handler');
  assertEquals(handlers['test.event'].length, 1, 'Should have 1 handler');
})();

// Test: mergeHooks merges multiple configurations
await test('mergeHooks merges multiple hook configs', async () => {
  const hooks1 = {
    'event1': [() => 'handler1'],
  };

  const hooks2 = {
    'event1': [() => 'handler2'],
    'event2': [() => 'handler3'],
  };

  const merged = mergeHooks(hooks1, hooks2);

  assertEquals(merged['event1'].length, 2, 'Should merge handlers for same event');
  assertEquals(merged['event2'].length, 1, 'Should include handlers from second config');
})();

// Test: mergeHooks handles non-array handlers
await test('mergeHooks converts single handlers to array', async () => {
  const hooks = {
    'event1': () => 'handler',  // Single function
  };

  const merged = mergeHooks(hooks);

  assertEquals(Array.isArray(merged['event1']), true, 'Should convert to array');
  assertEquals(merged['event1'].length, 1, 'Should have 1 handler');
})();

// Test: Parallel channel execution
await test('Dispatcher executes channels in parallel', async () => {
  const startTime = Date.now();
  
  class SlowChannel extends MockChannel {
    async send(notification) {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { status: 'sent' };
    }
  }

  const channel1 = new SlowChannel({ events: ['test.event'] });
  const channel2 = new SlowChannel({ events: ['test.event'] });

  const dispatcher = createDispatcher([channel1, channel2]);

  await dispatcher(
    'test.event',
    {},
    async () => ({ id: 'user1' }),
    () => ({})
  );

  const elapsed = Date.now() - startTime;

  // Should take ~100ms (parallel), not ~200ms (sequential)
  if (elapsed > 150) {
    throw new Error(`Execution took ${elapsed}ms, expected <150ms for parallel execution`);
  }
})();

// Test: Error in one channel doesn't affect others
await test('Error in one channel doesn\'t affect others', async () => {
  class FailingChannel extends MockChannel {
    async send() {
      throw new Error('Channel error');
    }
  }

  const failingChannel = new FailingChannel({ events: ['test.event'] });
  const workingChannel = new MockChannel({ events: ['test.event'] });

  const dispatcher = createDispatcher([failingChannel, workingChannel]);

  const result = await dispatcher(
    'test.event',
    {},
    async () => ({ id: 'user1' }),
    () => ({})
  );

  assertEquals(result.failed, 1, 'Should have 1 failed channel');
  assertEquals(result.sent, 1, 'Should have 1 successful channel');
  assertEquals(workingChannel.sent.length, 1, 'Working channel should succeed');
})();

console.log('\n✅ All tests passed!\n');

