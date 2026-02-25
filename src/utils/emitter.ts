/**
 * Lightweight typed event emitter
 * @module @classytic/notifications
 *
 * Zero-dependency alternative to Node's EventEmitter.
 * Keeps the library portable across runtimes.
 */

type Handler = (...args: unknown[]) => void | Promise<void>;

export class Emitter {
  private handlers = new Map<string, Handler[]>();

  /** Register an event handler */
  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  /** Remove an event handler */
  off(event: string, handler: Handler): this {
    const list = this.handlers.get(event);
    if (list) {
      this.handlers.set(event, list.filter(h => h !== handler));
    }
    return this;
  }

  /** Emit an event (runs handlers sequentially, awaits async) */
  async emit(event: string, ...args: unknown[]): Promise<void> {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const handler of list) {
      await handler(...args);
    }
  }

  /** Remove all handlers for an event (or all events) */
  removeAll(event?: string): this {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
    return this;
  }
}
