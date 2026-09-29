import type { World } from '@forgeax/engine-ecs';
import type { GpuResidencyCache } from '../device/gpu-residency';
import {
  createDynamicGeometryLifecycle,
  type DynamicGeometryCandidate,
  type DynamicGeometryLifecycle,
} from '../dynamic-geometry';
import { RendererContractFailureError, RendererOperationError } from '../errors/render';
import type { RenderSystem } from '../render-system';
import {
  createDynamicGeometryHost,
  type DynamicGeometryHostImplementation,
} from './dynamic-geometry-host';

export interface DynamicGeometryRuntime {
  readonly lifecycle: DynamicGeometryLifecycle;
  readonly host: DynamicGeometryHostImplementation;
}

/** Assemble the renderer-owned candidate lifecycle and its device host. */
export function createDynamicGeometryRuntime(options: {
  readonly attachedWorlds: ReadonlySet<World>;
  readonly getGpuStore: () => GpuResidencyCache;
  readonly currentGeneration: () => number;
  readonly renderSystem: Pick<
    RenderSystem,
    'invalidateGeometryHistory' | 'isDynamicGeometryConsumed' | 'dynamicGeometryRecordStageLane'
  >;
}): DynamicGeometryRuntime {
  const lifecycle = createDynamicGeometryLifecycle();
  const host = createDynamicGeometryHost({
    lifecycle,
    attachedWorlds: options.attachedWorlds,
    getGpuStore: options.getGpuStore,
    currentGeneration: options.currentGeneration,
    onTopologyChanged: () => options.renderSystem.invalidateGeometryHistory(),
    isConsumedByRenderFrame: (candidate: DynamicGeometryCandidate) =>
      options.renderSystem.isDynamicGeometryConsumed(
        candidate.world as World,
        candidate.entity ?? -1,
        candidate.meshHandle,
      ),
    recordStageLane: (candidate) =>
      options.renderSystem.dynamicGeometryRecordStageLane(
        candidate.world as World,
        candidate.entity ?? -1,
        candidate.meshHandle,
      ),
  });
  return { lifecycle, host };
}

/** Reject a draw while a derived-physics publication is still unsettled. */
export function validateDerivedPhysicsFrame(
  worlds: readonly World[],
): RendererOperationError<'frame-input-invalid'> | undefined {
  for (const world of worlds) {
    if (!world.hasResource('PhysicsWorld')) continue;
    const physics = world.getResource<{
      readonly getDerivedAdmission?: () => unknown;
      readonly getDerivedRecoveryState?: () => string;
    }>('PhysicsWorld');
    if (
      physics?.getDerivedAdmission?.() !== undefined ||
      physics?.getDerivedRecoveryState?.() === 'rebuild-required'
    ) {
      return new RendererOperationError('frame-input-invalid', {
        operation: 'draw',
        cause: new RendererContractFailureError(
          'draw',
          'paired geometry admission must finish physics step and writeback in a healthy World before draw',
        ),
      });
    }
  }
  return undefined;
}
