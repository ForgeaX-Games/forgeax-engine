import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type RenderError,
  RenderFeatureCapabilityMissingError,
  RenderFeatureRegistrationConflictError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import type {
  PreparedGraphicsReference,
  PreparedGraphicsResolvedSnapshot,
  PreparedGraphicsResolver,
  PreparedGraphicsResourceLease,
} from '../prepare/prepared-graphics-resolver';
import type {
  RenderFeatureContributionStaging,
  RenderFeatureGraphContribution,
  RenderFeatureGraphicsValidator,
} from './graph-contribution';
import { createRenderFeatureContributionStaging } from './graph-contribution';
import {
  createRenderFeatureGraphicsPrepare,
  type RenderFeatureGraphicsContributionStaging,
  type RenderFeatureGraphicsPrepare,
  validateRenderFeatureGraphicsPass,
} from './prepared-graphics';
import {
  createPreparedGraphicsStore,
  type PreparedGraphicsStore,
  type PreparedGraphicsTransaction,
} from './prepared-graphics-store';
import type {
  RenderFeature,
  RenderFeatureCapabilityKey,
  RenderFeatureCleanupFailure,
  RenderFeatureDiagnostics,
  RenderFeatureErrorDescriptor,
  RenderFeaturePrepareContext,
  RenderFeatureRecoverInput,
  RenderFeatureResourceHandle,
  RenderFeatureStatus,
} from './types';

export interface RenderFeatureStageEvent {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: 'extract' | 'prepare' | 'contribute';
}

export interface RenderFeatureFrameInput {
  readonly worlds: readonly import('@forgeax/engine-ecs').World[];
  readonly owner: number;
  readonly frameNumber: number;
  readonly generation?: number;
  readonly caps: Readonly<RhiCaps>;
  readonly createContributionStaging?: (
    featureIdentity: string,
    order: number,
    validateGraphics?: RenderFeatureGraphicsValidator,
    resolveGraphics?: import('./graph-contribution').RenderFeatureGraphicsResolver,
  ) => RenderFeatureContributionStaging & RenderFeatureGraphicsContributionStaging;
  readonly createPreparedGraphicsResolver?: (
    input: RenderFeaturePreparedGraphicsResolverInput,
  ) => PreparedGraphicsResolver;
}

export interface RenderFeaturePreparedGraphicsResolverInput {
  readonly featureIdentity: string;
  readonly order: number;
  readonly generation: number;
  readonly transaction: PreparedGraphicsTransaction;
  readonly lookup: (
    reference: import('./prepared-graphics').RenderFeaturePreparedRef,
  ) => import('./prepared-graphics-store').PreparedGraphicsItem | undefined;
}

export interface RenderFeatureFrameResult {
  readonly events: readonly string[];
  readonly stageEvents: readonly RenderFeatureStageEvent[];
  readonly errors: readonly RenderError[];
  readonly contributions: readonly RenderFeatureGraphContribution[];
  readonly preparedResourceBatches: readonly RenderFeaturePreparedResourceBatch[];
}

export interface RenderFeatureOwnedResource {
  readonly handle: RenderFeatureResourceHandle;
  readonly release: () => Result<void, RenderError>;
}

export interface RenderFeatureHost {
  readonly size: number;
  readonly features: readonly RenderFeature<unknown>[];
  readonly preparedGeneration: number;
  advancePreparedGeneration(): number;
  registerResource(
    identity: string,
    resource: RenderFeatureOwnedResource,
  ): Result<void, RenderError>;
  setStatus(
    identity: string,
    status: RenderFeatureStatus,
    latestError?: RenderFeatureErrorDescriptor,
  ): Result<void, RenderError>;
  /** Record a failure from active-graph execution against its owning slot. */
  recordError(identity: string, error: RenderError): RenderError;
  beginPreparedFrame(identity: string, generation: number): PreparedGraphicsTransaction | undefined;
  retainPreparedGraphics(
    identity: string,
    leases: readonly PreparedGraphicsResourceLease[],
  ): Result<RenderFeaturePreparedResourceBatch, RenderError>;
  /** Mark batches used by the just-recorded frame as protected by queue work. */
  markPreparedGraphicsSubmitted(batches: readonly RenderFeaturePreparedResourceBatch[]): void;
  /** Release completed batches, or all batches that were never submitted. */
  retirePreparedGraphics(
    batches?: readonly RenderFeaturePreparedResourceBatch[],
  ): Result<void, RenderError>;
  /** Release submitted batches when queue completion rejects and cannot prove completion. */
  recoverPreparedGraphics(
    batches: readonly RenderFeaturePreparedResourceBatch[],
  ): Result<void, RenderError>;
  recover(input: RenderFeatureRecoverInput): Result<void, RenderError>;
  diagnostics(): readonly RenderFeatureDiagnostics[];
  dispose(): Result<void, RenderError>;
}

export interface RenderFeaturePreparedResourceBatch {
  release(): Result<void, RenderError>;
}

/**
 * Resolve a submitted batch from queue completion without conflating promise
 * rejection with retirement failures. Rejection is treated as lost completion
 * evidence, so the host releases only batches still marked submitted.
 */
export function settlePreparedGraphicsCompletion(
  host: RenderFeatureHost,
  batches: readonly RenderFeaturePreparedResourceBatch[],
  completion: PromiseLike<unknown>,
  onError: (error: unknown) => void,
): void {
  const run = (operation: () => Result<void, RenderError>): void => {
    try {
      const result = operation();
      if (!result.ok) onError(result.error);
    } catch (error) {
      onError(error);
    }
  };

  void completion.then(
    () => run(() => host.retirePreparedGraphics(batches)),
    () => run(() => host.recoverPreparedGraphics(batches)),
  );
}

interface FeatureSlot {
  readonly feature: RenderFeature<unknown>;
  readonly order: number;
  readonly resources: RenderFeatureOwnedResource[];
  readonly preparedResourceBatches: Set<RenderFeaturePreparedResourceBatch>;
  readonly preparedStore: PreparedGraphicsStore;
  status: RenderFeatureStatus;
  latestError: RenderFeatureErrorDescriptor | undefined;
}

function freezeError(error: RenderFeatureErrorDescriptor): RenderFeatureErrorDescriptor {
  const detail = { ...error.detail } as RenderFeatureErrorDescriptor['detail'];
  if ('cleanupFailures' in detail && detail.cleanupFailures !== undefined) {
    (detail as { cleanupFailures: readonly RenderFeatureCleanupFailure[] }).cleanupFailures =
      Object.freeze([...detail.cleanupFailures]);
  }
  return Object.freeze({
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: Object.freeze(detail),
  }) as RenderFeatureErrorDescriptor;
}

function freezeDiagnostics(slot: FeatureSlot): RenderFeatureDiagnostics {
  return Object.freeze({
    identity: slot.feature.identity,
    order: slot.order,
    status: slot.status,
    latestError: slot.latestError === undefined ? undefined : freezeError(slot.latestError),
  });
}

function findSlot(slots: readonly FeatureSlot[], identity: string): FeatureSlot | undefined {
  return slots.find((slot) => slot.feature.identity === identity);
}

function registrationConflict(
  featureIdentity: string,
  order: number,
  conflictingOrder: number,
): RenderFeatureRegistrationConflictError {
  return new RenderFeatureRegistrationConflictError(featureIdentity, order, conflictingOrder);
}

function unknownFeatureError(
  identity: string,
  stage: 'recover' | 'dispose',
): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(identity, -1, stage, 'registration');
}

function missingCapability(
  feature: RenderFeature<unknown>,
  caps: Readonly<RhiCaps>,
): RenderFeatureCapabilityKey | undefined {
  return feature.requiredCapabilities?.find((capability) => caps[capability] !== true);
}

function lifecycleContext(input: RenderFeatureRecoverInput): RenderFeaturePrepareContext {
  return {
    caps: input.caps,
    frame: { frameNumber: input.frameNumber },
    resources: [],
    targets: [],
    reportError: { report: () => undefined },
    graphics: createRenderFeatureGraphicsPrepare('renderer.lifecycle', -1),
  };
}

function createPreparedGraphicsPrepare(
  transaction: PreparedGraphicsTransaction,
): RenderFeatureGraphicsPrepare {
  return {
    preparePipeline: (name, descriptor) => transaction.prepare('pipeline', name, descriptor),
    prepareBindings: (name, descriptor) => transaction.prepare('bindings', name, descriptor),
    prepareVertexData: (name, descriptor) => transaction.prepare('vertex-data', name, descriptor),
    prepareIndexData: (name, descriptor) => transaction.prepare('index-data', name, descriptor),
  };
}

function preparedGraphicsReferences(
  descriptor: import('./prepared-graphics').RenderFeatureGraphicsPassDescriptor,
): readonly PreparedGraphicsReference[] {
  return descriptor.draws.flatMap((draw) => [
    draw.pipeline,
    ...draw.bindings,
    ...draw.vertexData.map((vertex) => vertex.resource),
    ...(draw.indexData === undefined ? [] : [draw.indexData.resource]),
  ]);
}

function resolveGraphicsSnapshot(
  resolver: PreparedGraphicsResolver,
  descriptor: import('./prepared-graphics').RenderFeatureGraphicsPassDescriptor,
  generation: number,
): Result<PreparedGraphicsResolvedSnapshot, RenderError> {
  const resources = new Map<
    object,
    import('../prepare/prepared-graphics-resolver').PreparedGraphicsResolvedResource
  >();
  for (const reference of preparedGraphicsReferences(descriptor)) {
    if (resources.has(reference)) continue;
    const resolved = resolver.resolve(reference);
    if (!resolved.ok) return resolved;
    resources.set(reference, resolved.value);
  }
  return ok({
    generation,
    leases: resolver.leases,
    resolve: (reference) => resources.get(reference),
  });
}

function graphicsValidator(
  identity: string,
  transaction: PreparedGraphicsTransaction,
  capabilityAvailable: boolean,
): RenderFeatureGraphicsValidator {
  return (descriptor, resources) => {
    const attachments = [
      ...descriptor.attachments.colors
        .filter(
          (attachment) =>
            attachment.resource === 'swapchain' ||
            resources.some((resource) => resource.name === `${identity}::${attachment.resource}`),
        )
        .map((attachment) => ({ resource: attachment.resource, format: attachment.format })),
      ...(descriptor.attachments.depthStencil === undefined
        ? []
        : resources.some(
              (resource) =>
                resource.name === `${identity}::${descriptor.attachments.depthStencil?.resource}`,
            )
          ? [
              {
                resource: descriptor.attachments.depthStencil.resource,
                format: descriptor.attachments.depthStencil.format,
              },
            ]
          : []),
    ];
    const state = transaction.graphicsState(capabilityAvailable, attachments);
    const validated = validateRenderFeatureGraphicsPass(identity, descriptor, state);
    return validated.ok ? ok(state) : validated;
  };
}

function invokeLifecycle(
  slot: FeatureSlot,
  stage: 'recover' | 'dispose',
  input: RenderFeatureRecoverInput,
): Result<void, RenderError> {
  const callback = slot.feature[stage];
  if (callback === undefined) return ok(undefined);
  try {
    const result = callback(lifecycleContext(input));
    return result.ok ? result : err(result.error);
  } catch (_failure) {
    return err(
      new RenderFeatureStageFailedError(
        slot.feature.identity,
        slot.order,
        stage,
        'renderer-recover',
      ),
    );
  }
}

function releaseResource(
  slot: FeatureSlot,
  resource: RenderFeatureOwnedResource,
): Result<void, RenderError> {
  try {
    return resource.release();
  } catch {
    return err(unknownFeatureError(slot.feature.identity, 'dispose'));
  }
}

function cleanupErrorDescriptor(
  error: RenderError,
  slot: FeatureSlot,
): RenderFeatureCleanupFailure {
  return {
    featureIdentity: slot.feature.identity,
    order: slot.order,
    code: error.code,
  };
}

function withCleanupFailures(
  error: RenderError,
  cleanupFailures: readonly RenderFeatureCleanupFailure[],
): RenderError {
  if (cleanupFailures.length === 0 || error.code !== 'render-feature-stage-failed') return error;
  const detail = {
    ...error.detail,
    cleanupFailures: Object.freeze([...cleanupFailures]),
  };
  const wrapped = new RenderFeatureStageFailedError(
    detail.featureIdentity,
    detail.order,
    detail.stage,
    detail.recovery,
  );
  Object.defineProperty(wrapped, 'detail', { value: detail });
  return wrapped;
}

function asFeatureError(
  error: unknown,
  identity: string,
  order: number,
  stage: 'extract' | 'prepare' | 'contribute',
): RenderError {
  if (error instanceof Error && typeof (error as Partial<RenderError>).code === 'string') {
    return error as RenderError;
  }
  return new RenderFeatureStageFailedError(identity, order, stage, 'next-frame');
}

function featureErrorForSlot(slot: FeatureSlot, error: RenderError): RenderError {
  switch (error.code) {
    case 'render-feature-registration-conflict':
    case 'render-feature-stage-failed':
    case 'render-feature-capability-missing':
    case 'render-feature-pass-order-conflict':
      return error.detail.featureIdentity === slot.feature.identity
        ? error
        : new RenderFeatureStageFailedError(
            slot.feature.identity,
            slot.order,
            'contribute',
            'next-frame',
          );
    default:
      return new RenderFeatureStageFailedError(
        slot.feature.identity,
        slot.order,
        'contribute',
        'next-frame',
      );
  }
}

function errorDescriptor(error: RenderError): RenderFeatureErrorDescriptor {
  switch (error.code) {
    case 'render-feature-registration-conflict':
    case 'render-feature-stage-failed':
    case 'render-feature-capability-missing':
    case 'render-feature-pass-order-conflict':
      return {
        code: error.code,
        expected: error.expected,
        hint: error.hint,
        detail: { ...error.detail },
      } as RenderFeatureErrorDescriptor;
    default:
      return {
        code: 'render-feature-stage-failed',
        expected: error.expected,
        hint: error.hint,
        detail: {
          featureIdentity: 'unknown',
          order: -1,
          stage: 'contribute',
          recovery: 'next-frame',
        },
      };
  }
}

function recordFailure(
  slot: FeatureSlot,
  stage: 'extract' | 'prepare' | 'contribute',
  failure: unknown,
  errors: RenderError[],
): void {
  const error = asFeatureError(failure, slot.feature.identity, slot.order, stage);
  errors.push(error);
  slot.status = 'failed';
  slot.latestError = errorDescriptor(error);
}

function invokeStage<T>(
  slot: FeatureSlot,
  stage: RenderFeatureStageEvent['stage'],
  action: () => Result<T, RenderError>,
  events: string[],
  stageEvents: RenderFeatureStageEvent[],
  errors: RenderError[],
): Result<T, RenderError> {
  const identity = slot.feature.identity;
  events.push(`${identity}:${stage}`);
  stageEvents.push({ featureIdentity: identity, order: slot.order, stage });
  try {
    const result = action();
    if (result.ok) return result;
    recordFailure(slot, stage, result.error, errors);
    return err(result.error);
  } catch (failure) {
    recordFailure(slot, stage, failure, errors);
    return err(errors[errors.length - 1] as RenderError);
  }
}

class FeatureHostImpl implements RenderFeatureHost {
  private disposed = false;
  private generation = 0;
  private lastRecoveryFrame: number | undefined;
  private readonly preparedBatchStates = new WeakMap<
    RenderFeaturePreparedResourceBatch,
    'unsubmitted' | 'submitted'
  >();

  constructor(private readonly slots: FeatureSlot[]) {}

  get size(): number {
    return this.slots.length;
  }

  get preparedGeneration(): number {
    return this.generation;
  }

  get features(): readonly RenderFeature<unknown>[] {
    return this.slots.map((slot) => slot.feature);
  }

  advancePreparedGeneration(): number {
    if (this.disposed) return this.generation;
    this.generation += 1;
    for (const slot of this.slots) {
      slot.preparedStore.invalidate(slot.feature.identity, this.generation);
    }
    this.lastRecoveryFrame = undefined;
    return this.generation;
  }

  registerResource(
    identity: string,
    resource: RenderFeatureOwnedResource,
  ): Result<void, RenderError> {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') {
      return err(unknownFeatureError(identity, 'dispose'));
    }
    slot.resources.push(resource);
    return ok(undefined);
  }

  setStatus(
    identity: string,
    status: RenderFeatureStatus,
    latestError?: RenderFeatureErrorDescriptor,
  ): Result<void, RenderError> {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') {
      return err(unknownFeatureError(identity, 'recover'));
    }
    slot.status = status;
    slot.latestError = latestError === undefined ? undefined : freezeError(latestError);
    return ok(undefined);
  }

  recordError(identity: string, error: RenderError): RenderError {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') return error;
    const owned = featureErrorForSlot(slot, error);
    slot.status = 'failed';
    slot.latestError = errorDescriptor(owned);
    return owned;
  }

  beginPreparedFrame(
    identity: string,
    generation: number,
  ): PreparedGraphicsTransaction | undefined {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') return undefined;
    if (generation > this.generation) this.generation = generation;
    return slot.preparedStore.beginFrame(identity, this.generation);
  }

  retainPreparedGraphics(
    identity: string,
    leases: readonly PreparedGraphicsResourceLease[],
  ): Result<RenderFeaturePreparedResourceBatch, RenderError> {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') {
      return err(unknownFeatureError(identity, 'dispose'));
    }
    if (leases.length === 0) {
      return ok({ release: () => ok(undefined) });
    }
    let released = false;
    let batch!: RenderFeaturePreparedResourceBatch;
    batch = {
      release: () => {
        if (released) return ok(undefined);
        released = true;
        this.preparedBatchStates.delete(batch);
        slot.preparedResourceBatches.delete(batch);
        let firstError: RenderError | undefined;
        for (const lease of leases) {
          const result = lease.release();
          if (!result.ok && firstError === undefined) firstError = result.error;
        }
        return firstError === undefined ? ok(undefined) : err(firstError);
      },
    };
    this.preparedBatchStates.set(batch, 'unsubmitted');
    slot.preparedResourceBatches.add(batch);
    return ok(batch);
  }

  markPreparedGraphicsSubmitted(batches: readonly RenderFeaturePreparedResourceBatch[]): void {
    for (const batch of batches) {
      if (this.preparedBatchStates.get(batch) === 'unsubmitted') {
        this.preparedBatchStates.set(batch, 'submitted');
      }
    }
  }

  retirePreparedGraphics(
    batches?: readonly RenderFeaturePreparedResourceBatch[],
  ): Result<void, RenderError> {
    const owned = batches ?? this.slots.flatMap((slot) => [...slot.preparedResourceBatches]);
    let firstError: RenderError | undefined;
    for (const batch of owned) {
      const state = this.preparedBatchStates.get(batch);
      if (state === undefined || (batches === undefined && state === 'submitted')) continue;
      if (batches !== undefined && state !== 'submitted') continue;
      const result = batch.release();
      if (!result.ok && firstError === undefined) firstError = result.error;
    }
    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  recoverPreparedGraphics(
    batches: readonly RenderFeaturePreparedResourceBatch[],
  ): Result<void, RenderError> {
    let firstError: RenderError | undefined;
    for (const batch of batches) {
      if (this.preparedBatchStates.get(batch) !== 'submitted') continue;
      const result = batch.release();
      if (!result.ok && firstError === undefined) firstError = result.error;
    }
    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  recover(input: RenderFeatureRecoverInput): Result<void, RenderError> {
    if (this.disposed) return err(unknownFeatureError('render-feature-host', 'recover'));
    if (this.lastRecoveryFrame === input.frameNumber) return ok(undefined);
    const retired = this.retirePreparedGraphics();
    this.advancePreparedGeneration();
    this.lastRecoveryFrame = input.frameNumber;
    let firstError: RenderError | undefined = retired.ok ? undefined : retired.error;
    for (const slot of this.slots) {
      if (slot.status === 'disposed') continue;
      const missing = missingCapability(slot.feature, input.caps);
      if (missing !== undefined) {
        const error = new RenderFeatureCapabilityMissingError(
          slot.feature.identity,
          slot.order,
          missing,
        );
        slot.status = 'disabled';
        slot.latestError = errorDescriptor(error);
        if (firstError === undefined) firstError = error;
        continue;
      }
      const recovered = invokeLifecycle(slot, 'recover', input);
      if (!recovered.ok) {
        slot.status = 'failed';
        slot.latestError = errorDescriptor(recovered.error);
        if (firstError === undefined) firstError = recovered.error;
        continue;
      }
      slot.status = 'active';
      slot.latestError = undefined;
    }
    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  diagnostics(): readonly RenderFeatureDiagnostics[] {
    return Object.freeze(this.slots.map(freezeDiagnostics));
  }

  dispose(): Result<void, RenderError> {
    if (this.disposed) return ok(undefined);
    this.disposed = true;

    const retired = this.retirePreparedGraphics();
    let firstError: RenderError | undefined = retired.ok ? undefined : retired.error;
    const cleanupFailures: RenderFeatureCleanupFailure[] = [];
    for (const slot of this.slots) {
      for (const resource of slot.resources) {
        const result = releaseResource(slot, resource);
        if (!result.ok) {
          cleanupFailures.push(cleanupErrorDescriptor(result.error, slot));
          if (firstError === undefined) firstError = result.error;
        }
      }
      const disposed = invokeLifecycle(slot, 'dispose', {
        frameNumber: -1,
        caps: {} as never,
      });
      if (!disposed.ok) {
        cleanupFailures.push(cleanupErrorDescriptor(disposed.error, slot));
        if (firstError === undefined) firstError = disposed.error;
      }
      slot.resources.length = 0;
      slot.status = 'disposed';
    }

    return firstError === undefined
      ? ok(undefined)
      : err(withCleanupFailures(firstError, cleanupFailures));
  }
}

/**
 * Run the three typed stages once for every active feature.
 *
 * The feature value is kept in the slot closure: no heterogeneous FrameData
 * ledger or assertion is needed between callbacks. A failure ends only the
 * current slot and is retained in the host diagnostics projection.
 */
export function runRenderFeatureFrame(
  host: RenderFeatureHost,
  input: RenderFeatureFrameInput,
): RenderFeatureFrameResult {
  const events: string[] = [];
  const stageEvents: RenderFeatureStageEvent[] = [];
  const errors: RenderError[] = [];
  const contributions: RenderFeatureGraphContribution[] = [];
  const preparedResourceBatches: RenderFeaturePreparedResourceBatch[] = [];

  const diagnostics = host.diagnostics();
  for (const [order, feature] of host.features.entries()) {
    const diagnostic = diagnostics[order];
    if (diagnostic?.status === 'disabled' || diagnostic?.status === 'disposed') continue;
    const missing = missingCapability(feature, input.caps);
    if (missing !== undefined) {
      const capabilityError = new RenderFeatureCapabilityMissingError(
        feature.identity,
        order,
        missing,
      );
      errors.push(capabilityError);
      host.setStatus(feature.identity, 'disabled', errorDescriptor(capabilityError));
      continue;
    }
    const slot: FeatureSlot = {
      feature,
      order,
      resources: [],
      preparedResourceBatches: new Set(),
      preparedStore: createPreparedGraphicsStore(),
      status: 'active',
      latestError: undefined,
    };
    const identity = slot.feature.identity;
    const transaction = host.beginPreparedFrame(identity, input.generation ?? 0);
    if (transaction === undefined) continue;
    const graphics = createPreparedGraphicsPrepare(transaction);
    const validateGraphics = graphicsValidator(
      identity,
      transaction,
      missingCapability(feature, input.caps) === undefined,
    );
    let staging!: RenderFeatureContributionStaging & RenderFeatureGraphicsContributionStaging;
    const extracted = invokeStage(
      slot,
      'extract',
      () =>
        slot.feature.extract({
          worlds: input.worlds,
          owner: input.owner,
          frameNumber: input.frameNumber,
        }),
      events,
      stageEvents,
      errors,
    );
    if (!extracted.ok) {
      transaction.abort();
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }

    const prepared = invokeStage(
      slot,
      'prepare',
      () =>
        slot.feature.prepare(extracted.value, {
          caps: input.caps,
          frame: { frameNumber: input.frameNumber },
          resources: [],
          targets: [],
          reportError: { report: (error) => errors.push(error) },
          graphics,
        }),
      events,
      stageEvents,
      errors,
    );
    if (!prepared.ok) {
      transaction.abort();
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }

    const resolverInput: RenderFeaturePreparedGraphicsResolverInput = {
      featureIdentity: identity,
      order,
      generation: transaction.generation,
      transaction,
      lookup: (reference) =>
        [...transaction.overlayItems(), ...transaction.committedItems()].find(
          (item) => item.reference === reference,
        ),
    };
    const resolver = input.createPreparedGraphicsResolver?.(resolverInput);
    const resolveGraphics =
      resolver === undefined
        ? undefined
        : (descriptor: import('./prepared-graphics').RenderFeatureGraphicsPassDescriptor) => {
            const resolved = resolveGraphicsSnapshot(resolver, descriptor, transaction.generation);
            if (!resolved.ok) resolver.release();
            return resolved;
          };
    const releaseResolver = (): void => {
      if (resolver !== undefined) resolver.release();
    };
    staging =
      input.createContributionStaging?.(identity, order, validateGraphics, resolveGraphics) ??
      createRenderFeatureContributionStaging(identity, order, validateGraphics, resolveGraphics);

    const contributed = invokeStage(
      slot,
      'contribute',
      () =>
        slot.feature.contribute(extracted.value, {
          caps: input.caps,
          frame: { frameNumber: input.frameNumber },
          resources: [],
          targets: [],
          reportError: { report: (error) => errors.push(error) },
          graphics,
          staging,
        }),
      events,
      stageEvents,
      errors,
    );
    if (!contributed.ok) {
      staging?.abort();
      transaction.abort();
      releaseResolver();
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }
    if (staging !== undefined) {
      const committed = staging.commit();
      if (!committed.ok) {
        recordFailure(slot, 'contribute', committed.error, errors);
        transaction.abort();
        releaseResolver();
        host.setStatus(identity, 'failed', slot.latestError);
        continue;
      }
      const preparedCommit = transaction.commit();
      if (!preparedCommit.ok) {
        recordFailure(slot, 'contribute', preparedCommit.error, errors);
        releaseResolver();
        host.setStatus(identity, 'failed', slot.latestError);
        continue;
      }
      const leases = [
        ...new Set(committed.value.passes.flatMap((pass) => pass.resolvedGraphics?.leases ?? [])),
      ];
      const retained = host.retainPreparedGraphics(identity, leases);
      if (!retained.ok) {
        recordFailure(slot, 'contribute', retained.error, errors);
        releaseResolver();
        host.setStatus(identity, 'failed', slot.latestError);
        continue;
      }
      if (leases.length > 0) preparedResourceBatches.push(retained.value);
      if (committed.value.resources.length > 0 || committed.value.passes.length > 0) {
        contributions.push(committed.value);
      }
    }
    host.setStatus(identity, 'active');
  }

  return { events, stageEvents, errors, contributions, preparedResourceBatches };
}

/**
 * Validate identities before creating typed slots or accepting resources.
 * Registration order is the input order and is never sorted by feature kind.
 */
export function createRenderFeatureHost(
  features: readonly RenderFeature<unknown>[],
  _caps?: Readonly<RhiCaps>,
): Result<RenderFeatureHost, RenderError> {
  const identities = new Map<string, number>();
  for (const [order, feature] of features.entries()) {
    const conflictingOrder = identities.get(feature.identity);
    if (conflictingOrder !== undefined) {
      return err(registrationConflict(feature.identity, order, conflictingOrder));
    }
    identities.set(feature.identity, order);
  }

  const slots: FeatureSlot[] = features.map((feature, order) => ({
    feature,
    order,
    resources: [],
    preparedResourceBatches: new Set(),
    preparedStore: createPreparedGraphicsStore(),
    status: 'active',
    latestError: undefined,
  }));
  return ok(new FeatureHostImpl(slots));
}
