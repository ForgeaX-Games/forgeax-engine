import { createVisibilityBudget, type VisibilityBudget } from './budget';

export type InvalidationReason =
  | 'cut'
  | 'teleport'
  | 'resize'
  | 'projection'
  | 'primitive'
  | 'bounds'
  | 'topology'
  | 'world-reorder'
  | 'detach'
  | 'failed-submit'
  | 'device-loss'
  | 'transparent';

export interface ConfidenceState {
  readonly status: 'visible' | 'hidden';
  readonly zeroStreak: number;
  readonly successfulSubmits: number;
  readonly queryable: boolean;
  readonly dirty: boolean;
  readonly lastResultGeneration: number | undefined;
}

export type ConfidenceEvent =
  | { readonly type: 'result'; readonly samples: number; readonly submissionGeneration: number }
  | { readonly type: 'submit'; readonly submissionGeneration: number }
  | { readonly type: 'failure'; readonly submissionGeneration: number }
  | { readonly type: 'invalidate'; readonly reason: InvalidationReason };

export function createConfidenceState(): ConfidenceState {
  return {
    status: 'visible',
    zeroStreak: 0,
    successfulSubmits: 0,
    queryable: true,
    dirty: true,
    lastResultGeneration: undefined,
  };
}

export function applyConfidenceEvent(
  state: ConfidenceState,
  event: ConfidenceEvent,
  budget: VisibilityBudget = createVisibilityBudget(),
): ConfidenceState {
  if (event.type === 'result') {
    if (!Number.isFinite(event.samples) || event.samples < 0) {
      return { ...state, status: 'visible', dirty: true, queryable: true };
    }
    if (event.samples > 0) {
      return {
        ...state,
        status: 'visible',
        zeroStreak: 0,
        successfulSubmits: 0,
        queryable: true,
        dirty: false,
        lastResultGeneration: event.submissionGeneration,
      };
    }
    const zeroStreak = state.zeroStreak + 1;
    const hidden = zeroStreak >= 2;
    return {
      ...state,
      status: hidden ? 'hidden' : 'visible',
      zeroStreak,
      successfulSubmits: 0,
      queryable: true,
      // A first zero is only provisional evidence. Keep it dirty so the
      // producer naturally submits the second query; suppression requires two
      // real zero results rather than two hand-applied state transitions.
      dirty: !hidden,
      lastResultGeneration: event.submissionGeneration,
    };
  }
  if (event.type === 'submit') {
    const successfulSubmits = state.successfulSubmits + 1;
    if (successfulSubmits >= budget.expirySubmits) {
      return {
        ...state,
        status: 'visible',
        zeroStreak: 0,
        successfulSubmits: 0,
        queryable: true,
        dirty: true,
      };
    }
    return { ...state, successfulSubmits, dirty: state.dirty };
  }
  if (event.type === 'failure') {
    return {
      ...state,
      status: 'visible',
      zeroStreak: 0,
      successfulSubmits: 0,
      queryable: true,
      dirty: true,
    };
  }
  return {
    ...state,
    status: 'visible',
    zeroStreak: 0,
    successfulSubmits: 0,
    queryable: event.reason !== 'transparent' && event.reason !== 'detach',
    dirty: true,
    lastResultGeneration: undefined,
  };
}

export function shouldIssueRetest(
  state: ConfidenceState,
  budget: VisibilityBudget = createVisibilityBudget(),
): boolean {
  return (
    state.status === 'hidden' && state.queryable && state.successfulSubmits >= budget.retestSubmits
  );
}

function shouldQueryState(state: ConfidenceState, budget: VisibilityBudget): boolean {
  return (state.dirty && state.successfulSubmits === 0) || shouldIssueRetest(state, budget);
}

export class OcclusionConfidenceScheduler {
  private readonly states = new Map<string, ConfidenceState>();
  private readonly wakeByGeneration = new Map<number, Set<string>>();
  private readonly expireByGeneration = new Map<number, Set<string>>();
  private readonly wakeHeap: number[] = [];
  private readonly expireHeap: number[] = [];
  private readonly wakeHeapMembers = new Set<number>();
  private readonly expireHeapMembers = new Set<number>();
  private readonly retestKeys = new Set<string>();
  private readonly scheduleByKey = new Map<
    string,
    { readonly wake: number; readonly expire: number }
  >();

  constructor(private readonly budget: VisibilityBudget = createVisibilityBudget()) {}

  ensure(key: string): ConfidenceState {
    const existing = this.states.get(key);
    if (existing !== undefined) return existing;
    const state = createConfidenceState();
    this.states.set(key, state);
    return state;
  }

  apply(key: string, event: ConfidenceEvent): ConfidenceState {
    this.unschedule(key);
    const next = applyConfidenceEvent(this.ensure(key), event, this.budget);
    this.states.set(key, next);
    this.refreshRetestKey(key, next);
    const anchor =
      event.type === 'result' || event.type === 'submit' || event.type === 'failure'
        ? event.submissionGeneration
        : next.lastResultGeneration;
    this.schedule(key, next, anchor);
    return next;
  }

  /** Apply an in-flight query submit without scheduling a same-generation wake. */
  applyInFlightSubmit(
    key: string,
    event: Extract<ConfidenceEvent, { readonly type: 'submit' }>,
  ): ConfidenceState {
    this.unschedule(key);
    const next = applyConfidenceEvent(this.ensure(key), event, this.budget);
    this.states.set(key, next);
    this.refreshRetestKey(key, next);
    this.scheduleExpiryOnly(key, next, event.submissionGeneration);
    return next;
  }

  drainRetests(limit: number): string[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    const result: string[] = [];
    for (const key of this.retestKeys) {
      if (result.length >= limit) break;
      result.push(key);
    }
    return result;
  }

  get(key: string): ConfidenceState | undefined {
    return this.states.get(key);
  }

  remove(key: string): void {
    this.unschedule(key);
    this.retestKeys.delete(key);
    this.states.delete(key);
  }

  /** Advance hidden evidence on a successful frame even when no query was issued for it. */
  advanceSuccessfulSubmits(
    submissionGeneration: number,
    excludedKeys?: ReadonlySet<string>,
  ): {
    readonly changed: boolean;
    readonly drawChangedKeys: readonly string[];
    readonly queryChangedKeys: readonly string[];
  } {
    let changed = false;
    const drawChangedKeys: string[] = [];
    const queryChangedKeys: string[] = [];
    // Expiry is consumed first. If a caller advances several generations in
    // one tick, an old expiry must win over a stale wake bucket; otherwise the
    // wake path could postpone visibility recovery indefinitely.
    const expireKeys = this.takeDue(
      this.expireByGeneration,
      this.expireHeap,
      this.expireHeapMembers,
      submissionGeneration,
    );
    for (const key of expireKeys) {
      const state = this.states.get(key);
      if (state === undefined || state.status !== 'hidden' || !state.queryable) continue;
      if (excludedKeys?.has(key)) {
        this.unschedule(key);
        this.schedule(key, state, submissionGeneration);
        continue;
      }
      const beforeQuery = shouldQueryState(state, this.budget);
      this.unschedule(key);
      const expiring =
        state.successfulSubmits >= this.budget.expirySubmits - 1
          ? state
          : { ...state, successfulSubmits: this.budget.expirySubmits - 1 };
      const expired = applyConfidenceEvent(
        expiring,
        {
          type: 'submit',
          submissionGeneration,
        },
        this.budget,
      );
      this.states.set(key, expired);
      this.refreshRetestKey(key, expired);
      changed = true;
      if (state.status !== expired.status || state.queryable !== expired.queryable) {
        drawChangedKeys.push(key);
      }
      if (beforeQuery !== shouldQueryState(expired, this.budget)) queryChangedKeys.push(key);
    }
    const wakeKeys = this.takeDue(
      this.wakeByGeneration,
      this.wakeHeap,
      this.wakeHeapMembers,
      submissionGeneration,
    );
    for (const key of wakeKeys) {
      const state = this.states.get(key);
      if (state === undefined || state.status !== 'hidden' || !state.queryable) continue;
      if (excludedKeys?.has(key)) {
        this.unschedule(key);
        this.schedule(key, state, submissionGeneration);
        continue;
      }
      const beforeQuery = shouldQueryState(state, this.budget);
      this.unschedule(key);
      const next: ConfidenceState =
        state.successfulSubmits >= this.budget.retestSubmits
          ? state
          : { ...state, successfulSubmits: this.budget.retestSubmits };
      this.states.set(key, next);
      this.refreshRetestKey(key, next);
      changed = changed || next !== state;
      if (state.status !== next.status || state.queryable !== next.queryable) {
        drawChangedKeys.push(key);
      }
      if (beforeQuery !== shouldQueryState(next, this.budget)) queryChangedKeys.push(key);
      this.scheduleExpiry(
        key,
        submissionGeneration + Math.max(1, this.budget.expirySubmits - next.successfulSubmits),
      );
    }
    return { changed, drawChangedKeys, queryChangedKeys };
  }

  clear(): void {
    this.states.clear();
    this.wakeByGeneration.clear();
    this.expireByGeneration.clear();
    this.scheduleByKey.clear();
    this.retestKeys.clear();
    this.wakeHeap.length = 0;
    this.expireHeap.length = 0;
    this.wakeHeapMembers.clear();
    this.expireHeapMembers.clear();
  }

  private schedule(key: string, state: ConfidenceState, anchorGeneration?: number): void {
    if (state.status !== 'hidden' || !state.queryable || state.lastResultGeneration === undefined) {
      return;
    }
    const anchor = anchorGeneration ?? state.lastResultGeneration;
    const wake = anchor + Math.max(0, this.budget.retestSubmits - state.successfulSubmits);
    const expire = anchor + Math.max(1, this.budget.expirySubmits - state.successfulSubmits);
    this.scheduleExpiry(key, expire);
    const entry = this.scheduleByKey.get(key);
    if (entry !== undefined && entry.wake === wake) return;
    this.addDue(this.wakeByGeneration, this.wakeHeap, this.wakeHeapMembers, wake, key);
    this.scheduleByKey.set(key, {
      wake,
      expire: entry?.expire ?? expire,
    });
  }

  private scheduleExpiry(key: string, expire: number): void {
    this.addDue(this.expireByGeneration, this.expireHeap, this.expireHeapMembers, expire, key);
    const entry = this.scheduleByKey.get(key);
    this.scheduleByKey.set(key, {
      wake: entry?.wake ?? Number.POSITIVE_INFINITY,
      expire,
    });
  }

  private scheduleExpiryOnly(key: string, state: ConfidenceState, anchorGeneration: number): void {
    if (state.status !== 'hidden' || !state.queryable || state.lastResultGeneration === undefined) {
      return;
    }
    const expire =
      anchorGeneration + Math.max(1, this.budget.expirySubmits - state.successfulSubmits);
    this.addDue(this.expireByGeneration, this.expireHeap, this.expireHeapMembers, expire, key);
    this.scheduleByKey.set(key, { wake: Number.POSITIVE_INFINITY, expire });
  }

  private unschedule(key: string): void {
    const entry = this.scheduleByKey.get(key);
    if (entry === undefined) return;
    if (Number.isFinite(entry.wake)) {
      removeDue(this.wakeByGeneration, this.wakeHeapMembers, entry.wake, key);
    }
    if (Number.isFinite(entry.expire)) {
      removeDue(this.expireByGeneration, this.expireHeapMembers, entry.expire, key);
    }
    this.scheduleByKey.delete(key);
  }

  private takeDue(
    source: Map<number, Set<string>>,
    heap: number[],
    heapMembers: Set<number>,
    generation: number,
  ): string[] {
    const result: string[] = [];
    while (heap[0] !== undefined && (heap[0] as number) <= generation) {
      const due = popMin(heap);
      heapMembers.delete(due);
      const keys = source.get(due);
      if (keys === undefined) continue;
      source.delete(due);
      result.push(...keys);
    }
    return result;
  }

  private addDue(
    source: Map<number, Set<string>>,
    heap: number[],
    heapMembers: Set<number>,
    generation: number,
    key: string,
  ): void {
    const set = source.get(generation) ?? new Set<string>();
    if (!source.has(generation)) {
      source.set(generation, set);
      if (!heapMembers.has(generation)) {
        heapMembers.add(generation);
        pushMin(heap, generation);
      }
    }
    set.add(key);
  }

  private refreshRetestKey(key: string, state: ConfidenceState): void {
    if (shouldIssueRetest(state, this.budget)) this.retestKeys.add(key);
    else this.retestKeys.delete(key);
  }
}

function removeDue(
  source: Map<number, Set<string>>,
  heapMembers: Set<number>,
  generation: number,
  key: string,
): void {
  const keys = source.get(generation);
  if (keys === undefined) return;
  keys.delete(key);
  // The heap intentionally has no arbitrary-delete operation. Removing the
  // membership marker lets a later requeue of this same generation push a
  // fresh heap entry; the old heap entry is harmlessly skipped by takeDue.
  if (keys.size === 0) {
    source.delete(generation);
    heapMembers.delete(generation);
  }
}

function pushMin(heap: number[], value: number): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if ((heap[parent] as number) <= value) break;
    heap[index] = heap[parent] as number;
    index = parent;
  }
  heap[index] = value;
}

function popMin(heap: number[]): number {
  const first = heap[0] as number;
  const last = heap.pop() as number | undefined;
  if (last !== undefined && heap.length > 0) {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child =
        right < heap.length && (heap[right] as number) < (heap[left] as number) ? right : left;
      if ((heap[child] as number) >= last) break;
      heap[index] = heap[child] as number;
      index = child;
    }
    heap[index] = last;
  }
  return first;
}

export interface VisibilityDecisionInput {
  readonly authorVisible: boolean;
  readonly validBounds: boolean;
  readonly frustumVisible: boolean;
  readonly lodReady: boolean;
  readonly occlusion: Pick<ConfidenceState, 'status' | 'queryable'>;
  readonly lane?: 'cpu' | 'gpu';
}

export interface VisibilityDecision {
  readonly draw: boolean;
  readonly stage: 'author' | 'bounds' | 'frustum' | 'lod' | 'occlusion';
}

export function decideVisibility(input: VisibilityDecisionInput): VisibilityDecision {
  if (!input.authorVisible) return { draw: false, stage: 'author' };
  // Bounds are query input, not draw authority. Unknown or invalid bounds
  // skip frustum/query rejection and remain conservatively visible.
  if (!input.validBounds) return { draw: true, stage: 'bounds' };
  if (!input.frustumVisible) return { draw: false, stage: 'frustum' };
  if (!input.lodReady) return { draw: true, stage: 'lod' };
  if (input.occlusion.status === 'hidden' && input.occlusion.queryable) {
    return { draw: false, stage: 'occlusion' };
  }
  return { draw: true, stage: 'occlusion' };
}

export interface RecoveredVisibilityState extends ConfidenceState {
  readonly retryCount: 1;
}

export function recoverVisibilityAfterDeviceLoss(
  _state: ConfidenceState,
  _deviceGeneration: number,
): RecoveredVisibilityState {
  return {
    status: 'visible',
    zeroStreak: 0,
    successfulSubmits: 0,
    queryable: true,
    dirty: true,
    lastResultGeneration: undefined,
    retryCount: 1,
  };
}
