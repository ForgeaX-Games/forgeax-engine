export const STANDARD_PIPELINE_ID = 'forgeax::standard' as const;
export const STANDARD_LIGHT_COUNTS = [1, 32, 256] as const;
/** Shared clustered-lighting facts consumed by pipeline, record, and buffers. */
export const DEFAULT_CLUSTER_GRID = { x: 16, y: 9, z: 24 } as const;
export const CLUSTER_GRID_STRIDE_U32 = 2;
export const LIGHT_INDEX_LIST_CAPACITY = 1048576;
export const MAX_LIGHTS = 256;

export type StandardLightCount = (typeof STANDARD_LIGHT_COUNTS)[number];
export type StandardLightingLane = 'direct' | 'clustered';
export type StandardFallbackLane = 'native' | 'cpu-webgl2';
export type StandardShadowMode = 'off' | 'hard' | 'filtered';
export type StandardTone =
  | 'none'
  | 'aces-filmic'
  | 'agx'
  | 'cineon'
  | 'linear'
  | 'neutral'
  | 'reinhard'
  | 'reinhard-extended';
export type StandardAntialias = 'none' | 'fxaa' | 'msaa';
export type StandardPostStage = 'transparent-blend' | 'bloom' | 'tone' | 'fxaa' | 'output';

export interface StandardProfile {
  readonly pipelineId: typeof STANDARD_PIPELINE_ID;
  readonly lightCount: StandardLightCount;
  readonly lighting: StandardLightingLane;
  readonly shadows: StandardShadowMode;
  readonly pbr: boolean;
  readonly ibl: boolean;
  readonly ssao: boolean;
  readonly bloom: boolean;
  readonly tone: StandardTone;
  readonly antialias: StandardAntialias;
  readonly sky: boolean;
  readonly fallback: StandardFallbackLane;
  readonly postStages: readonly ['transparent-blend', 'bloom', 'tone', 'fxaa', 'output'];
}

export const DEFAULT_STANDARD_PROFILE: StandardProfile = Object.freeze({
  pipelineId: STANDARD_PIPELINE_ID,
  lightCount: 32,
  lighting: 'direct',
  shadows: 'filtered',
  pbr: true,
  ibl: true,
  ssao: false,
  bloom: true,
  tone: 'aces-filmic',
  antialias: 'fxaa',
  sky: true,
  fallback: 'native',
  postStages: ['transparent-blend', 'bloom', 'tone', 'fxaa', 'output'] as const,
});

export type StandardLane = StandardLightingLane | 'cpu-webgl2';

export function resolveStandardLane(
  profile: Pick<StandardProfile, 'lighting'>,
  capabilities: { readonly compute: boolean; readonly storageBuffer: boolean },
): StandardLane {
  if (!capabilities.compute || !capabilities.storageBuffer) return 'cpu-webgl2';
  return profile.lighting;
}
