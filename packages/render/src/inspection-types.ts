/**
 * Renderer-owned inspection PODs. Keeping these projections free of renderer
 * implementation imports prevents the observation contract from reopening the
 * extract/record dependency graph.
 */

import type { PointsLinesInspection } from './points-lines/inspection';

export interface BatchTopologyInspection {
  readonly revision: number;
  readonly batchCount: number;
  readonly candidateCount: number;
  readonly rebuilds: number;
  readonly patches: number;
  readonly ineligible: number;
}

export interface GpuSceneTableInspection {
  readonly capacity: number;
  readonly bytes: number;
}

type GpuSceneTableName = 'primitive' | 'instance' | 'transform' | 'drawTemplate' | 'material';

export interface GpuSceneInspection {
  readonly capacity: number;
  readonly tables: Readonly<Record<GpuSceneTableName, GpuSceneTableInspection>>;
  readonly uploadRanges: number;
  readonly uploadBytes: number;
  readonly capacityGrows: number;
  readonly fullRebuilds: number;
  readonly clearedSlots: number;
  readonly noChangeFrames: number;
}

export interface GpuDrivenProductionInspection {
  readonly gpuOwnedSnapshotsMaterialized: number;
  readonly filteredPlanBuilds: number;
  readonly gpuOwnedEntityCount: number;
  readonly candidateUploadBytes: number;
  readonly batchUploadBytes: number;
  readonly viewConstantsUploadBytes: number;
  readonly batchBindGroupCreates: number;
  readonly viewBindGroupCreates: number;
  readonly topologyRevision: number | undefined;
  readonly validatedGpuOwnedRows: number;
  readonly cpuFallbackDrawItems: number;
}

export type RenderSceneResyncReason =
  | 'attach'
  | 'asset-catalog-changed'
  | 'shared-ref-changed'
  | 'journal-overflow'
  | 'unsupported-change'
  | 'non-rigid-lane'
  | 'explicit-invalidate';

export interface PersistentRenderSceneInspection {
  readonly worldEntitiesScanned: number;
  readonly fullRebuilds: number;
  readonly noChangeFrames: number;
  readonly deltaFrames: number;
  readonly transformUpdates: number;
  readonly lastResyncReason: RenderSceneResyncReason | undefined;
  readonly projectionRecords: number;
  readonly topology: BatchTopologyInspection;
  readonly gpu:
    | { readonly status: 'inactive' }
    | { readonly status: 'unsupported'; readonly reason: 'storage-buffer-unavailable' }
    | ({ readonly status: 'resident' } & GpuSceneInspection)
    | { readonly status: 'rebuild-pending' }
    | { readonly status: 'error' };
  /** Bounded retained authoring observations; no graph or backend handles. */
  readonly pointsLines: readonly PointsLinesInspection[];
}

export type RenderSceneInspection = PersistentRenderSceneInspection & {
  readonly gpuDriven: GpuDrivenProductionInspection;
};
