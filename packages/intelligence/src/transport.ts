import { err, ok, type Result } from '@forgeax/engine-types';
import { IntelligenceError } from './errors';
import { type IntelligenceRuntime, resolveIntelligenceLimits } from './runtime';
import {
  type ActivityEvent,
  type ActivityId,
  type ActivityRef,
  type ActivityRequest,
  type ActivitySubmission,
  activityId,
  type IntelligenceLimits,
  type IntelligenceRuntimeOptions,
  type IntelligenceService,
} from './types';

export type IntelligenceHostCommand =
  | { readonly kind: 'intelligence-submit'; readonly submission: ActivitySubmission }
  | { readonly kind: 'intelligence-poll'; readonly maxEvents: number }
  | { readonly kind: 'intelligence-cancel'; readonly activityId: ActivityId }
  | { readonly kind: 'intelligence-close' };

export type IntelligenceRealmMessage =
  | { readonly kind: 'intelligence-events'; readonly events: readonly ActivityEvent[] }
  | { readonly kind: 'intelligence-closed' }
  | {
      readonly kind: 'intelligence-rejected';
      readonly activityId: ActivityId;
      readonly error: import('./errors').IntelligenceFailure;
    };

export interface IntelligenceMessagePort {
  postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>) => void,
  ): void;
  start?(): void;
  close(): void;
}

export interface IntelligencePortBinding {
  close(): Promise<void>;
}

/** Bind a Host-owned runtime to the realm side of a MessageChannel. */
export function bindIntelligencePort(
  port: IntelligenceMessagePort,
  runtime: IntelligenceRuntime,
): IntelligencePortBinding {
  let closed = false;
  let closeTask: Promise<void> | undefined;
  const listener = (
    event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>,
  ): void => {
    if (closed) return;
    const message = event.data;
    if (message.kind === 'intelligence-submit') {
      const accepted = runtime.accept(message.submission);
      if (!accepted.ok) {
        const failure = importFailure(accepted.error);
        port.postMessage({
          kind: 'intelligence-rejected',
          activityId: message.submission.id,
          error: failure,
        });
      }
      return;
    }
    if (message.kind === 'intelligence-poll') {
      port.postMessage({ kind: 'intelligence-events', events: runtime.poll(message.maxEvents) });
      return;
    }
    if (message.kind === 'intelligence-cancel') {
      runtime.cancel(message.activityId);
      return;
    }
    if (message.kind === 'intelligence-close') void close();
  };
  const close = (): Promise<void> => {
    if (closeTask !== undefined) return closeTask;
    closed = true;
    port.removeEventListener('message', listener);
    closeTask = (async () => {
      await runtime.close();
      try {
        port.postMessage({ kind: 'intelligence-closed' });
      } catch {
        // A failed terminal notification must not strand the physical transport.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      port.close();
    })();
    return closeTask;
  };
  port.addEventListener('message', listener);
  port.start?.();
  return { close };
}

function importFailure(error: import('./errors').IntelligenceError) {
  if (error.code === 'intelligence-provider-failed') {
    return {
      code: error.code,
      expected: error.expected,
      hint: error.hint,
      detail: {
        providerId: error.detail.providerId,
        cause:
          error.detail.cause instanceof Error
            ? error.detail.cause.message
            : String(error.detail.cause),
      },
    } as const;
  }
  return {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
  } as import('./errors').IntelligenceFailure;
}

let portIdentity = 0;

function nextPortIdentity(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `${prefix}-${uuid}`;
  portIdentity += 1;
  return `${prefix}-${portIdentity}`;
}

/** Worker/main-realm client. Polling is request/response and never awaits a Host provider. */
export class IntelligencePortClient implements IntelligenceService {
  readonly limits: IntelligenceLimits;
  private readonly received: ActivityEvent[] = [];
  private readonly active = new Set<ActivityId>();
  private readonly rejected = new Map<
    ActivityId,
    IntelligenceRealmMessage & { kind: 'intelligence-rejected' }
  >();
  private readonly createActivityId: () => ActivityId;
  private readonly createSessionId: () => string;
  private readonly listener: (
    event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>,
  ) => void;
  private closed = false;
  private pollPending = false;
  private closeTask: Promise<void> | undefined;
  private closeResolve: (() => void) | undefined;

  constructor(
    readonly providerId: string,
    private readonly port: IntelligenceMessagePort,
    options: IntelligenceRuntimeOptions = {},
  ) {
    this.limits = resolveIntelligenceLimits(options.limits);
    this.createActivityId =
      options.createActivityId ?? (() => activityId(nextPortIdentity('activity')));
    this.createSessionId = options.createSessionId ?? (() => nextPortIdentity('session'));
    this.listener = (event) => {
      const message = event.data;
      if (this.closed && message.kind !== 'intelligence-closed') return;
      if (message.kind === 'intelligence-events') {
        this.pollPending = false;
        for (const item of message.events) {
          this.received.push(item);
          if (item.type !== 'text-delta') this.active.delete(item.activityId);
        }
      } else if (message.kind === 'intelligence-rejected') {
        this.active.delete(message.activityId);
        this.rejected.set(message.activityId, message);
      } else if (message.kind === 'intelligence-closed') {
        this.markClosed();
        this.port.removeEventListener('message', this.listener);
        this.port.close();
        this.closeResolve?.();
        this.closeResolve = undefined;
        this.closeTask ??= Promise.resolve();
      }
    };
    port.addEventListener('message', this.listener);
    port.start?.();
  }

  private markClosed(): void {
    this.closed = true;
    this.received.length = 0;
    this.active.clear();
    this.rejected.clear();
    this.pollPending = false;
  }

  submit(request: ActivityRequest): Result<ActivityRef, IntelligenceError> {
    if (this.closed) return err(new IntelligenceError({ code: 'intelligence-closed', detail: {} }));
    if (request.input.length === 0 || request.input.length > this.limits.maxInputChars) {
      return err(
        new IntelligenceError({
          code: 'intelligence-invalid-request',
          detail: {
            field: 'input',
            reason:
              request.input.length === 0
                ? 'input is empty'
                : `input exceeds ${this.limits.maxInputChars} characters`,
          },
        }),
      );
    }
    if (request.session !== undefined && request.session.providerId !== this.providerId) {
      return err(
        new IntelligenceError({
          code: 'intelligence-session-provider-mismatch',
          detail: {
            expectedProviderId: this.providerId,
            receivedProviderId: request.session.providerId,
          },
        }),
      );
    }
    if (this.active.size >= this.limits.maxConcurrentActivities) {
      return err(
        new IntelligenceError({
          code: 'intelligence-capacity-exceeded',
          detail: { limit: this.limits.maxConcurrentActivities },
        }),
      );
    }
    const ref: ActivityRef = {
      id: this.createActivityId(),
      session: request.session ?? { providerId: this.providerId, id: this.createSessionId() },
    };
    this.active.add(ref.id);
    this.port.postMessage({
      kind: 'intelligence-submit',
      submission: { ...ref, input: request.input },
    });
    return ok(ref);
  }

  poll(maxEvents = this.limits.maxPollEvents): readonly ActivityEvent[] {
    if (this.closed || !Number.isInteger(maxEvents) || maxEvents <= 0) return [];
    const count = Math.min(maxEvents, this.limits.maxPollEvents);
    const events = this.received.splice(0, count);
    for (const [id, rejection] of this.rejected) {
      if (events.length >= count) break;
      this.rejected.delete(id);
      events.push({
        type: 'failed',
        activityId: id,
        sequence: 1,
        error: rejection.error,
      });
    }
    if (!this.pollPending) {
      this.pollPending = true;
      this.port.postMessage({ kind: 'intelligence-poll', maxEvents: count });
    }
    return events;
  }

  cancel(id: ActivityId): Result<void, IntelligenceError> {
    if (this.closed) return err(new IntelligenceError({ code: 'intelligence-closed', detail: {} }));
    if (!this.active.has(id)) {
      return err(
        new IntelligenceError({
          code: 'intelligence-activity-not-found',
          detail: { activityId: id },
        }),
      );
    }
    this.port.postMessage({ kind: 'intelligence-cancel', activityId: id });
    return ok(undefined);
  }

  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask;
    if (this.closed) {
      this.closeTask = Promise.resolve();
      return this.closeTask;
    }
    this.markClosed();
    this.closeTask = new Promise((resolve) => {
      this.closeResolve = resolve;
      this.port.postMessage({ kind: 'intelligence-close' });
    });
    return this.closeTask;
  }
}

export function createIntelligencePortClient(
  providerId: string,
  port: IntelligenceMessagePort,
  options: IntelligenceRuntimeOptions = {},
): IntelligencePortClient {
  return new IntelligencePortClient(providerId, port, options);
}
