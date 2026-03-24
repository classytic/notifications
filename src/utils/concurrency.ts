/**
 * Concurrency pool utility
 * @module @classytic/notifications/utils
 *
 * Process items in parallel with controlled concurrency.
 * Zero dependencies — uses a worker-pool pattern where N workers
 * pull from a shared queue, keeping the pipeline full at all times.
 *
 * Unlike chunk-based approaches (process N, wait, process N, wait),
 * the pool starts the next item as soon as any worker finishes,
 * eliminating idle time from slow outliers.
 *
 * @example
 * ```typescript
 * import { pMap } from '@classytic/notifications/utils';
 *
 * const results = await pMap(
 *   urls,
 *   async (url) => fetch(url).then(r => r.json()),
 *   { concurrency: 5 },
 * );
 * ```
 */

/** Options for pMap */
export interface PMapOptions {
  /** Max parallel operations (default: 10) */
  concurrency?: number;
}

/**
 * Map over items with controlled concurrency.
 *
 * Like `Promise.all(items.map(fn))` but with a max number of
 * parallel operations. Results are returned in input order.
 *
 * Uses a worker-pool pattern: N workers pull from a shared index,
 * so the pipeline stays full even when some items are slower.
 *
 * @param items - Array of items to process
 * @param fn - Async function to apply to each item
 * @param options - Concurrency options
 * @returns Array of results in the same order as input
 */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: PMapOptions = {},
): Promise<R[]> {
  const { concurrency = 10 } = options;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`pMap: concurrency must be a positive integer, got ${concurrency}`);
  }

  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  // Spawn min(concurrency, items.length) workers
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );

  return results;
}
