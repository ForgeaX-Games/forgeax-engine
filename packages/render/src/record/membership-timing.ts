import type {
  Buffer,
  CommandBuffer,
  QuerySet,
  Result,
  RhiCommandEncoder,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';

export const MEMBERSHIP_TIMING_REASON_CODES = [
  'invalid-options',
  'timestamp-query-unsupported',
  'timestamp-period-unavailable',
  'timestamp-write-unavailable',
  'capture-capacity-exhausted',
  'capture-already-active',
  'queue-submit-failed',
  'queue-completion-failed',
  'readback-map-failed',
  'capture-timeout',
  'device-lost',
  'stale-device-generation',
  'capture-disposed',
  'timestamp-range-invalid',
  'profile-incomplete',
  'provenance-missing',
  'provenance-mismatch',
  'reference-missing',
  'reference-reused',
  'reference-cross-parent',
  'membership-output-mismatch',
  'pixel-output-mismatch',
  'terminal-record-incomplete',
] as const;

export type MembershipTimingReasonCode = (typeof MEMBERSHIP_TIMING_REASON_CODES)[number];

export const MEMBERSHIP_TIMING_REASON_MAPPING = {
  'invalid-options': { api: 'refused', topLevel: 'incomplete', reference: 'incomplete' },
  'timestamp-query-unsupported': { api: 'refused', topLevel: 'refused', reference: 'refused' },
  'timestamp-period-unavailable': { api: 'refused', topLevel: 'refused', reference: 'refused' },
  'timestamp-write-unavailable': { api: 'terminal', topLevel: 'refused', reference: 'refused' },
  'capture-capacity-exhausted': { api: 'refused', topLevel: 'incomplete', reference: 'incomplete' },
  'capture-already-active': { api: 'refused', topLevel: 'incomplete', reference: 'incomplete' },
  'queue-submit-failed': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'queue-completion-failed': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'readback-map-failed': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'capture-timeout': { api: 'terminal', topLevel: 'timed-out', reference: 'timed-out' },
  'device-lost': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'stale-device-generation': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'capture-disposed': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'timestamp-range-invalid': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'profile-incomplete': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'provenance-missing': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'provenance-mismatch': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'reference-missing': { api: 'terminal', topLevel: 'incomplete', reference: 'none' },
  'reference-reused': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'reference-cross-parent': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'membership-output-mismatch': {
    api: 'terminal',
    topLevel: 'incomplete',
    reference: 'incomplete',
  },
  'pixel-output-mismatch': { api: 'terminal', topLevel: 'incomplete', reference: 'incomplete' },
  'terminal-record-incomplete': {
    api: 'terminal',
    topLevel: 'incomplete',
    reference: 'incomplete',
  },
} as const satisfies Record<
  MembershipTimingReasonCode,
  {
    readonly api: 'refused' | 'terminal';
    readonly topLevel: 'refused' | 'timed-out' | 'incomplete';
    readonly reference: 'refused' | 'timed-out' | 'incomplete' | 'none';
  }
>;

export const MEMBERSHIP_TIMING_REASON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://forgeax.dev/schemas/render/membership-timing-reason-code.schema.json',
  title: 'ForgeaX Render membership timing reason code',
  type: 'string',
  enum: MEMBERSHIP_TIMING_REASON_CODES,
} as const;

/** Canonical membership facts projected by the Render HDRP producer. */
export interface MembershipTimingMembershipOutput {
  readonly schemaVersion: 1;
  readonly lightCount: number;
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  readonly clusterOffsetsAndCounts: readonly number[];
  readonly attemptedTotal: number;
  readonly writtenTotal: number;
  readonly capacity: number;
  readonly overflow: boolean;
  readonly lightIndexPrefix: readonly number[];
}

/** Actual device buffers consumed/written by hdrp-cluster-membership. */
export interface MembershipTimingGpuOutputSource {
  readonly clusterGridBuffer: Buffer;
  readonly clusterGridBytes: number;
  readonly lightIndexListBuffer: Buffer;
  readonly lightIndexListBytes: number;
  readonly lightCount: number;
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  readonly attemptedTotal: number;
  readonly writtenTotal: number;
  readonly capacity: number;
  readonly overflow: boolean;
}

export type MembershipTimingOptions =
  | { readonly mode: 'gpu'; readonly maxPendingCaptures?: number }
  | { readonly mode: 'cpu-control' };

export type MembershipTimingGpuReport = {
  readonly rawUnit: 'ticks';
  readonly rawBeginTick: string;
  readonly rawEndTick: string;
  readonly deltaTicks: string;
  readonly timestampPeriodNanoseconds: number;
  readonly durationNanoseconds: number;
};

export interface MembershipTimingInterval {
  readonly startNanoseconds: number;
  readonly endNanoseconds: number;
  readonly durationNanoseconds: number;
}

export interface MembershipTimingReport {
  readonly captureId: string;
  readonly submissionToken: string | null;
  readonly dispatchId: string | null;
  readonly actualProducer: 'gpu' | 'cpu';
  readonly backendKind: RhiDevice['caps']['backendKind'];
  readonly compute: boolean;
  readonly timestampQuery: boolean;
  readonly timestampPeriodNanoseconds: number | null;
  readonly gpu: MembershipTimingGpuReport | null;
  readonly membership: MembershipTimingMembershipOutput | null;
  readonly cpu: {
    readonly encode: MembershipTimingInterval | null;
    readonly submit: MembershipTimingInterval | null;
  };
  readonly async: {
    readonly queueCompletion: MembershipTimingInterval | null;
    readonly readback: MembershipTimingInterval | null;
  };
}

export class MembershipTimingError extends Error {
  readonly code: MembershipTimingReasonCode;
  readonly expected: string;
  readonly hint: string;

  constructor(code: MembershipTimingReasonCode, expected: string, hint: string) {
    super(hint);
    this.name = 'MembershipTimingError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
  }
}

export interface MembershipTimingController {
  readonly mode: MembershipTimingOptions['mode'];
  readonly maxPendingCaptures: number;
  readonly active: boolean;
  readonly shouldTimestampPass: boolean;
  usesCpuControl(): boolean;
  start(): Result<{ readonly captureId: string }, MembershipTimingError>;
  finish(): Promise<Result<MembershipTimingReport, MembershipTimingError>>;
  beforeMembership(encoder: RhiCommandEncoder): void;
  afterMembership(encoder: RhiCommandEncoder): void;
  markEncodeFinished(): void;
  markEncodeFailed(detail?: string): void;
  markSubmitStarted(): void;
  markSubmitted(command: CommandBuffer): void;
  markSubmitFailed(detail?: string): void;
  markDeviceLost(detail?: string): void;
  bindDevice(device: RhiDevice): void;
  recordGpuMembershipSource(source: MembershipTimingGpuOutputSource): void;
  recordMembershipOutput(output: MembershipTimingMembershipOutput): void;
  dispose(): void;
}

type Capture = {
  readonly captureId: string;
  readonly device: RhiDevice;
  querySet?: QuerySet;
  resolveBuffer?: Buffer;
  stagingBuffer?: Buffer;
  clusterReadbackBuffer?: Buffer;
  indexReadbackBuffer?: Buffer;
  gpuSource?: MembershipTimingGpuOutputSource;
  begun: boolean;
  ended: boolean;
  submitted: boolean;
  finished: boolean;
  asyncStarted: boolean;
  settled: boolean;
  cleaned: boolean;
  membership: MembershipTimingMembershipOutput | null;
  submissionToken?: string;
  dispatchId?: string;
  encodeStartedAt?: number;
  encodeFinishedAt?: number;
  submitStartedAt?: number;
  submitFinishedAt?: number;
  queueCompletionStartedAt?: number;
  queueCompletionFinishedAt?: number;
  readbackStartedAt?: number;
  readbackFinishedAt?: number;
  resolve: (result: Result<MembershipTimingReport, MembershipTimingError>) => void;
  completion: Promise<Result<MembershipTimingReport, MembershipTimingError>>;
};

const QUERY_RESOLVE = 0x200;
const COPY_SRC = 0x04;
const COPY_DST = 0x08;
const MAP_READ = 0x01;
const READBACK_BYTES = 256;
const DEFAULT_MAX_PENDING = 2;
const CAPTURE_TIMEOUT_MS = 2000;

function monotonicNanoseconds(): number {
  const clock = globalThis.performance;
  return typeof clock?.now === 'function' ? clock.now() * 1_000_000 : 0;
}

function duration(start: number | undefined, end: number | undefined): number | null {
  if (start === undefined || end === undefined || end < start) return null;
  return end - start;
}

function interval(
  start: number | undefined,
  end: number | undefined,
): MembershipTimingInterval | null {
  const elapsed = duration(start, end);
  if (elapsed === null || start === undefined || end === undefined) return null;
  return { startNanoseconds: start, endNanoseconds: end, durationNanoseconds: elapsed };
}

function invalidOptions(options: MembershipTimingOptions): MembershipTimingError | undefined {
  if (options.mode !== 'gpu') return undefined;
  const bound = options.maxPendingCaptures ?? DEFAULT_MAX_PENDING;
  if (!Number.isInteger(bound) || bound < 1 || bound > 8) {
    return new MembershipTimingError(
      'invalid-options',
      'gpu maxPendingCaptures must be an integer in [1, 8]',
      `got maxPendingCaptures=${String(options.maxPendingCaptures)}`,
    );
  }
  return undefined;
}

function refusedForCaps(device: RhiDevice): MembershipTimingError | undefined {
  if (!device.caps.timestampQuery) {
    return new MembershipTimingError(
      'timestamp-query-unsupported',
      'device.caps.timestampQuery === true',
      `backend ${device.caps.backendKind} cannot produce timestamp ticks`,
    );
  }
  const period = device.caps.timestampPeriodNanoseconds;
  if (typeof period !== 'number' || !Number.isFinite(period) || period <= 0) {
    return new MembershipTimingError(
      'timestamp-period-unavailable',
      'device.caps.timestampPeriodNanoseconds is finite and positive',
      'the backend did not publish a trustworthy timestamp unit',
    );
  }
  return undefined;
}

function captureError(
  code: MembershipTimingReasonCode,
  expected: string,
  hint: string,
): MembershipTimingError {
  return new MembershipTimingError(code, expected, hint);
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          captureError(
            'capture-timeout',
            'GPU queue completion and readback finish before the capture deadline',
            `capture exceeded ${CAPTURE_TIMEOUT_MS}ms`,
          ),
        ),
      CAPTURE_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

export function createMembershipTiming(
  initialDevice: RhiDevice,
  options: MembershipTimingOptions,
): MembershipTimingController {
  const optionError = invalidOptions(options);
  const maxPendingCaptures =
    options.mode === 'gpu'
      ? (options.maxPendingCaptures ?? DEFAULT_MAX_PENDING)
      : DEFAULT_MAX_PENDING;
  let device = initialDevice;
  let disposed = false;
  let serial = 0;
  let deviceLost = false;
  let current: Capture | undefined;
  let detached: Capture | undefined;
  const pending = new Set<Capture>();

  function release(capture: Capture): void {
    if (capture.cleaned) return;
    capture.cleaned = true;
    const buffers = [
      capture.clusterReadbackBuffer,
      capture.indexReadbackBuffer,
      capture.stagingBuffer,
      capture.resolveBuffer,
    ];
    for (const buffer of buffers) {
      if (buffer === undefined) continue;
      try {
        deviceDestroyBuffer(capture, buffer);
      } catch {
        // Cleanup continues so one backend release failure cannot leak the other handles.
      }
    }
    if (capture.querySet !== undefined) {
      try {
        capture.device.destroyQuerySet(capture.querySet);
      } catch {
        // The capture is already terminal; the backend owns any failed release diagnostic.
      }
    }
    pending.delete(capture);
  }

  function deviceDestroyBuffer(capture: Capture, buffer: Buffer): void {
    capture.device.destroyBuffer(buffer);
  }

  function settleError(capture: Capture, error: MembershipTimingError): void {
    if (capture.settled) return;
    capture.settled = true;
    capture.resolve(err(error));
  }

  function settleSuccess(capture: Capture, report: MembershipTimingReport): void {
    if (capture.settled) return;
    capture.settled = true;
    capture.resolve(ok(report));
  }

  function terminalizeIdle(capture: Capture, error: MembershipTimingError): void {
    settleError(capture, error);
    if (!capture.asyncStarted && !capture.submitted) release(capture);
  }

  function createReadback(
    capture: Capture,
    size: number,
    label: string,
  ): Result<Buffer, MembershipTimingError> {
    const result = capture.device.createBuffer({
      label,
      size,
      usage: COPY_DST | MAP_READ,
      mappedAtCreation: false,
    });
    return result.ok
      ? ok(result.value)
      : err(
          captureError(
            'terminal-record-incomplete',
            'membership readback buffer is created',
            result.error.hint,
          ),
        );
  }

  async function readU32(buffer: Buffer, expectedBytes: number): Promise<Uint32Array> {
    const mapped = await buffer.mapAsync(MAP_READ, 0, expectedBytes);
    if (!mapped.ok)
      throw captureError(
        'readback-map-failed',
        'membership readback maps successfully',
        mapped.error.hint,
      );
    try {
      const range = mapped.value.getMappedRange(0, expectedBytes);
      if (!range.ok)
        throw captureError(
          'readback-map-failed',
          'membership readback range is readable',
          range.error.hint,
        );
      return new Uint32Array(range.value.slice(0));
    } finally {
      mapped.value.unmap();
    }
  }

  async function completeGpu(capture: Capture): Promise<void> {
    try {
      capture.queueCompletionStartedAt = monotonicNanoseconds();
      try {
        await capture.device.queue.onSubmittedWorkDone();
      } catch (cause) {
        throw captureError(
          'queue-completion-failed',
          'the submitted render work completes successfully',
          String(cause),
        );
      }
      capture.queueCompletionFinishedAt = monotonicNanoseconds();
      if (capture.settled) return;
      if (!capture.ended || capture.stagingBuffer === undefined) {
        throw captureError(
          'terminal-record-incomplete',
          'the membership pass emitted both timestamp writes',
          'start must surround the real hdrp-cluster-membership pass',
        );
      }
      capture.readbackStartedAt = monotonicNanoseconds();
      const mapped = await capture.stagingBuffer.mapAsync(MAP_READ, 0, READBACK_BYTES);
      if (!mapped.ok)
        throw captureError(
          'readback-map-failed',
          'timestamp readback maps successfully',
          mapped.error.hint,
        );
      let begin: bigint;
      let end: bigint;
      try {
        const bytes = mapped.value.getMappedRange(0, READBACK_BYTES);
        if (!bytes.ok)
          throw captureError(
            'readback-map-failed',
            'timestamp readback range is readable',
            bytes.error.hint,
          );
        const ticks = new BigUint64Array(bytes.value);
        begin = ticks[0] ?? 0n;
        end = ticks[1] ?? 0n;
      } finally {
        mapped.value.unmap();
      }
      if (end <= begin)
        throw captureError(
          'timestamp-range-invalid',
          'timestamp end tick is greater than begin tick',
          'discard the zero or reversed GPU interval',
        );
      const period = capture.device.caps.timestampPeriodNanoseconds;
      if (typeof period !== 'number' || !Number.isFinite(period) || period <= 0)
        throw captureError(
          'timestamp-period-unavailable',
          'timestamp period remains valid at readback',
          'discard the sample',
        );
      const deltaTicks = end - begin;
      const durationNanoseconds = Number(deltaTicks) * period;
      if (!Number.isFinite(durationNanoseconds) || durationNanoseconds <= 0)
        throw captureError(
          'timestamp-range-invalid',
          'derived GPU duration is finite and positive',
          'discard the GPU interval whose tick delta cannot be represented as a duration',
        );
      const source = capture.gpuSource;
      if (
        source === undefined ||
        capture.clusterReadbackBuffer === undefined ||
        capture.indexReadbackBuffer === undefined
      ) {
        throw captureError(
          'membership-output-mismatch',
          'the real hdrp-cluster-membership output buffers are attached to the capture',
          'the GPU timing sample has no canonical membership output',
        );
      }
      const clusterValues = await readU32(capture.clusterReadbackBuffer, source.clusterGridBytes);
      const indexValues = await readU32(capture.indexReadbackBuffer, source.lightIndexListBytes);
      capture.readbackFinishedAt = monotonicNanoseconds();
      const report: MembershipTimingReport = {
        captureId: capture.captureId,
        submissionToken: capture.submissionToken ?? null,
        dispatchId: capture.dispatchId ?? null,
        actualProducer: 'gpu',
        backendKind: capture.device.caps.backendKind,
        compute: capture.device.caps.compute,
        timestampQuery: capture.device.caps.timestampQuery,
        timestampPeriodNanoseconds: period,
        gpu: {
          rawUnit: 'ticks',
          rawBeginTick: begin.toString(10),
          rawEndTick: end.toString(10),
          deltaTicks: deltaTicks.toString(10),
          timestampPeriodNanoseconds: period,
          durationNanoseconds,
        },
        membership: {
          schemaVersion: 1,
          lightCount: source.lightCount,
          grid: source.grid,
          clusterOffsetsAndCounts: Array.from(clusterValues),
          attemptedTotal: source.attemptedTotal,
          writtenTotal: source.writtenTotal,
          capacity: source.capacity,
          overflow: source.overflow,
          lightIndexPrefix: Array.from(indexValues.subarray(0, source.writtenTotal)),
        },
        cpu: {
          encode: interval(capture.encodeStartedAt, capture.encodeFinishedAt),
          submit: interval(capture.submitStartedAt, capture.submitFinishedAt),
        },
        async: {
          queueCompletion: interval(
            capture.queueCompletionStartedAt,
            capture.queueCompletionFinishedAt,
          ),
          readback: interval(capture.readbackStartedAt, capture.readbackFinishedAt),
        },
      };
      settleSuccess(capture, report);
    } catch (cause) {
      settleError(
        capture,
        cause instanceof MembershipTimingError
          ? cause
          : captureError(
              'readback-map-failed',
              'timestamp and membership readback completes',
              String(cause),
            ),
      );
    } finally {
      release(capture);
    }
  }

  const controller: MembershipTimingController = {
    mode: options.mode,
    maxPendingCaptures,
    get active() {
      return current !== undefined;
    },
    get shouldTimestampPass() {
      return (
        options.mode === 'gpu' &&
        current?.begun !== true &&
        current?.ended !== true &&
        current?.settled !== true
      );
    },
    usesCpuControl() {
      return options.mode === 'cpu-control';
    },
    start() {
      if (optionError !== undefined) return err(optionError);
      if (disposed)
        return err(
          captureError('capture-disposed', 'renderer is alive', 'dispose ended membership timing'),
        );
      if (deviceLost)
        return err(
          captureError(
            'device-lost',
            'the current renderer device remains available',
            'device.lost terminalized membership timing before recovery',
          ),
        );
      if (options.mode === 'gpu') {
        const capabilityError = refusedForCaps(device);
        if (capabilityError !== undefined) return err(capabilityError);
      }
      if (current !== undefined)
        return err(
          captureError(
            'capture-already-active',
            'only one capture is active',
            'finish the active capture first',
          ),
        );
      if (pending.size >= maxPendingCaptures)
        return err(
          captureError(
            'capture-capacity-exhausted',
            'pending captures stay within the configured bound',
            'await a prior capture before starting another',
          ),
        );
      const captureId = `membership-${++serial}`;
      let resolve!: (result: Result<MembershipTimingReport, MembershipTimingError>) => void;
      const completion = new Promise<Result<MembershipTimingReport, MembershipTimingError>>(
        (res) => {
          resolve = res;
        },
      );
      const capture: Capture = {
        captureId,
        device,
        begun: false,
        ended: false,
        submitted: false,
        finished: false,
        asyncStarted: false,
        settled: false,
        cleaned: false,
        membership: null,
        encodeStartedAt: monotonicNanoseconds(),
        resolve,
        completion,
      };
      if (options.mode === 'gpu') {
        const query = device.createQuerySet({
          label: 'membership-timing',
          type: 'timestamp',
          count: 2,
        });
        if (!query.ok) {
          terminalizeIdle(
            capture,
            captureError(
              'timestamp-query-unsupported',
              'timestamp QuerySet creation succeeds',
              query.error.hint,
            ),
          );
          return err(
            captureError(
              'timestamp-query-unsupported',
              'timestamp QuerySet creation succeeds',
              query.error.hint,
            ),
          );
        }
        capture.querySet = query.value;
        const resolveBuffer = device.createBuffer({
          label: 'membership-timing-resolve',
          size: READBACK_BYTES,
          usage: QUERY_RESOLVE | COPY_SRC,
        });
        if (!resolveBuffer.ok) {
          terminalizeIdle(
            capture,
            captureError(
              'terminal-record-incomplete',
              'timestamp resolve buffer is created',
              resolveBuffer.error.hint,
            ),
          );
          return err(
            captureError(
              'terminal-record-incomplete',
              'timestamp resolve buffer is created',
              resolveBuffer.error.hint,
            ),
          );
        }
        capture.resolveBuffer = resolveBuffer.value;
        const stagingBuffer = device.createBuffer({
          label: 'membership-timing-readback',
          size: READBACK_BYTES,
          usage: COPY_DST | MAP_READ,
        });
        if (!stagingBuffer.ok) {
          terminalizeIdle(
            capture,
            captureError(
              'terminal-record-incomplete',
              'timestamp readback buffer is created',
              stagingBuffer.error.hint,
            ),
          );
          return err(
            captureError(
              'terminal-record-incomplete',
              'timestamp readback buffer is created',
              stagingBuffer.error.hint,
            ),
          );
        }
        capture.stagingBuffer = stagingBuffer.value;
      }
      current = capture;
      pending.add(capture);
      return ok({ captureId });
    },
    async finish() {
      const capture = current ?? detached;
      detached = undefined;
      if (capture === undefined)
        return err(
          captureError('capture-disposed', 'an active capture exists', 'call start before finish'),
        );
      if (capture.finished)
        return err(
          captureError(
            'terminal-record-incomplete',
            'a capture terminalizes once',
            'finish was called twice',
          ),
        );
      capture.finished = true;
      if (current === capture) current = undefined;
      if (capture.settled) {
        const result = await capture.completion;
        if (!capture.asyncStarted && !capture.submitted) release(capture);
        return result;
      }
      try {
        return await withTimeout(capture.completion);
      } catch (cause) {
        const timeoutError =
          cause instanceof MembershipTimingError && cause.code === 'capture-timeout'
            ? cause
            : captureError(
                'terminal-record-incomplete',
                'capture completion resolves',
                String(cause),
              );
        settleError(capture, timeoutError);
        if (!capture.asyncStarted && !capture.submitted) release(capture);
        return err(timeoutError);
      }
    },
    beforeMembership(encoder) {
      const capture = current;
      if (
        capture === undefined ||
        options.mode !== 'gpu' ||
        capture.begun ||
        capture.ended ||
        capture.settled
      )
        return;
      if (capture.querySet === undefined) return;
      try {
        capture.dispatchId = `${capture.captureId}:hdrp-cluster-membership`;
        encoder.writeTimestamp(capture.querySet, 0);
        capture.begun = true;
      } catch (cause) {
        terminalizeIdle(
          capture,
          captureError(
            'timestamp-write-unavailable',
            'the timestamp begin write succeeds on the timestamp-capable encoder',
            String(cause),
          ),
        );
      }
    },
    afterMembership(encoder) {
      const capture = current;
      if (capture === undefined || options.mode !== 'gpu' || !capture.begun || capture.ended)
        return;
      try {
        if (
          capture.querySet === undefined ||
          capture.resolveBuffer === undefined ||
          capture.stagingBuffer === undefined
        )
          throw captureError(
            'terminal-record-incomplete',
            'timestamp resources remain available',
            'capture resources are incomplete',
          );
        try {
          encoder.writeTimestamp(capture.querySet, 1);
        } catch (cause) {
          settleError(
            capture,
            captureError(
              'timestamp-write-unavailable',
              'the timestamp end write succeeds on the timestamp-capable encoder',
              String(cause),
            ),
          );
          return;
        }
        capture.ended = true;
        const resolved = encoder.resolveQuerySet(capture.querySet, 0, 2, capture.resolveBuffer, 0);
        if (!resolved.ok)
          throw captureError(
            'terminal-record-incomplete',
            'timestamp queries resolve',
            resolved.error.hint,
          );
        encoder.copyBufferToBuffer(
          capture.resolveBuffer,
          0,
          capture.stagingBuffer,
          0,
          READBACK_BYTES,
        );
        const source = capture.gpuSource;
        if (
          source === undefined ||
          capture.clusterReadbackBuffer === undefined ||
          capture.indexReadbackBuffer === undefined
        ) {
          settleError(
            capture,
            captureError(
              'membership-output-mismatch',
              'the real membership output source is attached before dispatch',
              'capture cannot be accepted without producer output',
            ),
          );
        } else {
          encoder.copyBufferToBuffer(
            source.clusterGridBuffer,
            0,
            capture.clusterReadbackBuffer,
            0,
            source.clusterGridBytes,
          );
          encoder.copyBufferToBuffer(
            source.lightIndexListBuffer,
            0,
            capture.indexReadbackBuffer,
            0,
            source.lightIndexListBytes,
          );
        }
      } catch (cause) {
        settleError(
          capture,
          cause instanceof MembershipTimingError
            ? cause
            : captureError(
                'terminal-record-incomplete',
                'timestamp encoder operations finish',
                String(cause),
              ),
        );
      }
    },
    markEncodeFinished() {
      const capture = current;
      if (capture === undefined || capture.encodeFinishedAt !== undefined) return;
      capture.encodeFinishedAt = monotonicNanoseconds();
    },
    markEncodeFailed(detail) {
      const capture = current;
      if (capture === undefined) return;
      terminalizeIdle(
        capture,
        captureError(
          'terminal-record-incomplete',
          'the frame encoder finishes successfully',
          detail ?? 'encoder.finish failed',
        ),
      );
    },
    markSubmitStarted() {
      const capture = current;
      if (capture === undefined || capture.submitStartedAt !== undefined) return;
      capture.submitStartedAt = monotonicNanoseconds();
    },
    markSubmitted(_command) {
      const capture = current;
      if (capture === undefined || capture.submitted) return;
      capture.submitted = true;
      capture.submitFinishedAt = monotonicNanoseconds();
      capture.submissionToken = `${capture.captureId}:submission`;
      if (options.mode === 'cpu-control') {
        settleSuccess(capture, {
          captureId: capture.captureId,
          submissionToken: capture.submissionToken,
          dispatchId: null,
          actualProducer: 'cpu',
          backendKind: capture.device.caps.backendKind,
          compute: capture.device.caps.compute,
          timestampQuery: capture.device.caps.timestampQuery,
          timestampPeriodNanoseconds: capture.device.caps.timestampPeriodNanoseconds,
          gpu: null,
          membership: capture.membership,
          cpu: {
            encode: interval(capture.encodeStartedAt, capture.encodeFinishedAt),
            submit: interval(capture.submitStartedAt, capture.submitFinishedAt),
          },
          async: { queueCompletion: null, readback: null },
        });
        release(capture);
        return;
      }
      capture.asyncStarted = true;
      void completeGpu(capture);
    },
    markSubmitFailed(detail) {
      const capture = current;
      if (capture === undefined) return;
      terminalizeIdle(
        capture,
        captureError(
          'queue-submit-failed',
          'the render command buffer submits successfully',
          detail ?? 'inspect the RHI queue submission failure',
        ),
      );
    },
    markDeviceLost(detail) {
      deviceLost = true;
      const error = captureError(
        'device-lost',
        'the device.lost transition terminalizes active membership captures',
        detail ?? 'the renderer device was lost',
      );
      for (const capture of [...pending]) {
        settleError(capture, error);
        if (!capture.asyncStarted && !capture.submitted) release(capture);
      }
    },
    bindDevice(nextDevice) {
      const previous = current;
      if (previous !== undefined) {
        current = undefined;
        detached = previous;
      }
      for (const capture of pending) {
        settleError(
          capture,
          captureError(
            'stale-device-generation',
            'capture resources belong to the current device generation',
            'device recovery invalidated the pending capture',
          ),
        );
        if (!capture.asyncStarted && !capture.submitted) release(capture);
      }
      device = nextDevice;
      deviceLost = false;
    },
    recordGpuMembershipSource(source) {
      const capture = current;
      if (capture === undefined || options.mode !== 'gpu' || capture.gpuSource !== undefined)
        return;
      capture.gpuSource = source;
      const cluster = createReadback(
        capture,
        source.clusterGridBytes,
        'membership-cluster-grid-readback',
      );
      if (cluster.ok) capture.clusterReadbackBuffer = cluster.value;
      const index = createReadback(
        capture,
        source.lightIndexListBytes,
        'membership-index-list-readback',
      );
      if (!cluster.ok) {
        terminalizeIdle(capture, cluster.error);
        return;
      }
      if (!index.ok) {
        terminalizeIdle(capture, index.error);
        return;
      }
      capture.indexReadbackBuffer = index.value;
    },
    recordMembershipOutput(output) {
      const capture = current;
      if (capture === undefined || options.mode !== 'cpu-control') return;
      capture.membership = output;
    },
    dispose() {
      disposed = true;
      const previous = current;
      if (previous !== undefined) {
        current = undefined;
        detached = previous;
      }
      for (const capture of pending) {
        settleError(
          capture,
          captureError(
            'capture-disposed',
            'active captures terminalize during disposal',
            'renderer was disposed',
          ),
        );
        if (!capture.asyncStarted && !capture.submitted) release(capture);
      }
    },
  };
  return controller;
}
