import { createVisibilityBudget, type VisibilityBudget } from './budget';
import {
  type ConfidenceEvent,
  type ConfidenceState,
  OcclusionConfidenceScheduler,
  shouldIssueRetest,
} from './occlusion-confidence';
import {
  type PrimitiveKey,
  primitiveKeyId,
  type ViewKey,
  type VisibilityCandidate,
  type VisibilityFacetInspection,
  viewKeyId,
} from './types';

interface ViewState {
  readonly key: ViewKey;
  epoch: number;
  readonly rows: Map<string, VisibilityCandidate>;
}

interface QueryEntry {
  readonly view: ViewKey;
  readonly primitive: PrimitiveKey;
}

interface QueryNode {
  readonly viewId: string;
  readonly key: string;
  previous: string | undefined;
  next: string | undefined;
}

interface QueryQueue {
  head: string | undefined;
  tail: string | undefined;
}

/**
 * Renderer-owned CPU visibility state indexed by ViewKey x PrimitiveKey.
 *
 * Attachment order is intentionally not part of the key. This keeps world
 * reorder, detach, and slot ABA recovery generation-safe without a second
 * lane-specific visibility map.
 */
export class VisibilityFacetStore {
  private readonly views = new Map<string, ViewState>();
  private readonly confidence: OcclusionConfidenceScheduler;
  private visibilityRevision = 0;
  private drawRevision = 0;
  private queryRevision = 0;
  private readonly queryEntries = new Map<string, QueryEntry>();
  private readonly readyQueryKeys = new Set<string>();
  private readonly inFlightQueryKeys = new Set<string>();
  private readonly queryQueues = new Map<string, QueryQueue>();
  /** Intrusive FIFO nodes make removal/requeue O(1), so dequeue never walks stale rows. */
  private readonly queryNodes = new Map<string, QueryNode>();

  constructor(private readonly budget: VisibilityBudget = createVisibilityBudget()) {
    this.confidence = new OcclusionConfidenceScheduler(budget);
  }

  visibilityBudget(): VisibilityBudget {
    return this.budget;
  }

  /** Monotonic token for confidence changes that can alter draw admission. */
  get revision(): number {
    return this.visibilityRevision;
  }

  /** Revision for the bounded query-candidate admission set only. */
  get queryRevisionValue(): number {
    return this.queryRevision;
  }

  /** Revision for the active draw admission set (status/queryable identity). */
  get drawRevisionValue(): number {
    return this.drawRevision;
  }

  activateView(key: ViewKey): void {
    const id = viewKeyId(key);
    const existing = this.views.get(id);
    if (existing !== undefined) return;
    this.views.set(id, { key, epoch: 0, rows: new Map() });
  }

  retireView(key: ViewKey): void {
    const id = viewKeyId(key);
    const state = this.views.get(id);
    this.views.delete(id);
    if (state !== undefined) {
      this.visibilityRevision += 1;
      this.drawRevision += 1;
      this.queryRevision += 1;
      for (const primitive of state.rows.keys()) {
        this.removeQueryKey(`${id}|${primitive}`);
      }
    }
  }

  detachAttachment(attachmentId: string): void {
    let detached = false;
    for (const [id, state] of this.views) {
      if (state.key.attachmentId === attachmentId) {
        this.views.delete(id);
        for (const primitive of state.rows.keys()) {
          this.removeQueryKey(`${id}|${primitive}`);
        }
        detached = true;
      }
    }
    if (detached) {
      this.visibilityRevision += 1;
      this.drawRevision += 1;
      this.queryRevision += 1;
    }
  }

  /** Drop every view/row when a composition owner is detached. */
  clear(): void {
    if (this.views.size > 0 || this.visibilityRevision > 0) {
      this.visibilityRevision += 1;
      this.drawRevision += 1;
      this.queryRevision += 1;
    }
    this.views.clear();
    this.confidence.clear();
    this.queryEntries.clear();
    this.readyQueryKeys.clear();
    this.inFlightQueryKeys.clear();
    this.queryQueues.clear();
    this.queryNodes.clear();
  }

  reorderAttachments(_attachmentIds: readonly string[]): void {
    // Attachment order is deliberately not stored. Keys remain stable when
    // the caller changes the order of its world list.
  }

  setCandidate(view: ViewKey, primitive: PrimitiveKey, candidate: VisibilityCandidate): boolean {
    const state = this.views.get(viewKeyId(view));
    if (state === undefined || primitive.attachmentId !== view.attachmentId) return false;
    const primitiveId = primitiveKeyId(primitive);
    const key = `${viewKeyId(view)}|${primitiveId}`;
    const previous = state.rows.get(primitiveId);
    if (
      previous === undefined ||
      previous.level !== candidate.level ||
      previous.confidence !== candidate.confidence
    ) {
      this.visibilityRevision += 1;
      this.drawRevision += 1;
    }
    state.rows.set(primitiveId, { ...candidate });
    this.queryEntries.set(key, { view, primitive });
    this.syncQueryKey(key, this.confidence.ensure(key));
    return true;
  }

  /** Remove rows that are no longer queryable in the extracted frame. */
  pruneCandidates(view: ViewKey, activePrimitives: ReadonlySet<string>): void {
    const state = this.views.get(viewKeyId(view));
    if (state === undefined) return;
    for (const primitiveId of [...state.rows.keys()]) {
      if (activePrimitives.has(primitiveId)) continue;
      state.rows.delete(primitiveId);
      this.removeQueryKey(`${viewKeyId(view)}|${primitiveId}`);
      this.visibilityRevision += 1;
      this.drawRevision += 1;
      this.queryRevision += 1;
    }
  }

  applyConfidence(view: ViewKey, primitive: PrimitiveKey, event: ConfidenceEvent): ConfidenceState {
    const key = `${viewKeyId(view)}|${primitiveKeyId(primitive)}`;
    const before = this.confidence.ensure(key);
    const after =
      event.type === 'submit' && this.inFlightQueryKeys.has(key)
        ? this.confidence.applyInFlightSubmit(key, event)
        : this.confidence.apply(key, event);
    if (event.type === 'failure') this.inFlightQueryKeys.delete(key);
    if (
      before.status !== after.status ||
      before.zeroStreak !== after.zeroStreak ||
      before.successfulSubmits !== after.successfulSubmits ||
      before.queryable !== after.queryable ||
      before.dirty !== after.dirty ||
      before.lastResultGeneration !== after.lastResultGeneration
    ) {
      this.visibilityRevision += 1;
    }
    if (before.status !== after.status || before.queryable !== after.queryable) {
      this.drawRevision += 1;
    }
    const beforeNeedsQuery =
      (before.dirty && before.successfulSubmits === 0) || shouldIssueRetest(before, this.budget);
    const afterNeedsQuery =
      (after.dirty && after.successfulSubmits === 0) || shouldIssueRetest(after, this.budget);
    if (beforeNeedsQuery !== afterNeedsQuery) this.queryRevision += 1;
    this.syncQueryKey(key, after);
    return after;
  }

  /** Advance hidden rows on a successful frame, excluding rows queried now. */
  advanceSuccessfulSubmits(
    submissionGeneration: number,
    excluded?: readonly { readonly view: ViewKey; readonly primitive: PrimitiveKey }[],
  ): void {
    let excludedKeys: ReadonlySet<string> | undefined;
    if (excluded !== undefined && excluded.length > 0) {
      const keys = new Set<string>();
      for (const { view, primitive } of excluded) {
        keys.add(`${viewKeyId(view)}|${primitiveKeyId(primitive)}`);
      }
      excludedKeys = keys;
    }
    const result = this.confidence.advanceSuccessfulSubmits(submissionGeneration, excludedKeys);
    if (result.changed) {
      this.visibilityRevision += 1;
    }
    if (result.drawChangedKeys.length > 0) this.drawRevision += 1;
    if (result.queryChangedKeys.length > 0) this.queryRevision += 1;
    for (const key of [...result.drawChangedKeys, ...result.queryChangedKeys]) {
      this.syncQueryKey(key, this.confidence.get(key));
    }
  }

  getConfidence(view: ViewKey, primitive: PrimitiveKey): ConfidenceState {
    return this.confidence.ensure(`${viewKeyId(view)}|${primitiveKeyId(primitive)}`);
  }

  /** Whether this candidate needs a bounded query this frame. */
  shouldQuery(view: ViewKey, primitive: PrimitiveKey): boolean {
    const state = this.getConfidence(view, primitive);
    return (state.dirty && state.successfulSubmits === 0) || shouldIssueRetest(state, this.budget);
  }

  drainConfidenceRetests(limit: number): string[] {
    return this.confidence.drainRetests(limit);
  }

  /**
   * Remove a bounded page of ready query work for one view. Queue entries are
   * identity keyed, so confidence completion and resource failure can safely
   * requeue the same primitive without scanning the scene.
   */
  dequeueQueryCandidates(view: ViewKey, limit: number): readonly QueryEntry[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    const viewId = viewKeyId(view);
    const queue = this.queryQueues.get(viewId);
    if (queue === undefined) return [];
    const result: QueryEntry[] = [];
    while (queue.head !== undefined && result.length < limit) {
      const key = queue.head;
      this.removeQueuedKey(key);
      if (!this.readyQueryKeys.delete(key)) continue;
      const entry = this.queryEntries.get(key);
      if (entry === undefined || viewKeyId(entry.view) !== viewId) continue;
      this.inFlightQueryKeys.add(key);
      result.push(entry);
    }
    return result;
  }

  /** Put a candidate back after a query page could not be reserved. */
  requeueQueryCandidate(view: ViewKey, primitive: PrimitiveKey): void {
    const key = `${viewKeyId(view)}|${primitiveKeyId(primitive)}`;
    this.inFlightQueryKeys.delete(key);
    this.syncQueryKey(key, this.confidence.get(key));
  }

  getCandidate(view: ViewKey, primitive: PrimitiveKey): VisibilityCandidate | undefined {
    const state = this.views.get(viewKeyId(view));
    if (state === undefined || primitive.attachmentId !== view.attachmentId) return undefined;
    const candidate = state.rows.get(primitiveKeyId(primitive));
    return candidate === undefined ? undefined : { ...candidate };
  }

  beginViewEpoch(view: ViewKey): number {
    const state = this.views.get(viewKeyId(view));
    if (state === undefined) return -1;
    for (const primitive of state.rows.keys()) {
      this.removeQueryKey(`${viewKeyId(view)}|${primitive}`);
    }
    state.epoch += 1;
    state.rows.clear();
    this.visibilityRevision += 1;
    this.drawRevision += 1;
    this.queryRevision += 1;
    return state.epoch;
  }

  applyCompletion(
    view: ViewKey,
    primitive: PrimitiveKey,
    epoch: number,
    candidate: VisibilityCandidate,
  ): boolean {
    const state = this.views.get(viewKeyId(view));
    if (
      state === undefined ||
      state.epoch !== epoch ||
      primitive.attachmentId !== view.attachmentId
    ) {
      return false;
    }
    const primitiveId = primitiveKeyId(primitive);
    const previous = state.rows.get(primitiveId);
    if (
      previous === undefined ||
      previous.level !== candidate.level ||
      previous.confidence !== candidate.confidence
    ) {
      this.visibilityRevision += 1;
      this.drawRevision += 1;
    }
    state.rows.set(primitiveId, { ...candidate });
    const key = `${viewKeyId(view)}|${primitiveId}`;
    this.queryEntries.set(key, { view, primitive });
    this.syncQueryKey(key, this.confidence.ensure(key));
    return true;
  }

  inspect(): VisibilityFacetInspection {
    let facetRows = 0;
    for (const state of this.views.values()) facetRows += state.rows.size;
    return { owner: 'persistent-render-scene', activeViews: this.views.size, facetRows };
  }

  private syncQueryKey(key: string, state: ConfidenceState | undefined): void {
    if (state === undefined) return;
    const shouldQuery =
      (state.dirty && state.successfulSubmits === 0) || shouldIssueRetest(state, this.budget);
    if (!shouldQuery) {
      this.removeQueuedKey(key);
      this.readyQueryKeys.delete(key);
      this.inFlightQueryKeys.delete(key);
      return;
    }
    if (this.readyQueryKeys.has(key) || this.inFlightQueryKeys.has(key)) return;
    const entry = this.queryEntries.get(key);
    if (entry === undefined) return;
    this.readyQueryKeys.add(key);
    const viewId = viewKeyId(entry.view);
    const queue = this.queryQueues.get(viewId) ?? { head: undefined, tail: undefined };
    const node: QueryNode = {
      viewId,
      key,
      previous: queue.tail,
      next: undefined,
    };
    if (queue.tail !== undefined) {
      const tail = this.queryNodes.get(queue.tail);
      if (tail !== undefined) tail.next = key;
    } else {
      queue.head = key;
    }
    queue.tail = key;
    this.queryQueues.set(viewId, queue);
    this.queryNodes.set(key, node);
  }

  private removeQueryKey(key: string): void {
    this.confidence.remove(key);
    this.queryEntries.delete(key);
    this.removeQueuedKey(key);
    this.readyQueryKeys.delete(key);
    this.inFlightQueryKeys.delete(key);
  }

  private removeQueuedKey(key: string): void {
    const node = this.queryNodes.get(key);
    if (node === undefined) return;
    const queue = this.queryQueues.get(node.viewId);
    this.queryNodes.delete(key);
    if (queue === undefined) return;
    if (node.previous === undefined) queue.head = node.next;
    else {
      const previous = this.queryNodes.get(node.previous);
      if (previous !== undefined) previous.next = node.next;
    }
    if (node.next === undefined) queue.tail = node.previous;
    else {
      const next = this.queryNodes.get(node.next);
      if (next !== undefined) next.previous = node.previous;
    }
    if (queue.head === undefined) this.queryQueues.delete(node.viewId);
  }
}

export type {
  PrimitiveKey,
  ViewKey,
  VisibilityCandidate,
  VisibilityFacetInspection,
} from './types';
export { primitiveKey, primitiveKeyId, viewKey, viewKeyId } from './types';
