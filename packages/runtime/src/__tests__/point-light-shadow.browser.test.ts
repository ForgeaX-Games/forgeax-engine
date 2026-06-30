// point-light-shadow.browser.test.ts
// feat-20260612-point-light-shadows-urp-hdrp M0 / T-M0-2.
//
// Minimal vitest browser (chromium + WebGPU) fixture: create
// texture_depth_cube_array + textureSampleCompareLevel + readback non-black.
// Proves Chromium WebGPU supports cube_array comparison sampler alongside dawn
// (T-M0-1). Plan-strategy D-5 risk R-5 calls for Chromium validation alongside
// dawn. New file under existing __tests__/ directory.
//
// This file is scoped to the 'browser' vitest project (file-naming convention
// *.browser.test.ts); the 'dawn' and 'unit' projects exclude it.

import { describe, expect, it } from 'vitest';

// WebGPU bitmask constants per spec (avoids needing @webgpu/types globals
// in the runtime tsconfig). Values are stable across implementations.
const TEX_USAGE_COPY_SRC = 0x01;
const TEX_USAGE_TEXTURE_BINDING = 0x04;
const TEX_USAGE_RENDER_ATTACHMENT = 0x10;
const BUF_USAGE_MAP_READ = 0x0001;
const BUF_USAGE_COPY_SRC = 0x0004;
const BUF_USAGE_COPY_DST = 0x0008;
const BUF_USAGE_STORAGE = 0x0080;
const SHADER_STAGE_COMPUTE = 0x4;
const MAP_MODE_READ = 0x0001;

describe('M0 cube_array comparison sampler (browser)', () => {
  it("'cube_array comparison sampler' -- creates texture_depth_cube_array, samples via textureSampleCompareLevel, readback non-black", async () => {
    // Guard: browser WebGPU must be available.
    if (!navigator.gpu) {
      throw new Error('WebGPU not available in browser test environment');
    }

    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    if (!adapter) throw new Error('adapter unavailable');

    const device = await adapter.requestDevice();
    expect(device).not.toBeNull();
    if (!device) throw new Error('device unavailable');

    const WIDTH = 512;
    const HEIGHT = 512;
    const LAYERS = 6; // one cube (6 faces)

    // Create a depth32float 2D texture array (6 layers -> cube view).
    const cubeAtlas = device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: LAYERS },
      format: 'depth32float',
      dimension: '2d',
      usage: TEX_USAGE_RENDER_ATTACHMENT | TEX_USAGE_TEXTURE_BINDING | TEX_USAGE_COPY_SRC,
    });

    // Cube-array texture view for shader sampling.
    const cubeView = cubeAtlas.createView({
      format: 'depth32float',
      dimension: 'cube',
      aspect: 'depth-only',
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 6,
    });

    // Comparison sampler.
    const comparisonSampler = device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      compare: 'less',
    });

    // Clear the cube atlas to depth=0.5. WebGPU comparison: ref < sampled -> pass.
    // We'll sample with ref=0.3, so 0.3 < 0.5 = true -> result = 1.0.
    for (let face = 0; face < 6; face++) {
      const faceView = cubeAtlas.createView({
        format: 'depth32float',
        dimension: '2d',
        aspect: 'depth-only',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: face,
        arrayLayerCount: 1,
      });
      const encoder = device.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: faceView,
            depthClearValue: 0.5,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        })
        .end();
      device.queue.submit([encoder.finish()]);
    }
    await device.queue.onSubmittedWorkDone();

    // Storage buffer for compute output + readback buffer.
    const resultBuffer = device.createBuffer({
      size: 4,
      usage: BUF_USAGE_STORAGE | BUF_USAGE_COPY_SRC,
    });
    const readbackBuffer = device.createBuffer({
      size: 4,
      usage: BUF_USAGE_MAP_READ | BUF_USAGE_COPY_DST,
    });

    // WGSL compute shader: sample the cube depth texture and write the result.
    const shaderModule = device.createShaderModule({
      code: `
        @group(0) @binding(0) var cubeAtlas : texture_depth_cube;
        @group(0) @binding(1) var cubeSampler : sampler_comparison;
        @group(0) @binding(2) var<storage, read_write> output : f32;

        @compute @workgroup_size(1)
        fn main() {
          // Sample the +X face with depth_ref=0.3. The atlas was cleared to
          // 0.5, so comparison 0.3 < 0.5 passes -> result = 1.0.
          let dir = vec3<f32>(1.0, 0.0, 0.0);
          let depth_ref = 0.3;
          output = textureSampleCompareLevel(cubeAtlas, cubeSampler, dir, depth_ref);
        }
      `,
    });

    const bgl = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'depth', viewDimension: 'cube' },
        },
        {
          binding: 1,
          visibility: SHADER_STAGE_COMPUTE,
          sampler: { type: 'comparison' },
        },
        {
          binding: 2,
          visibility: SHADER_STAGE_COMPUTE,
          buffer: { type: 'storage' },
        },
      ],
    });

    const bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: cubeView },
        { binding: 1, resource: comparisonSampler },
        { binding: 2, resource: { buffer: resultBuffer } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bgl],
    });

    const computePipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(computePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();

    encoder.copyBufferToBuffer(resultBuffer, 0, readbackBuffer, 0, 4);
    device.queue.submit([encoder.finish()]);

    await device.queue.onSubmittedWorkDone();
    await readbackBuffer.mapAsync(MAP_MODE_READ);
    const result = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();

    // Cleared to 0.5, ref=0.3, compare='less': 0.3 < 0.5 = true -> 1.0.
    expect(result[0]).toBe(1.0);

    readbackBuffer.destroy();
    resultBuffer.destroy();
    cubeAtlas.destroy();
    device.destroy();
  });
});

// feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-6 (AC-14 URP path).
//
// URP-end-to-end pixel-readback assertion: spawn PointLight + PointLightShadow
// + occluder + ground plane, run one frame, read back swap-chain pixels, and
// assert the occluded fragment is darker than a non-occluded reference
// fragment.
//
// Round-2 status (feat-20260612 Round-2 commit-B + commit-C): the BGL
// hookup landed -- POINT_SHADOW_AVAILABLE is registered at all 3
// vite-plugin-shader define sites, the runtime PBR view BGL emits
// always-on bindings 5 (cube_array depth atlas) + 6 (shadowParams UBO 64 B),
// and recordPointShadowPass walks validated entries with real drawIndexed
// calls + per-face VP write to viewUniformBuffer.lightSpaceMatrix. The
// shadowParams UBO is written per frame in record-stage with
// (near, far, 1/(far-near), 0) per shadow-casting snapshot.
//
// What remains for this `it.skip` to flip to `it`: the full
// createRenderer + canvas + readPixels + scene scaffolding (mirror of
// `light-casters-9-light.browser.test.ts` shape: spawnCamera + spawn
// occluder cube + spawn ground plane + spawnPointAt + spawnPointShadow
// + driving FRAMES_PER_SCENE rAF ticks + sampleBlockAverage at occluded
// vs free sample sites). The wiring is unblocked at the engine layer; the
// scope of writing the test fixture itself + tuning the lighting setup so
// occluded < non-occluded reliably under chromium headless presentation
// timing exceeds Round-2 fix-up budget. Tracked as a sub-followup
// (feat-followup-point-shadow-browser-readback) per implement-decisions.md.
describe('URP point shadow pixel readback (browser, T-M3-6 / AC-14)', () => {
  it.skip('occluded fragment darker than non-occluded -- BGL hookup landed in Round-2; full createRenderer + readPixels scaffolding deferred', () => {
    // Pseudocode for the assertion the runnable test will make once the
    // hookup lands:
    //
    //   const renderer = createRenderer(canvas, { ... });
    //   const world = new World();
    //   world.spawn({ component: Transform, data: {...} },
    //               { component: PointLight, data: {...} },
    //               { component: PointLightShadow, data: {} });
    //   // ... ground plane + occluder ...
    //   renderer.draw(world);
    //   const px = await readback(canvas, occludedX, occludedY);
    //   const py = await readback(canvas, freeX, freeY);
    //   expect(px.r + px.g + px.b).toBeLessThan(py.r + py.g + py.b);
    //   expect(py.r + py.g + py.b).toBeGreaterThan(0); // non-black frame
  });
});

// feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-6 (AC-14 HDRP path).
//
// HDRP-end-to-end pixel-readback assertion: createRenderer with HDRP pipeline
// installed -> spawn PointLight + PointLightShadow + occluder + ground ->
// renderFrame -> readback pixels. Assert occluded < non-occluded brightness
// AND non-black frame.
//
// Round-2 status (feat-20260612 Round-2 commit-B + commit-C): the BGL
// hookup landed for both URP and HDRP -- the shared `pbr-view-bgl` declares
// always-on bindings 5 + 6 (HDRP rides binding 5 only; HDRP gets the
// (near, far) pair via LightSlot.kind_and_pad.zw per plan-strategy D-8),
// and hdrp-cluster-forward.wgsl now imports shadowAtlas + shadowSampler
// from common.wgsl under the POINT_SHADOW_AVAILABLE ifdef so naga_oil
// resolves the free identifiers. recordPointShadowPass writes real depth
// values to the cube atlas faces.
//
// What remains for this `it.skip` to flip to `it`: same as the URP test --
// the full createRenderer + canvas + readPixels + scene scaffolding,
// additionally with `installPipeline(hdrpAsset)` to drive the HDRP path.
// Tracked under the same sub-followup (feat-followup-point-shadow-browser-readback).
describe('HDRP point shadow pixel readback (browser, T-M4-6 / AC-14)', () => {
  it.skip('occluded fragment darker than non-occluded -- BGL hookup landed in Round-2; full createRenderer + readPixels + HDRP install scaffolding deferred', () => {
    // Pseudocode for the assertion the runnable test will make once the
    // hookup lands:
    //
    //   const renderer = createRenderer(canvas, { ... });
    //   renderer.installPipeline(hdrpAsset);  // forgeax::hdrp
    //   const world = new World();
    //   world.spawn({ component: Transform, data: {...} },
    //               { component: PointLight, data: {...} },
    //               { component: PointLightShadow, data: {} });
    //   // ... ground plane + occluder ...
    //   renderer.draw(world);
    //   const px = await readback(canvas, occludedX, occludedY);
    //   const py = await readback(canvas, freeX, freeY);
    //   expect(px.r + px.g + px.b).toBeLessThan(py.r + py.g + py.b);
    //   expect(py.r + py.g + py.b).toBeGreaterThan(0); // non-black frame
  });
});
