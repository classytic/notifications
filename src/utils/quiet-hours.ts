/**
 * Quiet hours utility
 * @module @classytic/notifications/utils
 *
 * Checks if the current time falls within a user's quiet hours window.
 * Uses Intl.DateTimeFormat for timezone conversion (zero dependencies, Node 18+).
 */

/** Quiet hours configuration */
export interface QuietHoursConfig {
  /** Start time in HH:MM format (e.g. "22:00") */
  start?: string;
  /** End time in HH:MM format (e.g. "07:00") */
  end?: string;
  /** IANA timezone (e.g. "America/New_York"). Defaults to UTC */
  timezone?: string;
}

/**
 * Check if the current time falls within quiet hours.
 *
 * Supports overnight ranges (e.g. 22:00 - 07:00).
 * Returns false if start/end are missing or malformed.
 *
 * @param quiet - Quiet hours config with start, end, and optional timezone
 * @param now - Current date (defaults to new Date(), injectable for testing)
 */
export function isQuietHours(quiet: QuietHoursConfig, now: Date = new Date()): boolean {
  if (!quiet.start || !quiet.end) return false;

  const startMinutes = parseTimeToMinutes(quiet.start);
  const endMinutes = parseTimeToMinutes(quiet.end);
  if (startMinutes === -1 || endMinutes === -1) return false;

  const currentMinutes = getCurrentMinutes(now, quiet.timezone);

  // Same-day range (e.g., 09:00 - 17:00)
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  // Overnight range (e.g., 22:00 - 07:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/** Parse "HH:MM" to minutes since midnight. Returns -1 on invalid input. */
function parseTimeToMinutes(time: string): number {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return -1;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return -1;
  return hours * 60 + minutes;
}

/** Get current minutes-since-midnight in the given timezone (or UTC). */
function getCurrentMinutes(now: Date, timezone?: string): number {
  if (!timezone) {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return hour * 60 + minute;
}
