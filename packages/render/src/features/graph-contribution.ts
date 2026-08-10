import type {
  PassDescriptor,
  RenderGraph,
  ResolveContext,
  ResourceDescriptor,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type RenderError,
  RenderFeatureDrawRecordingFailedError,
  RenderFeaturePassOrderConflictError,
  RenderFeaturePreparationFailedError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import type { PreparedGraphicsResolvedSnapshot } from '../prepare/prepared-graphics-resolver';
import type {
  RenderFeatureGpuComputePassDescriptor,
  RenderFeatureResolvedGpuComputePass,
} from './prepared-gpu-work';
import type {
  RenderFeatureGraphicsContributionStaging,
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
} from './prepared-graphics';
import {
  isRenderFeatureTargetHandle,
  type RenderFeatureTargetHandle,
  renderFeatureAttachmentResource,
} from './targets';
import type { RenderFeaturePassContext } from './types';

export interface RenderFeaturePassDependency {
  readonly featureIdentity: string;
  readonly passIdentity: string;
}

export interface RenderFeaturePassOptions {
  readonly dependsOn?: readonly RenderFeaturePassDependency[];
}

export interface RenderFeatureContributionResource {
  readonly name: string;
  readonly descriptor: ResourceDescriptor;
}

export interface RenderFeatureContributionPass<Ctx = RenderFeaturePassContext> {
  readonly featureIdentity: string;
  readonly order: number;
  readonly name: string;
  readonly descriptor: PassDescriptor<Ctx>;
  readonly dependsOn: readonly string[];
  readonly graphics?: RenderFeatureGraphicsPassDescriptor;
  readonly graphicsState?: RenderFeaturePreparedGraphicsState;
  readonly resolvedGraphics?: PreparedGraphicsResolvedSnapshot;
  readonly gpuCompute?: RenderFeatureGpuComputePassDescriptor;
  readonly resolvedGpuCompute?: RenderFeatureResolvedGpuComputePass;
}

export interface RenderFeatureGraphContribution<Ctx = RenderFeaturePassContext> {
  readonly featureIdentity: string;
  readonly order: number;
  readonly resources: readonly RenderFeatureContributionResource[];
  readonly passes: readonly RenderFeatureContributionPass<Ctx>[];
  readonly topologySignature: string;
}

export interface RenderFeatureContributionStaging<Ctx = RenderFeaturePassContext>
  extends RenderFeatureGraphicsContributionStaging {
  readonly resources: readonly RenderFeatureContributionResource[];
  readonly passes: readonly RenderFeatureContributionPass<Ctx>[];
  addResource(name: string, descriptor: ResourceDescriptor): Result<void, RenderError>;
  addPass(
    name: string,
    descriptor: PassDescriptor<Ctx>,
    options?: RenderFeaturePassOptions,
  ): Result<void, RenderError>;
  addComputePass(
    name: string,
    descriptor: RenderFeatureGpuComputePassDescriptor,
    options?: RenderFeaturePassOptions,
  ): Result<void, RenderError>;
  commit(): Result<RenderFeatureGraphContribution<Ctx>, RenderError>;
  abort(): void;
}

export type RenderFeatureGraphicsValidator = (
  descriptor: RenderFeatureGraphicsPassDescriptor,
  resources: readonly RenderFeatureContributionResource[],
) => Result<RenderFeaturePreparedGraphicsState, RenderError>;

export type RenderFeatureGraphicsResolver = (
  descriptor: RenderFeatureGraphicsPassDescriptor,
) => Result<PreparedGraphicsResolvedSnapshot, RenderError>;

export type RenderFeatureGpuComputeResolver = (
  descriptor: RenderFeatureGpuComputePassDescriptor,
) => Result<RenderFeatureResolvedGpuComputePass, RenderError>;

function qualify(identity: string, name: string): string {
  return `${identity}::${name}`;
}

function qualifyAttachment(identity: string, resource: string | RenderFeatureTargetHandle): string {
  const name = renderFeatureAttachmentResource(resource);
  return name === 'swapchain' || isRenderFeatureTargetHandle(resource)
    ? name
    : qualify(identity, name);
}

function failed(identity: string, order: number): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(identity, order, 'contribute', 'next-frame');
}

function signature<Ctx>(
  resources: readonly RenderFeatureContributionResource[],
  passes: readonly RenderFeatureContributionPass<Ctx>[],
): string {
  return JSON.stringify({
    resources: resources.map((resource) => [resource.name, resource.descriptor]),
    passes: passes.map((pass) => [
      pass.name,
      pass.descriptor.reads,
      pass.descriptor.writes,
      pass.dependsOn,
      pass.graphics,
    ]),
  });
}

class ContributionStaging<Ctx> implements RenderFeatureContributionStaging<Ctx> {
  private aborted = false;
  private committed = false;
  private readonly resourceEntries: RenderFeatureContributionResource[] = [];
  private readonly passEntries: RenderFeatureContributionPass<Ctx>[] = [];

  constructor(
    private readonly identity: string,
    private readonly order: number,
    private readonly validateGraphics?: RenderFeatureGraphicsValidator,
    private readonly resolveGraphics?: RenderFeatureGraphicsResolver,
    private readonly resolveGpuCompute?: RenderFeatureGpuComputeResolver,
  ) {}

  get resources(): readonly RenderFeatureContributionResource[] {
    return this.resourceEntries;
  }

  get passes(): readonly RenderFeatureContributionPass<Ctx>[] {
    return this.passEntries;
  }

  addResource(name: string, descriptor: ResourceDescriptor): Result<void, RenderError> {
    if (
      this.aborted ||
      this.committed ||
      this.resourceEntries.some((entry) => entry.name === qualify(this.identity, name))
    ) {
      return err(failed(this.identity, this.order));
    }
    this.resourceEntries.push({ name: qualify(this.identity, name), descriptor });
    return ok(undefined);
  }

  addPass(
    name: string,
    descriptor: PassDescriptor<Ctx>,
    options: RenderFeaturePassOptions = {},
  ): Result<void, RenderError> {
    const qualifiedName = qualify(this.identity, name);
    if (
      this.aborted ||
      this.committed ||
      this.passEntries.some((entry) => entry.name === qualifiedName)
    ) {
      return err(failed(this.identity, this.order));
    }
    const dependencies = (options.dependsOn ?? []).map((dependency) =>
      qualify(dependency.featureIdentity, dependency.passIdentity),
    );
    this.passEntries.push({
      featureIdentity: this.identity,
      order: this.order,
      name: qualifiedName,
      descriptor: {
        ...descriptor,
        reads: descriptor.reads.map((read) => qualify(this.identity, read)),
        writes: descriptor.writes.map((write) => qualify(this.identity, write)),
      },
      dependsOn: dependencies,
    });
    return ok(undefined);
  }

  addGraphicsPass(
    name: string,
    descriptor: RenderFeatureGraphicsPassDescriptor,
    options: RenderFeaturePassOptions = {},
  ): Result<void, RenderError> {
    const qualifiedName = qualify(this.identity, name);
    if (
      this.aborted ||
      this.committed ||
      descriptor.draws.length === 0 ||
      this.passEntries.some((entry) => entry.name === qualifiedName)
    ) {
      return this.aborted ||
        this.committed ||
        this.passEntries.some((entry) => entry.name === qualifiedName)
        ? err(failed(this.identity, this.order))
        : ok(undefined);
    }
    const graphicsState = this.validateGraphics?.(descriptor, this.resourceEntries);
    if (graphicsState !== undefined && !graphicsState.ok) {
      return err(graphicsState.error);
    }
    const resolvedGraphics = this.resolveGraphics?.(descriptor);
    if (resolvedGraphics !== undefined && !resolvedGraphics.ok) {
      if (
        resolvedGraphics.error instanceof RenderFeaturePreparationFailedError &&
        resolvedGraphics.error.detail.reason === 'pipeline-pending'
      ) {
        return ok(undefined);
      }
      return err(resolvedGraphics.error);
    }
    const qualifiedResources = descriptor.attachments.colors.map((attachment) =>
      qualifyAttachment(this.identity, attachment.resource),
    );
    const qualifiedDepth =
      descriptor.attachments.depthStencil === undefined
        ? undefined
        : qualifyAttachment(this.identity, descriptor.attachments.depthStencil.resource);
    const contributionPass: RenderFeatureContributionPass<Ctx> = {
      featureIdentity: this.identity,
      order: this.order,
      name: qualifiedName,
      descriptor: {
        reads: qualifiedDepth === undefined ? [] : [qualifiedDepth],
        writes: qualifiedResources,
      },
      dependsOn: (options.dependsOn ?? []).map((dependency) =>
        qualify(dependency.featureIdentity, dependency.passIdentity),
      ),
      graphics: descriptor,
      ...(graphicsState?.ok === true ? { graphicsState: graphicsState.value } : {}),
      ...(resolvedGraphics?.ok === true ? { resolvedGraphics: resolvedGraphics.value } : {}),
    };
    this.passEntries.push(contributionPass);
    return ok(undefined);
  }

  addComputePass(
    name: string,
    descriptor: RenderFeatureGpuComputePassDescriptor,
    options: RenderFeaturePassOptions = {},
  ): Result<void, RenderError> {
    const qualifiedName = qualify(this.identity, name);
    if (
      this.aborted ||
      this.committed ||
      descriptor.dispatches.length === 0 ||
      this.passEntries.some((entry) => entry.name === qualifiedName)
    ) {
      return err(failed(this.identity, this.order));
    }
    const resolved = this.resolveGpuCompute?.(descriptor);
    if (resolved === undefined || !resolved.ok) {
      return resolved === undefined ? err(failed(this.identity, this.order)) : resolved;
    }
    this.passEntries.push({
      featureIdentity: this.identity,
      order: this.order,
      name: qualifiedName,
      descriptor: { reads: [], writes: [] },
      dependsOn: (options.dependsOn ?? []).map((dependency) =>
        qualify(dependency.featureIdentity, dependency.passIdentity),
      ),
      gpuCompute: descriptor,
      resolvedGpuCompute: resolved.value,
    });
    return ok(undefined);
  }

  commit(): Result<RenderFeatureGraphContribution<Ctx>, RenderError> {
    if (this.aborted || this.committed) return err(failed(this.identity, this.order));
    this.committed = true;
    return ok({
      featureIdentity: this.identity,
      order: this.order,
      resources: Object.freeze([...this.resourceEntries]),
      passes: Object.freeze([...this.passEntries]),
      topologySignature: signature(this.resourceEntries, this.passEntries),
    });
  }

  abort(): void {
    if (this.committed) return;
    this.aborted = true;
    this.resourceEntries.length = 0;
    this.passEntries.length = 0;
  }
}

export function createRenderFeatureContributionStaging<Ctx = RenderFeaturePassContext>(
  featureIdentity: string,
  order: number,
  validateGraphics?: RenderFeatureGraphicsValidator,
  resolveGraphics?: RenderFeatureGraphicsResolver,
  resolveGpuCompute?: RenderFeatureGpuComputeResolver,
): RenderFeatureContributionStaging<Ctx> {
  return new ContributionStaging(
    featureIdentity,
    order,
    validateGraphics,
    resolveGraphics,
    resolveGpuCompute,
  );
}

export function mergeRenderFeatureContributions<Ctx>(
  contributions: readonly RenderFeatureGraphContribution<Ctx>[],
): Result<RenderFeatureGraphContribution<Ctx>, RenderError> {
  const ordered = [...contributions].sort((left, right) => left.order - right.order);
  const byIdentity = new Map(
    ordered.map((contribution) => [contribution.featureIdentity, contribution]),
  );
  for (const contribution of ordered) {
    const localPasses = new Map(contribution.passes.map((pass, index) => [pass.name, index]));
    for (const pass of contribution.passes) {
      for (const dependency of pass.dependsOn) {
        const separator = dependency.lastIndexOf('::');
        const dependencyFeature = separator < 0 ? dependency : dependency.slice(0, separator);
        const dependencyContribution = byIdentity.get(dependencyFeature);
        const dependencyIndex = dependencyContribution?.passes.findIndex(
          (entry) => entry.name === dependency,
        );
        const isLaterFeature =
          dependencyContribution !== undefined && dependencyContribution.order > contribution.order;
        const isLaterLocalPass =
          dependencyContribution === contribution &&
          dependencyIndex !== undefined &&
          dependencyIndex >= (localPasses.get(pass.name) ?? 0);
        if (dependencyContribution === undefined || isLaterFeature || isLaterLocalPass) {
          return err(
            new RenderFeaturePassOrderConflictError(
              contribution.featureIdentity,
              contribution.order,
              pass.name,
              dependency,
            ),
          );
        }
      }
    }
  }
  const resources = ordered.flatMap((contribution) => contribution.resources);
  const passes = ordered.flatMap((contribution) => contribution.passes);
  return ok({
    featureIdentity: 'render-feature-aggregate',
    order: -1,
    resources,
    passes,
    topologySignature: signature(resources, passes),
  });
}

export interface RenderFeatureGraphComposition<
  GraphCtx = unknown,
  FeatureCtx = RenderFeaturePassContext,
> {
  readonly graph: RenderGraph<GraphCtx>;
  readonly topologySignature: string;
  readonly passNames: readonly string[];
  readonly executeCount: number;
  update(contributions: readonly RenderFeatureGraphContribution<FeatureCtx>[]): {
    readonly topologyChanged: boolean;
  };
}

function toDelegate<FeatureCtx>(
  execute: PassDescriptor<FeatureCtx>['execute'],
): ((context: FeatureCtx) => void) | undefined {
  if (execute === undefined) return undefined;
  return (context) => (execute as (value: FeatureCtx) => void)(context);
}

export type RenderFeatureGraphPassProjector<GraphCtx, FeatureCtx> = (
  context: GraphCtx,
  pass: RenderFeatureContributionPass<FeatureCtx>,
  resolveContext: ResolveContext,
  execute: (context: FeatureCtx) => void,
) => void;

export type RenderFeatureGraphErrorReporter = (
  featureIdentity: string,
  order: number,
  failure: unknown,
) => void;

export function composeRenderFeatureGraph<GraphCtx, FeatureCtx = RenderFeaturePassContext>(
  graph: RenderGraph<GraphCtx>,
  contributions: readonly RenderFeatureGraphContribution<FeatureCtx>[],
  project: RenderFeatureGraphPassProjector<GraphCtx, FeatureCtx> = (
    context,
    _pass,
    _resolveContext,
    execute,
  ) => execute(context as unknown as FeatureCtx),
  reportError?: RenderFeatureGraphErrorReporter,
): Result<RenderFeatureGraphComposition<GraphCtx, FeatureCtx>, RenderError> {
  const merged = mergeRenderFeatureContributions(contributions);
  if (!merged.ok) return merged;
  const proxies = merged.value.passes.map((pass) => ({
    name: pass.name,
    pass,
    delegate: toDelegate(pass.descriptor.execute),
  }));
  for (const resource of merged.value.resources) {
    const added = graph.addResource(resource.name, resource.descriptor);
    if (!added.ok) return err(failed(merged.value.featureIdentity, merged.value.order));
  }
  let executeCount = 0;
  let observedExecution = false;
  for (const [index, pass] of merged.value.passes.entries()) {
    const proxy = proxies[index];
    if (proxy === undefined) continue;
    graph.addPass(pass.name, {
      ...pass.descriptor,
      execute: (ctx: GraphCtx, resolveCtx: ResolveContext) => {
        if (!observedExecution) {
          observedExecution = true;
          executeCount += 1;
        }
        try {
          project(ctx, proxy.pass, resolveCtx, (featureContext) =>
            proxy.delegate?.(featureContext),
          );
        } catch (failure) {
          reportError?.(
            pass.featureIdentity,
            pass.order,
            failure instanceof Error && typeof (failure as Partial<RenderError>).code === 'string'
              ? failure
              : new RenderFeatureDrawRecordingFailedError(
                  pass.featureIdentity,
                  pass.order,
                  pass.name,
                  proxy.pass.gpuCompute === undefined ? 'pipeline' : 'bindings',
                  'backend-recording-failed',
                  failure instanceof Error ? failure.message : String(failure),
                  'renderer-recover',
                ),
          );
        }
      },
    });
  }
  let currentSignature = merged.value.topologySignature;
  return ok({
    graph,
    topologySignature: currentSignature,
    passNames: Object.freeze(merged.value.passes.map((pass) => pass.name)),
    get executeCount() {
      return executeCount;
    },
    update(next) {
      const nextMerged = mergeRenderFeatureContributions(next);
      if (!nextMerged.ok || nextMerged.value.topologySignature !== currentSignature) {
        return { topologyChanged: true };
      }
      for (const [index, pass] of nextMerged.value.passes.entries()) {
        const proxy = proxies[index];
        if (proxy !== undefined) {
          proxy.pass = pass;
          proxy.delegate = toDelegate(pass.descriptor.execute);
        }
      }
      currentSignature = nextMerged.value.topologySignature;
      return { topologyChanged: false };
    },
  });
}
