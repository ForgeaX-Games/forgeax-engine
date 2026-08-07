import type { ProfileClock } from './clock.js';
import { boundaryError, type ProfilerResult, stateError } from './errors.js';
import type {
  ProfileCapture,
  ProfilePhaseStart,
  ProfileRecord,
  ProfileSkipInput,
} from './types.js';

export interface RecorderLimits {
  readonly frameLimit: number;
  readonly eventLimit: number;
  readonly detail?: ProfileDetail;
}

export type ProfileDetail = 'owner' | 'nested';

export interface RecorderPhaseCatalog {
  readonly app: readonly string[];
  readonly render: readonly string[];
}

export interface RecorderSession {
  readonly captureId: string;
  readonly detail: ProfileDetail;
  beginFrame(frameId: number): ProfilerResult<void>;
  beginPhase(input: ProfilePhaseStart): ProfilerResult<void>;
  endPhase(): ProfilerResult<void>;
  recordSkip(input: ProfileSkipInput): ProfilerResult<void>;
  endFrame(): ProfilerResult<void>;
  finish(): ProfilerResult<ProfileCapture>;
}

type OpenPhase = ProfilePhaseStart & { readonly frameId: number; readonly startMicros: number };

interface RecorderState {
  readonly limits: RecorderLimits;
  readonly phaseCatalog: RecorderPhaseCatalog;
  readonly records: ProfileRecord[];
  readonly captureId: string;
  readonly clock: ProfileClock;
  frameCount: number;
  lastFrameId: number;
  currentFrameId: number | undefined;
  openPhases: OpenPhase[];
  droppedEventCount: number;
  firstAffectedFrameId: number | undefined;
  lastAffectedFrameId: number | undefined;
  overflow: boolean;
  finished: boolean;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function validateRecorderLimits(limits: RecorderLimits): ProfilerResult<void> {
  if (!positiveSafeInteger(limits.frameLimit) || !positiveSafeInteger(limits.eventLimit)) {
    return { ok: false, error: boundaryError(limits.frameLimit, limits.eventLimit) };
  }
  return { ok: true, value: undefined };
}

function recordOverflow(state: RecorderState, frameId: number): void {
  state.overflow = true;
  state.droppedEventCount += 1;
  state.firstAffectedFrameId ??= frameId;
  state.lastAffectedFrameId = frameId;
}

function stateResult(state: RecorderState, operation: string): ProfilerResult<void> {
  if (state.finished) return { ok: false, error: stateError(operation) };
  return { ok: true, value: undefined };
}

function sourceHasPhase(state: RecorderState, source: string, phase: string): boolean {
  return (state.phaseCatalog[source as 'app' | 'render'] ?? []).includes(phase);
}

function sourceError(source: string, phase: string, frameId: number): ProfilerResult<never> {
  return {
    ok: false,
    error: {
      code: 'profile-source-failed',
      expected: 'a phase declared by the source catalog',
      hint: 'Use the source-owned phase catalog and retry the frame.',
      detail: { source, phase, frameId },
    },
  };
}

function canRetain(state: RecorderState): boolean {
  return state.records.length < state.limits.eventLimit;
}

function addRecord(state: RecorderState, record: ProfileRecord): void {
  if (canRetain(state)) {
    state.records.push(record);
  } else {
    recordOverflow(state, record.frameId);
  }
}

function buildCapture(state: RecorderState): ProfileCapture {
  const status = state.overflow
    ? 'overflow'
    : state.frameCount < state.limits.frameLimit || state.currentFrameId !== undefined
      ? 'partial'
      : 'complete';
  const completeness = {
    status,
    retainedEventCount: state.records.length,
    droppedEventCount: state.droppedEventCount,
    ...(status === 'partial' ? { incompleteReason: 'stopped-before-frame' } : {}),
    ...(state.firstAffectedFrameId !== undefined
      ? { firstAffectedFrameId: state.firstAffectedFrameId }
      : {}),
    ...(state.lastAffectedFrameId !== undefined
      ? { lastAffectedFrameId: state.lastAffectedFrameId }
      : {}),
  } as ProfileCapture['completeness'];
  return {
    schemaVersion: '1.0',
    captureId: state.captureId,
    timeUnit: 'microseconds',
    frameLimit: state.limits.frameLimit,
    eventLimit: state.limits.eventLimit,
    phaseCatalog: state.phaseCatalog,
    records: state.records,
    completeness,
  };
}

export function createRecorder(
  captureId: string,
  limits: RecorderLimits,
  clock: ProfileClock,
  phaseCatalog: RecorderPhaseCatalog,
  allocationReport?: { profilerEventObjectAllocations: number },
): ProfilerResult<RecorderSession> {
  const validLimits = validateRecorderLimits(limits);
  if (!validLimits.ok) return validLimits;
  const state: RecorderState = {
    limits,
    phaseCatalog,
    records: [],
    captureId,
    clock,
    frameCount: 0,
    lastFrameId: 0,
    currentFrameId: undefined,
    openPhases: [],
    droppedEventCount: 0,
    firstAffectedFrameId: undefined,
    lastAffectedFrameId: undefined,
    overflow: false,
    finished: false,
  };

  const session: RecorderSession = {
    captureId,
    detail: limits.detail ?? 'owner',
    beginFrame(frameId) {
      const stateCheck = stateResult(state, 'beginFrame');
      if (!stateCheck.ok) return stateCheck;
      if (
        !positiveSafeInteger(frameId) ||
        state.currentFrameId !== undefined ||
        frameId <= state.lastFrameId
      ) {
        return { ok: false, error: stateError('beginFrame') };
      }
      state.lastFrameId = frameId;
      state.currentFrameId = frameId;
      state.frameCount += 1;
      if (state.frameCount > state.limits.frameLimit)
        recordOverflow(state, state.limits.frameLimit);
      return { ok: true, value: undefined };
    },
    beginPhase(input) {
      const stateCheck = stateResult(state, 'beginPhase');
      if (!stateCheck.ok) return stateCheck;
      const frameId = state.currentFrameId;
      if (frameId === undefined) return { ok: false, error: stateError('beginPhase') };
      if (!sourceHasPhase(state, input.source, input.phase))
        return sourceError(input.source, input.phase, frameId);
      state.openPhases.push({ ...input, frameId, startMicros: clock.nowMicros() });
      return { ok: true, value: undefined };
    },
    endPhase() {
      const stateCheck = stateResult(state, 'endPhase');
      if (!stateCheck.ok) return stateCheck;
      const openPhase = state.openPhases.pop();
      if (openPhase === undefined) return { ok: false, error: stateError('endPhase') };
      const parent = state.openPhases.at(-1);
      if (!state.overflow) {
        const endMicros = Math.max(openPhase.startMicros, clock.nowMicros());
        if (allocationReport !== undefined) allocationReport.profilerEventObjectAllocations += 1;
        addRecord(state, {
          kind: 'phase',
          source: openPhase.source,
          frameId: openPhase.frameId,
          phase: openPhase.phase,
          ...(parent === undefined
            ? {}
            : { parentSource: parent.source, parentPhase: parent.phase }),
          startMicros: openPhase.startMicros,
          endMicros,
          durationMicros: endMicros - openPhase.startMicros,
        });
      } else {
        recordOverflow(state, openPhase.frameId);
      }
      return { ok: true, value: undefined };
    },
    recordSkip(input) {
      const stateCheck = stateResult(state, 'recordSkip');
      if (!stateCheck.ok) return stateCheck;
      const frameId = state.currentFrameId;
      if (frameId === undefined || state.openPhases.length > 0)
        return { ok: false, error: stateError('recordSkip') };
      if (!sourceHasPhase(state, input.source, input.phase))
        return sourceError(input.source, input.phase, frameId);
      if (state.overflow) recordOverflow(state, frameId);
      else {
        if (allocationReport !== undefined) allocationReport.profilerEventObjectAllocations += 1;
        addRecord(state, { kind: 'skip', ...input, frameId });
      }
      return { ok: true, value: undefined };
    },
    endFrame() {
      const stateCheck = stateResult(state, 'endFrame');
      if (!stateCheck.ok) return stateCheck;
      if (state.currentFrameId === undefined || state.openPhases.length > 0)
        return { ok: false, error: stateError('endFrame') };
      state.currentFrameId = undefined;
      return { ok: true, value: undefined };
    },
    finish() {
      const stateCheck = stateResult(state, 'finish');
      if (!stateCheck.ok) return { ok: false, error: stateCheck.error };
      if (state.openPhases.length > 0 || state.currentFrameId !== undefined) {
        return { ok: false, error: stateError('finish') };
      }
      state.finished = true;
      return { ok: true, value: buildCapture(state) };
    },
  };
  return { ok: true, value: session };
}
