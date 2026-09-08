import type { EntityHandle } from '@forgeax/engine-ecs';
import type { RhiCaps, TextureFormat } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type RenderError,
  RenderFeatureCapabilityMissingError,
  RenderFeaturePreparationFailedError,
  RenderFeatureRegistrationConflictError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import type {
  PreparedGraphicsReference,
  PreparedGraphicsResolvedSnapshot,
  PreparedGraphicsResolver,
  PreparedGraphicsResourceLease,
} from '../prepare/prepared-graphics-resolver';
import {
  freezeRenderFeaturePlan,
  type RenderFeatureLogicalTarget,
  type RenderFeatureMaterialShaderBindingContract,
  type RenderFeaturePassDeclaration,
  type RenderFeaturePlan,
  type RenderFeaturePlannedFrame,
  type RenderFeatureResourceDeclaration,
  renderFeaturePlanSignature,
} from './plan';
import type {
  RenderFeatureGpuBindingsRef,
  RenderFeatureGpuBufferRef,
  RenderFeatureGpuComputePassDescriptor,
  RenderFeatureGpuPrepareSession,
  RenderFeatureGpuProgramRef,
  RenderFeatureGpuWorkOwner,
} from './prepared-gpu-work';
import {
  type RenderFeatureGraphicsPassDescriptor,
  type RenderFeatureGraphicsPrepare,
  type RenderFeaturePreparedGraphicsState,
  type RenderFeaturePreparedRef,
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
  RenderFeatureExtractContext,
  RenderFeatureHiddenEntityReport,
  RenderFeatureRecoverInput,
  RenderFeatureStatus,
  RenderFeatureTargetHandle,
  RenderFeatureWorldVisibilitySnapshot,
} from './types';

const planExecutionProjections = new WeakMap<
  RenderFeaturePlannedFrame,
  RenderFeaturePlanExecution
>();

export interface RenderFeaturePlanExecutionPass {
  readonly featureIdentity: string;
  readonly order: number;
  readonly name: string;
  readonly graphics?: RenderFeatureGraphicsPassDescriptor;
  readonly graphicsState?: RenderFeaturePreparedGraphicsState;
  readonly gpuCompute?: RenderFeatureGpuComputePassDescriptor;
  readonly resolvedGraphics?: PreparedGraphicsResolvedSnapshot;
  readonly resolvedGpuCompute?: import('./prepared-gpu-work').RenderFeatureResolvedGpuComputePass;
}

/** Host-owned device projection of one frozen plan; graph access is derived later. */
export interface RenderFeaturePlanExecution {
  readonly featureIdentity: string;
  readonly order: number;
  readonly passes: readonly RenderFeaturePlanExecutionPass[];
}

/** @internal Typed-graph adapter for the host-owned projection of a validated plan. */
export function getRenderFeaturePlanExecutionProjection(
  planned: RenderFeaturePlannedFrame,
): RenderFeaturePlanExecution | undefined {
  return planExecutionProjections.get(planned);
}

export interface RenderFeatureStageEvent {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: 'extract' | 'plan';
}

export interface RenderFeatureFrameInput {
  readonly worlds: readonly import('@forgeax/engine-ecs').World[];
  readonly owner: number;
  readonly frameNumber: number;
  readonly visibilitySnapshots?: readonly RenderFeatureWorldVisibilitySnapshot[];
  readonly hiddenEntityReports?: readonly RenderFeatureHiddenEntityReport[];
  /** Active-pipeline logical targets available to producer-owned features. */
  readonly targets?: readonly RenderFeatureTargetHandle[];
  readonly generation?: number;
  readonly caps: Readonly<RhiCaps>;
  /** Renderer-owned material binding contract projection for producer plans. */
  readonly materialShaderBindingContract?: (
    materialShaderId: string,
  ) => RenderFeatureMaterialShaderBindingContract;
  readonly createPreparedGraphicsResolver?: (
    input: RenderFeaturePreparedGraphicsResolverInput,
  ) => PreparedGraphicsResolver;
  /** Single renderer-owned GPU preparation owner for all feature sessions. */
  readonly gpuWork?: RenderFeatureGpuWorkOwner;
}

export interface RenderFeaturePreparedGraphicsResolverInput {
  readonly featureIdentity: string;
  readonly order: number;
  readonly generation: number;
  readonly transaction: PreparedGraphicsTransaction;
  readonly fullscreenEffects: ReadonlyMap<string, PostProcessShaderEntry>;
  readonly lookup: (
    reference: import('./prepared-graphics').RenderFeaturePreparedRef,
  ) => import('./prepared-graphics-store').PreparedGraphicsItem | undefined;
}

export interface RenderFeatureFrameResult {
  readonly stageEvents: readonly RenderFeatureStageEvent[];
  readonly errors: readonly RenderError[];
  readonly plans: readonly RenderFeaturePlannedFrame[];
  readonly fullscreenEffects: ReadonlyMap<string, PostProcessShaderEntry>;
  readonly preparedResourceBatches: readonly RenderFeaturePreparedResourceBatch[];
  readonly hiddenEntityReports: readonly RenderFeatureHiddenEntityReport[];
}

export interface RenderFeatureHost {
  readonly size: number;
  readonly features: readonly RenderFeature<unknown>[];
  readonly preparedGeneration: number;
  /** Install a producer after renderer creation; same object identity is idempotent. */
  install(feature: RenderFeature<unknown>): Result<void, RenderError>;
  /** Remove one installed producer and release every resource it owns. */
  uninstall(feature: RenderFeature<unknown>): Result<void, RenderError>;
  advancePreparedGeneration(): number;
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
  /** Subscribe to lifecycle projection changes; unchanged active frames are silent. */
  subscribeDiagnostics(listener: () => void): () => void;
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
  order: number;
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
    ...(resolver.resolveGpuBuffer === undefined
      ? {}
      : { resolveGpuBuffer: resolver.resolveGpuBuffer }),
  });
}

function graphicsValidator(
  identity: string,
  transaction: PreparedGraphicsTransaction,
  capabilityAvailable: boolean,
): (
  descriptor: RenderFeatureGraphicsPassDescriptor,
  resources: readonly { readonly name: string }[],
) => Result<RenderFeaturePreparedGraphicsState, RenderError> {
  return (descriptor, resources) => {
    const attachments = [
      ...descriptor.attachments.colors
        .filter(
          (attachment) =>
            typeof attachment.resource !== 'string' ||
            attachment.resource === 'swapchain' ||
            resources.some((resource) => resource.name === `${identity}::${attachment.resource}`),
        )
        .map((attachment) => ({ resource: attachment.resource, format: attachment.format })),
      ...(descriptor.attachments.depthStencil === undefined
        ? []
        : resources.some(
              (resource) =>
                resource.name === `${identity}::${descriptor.attachments.depthStencil?.resource}`,
            ) || typeof descriptor.attachments.depthStencil.resource !== 'string'
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

function asFeatureError(
  error: unknown,
  identity: string,
  order: number,
  stage: 'extract' | 'plan',
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
    case 'render-feature-preparation-failed':
    case 'render-feature-prepared-state-mismatch':
    case 'render-feature-draw-recording-failed':
      return error.detail.featureIdentity === slot.feature.identity
        ? error
        : new RenderFeatureStageFailedError(
            slot.feature.identity,
            slot.order,
            'plan',
            'next-frame',
          );
    default:
      return new RenderFeatureStageFailedError(
        slot.feature.identity,
        slot.order,
        'plan',
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
    case 'render-feature-preparation-failed':
    case 'render-feature-prepared-state-mismatch':
    case 'render-feature-draw-recording-failed':
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
          stage: 'plan',
          recovery: 'next-frame',
        },
      };
  }
}

function recordFailure(
  slot: FeatureSlot,
  stage: 'extract' | 'plan',
  failure: unknown,
  errors: RenderError[],
): void {
  const error = asFeatureError(failure, slot.feature.identity, slot.order, stage);
  errors.push(error);
  slot.status = 'failed';
  slot.latestError = errorDescriptor(error);
}

function logicalTargets(
  targets: readonly RenderFeatureTargetHandle[],
): readonly RenderFeatureLogicalTarget[] {
  return Object.freeze(
    targets.map((target) => ({
      name: target.kind === 'scene-color' ? 'color' : 'depth',
      kind: target.kind === 'scene-color' ? ('color' as const) : ('depth' as const),
      format: target.format,
      sampleCount: target.sampleCount,
    })),
  );
}

interface PreparedPlanResources {
  readonly computePrograms: ReadonlyMap<string, RenderFeatureGpuProgramRef>;
  readonly graphicsPrograms: ReadonlyMap<string, RenderFeaturePreparedRef<'pipeline'>>;
  readonly buffers: ReadonlyMap<string, RenderFeatureGpuBufferRef>;
  readonly computeBindings: ReadonlyMap<string, RenderFeatureGpuBindingsRef>;
  readonly graphicsBindings: ReadonlyMap<string, RenderFeaturePreparedRef<'bindings'>>;
  readonly vertexData: ReadonlyMap<string, RenderFeaturePreparedRef<'vertex-data'>>;
  readonly indexData: ReadonlyMap<string, RenderFeaturePreparedRef<'index-data'>>;
}

function planFailure(slot: FeatureSlot): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(slot.feature.identity, slot.order, 'plan', 'next-frame');
}

function targetHandle(
  name: string,
  targets: readonly RenderFeatureTargetHandle[],
): string | RenderFeatureTargetHandle | undefined {
  if (name === 'swapchain') return 'swapchain';
  return targets.find(
    (target) =>
      (name === 'color' && target.kind === 'scene-color') ||
      (name === 'depth' && target.kind === 'scene-depth'),
  );
}

function targetFormat(
  name: string,
  targets: readonly RenderFeatureLogicalTarget[],
  fallback: string | undefined,
): TextureFormat | undefined {
  const target = targets.find((candidate) => candidate.name === name);
  return (target?.format ?? fallback) as TextureFormat | undefined;
}

function preparePlanResources(
  slot: FeatureSlot,
  plan: RenderFeaturePlan,
  graphics: RenderFeatureGraphicsPrepare,
  gpu: RenderFeatureGpuPrepareSession | undefined,
  targets: readonly RenderFeatureTargetHandle[],
): Result<PreparedPlanResources, RenderError> {
  const computePrograms = new Map<string, RenderFeatureGpuProgramRef>();
  const graphicsPrograms = new Map<string, RenderFeaturePreparedRef<'pipeline'>>();
  const buffers = new Map<string, RenderFeatureGpuBufferRef>();
  const computeBindings = new Map<string, RenderFeatureGpuBindingsRef>();
  const graphicsBindings = new Map<string, RenderFeaturePreparedRef<'bindings'>>();
  const vertexData = new Map<string, RenderFeaturePreparedRef<'vertex-data'>>();
  const indexData = new Map<string, RenderFeaturePreparedRef<'index-data'>>();
  const byKind = <Kind extends RenderFeatureResourceDeclaration['kind']>(kind: Kind) =>
    plan.resources.filter(
      (resource): resource is Extract<RenderFeatureResourceDeclaration, { readonly kind: Kind }> =>
        resource.kind === kind,
    );

  if (
    gpu === undefined &&
    plan.resources.some((resource) =>
      ['compute-program', 'buffer', 'compute-bindings'].includes(resource.kind),
    )
  ) {
    return err(planFailure(slot));
  }
  for (const resource of byKind('compute-program')) {
    const prepared = gpu?.prepareProgram(resource.name, resource.program);
    if (prepared === undefined) return err(planFailure(slot));
    if (!prepared.ok) return prepared;
    computePrograms.set(resource.name, prepared.value);
  }
  for (const resource of byKind('graphics-program')) {
    const prepared = graphics.preparePipeline(resource.name, resource.program);
    if (!prepared.ok) return prepared;
    graphicsPrograms.set(resource.name, prepared.value);
  }
  for (const resource of byKind('buffer')) {
    const prepared = gpu?.prepareBuffer(resource.name, {
      size: resource.size,
      usage: resource.usage,
      ...(resource.data === undefined ? {} : { data: resource.data }),
    });
    if (prepared === undefined) return err(planFailure(slot));
    if (!prepared.ok) return prepared;
    buffers.set(resource.name, prepared.value);
  }
  for (const resource of byKind('compute-bindings')) {
    const program = computePrograms.get(resource.program);
    const entries = resource.entries.map((entry) => ({
      binding: entry.binding,
      buffer: buffers.get(entry.resource),
    }));
    if (program === undefined || entries.some((entry) => entry.buffer === undefined)) {
      return err(planFailure(slot));
    }
    const prepared = gpu?.prepareBindings(resource.name, {
      program,
      entries: entries.map((entry) => ({
        binding: entry.binding,
        buffer: entry.buffer as RenderFeatureGpuBufferRef,
      })),
    });
    if (prepared === undefined) return err(planFailure(slot));
    if (!prepared.ok) return prepared;
    computeBindings.set(resource.name, prepared.value);
  }
  for (const resource of byKind('graphics-bindings')) {
    const program = graphicsPrograms.get(resource.program);
    if (program === undefined) return err(planFailure(slot));
    const values: Record<string, unknown> = { ...resource.values };
    for (const [key, targetName] of Object.entries(resource.logicalTargets ?? {})) {
      const target = targetHandle(targetName, targets);
      if (target === undefined || typeof target === 'string') return err(planFailure(slot));
      values[key] = target;
    }
    const prepared = graphics.prepareBindings(resource.name, { pipeline: program, values });
    if (!prepared.ok) return prepared;
    graphicsBindings.set(resource.name, prepared.value);
  }
  for (const resource of byKind('vertex-data')) {
    const descriptor =
      resource.buffer === undefined
        ? { layout: resource.layout, data: resource.data }
        : { layout: resource.layout, buffer: buffers.get(resource.buffer) };
    if ('buffer' in descriptor && descriptor.buffer === undefined) return err(planFailure(slot));
    const prepared = graphics.prepareVertexData(
      resource.name,
      descriptor as import('./prepared-graphics').RenderFeatureVertexDataDescriptor,
    );
    if (!prepared.ok) return prepared;
    vertexData.set(resource.name, prepared.value);
  }
  for (const resource of byKind('index-data')) {
    const descriptor =
      resource.buffer === undefined
        ? { format: resource.format, data: resource.data }
        : { format: resource.format, buffer: buffers.get(resource.buffer) };
    if ('buffer' in descriptor && descriptor.buffer === undefined) return err(planFailure(slot));
    const prepared = graphics.prepareIndexData(
      resource.name,
      descriptor as import('./prepared-graphics').RenderFeatureIndexDataDescriptor,
    );
    if (!prepared.ok) return prepared;
    indexData.set(resource.name, prepared.value);
  }
  return ok({
    computePrograms,
    graphicsPrograms,
    buffers,
    computeBindings,
    graphicsBindings,
    vertexData,
    indexData,
  });
}

function projectDraw(
  slot: FeatureSlot,
  draw: Extract<RenderFeaturePassDeclaration, { readonly kind: 'raster' }>['draws'][number],
  prepared: PreparedPlanResources,
): Result<import('./prepared-graphics').RenderFeatureDrawRecord, RenderError> {
  const pipeline = prepared.graphicsPrograms.get(draw.program);
  const bindings = draw.bindings.map((name) => prepared.graphicsBindings.get(name));
  const vertexData = draw.vertexData.map((entry) => ({
    slot: entry.slot,
    resource: prepared.vertexData.get(entry.resource),
  }));
  const indexData =
    draw.indexData === undefined
      ? undefined
      : {
          resource: prepared.indexData.get(draw.indexData.resource),
          format: draw.indexData.format,
        };
  if (
    pipeline === undefined ||
    bindings.some((binding) => binding === undefined) ||
    vertexData.some((vertex) => vertex.resource === undefined) ||
    (indexData !== undefined && indexData.resource === undefined)
  ) {
    return err(planFailure(slot));
  }
  const common = {
    pipeline,
    bindings: bindings as readonly RenderFeaturePreparedRef<'bindings'>[],
    vertexData: vertexData as readonly {
      readonly slot: number;
      readonly resource: RenderFeaturePreparedRef<'vertex-data'>;
    }[],
    ...(draw.vertexLayout === undefined ? {} : { vertexLayout: draw.vertexLayout }),
  };
  switch (draw.draw.kind) {
    case 'draw':
      return ok({
        kind: 'draw',
        ...common,
        ...(indexData === undefined
          ? {}
          : {
              indexData: {
                resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                format: indexData.format,
              },
            }),
        command: {
          vertexCount: draw.draw.vertexCount,
          instanceCount: draw.draw.instanceCount,
          ...(draw.draw.firstVertex === undefined ? {} : { firstVertex: draw.draw.firstVertex }),
          ...(draw.draw.firstInstance === undefined
            ? {}
            : { firstInstance: draw.draw.firstInstance }),
        },
      });
    case 'draw-indexed':
      return ok({
        kind: 'draw-indexed',
        ...common,
        indexData:
          indexData === undefined
            ? undefined
            : {
                resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                format: indexData.format,
              },
        command: {
          indexCount: draw.draw.indexCount,
          instanceCount: draw.draw.instanceCount,
          ...(draw.draw.firstIndex === undefined ? {} : { firstIndex: draw.draw.firstIndex }),
          ...(draw.draw.baseVertex === undefined ? {} : { baseVertex: draw.draw.baseVertex }),
          ...(draw.draw.firstInstance === undefined
            ? {}
            : { firstInstance: draw.draw.firstInstance }),
        },
      });
    case 'draw-indirect':
    case 'draw-indexed-indirect': {
      const buffer = prepared.buffers.get(draw.draw.resource);
      if (buffer === undefined) return err(planFailure(slot));
      const command = {
        buffer,
        ...(draw.draw.offset === undefined ? {} : { offset: draw.draw.offset }),
      };
      if (draw.draw.kind === 'draw-indexed-indirect') {
        return ok({
          kind: 'draw-indexed-indirect',
          ...common,
          indexData:
            indexData === undefined
              ? undefined
              : {
                  resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                  format: indexData.format,
                },
          command,
        });
      }
      return ok({
        kind: 'draw-indirect',
        ...common,
        ...(indexData === undefined
          ? {}
          : {
              indexData: {
                resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                format: indexData.format,
              },
            }),
        command,
      });
    }
  }
}

function projectPlanPasses(
  slot: FeatureSlot,
  plan: RenderFeaturePlan,
  prepared: PreparedPlanResources,
  gpu: RenderFeatureGpuPrepareSession | undefined,
  targets: readonly RenderFeatureTargetHandle[],
  validateGraphics: (
    descriptor: RenderFeatureGraphicsPassDescriptor,
    resources: readonly { readonly name: string }[],
  ) => Result<RenderFeaturePreparedGraphicsState, RenderError>,
  resolveGraphics?: (
    descriptor: RenderFeatureGraphicsPassDescriptor,
  ) => Result<PreparedGraphicsResolvedSnapshot, RenderError> | undefined,
): Result<RenderFeaturePlanExecution, RenderError> {
  const logical = logicalTargets(targets);
  const projected: RenderFeaturePlanExecutionPass[] = [];
  for (const pass of plan.passes) {
    if (pass.kind === 'compute') {
      const program = prepared.computePrograms.get(pass.program);
      const bindings = prepared.computeBindings.get(pass.bindings);
      if (program === undefined || bindings === undefined) return err(planFailure(slot));
      const descriptor: RenderFeatureGpuComputePassDescriptor = {
        program,
        bindings,
        dispatches: pass.dispatches.map((dispatch) =>
          dispatch.kind === 'direct'
            ? {
                entryPoint: dispatch.entryPoint,
                bindings,
                workgroups: dispatch.workgroups,
              }
            : {
                entryPoint: dispatch.entryPoint,
                bindings,
                indirect: {
                  buffer: prepared.buffers.get(dispatch.resource) as RenderFeatureGpuBufferRef,
                  offset: dispatch.offset,
                },
              },
        ),
      };
      if (
        descriptor.dispatches.some(
          (dispatch) => dispatch.indirect !== undefined && dispatch.indirect.buffer === undefined,
        )
      ) {
        return err(planFailure(slot));
      }
      const resolved = gpu?.resolveComputePass(slot.feature.identity, descriptor);
      if (resolved === undefined) return err(planFailure(slot));
      if (!resolved.ok) return resolved;
      projected.push({
        featureIdentity: slot.feature.identity,
        order: slot.order,
        name: pass.name,
        gpuCompute: descriptor,
        resolvedGpuCompute: resolved.value,
      });
      continue;
    }

    const draws: import('./prepared-graphics').RenderFeatureDrawRecord[] = [];
    for (const draw of pass.draws) {
      const projected = projectDraw(slot, draw, prepared);
      if (!projected.ok) return projected;
      draws.push(projected.value);
    }
    const fallbackFormat = (() => {
      const firstProgram = prepared.graphicsPrograms.get(pass.draws[0]?.program ?? '');
      const declaration = plan.resources.find(
        (resource) =>
          resource.kind === 'graphics-program' &&
          prepared.graphicsPrograms.get(resource.name) === firstProgram,
      );
      return declaration?.kind === 'graphics-program'
        ? declaration.program.colorFormats[0]
        : undefined;
    })();
    const colors = pass.colorAttachments.map((attachment) => ({
      resource: targetHandle(attachment.target, targets),
      format: targetFormat(attachment.target, logical, fallbackFormat),
      loadOp: attachment.loadOp,
      storeOp: attachment.storeOp,
    }));
    const depth =
      pass.depthStencilAttachment === undefined
        ? undefined
        : {
            resource: targetHandle(pass.depthStencilAttachment.target, targets),
            format: targetFormat(pass.depthStencilAttachment.target, logical, undefined),
            depthLoadOp: pass.depthStencilAttachment.depthLoadOp,
            depthStoreOp: pass.depthStencilAttachment.depthStoreOp,
          };
    const sampledTargets = (pass.sampledTargets ?? []).map((name) => targetHandle(name, targets));
    if (
      colors.some(
        (attachment) => attachment.resource === undefined || attachment.format === undefined,
      ) ||
      (depth !== undefined && (depth.resource === undefined || depth.format === undefined)) ||
      sampledTargets.some((target) => target === undefined || typeof target === 'string')
    ) {
      return err(planFailure(slot));
    }
    const attachments: RenderFeatureGraphicsPassDescriptor['attachments'] =
      depth === undefined
        ? { colors: colors as RenderFeatureGraphicsPassDescriptor['attachments']['colors'] }
        : {
            colors: colors as RenderFeatureGraphicsPassDescriptor['attachments']['colors'],
            depthStencil: depth as NonNullable<
              RenderFeatureGraphicsPassDescriptor['attachments']['depthStencil']
            >,
          };
    const descriptor: RenderFeatureGraphicsPassDescriptor = {
      attachments,
      ...(sampledTargets.length === 0
        ? {}
        : {
            sampledTargets: sampledTargets as readonly RenderFeatureTargetHandle[],
          }),
      draws,
    };
    const graphicsState = validateGraphics(descriptor, []);
    if (!graphicsState.ok) return graphicsState;
    const resolved = resolveGraphics?.(descriptor);
    if (
      resolved !== undefined &&
      !resolved.ok &&
      resolved.error instanceof RenderFeaturePreparationFailedError &&
      resolved.error.detail.reason === 'pipeline-pending'
    ) {
      continue;
    }
    if (resolved !== undefined && !resolved.ok) return resolved;
    projected.push({
      featureIdentity: slot.feature.identity,
      order: slot.order,
      name: pass.name,
      graphics: descriptor,
      graphicsState: graphicsState.value,
      ...(resolved?.ok === true ? { resolvedGraphics: resolved.value } : {}),
    });
  }
  return ok({
    featureIdentity: slot.feature.identity,
    order: slot.order,
    passes: Object.freeze(projected),
  });
}

function invokeStage<T>(
  slot: FeatureSlot,
  stage: RenderFeatureStageEvent['stage'],
  action: () => Result<T, RenderError>,
  stageEvents: RenderFeatureStageEvent[],
  errors: RenderError[],
): Result<T, RenderError> {
  const identity = slot.feature.identity;
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
  private readonly diagnosticsListeners = new Set<() => void>();
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

  private publishDiagnosticsChanged(): void {
    for (const listener of this.diagnosticsListeners) {
      try {
        listener();
      } catch {
        // Diagnostics are a projection of renderer state. An observer failure
        // must not alter an already-applied feature lifecycle transition.
      }
    }
  }

  install(feature: RenderFeature<unknown>): Result<void, RenderError> {
    if (this.disposed) return err(unknownFeatureError(feature.identity, 'dispose'));
    const existingOrder = this.slots.findIndex(
      (slot) => slot.feature.identity === feature.identity,
    );
    if (existingOrder >= 0) {
      const existing = this.slots[existingOrder];
      if (existing?.feature === feature) return ok(undefined);
      return err(registrationConflict(feature.identity, this.slots.length, existingOrder));
    }
    this.slots.push({
      feature,
      order: this.slots.length,
      preparedResourceBatches: new Set(),
      preparedStore: createPreparedGraphicsStore(),
      status: 'active',
      latestError: undefined,
    });
    this.publishDiagnosticsChanged();
    return ok(undefined);
  }

  uninstall(feature: RenderFeature<unknown>): Result<void, RenderError> {
    if (this.disposed) return err(unknownFeatureError(feature.identity, 'dispose'));
    const index = this.slots.findIndex((slot) => slot.feature === feature);
    if (index < 0) return ok(undefined);
    const slot = this.slots[index];
    if (slot === undefined) return ok(undefined);

    let firstError: RenderError | undefined;
    for (const batch of slot.preparedResourceBatches) {
      const result = batch.release();
      if (!result.ok && firstError === undefined) firstError = result.error;
    }
    slot.status = 'disposed';
    this.slots.splice(index, 1);
    for (const [order, remaining] of this.slots.entries()) remaining.order = order;
    this.publishDiagnosticsChanged();
    return firstError === undefined ? ok(undefined) : err(firstError);
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

  setStatus(
    identity: string,
    status: RenderFeatureStatus,
    latestError?: RenderFeatureErrorDescriptor,
  ): Result<void, RenderError> {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') {
      return err(unknownFeatureError(identity, 'recover'));
    }
    if (slot.status === status && slot.latestError === undefined && latestError === undefined) {
      return ok(undefined);
    }
    slot.status = status;
    slot.latestError = latestError === undefined ? undefined : freezeError(latestError);
    this.publishDiagnosticsChanged();
    return ok(undefined);
  }

  recordError(identity: string, error: RenderError): RenderError {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') return error;
    const owned = featureErrorForSlot(slot, error);
    slot.status = 'failed';
    slot.latestError = errorDescriptor(owned);
    this.publishDiagnosticsChanged();
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
    let diagnosticsChanged = false;
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
        diagnosticsChanged = true;
        if (firstError === undefined) firstError = error;
        continue;
      }
      if (slot.status !== 'active' || slot.latestError !== undefined) {
        slot.status = 'active';
        slot.latestError = undefined;
        diagnosticsChanged = true;
      }
    }
    if (diagnosticsChanged) this.publishDiagnosticsChanged();
    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  diagnostics(): readonly RenderFeatureDiagnostics[] {
    return Object.freeze(this.slots.map(freezeDiagnostics));
  }

  subscribeDiagnostics(listener: () => void): () => void {
    this.diagnosticsListeners.add(listener);
    return () => this.diagnosticsListeners.delete(listener);
  }

  dispose(): Result<void, RenderError> {
    if (this.disposed) return ok(undefined);
    this.disposed = true;

    const retired = this.retirePreparedGraphics();
    const firstError: RenderError | undefined = retired.ok ? undefined : retired.error;
    for (const slot of this.slots) {
      slot.status = 'disposed';
    }
    this.publishDiagnosticsChanged();
    this.diagnosticsListeners.clear();

    return firstError === undefined ? ok(undefined) : err(firstError);
  }
}

/** Build and project the mandatory plan once for every active feature. */
export function runRenderFeatureFrame(
  host: RenderFeatureHost,
  input: RenderFeatureFrameInput,
): RenderFeatureFrameResult {
  const stageEvents: RenderFeatureStageEvent[] = [];
  const errors: RenderError[] = [];
  const plans: RenderFeaturePlannedFrame[] = [];
  const fullscreenEffects = new Map<string, PostProcessShaderEntry>();
  const preparedResourceBatches: RenderFeaturePreparedResourceBatch[] = [];
  const hiddenEntityReports: RenderFeatureHiddenEntityReport[] = [
    ...(input.hiddenEntityReports ?? []),
  ];

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
      preparedResourceBatches: new Set(),
      preparedStore: createPreparedGraphicsStore(),
      status: 'active',
      latestError: undefined,
    };
    const identity = slot.feature.identity;
    const transaction = host.beginPreparedFrame(identity, input.generation ?? 0);
    if (transaction === undefined) continue;
    const graphics = createPreparedGraphicsPrepare(transaction);
    const gpu: RenderFeatureGpuPrepareSession | undefined = input.gpuWork?.beginFeature(
      identity,
      input.generation ?? 0,
    );
    const featureHiddenEntityReports: RenderFeatureHiddenEntityReport[] = [];
    const extractContext = {
      worlds: input.worlds,
      owner: input.owner,
      frameNumber: input.frameNumber,
      reportHiddenEntity: (report) => featureHiddenEntityReports.push(report),
      ...(input.visibilitySnapshots === undefined
        ? {}
        : { visibilitySnapshots: input.visibilitySnapshots }),
    } satisfies RenderFeatureExtractContext;
    const extracted = invokeStage(
      slot,
      'extract',
      () => slot.feature.extract(extractContext),
      stageEvents,
      errors,
    );
    if (!extracted.ok) {
      transaction.abort();
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }

    const targets = logicalTargets(input.targets ?? []);
    const declared = invokeStage(
      slot,
      'plan',
      () =>
        feature.plan(extracted.value, {
          caps: input.caps,
          frame: { frameNumber: input.frameNumber },
          generation: transaction.generation,
          targets,
          ...(input.materialShaderBindingContract === undefined
            ? {}
            : { materialShaderBindingContract: input.materialShaderBindingContract }),
        }),
      stageEvents,
      errors,
    );
    if (!declared.ok) {
      transaction.abort();
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }
    const frozen = freezeRenderFeaturePlan(identity, declared.value, targets);
    if (!frozen.ok) {
      recordFailure(slot, 'plan', frozen.error, errors);
      transaction.abort();
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }
    const plannedFrame: RenderFeaturePlannedFrame = Object.freeze({
      featureIdentity: identity,
      generation: transaction.generation,
      signature: renderFeaturePlanSignature(frozen.value),
      plan: frozen.value,
    });
    for (const resource of frozen.value.resources) {
      if (resource.kind !== 'fullscreen-program') continue;
      fullscreenEffects.set(identity, {
        source: resource.source,
        ...(resource.reads === undefined ? {} : { reads: resource.reads }),
        ...(resource.params === undefined ? {} : { params: resource.params }),
      });
    }
    const prepared = preparePlanResources(slot, frozen.value, graphics, gpu, input.targets ?? []);
    if (!prepared.ok) {
      recordFailure(slot, 'plan', prepared.error, errors);
      transaction.abort();
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }
    const validateGraphics = graphicsValidator(identity, transaction, true);

    const resolverInput: RenderFeaturePreparedGraphicsResolverInput = {
      featureIdentity: identity,
      order,
      generation: transaction.generation,
      transaction,
      fullscreenEffects,
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
    const projected = projectPlanPasses(
      slot,
      frozen.value,
      prepared.value,
      gpu,
      input.targets ?? [],
      validateGraphics,
      resolveGraphics,
    );
    if (!projected.ok) {
      recordFailure(slot, 'plan', projected.error, errors);
      transaction.abort();
      releaseResolver();
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }
    const preparedCommit = transaction.commit();
    if (!preparedCommit.ok) {
      recordFailure(slot, 'plan', preparedCommit.error, errors);
      releaseResolver();
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }
    const leases = [
      ...new Set(projected.value.passes.flatMap((pass) => pass.resolvedGraphics?.leases ?? [])),
      ...(gpu?.retireUntouched() ?? []),
    ];
    const retained = host.retainPreparedGraphics(identity, leases);
    if (!retained.ok) {
      recordFailure(slot, 'plan', retained.error, errors);
      releaseResolver();
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }
    planExecutionProjections.set(plannedFrame, projected.value);
    plans.push(plannedFrame);
    if (leases.length > 0) preparedResourceBatches.push(retained.value);
    hiddenEntityReports.push(...featureHiddenEntityReports);
    host.setStatus(identity, 'active');
  }

  return {
    stageEvents,
    errors,
    plans,
    fullscreenEffects,
    preparedResourceBatches,
    hiddenEntityReports: mergeHiddenEntityReports(hiddenEntityReports),
  };
}

function mergeHiddenEntityReports(
  reports: readonly RenderFeatureHiddenEntityReport[],
): readonly RenderFeatureHiddenEntityReport[] {
  const entitiesByWorld = new WeakMap<object, Set<EntityHandle>>();
  const merged: RenderFeatureHiddenEntityReport[] = [];
  for (const report of reports) {
    let entities = entitiesByWorld.get(report.world);
    if (entities === undefined) {
      entities = new Set<EntityHandle>();
      entitiesByWorld.set(report.world, entities);
    }
    if (entities.has(report.entity)) continue;
    entities.add(report.entity);
    merged.push(report);
  }
  return Object.freeze(merged);
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
    preparedResourceBatches: new Set(),
    preparedStore: createPreparedGraphicsStore(),
    status: 'active',
    latestError: undefined,
  }));
  return ok(new FeatureHostImpl(slots));
}
