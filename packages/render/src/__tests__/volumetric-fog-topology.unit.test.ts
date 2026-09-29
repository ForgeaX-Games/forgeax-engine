import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { volumetricFogTopology } from '../volume/passes';
import { deriveVolumetricFogResolvedExtent } from '../volume/resources';

const pipelineSource = readFileSync(
  fileURLToPath(new URL('../pipeline/standard-pipeline.ts', import.meta.url)),
  'utf8',
);
const forwardPipelineSource = readFileSync(
  fileURLToPath(new URL('../pipeline/standard-forward-lane.ts', import.meta.url)),
  'utf8',
);
const opaqueFogSource = readFileSync(
  fileURLToPath(new URL('../pipeline/analytic-fog-pass.ts', import.meta.url)),
  'utf8',
);
const shaderSource = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../shader/src/volume/${name}`, import.meta.url)),
    'utf8',
  );

describe('volumetric fog RenderGraph topology', () => {
  it('uses the official quarter-resolution high-quality resolve lane', () => {
    expect(deriveVolumetricFogResolvedExtent({ width: 1920, height: 1080 }, 4)).toEqual({
      width: 480,
      height: 270,
      depth: 1,
    });
    expect(deriveVolumetricFogResolvedExtent({ width: 1920, height: 1080 }, 16)).toEqual({
      width: 240,
      height: 135,
      depth: 1,
    });
  });

  it('keeps denoise soft while retaining depth-boundary rejection', () => {
    const composite = shaderSource('volume-composite.wgsl');
    expect(composite).toContain('abs(neighbor_depth - center_depth)');
    expect(composite).toContain('abs(neighbor.a - center.a) * 6.0');
  });

  it('integrates the ray independently of packed visibility depth', () => {
    const integrate = shaderSource('volume-integrate.wgsl');
    expect(integrate).toContain('for (var step = 0u; step < ray_step_count; step = step + 1u)');
    expect(integrate).toContain('let visibility_depth = max(owner_layers * 4u, 1u);');
  });

  it('keeps the Beer-Lambert extinction input physically non-negative', () => {
    const integrate = shaderSource('volume-integrate.wgsl');
    expect(integrate).toContain(
      'let density_value = max(volume_scattering_density(world_position, volume_params.simulation.x), 0.0);',
    );
  });

  it('keeps the authored path to four ordered passes and two history slots', () => {
    const topology = volumetricFogTopology(true);
    expect(topology.passes).toEqual([
      'volume-inject',
      'volume-integrate',
      'volume-temporal',
      'volume-composite',
    ]);
    expect(topology.resources).toEqual([
      'volume-froxel',
      'volume-resolved-current',
      'volume-history',
      'volume-temporal',
    ]);
    expect(topology.colorInput).toBe('linear-hdr');
    expect(topology.depthInput).toBe('scene-depth');
    expect(topology.passes).not.toContain('apply_fog');
  });

  it('packs four logical visibility slices per rgba8 array texel', () => {
    const resources = readFileSync(
      fileURLToPath(new URL('../volume/resources.ts', import.meta.url)),
      'utf8',
    );
    const passes = readFileSync(
      fileURLToPath(new URL('../volume/passes.ts', import.meta.url)),
      'utf8',
    );
    expect(resources).toContain("VOLUME_FROXEL_FORMAT = 'rgba8unorm'");
    expect(passes).toContain('format: VOLUME_FROXEL_FORMAT');
    expect(shaderSource('volume-inject.wgsl')).toContain(
      'texture_storage_2d_array<rgba8unorm, write>',
    );
    expect(shaderSource('volume-inject.wgsl')).not.toContain('var density : texture_3d');
    expect(shaderSource('volume-integrate.wgsl')).toContain('texture_2d_array<f32>');
    expect(shaderSource('volume-integrate.wgsl')).toContain('texture_3d<f32>');
    expect(shaderSource('volume-integrate.wgsl')).toContain('slice_group');
  });

  it('uploads the camera depth convention consumed by volume CSM selection', () => {
    const viewUbo = readFileSync(
      fileURLToPath(new URL('../record/view-ubo.ts', import.meta.url)),
      'utf8',
    );
    expect(viewUbo).toContain('viewPayload[228] = camera.near');
    expect(viewUbo).toContain('viewPayload[229] = camera.far');
    expect(viewUbo).toContain("camera.projection === 'orthographic' ? 1 : 0");
  });

  it('does not allocate or schedule volume work when fog is off', () => {
    expect(volumetricFogTopology(false)).toEqual({
      passes: [],
      resources: [],
      colorInput: 'linear-hdr',
      depthInput: 'scene-depth',
    });
  });

  it('composites the integrated volume onto the opaque scene before translucency', () => {
    expect(opaqueFogSource).toContain('addAuthoredVolumetricFogPasses');
    expect(opaqueFogSource.indexOf('addAuthoredVolumetricFogPasses(')).toBeLessThan(
      opaqueFogSource.indexOf('addAnalyticFogPass(graph, {'),
    );
    for (const source of [pipelineSource, forwardPipelineSource]) {
      const fog = source.indexOf('addOpaqueFogPasses(graph');
      expect(fog).toBeGreaterThan(0);
      expect(fog).toBeLessThan(source.indexOf('addStandardTransparentPasses(graph'));
    }
    expect(pipelineSource.indexOf('addOpaqueFogPasses(graph')).toBeLessThan(
      pipelineSource.indexOf('addTransmissionBackdropPasses({'),
    );
  });

  it('keeps mesh CSM visibility on the shared volume owner in both Standard lanes', () => {
    expect(opaqueFogSource).toContain('input.directionalShadow');
    for (const source of [pipelineSource, forwardPipelineSource]) {
      expect(source).toContain('addOpaqueFogPasses');
      expect(source).toContain('shadows.value.directional?.view');
    }
    expect(shaderSource('volume-inject.wgsl')).toContain('fn volume_cascade');
    expect(shaderSource('volume-inject.wgsl')).toContain('sample_shadow_2d_kernel');
  });

  it('encodes real volume work and non-constant optical semantics', () => {
    const passes = readFileSync(
      fileURLToPath(new URL('../volume/passes.ts', import.meta.url)),
      'utf8',
    );
    expect(passes).toContain('pass.dispatchWorkgroups(dispatchX, dispatchY, packedLayers)');
    expect(passes).toContain('pass.dispatchWorkgroups(resolvedDispatchX, resolvedDispatchY, 1)');
    expect(passes).toContain('resolvedExtent');
    expect(passes).toContain('pass.draw(3)');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('scene_depth');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('depth_weight');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('scene_world');
    expect(shaderSource('volume-inject.wgsl')).toContain('fn volume_cascade');
    expect(shaderSource('volume-inject.wgsl')).toContain('fn ray_box_interval');
    expect(shaderSource('volume-inject.wgsl')).toContain('view.inverseViewProj');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('textureSampleLevel(density');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('stratified32');
    expect(shaderSource('volume-inject.wgsl')).not.toContain('dither_unorm8');
    expect(shaderSource('volume-integrate.wgsl')).toContain('exp(-extinction * sample_length)');
    expect(shaderSource('volume-integrate.wgsl')).toContain('textureSampleLevel(froxel');
    expect(shaderSource('volume-integrate.wgsl')).toContain('textureStore(resolved');
    expect(shaderSource('volume-temporal.wgsl')).toContain('var lower');
    expect(shaderSource('volume-temporal.wgsl')).toContain('fn bilinear');
    expect(shaderSource('volume-integrate.wgsl')).not.toContain('previous_ndc.z');
    expect(shaderSource('volume-composite.wgsl')).toContain('textureSampleLevel');
    expect(shaderSource('volume-composite.wgsl')).toContain('edge_aware_resolved_volume');
    expect(shaderSource('volume-composite.wgsl')).toContain('textureDimensions(resolved_volume)');
    expect(passes).toContain("{ resource: inputs.density, usage: 'sampled-read' }");
    expect(passes).toContain("viewDimension: '2d-array'");
    expect(shaderSource('volume-composite.wgsl')).toContain('linear_scene_depth');
    expect(shaderSource('volume-composite.wgsl')).toContain('depth_weight');
    expect(shaderSource('volume-temporal.wgsl')).toContain('temporalPreviousViewProj');
    expect(shaderSource('volume-temporal.wgsl')).toContain('fn reproject_uv');
    expect(shaderSource('volume-temporal.wgsl')).toContain(
      'temporalPreviousViewProj * vec4<f32>(world, 1.0)',
    );
    expect(shaderSource('volume-temporal.wgsl')).toContain('var lower');
    expect(shaderSource('volume-composite.wgsl')).not.toContain('/ 64.0');
  });

  it('uses fixed logical-slice centers for injection and integration', () => {
    const inject = shaderSource('volume-inject.wgsl');
    const integrate = shaderSource('volume-integrate.wgsl');
    expect(inject).toContain('(f32(logical_slice) + 0.5) / f32(logical_depth)');
    expect(inject).not.toContain('depth_phase');
    expect(integrate).not.toContain('fn stratified32');
    expect(integrate).toContain('segment_start + segment_length * 0.5');
  });

  it('keeps temporal history graph-owned and slot-selectable', () => {
    const passes = readFileSync(
      fileURLToPath(new URL('../volume/passes.ts', import.meta.url)),
      'utf8',
    );
    const frameSource = readFileSync(
      fileURLToPath(new URL('../record/frame.ts', import.meta.url)),
      'utf8',
    );
    expect(passes).toContain('historyReadSlot');
    expect(passes).toContain('historyWriteSlot');
    expect(passes).toContain("usage: 'sampled-storage-read-write'");
    expect(passes).not.toContain('temporalInit');
    expect(passes).not.toContain('volume_temporal_init');
    expect(passes).not.toContain('textureStore(volume_history');
    expect(frameSource).toContain('volumetricFogHistoryGraph');
    expect(frameSource).toContain('volumetricFogHistorySlot');
    expect(frameSource).toContain('volumetricFogHistorySignature');
    expect(frameSource).toContain('activeVolumetricFogSignature');
    expect(
      readFileSync(fileURLToPath(new URL('../record/volume-params.ts', import.meta.url)), 'utf8'),
    ).toContain('params[32] = fog.worldTimeSeconds ?? 0');
    expect(
      readFileSync(fileURLToPath(new URL('../volume/temporal.ts', import.meta.url)), 'utf8'),
    ).toContain("reason: 'simulation-time'");
  });

  it('advances temporal history only after the accepted queue submit', () => {
    const recordSource = readFileSync(
      fileURLToPath(new URL('../record/frame.ts', import.meta.url)),
      'utf8',
    );
    const submitSource = readFileSync(
      fileURLToPath(new URL('../record/typed-frame-graph.ts', import.meta.url)),
      'utf8',
    );
    expect(recordSource).toContain('temporalFrameTransaction.stage');
    expect(recordSource).toContain('volumetricFogParamsPendingSlot');
    expect(recordSource).toContain('volumetricFogParamsAcceptedSlot');
    expect(recordSource).toContain('hasVolumetricFogCapability');
    expect(submitSource).toContain('yield* recordFrameTransaction(steps,');
    expect(submitSource).not.toContain('queue.submit(');
    expect(submitSource).toContain('commitTemporalGpuSubmit(stagedGpuState)');
  });

  it('requires the manifest-owned shader bundle in addition to compute/storage caps', async () => {
    const { hasVolumetricFogCapability } = await import('../volume/capability');
    expect(hasVolumetricFogCapability({ compute: true, storageTexture: true }, {})).toBe(true);
    expect(hasVolumetricFogCapability({ compute: true, storageTexture: true }, undefined)).toBe(
      false,
    );
    expect(hasVolumetricFogCapability({ compute: false, storageTexture: true }, {})).toBe(false);
    expect(hasVolumetricFogCapability({ compute: true, storageTexture: false }, {})).toBe(false);
  });

  it('clears device-bound volume parameter slots during recovery without destroying old handles', () => {
    const renderSystemSource = readFileSync(
      fileURLToPath(new URL('../render-system.ts', import.meta.url)),
      'utf8',
    );
    const recoverStart = renderSystemSource.indexOf(
      'resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void {',
    );
    expect(recoverStart).toBeGreaterThanOrEqual(0);
    const recoverEnd = renderSystemSource.indexOf(
      'restorePostProcessResources(): void',
      recoverStart,
    );
    expect(recoverEnd).toBeGreaterThan(recoverStart);
    const recoverSource = renderSystemSource.slice(recoverStart, recoverEnd);
    expect(recoverSource).toContain('frameState.volumetricFogParamsBuffers = [null, null]');
    expect(recoverSource).toContain('frameState.volumetricFogParamsPendingSlot = null');
    expect(recoverSource).toContain('frameState.volumetricFogParamsAcceptedSlot = null');
    expect(recoverSource).toContain('frameState.volumetricFogAcceptedParams = undefined');
    expect(recoverSource).toContain('frameState.volumetricFogPendingParams = undefined');
    expect(recoverSource).not.toContain('destroyBuffer(buffer)');
  });
});
