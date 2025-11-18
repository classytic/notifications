/**
 * Notification Dispatcher
 * @classytic/notifications
 * 
 * Routes notifications to appropriate channels
 * Pattern: Mediator + Chain of Responsibility
 */

/**
 * Create notification dispatcher
 * 
 * @param {Array<NotificationChannel>} channels - Registered channels
 * @returns {Function} Async dispatcher function
 */
export function createDispatcher(channels = []) {
  if (!Array.isArray(channels)) {
    throw new Error('Channels must be an array');
  }

  return async function dispatch(event, eventData, recipientResolver, dataExtractor) {
    if (!channels.length) return { sent: 0, channels: [] };

    try {
      // 1. Resolve recipient
      const recipient = await recipientResolver(eventData);
      if (!recipient) {
        return { sent: 0, skipped: true, reason: 'no_recipient' };
      }

      // 2. Extract notification data
      const data = dataExtractor(eventData);

      // 3. Filter channels that should handle this event
      const activeChannels = channels.filter(channel => channel.shouldHandle(event));

      if (!activeChannels.length) {
        return { sent: 0, skipped: true, reason: 'no_active_channels' };
      }

      // 4. Send to all active channels (parallel)
      const results = await Promise.allSettled(
        activeChannels.map(channel =>
          channel.send({
            event,
            recipient,
            data,
          }).catch(error => ({
            status: 'failed',
            channel: channel.name,
            error: error.message,
          }))
        )
      );

      // 5. Collect results
      const sent = results.filter(r => r.status === 'fulfilled' && r.value?.status === 'sent').length;
      const failed = results.filter(r => r.status === 'rejected' || r.value?.status === 'failed').length;

      return {
        sent,
        failed,
        total: activeChannels.length,
        channels: activeChannels.map(c => c.name),
      };
    } catch (error) {
      console.error(`[Dispatcher] Failed for ${event}:`, error.message);
      return { sent: 0, failed: 1, error: error.message };
    }
  };
}

export default createDispatcher;

