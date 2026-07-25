import type {
  HealthChangeListener,
  HealthReason,
  HealthSnapshot,
  RendererError,
  RendererErrorListener,
  RendererLostInfo,
  RendererLostListener,
} from './renderer';

export function deriveRecoverable(reason: HealthReason): boolean {
  switch (reason) {
    case 'alive':
      return false;
    case 'device-lost':
      return true;
    case 'internal-fault':
      return false;
  }
}

export class LostListenerRegistry {
  private readonly listeners = new Set<RendererLostListener>();
  private fired = false;
  private lastInfo: RendererLostInfo | null = null;

  add(listener: RendererLostListener): () => void {
    this.listeners.add(listener);
    if (this.fired && this.lastInfo) listener(this.lastInfo);
    return () => this.listeners.delete(listener);
  }

  fire(info: RendererLostInfo): void {
    this.fired = true;
    this.lastInfo = info;
    for (const listener of this.listeners) listener(info);
  }

  clear(): void {
    this.listeners.clear();
  }
}

export class RhiErrorListenerRegistry {
  private readonly listeners: RendererErrorListener[] = [];
  private fired = false;
  private lastError: RendererError | null = null;

  add(listener: RendererErrorListener): () => void {
    this.listeners.push(listener);
    if (this.fired && this.lastError) {
      try {
        listener(this.lastError);
      } catch (error) {
        console.error('[RhiErrorListenerRegistry] late-attach listener threw:', error);
      }
    }
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  fire(error: RendererError): void {
    this.fired = true;
    this.lastError = error;
    if (this.listeners.length === 0) {
      console.error(`[RhiError ${error.code}] expected: ${error.expected}; hint: ${error.hint}`);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(error);
      } catch (cause) {
        console.error('[RhiErrorListenerRegistry] listener threw:', cause);
      }
    }
  }

  clear(): void {
    this.listeners.length = 0;
  }
}

export class HealthListenerRegistry {
  private readonly listeners = new Set<HealthChangeListener>();
  private fired = false;
  private lastSnapshot: HealthSnapshot | null = null;

  add(listener: HealthChangeListener): () => void {
    this.listeners.add(listener);
    if (this.fired && this.lastSnapshot) {
      try {
        listener(this.lastSnapshot);
      } catch (error) {
        console.error('[HealthListenerRegistry] late-attach listener threw:', error);
      }
    }
    return () => this.listeners.delete(listener);
  }

  fire(snapshot: HealthSnapshot): void {
    this.fired = true;
    this.lastSnapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[HealthListenerRegistry] listener threw:', error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  getLastSnapshot(): HealthSnapshot {
    return this.fired && this.lastSnapshot
      ? this.lastSnapshot
      : { reason: 'alive', recoverable: false };
  }
}
