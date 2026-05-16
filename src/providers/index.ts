/**
 * Credential providers — credential schemas + transport builders for
 * configurable backends (email today; SMS / push providers as they
 * land). Distinct from the runtime `channels/` dispatchers in that
 * these own the "config + verify" surface rather than the "send" path.
 */

export * from './email/index.js';
