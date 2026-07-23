import type { EndpointEvent } from '@forgeax/engine-net';

export class BoundedEventQueue {
  readonly #events: EndpointEvent[] = [];
  #closed = false;
  #disconnectReason: string | undefined;

  constructor(readonly maxQueuedEvents: number) {
    if (!Number.isInteger(maxQueuedEvents) || maxQueuedEvents < 1) {
      throw new RangeError('maxQueuedEvents must be a positive integer');
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get disconnectReason(): string | undefined {
    return this.#disconnectReason;
  }

  enqueue(event: EndpointEvent): boolean {
    if (this.#closed) return false;
    if (this.#events.length === this.maxQueuedEvents) {
      this.close(`event queue overflow (maxQueuedEvents=${this.maxQueuedEvents})`);
      return false;
    }
    this.#events.push(event);
    return true;
  }

  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#disconnectReason = reason;
  }

  drain(): EndpointEvent[] {
    return this.#events.splice(0);
  }
}
