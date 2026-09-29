import {
  LOD_PROJECTION_ROW_CAPACITY,
  LOD_PROJECTION_WGSL,
} from '../gpu-driven/lod-projection.wgsl';
import { GPU_SCENE_LAYOUTS, gpuSceneWgsl } from '../gpu-scene-schema';

/** `ProjectionCase` stride: bounds (2 × vec4) + world mat4 + LodViewConstants. */
export const LOD_PROJECTION_CASE_BYTES = 128;
/** `SelectionCase` stride: height, previousLevel, historyValid, chain. */
export const LOD_SELECTION_CASE_BYTES = 16;
/** `LodChain` stride: the fixed row array plus its level count. */
export const LOD_CHAIN_BYTES = LOD_PROJECTION_ROW_CAPACITY * GPU_SCENE_LAYOUTS.lod.stride + 4;

/**
 * Compute harness that evaluates the production LOD kernels verbatim: every
 * case writes the kernel result, and `round_trip` feeds each chain's own
 * selection back as history so hysteresis runs end-to-end on the device.
 */
export const LOD_PROJECTION_HARNESS_WGSL = /* wgsl */ `
${gpuSceneWgsl(GPU_SCENE_LAYOUTS.lod)}
${LOD_PROJECTION_WGSL}

struct ProjectionCase {
  boundsMin: vec4<f32>,
  boundsMax: vec4<f32>,
  world: mat4x4<f32>,
  view: LodViewConstants,
};

struct SelectionCase {
  height: f32,
  previousLevel: u32,
  historyValid: u32,
  chain: u32,
};

struct LodChain {
  rows: array<GpuSceneLod, ${LOD_PROJECTION_ROW_CAPACITY}>,
  levelCount: u32,
};

@group(0) @binding(0) var<storage, read> projectionCases: array<ProjectionCase>;
@group(0) @binding(1) var<storage, read> selectionCases: array<SelectionCase>;
@group(0) @binding(2) var<storage, read> chains: array<LodChain>;
@group(0) @binding(3) var<storage, read> ramp: array<f32>;
@group(0) @binding(4) var<storage, read_write> projectionOut: array<f32>;
@group(0) @binding(5) var<storage, read_write> selectionOut: array<vec4<u32>>;
@group(0) @binding(6) var<storage, read_write> rampOut: array<u32>;

@compute @workgroup_size(64)
fn project(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&projectionCases)) { return; }
  let item = projectionCases[id.x];
  projectionOut[id.x] = projectedHeight(item.boundsMin.xyz, item.boundsMax.xyz, item.world, item.view);
}

@compute @workgroup_size(64)
fn select_lod(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&selectionCases)) { return; }
  let item = selectionCases[id.x];
  let chain = chains[item.chain];
  let level = selectLodLevel(
    item.height,
    item.previousLevel,
    item.historyValid != 0u,
    chain.rows,
    chain.levelCount,
  );
  let crossfade = lodCrossfade(item.height, chain.rows, chain.levelCount);
  selectionOut[id.x * 2u] = vec4<u32>(
    level,
    crossfade.level,
    bitcast<u32>(crossfade.fade),
    select(0u, 1u, crossfade.paired),
  );
  // Shadow clamp: the finest level a reference view draws and the height
  // floor that keeps a shadow view within one level of it.
  let finest = lodFinestLevel(item.height, true, chain.rows, chain.levelCount);
  selectionOut[id.x * 2u + 1u] = vec4<u32>(
    lodFinestLevel(item.height, false, chain.rows, chain.levelCount),
    finest,
    bitcast<u32>(lodClampHeight(finest, 1u, chain.rows, chain.levelCount)),
    0u,
  );
}

@compute @workgroup_size(1)
fn round_trip(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&chains)) { return; }
  let chain = chains[id.x];
  let steps = arrayLength(&ramp);
  var previous = 0xffffffffu;
  for (var step = 0u; step < steps; step += 1u) {
    let level = selectLodLevel(
      ramp[step],
      previous,
      previous != 0xffffffffu,
      chain.rows,
      chain.levelCount,
    );
    rampOut[id.x * steps + step] = level;
    previous = level;
  }
}
`;
