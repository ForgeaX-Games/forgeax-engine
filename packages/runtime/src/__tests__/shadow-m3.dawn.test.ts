// shadow-m3.dawn.test.ts -
// feat-20260621-merge-directionallightshadow-into-directionallight / M3 / m3-t1.
//
// M3 wires the merged DirectionalLight's depthBias / normalBias / pcfKernelSize
// into the View UBO tail (floats [126/127/128], bytes 504/508/512) and drives
// the directional shadow bias + variable-width PCF loop from those uniforms
// (lighting-directional.wgsl::_sampleShadowForCascade, D-1 / D-2). This test is
// the RED gate for that wiring.
//
// AC anchor: requirements AC-03 (shadow params flow from the merged component to
// the shader) + AC-08 (View UBO byte layout stays fixed: VIEW_PAYLOAD_FLOATS=148
// / VIEW_UBO_BYTES=592 unchanged; append at tail). plan-strategy D-1 (directional
// bias mapping: normalBias=slope, depthBias=floor), D-2 (variable-width PCF
// driven by pcfKernelSize via the merged 5.3-production-shadow-demos AC-14
// constant-trip-count loop), D-7 (host clamp pcfKernelSize into {1,3,5}).
//
// What is observable, and why these assertions:
//   * The View UBO buffer is created UNIFORM | COPY_DST only (no COPY_SRC) and
//     there is no debug accessor returning its bytes, so the float-slot
//     placement cannot be asserted by GPU readback. The debugSampleShadowFactor
//     probe is a SELF-CONTAINED shader (hardcoded bias + fixed 3x3 textureLoad)
//     that never binds the View UBO, so it cannot observe pcfKernelSize either.
//   * The shader-wiring RED gate is therefore asserted against the COMPOSED
//     engine shader: _sampleShadowForCascade reads view.pcfKernelSize and runs
//     a kernel/MAX_PCF_HALF constant-trip-count PCF loop (variant-free, merged
//     from 5.3-production-shadow-demos AC-14), and derives the bias from
//     view.normalBias / view.depthBias (D-1). Pre-wiring the composed default-standard-pbr shader
//     has none of these tokens (RED); post-m3-t4 it does (GREEN). The composed
//     WGSL is the single source the GPU compiles, so this is a faithful gate.
//   * The merged component is exercised end-to-end on a real device: a single
//     DirectionalLight (castShadow default true) + cube occluder + ground
//     populates the shadow atlas, and debugSampleShadowFactor reports occluded
//     positions shadowed and lit positions lit -- proving the merged shadow
//     fields drive a working shadow pass.
//   * Byte-layout invariance (AC-08) is asserted structurally: if the host
//     payload float count or the WGSL struct byte size drifted out of sync, the
//     pbr pipeline would fail to compile / validate and renderer.ready /
//     renderer.draw would not return ok. A clean default-config render across
//     the four clamped kernel sizes is the proxy for "VIEW_UBO_BYTES unchanged".

import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, Transform } from '../components';
import { createRenderer, HANDLE_CUBE } from '../index';

const WIDTH = 256;
const HEIGHT = 256;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const GROUND_SIZE = 20;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify(ENGINE_MANIFEST),
)}`;

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

/** The composed default-standard-pbr WGSL the GPU actually compiles. */
function composedStandardPbr(): string {
  const m = ENGINE_MANIFEST.materialShaders.find(
    (s) => s.identifier === 'forgeax::default-standard-pbr',
  );
  if (m === undefined) throw new Error('default-standard-pbr not in engine manifest');
  return m.composedWgsl;
}

function createMockCanvas(): { canvas: HTMLCanvasElement; getDevice: () => GPUDevice | undefined } {
  let sharedDevice: GPUDevice | undefined;
  const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (opts) => {
    const rawAdapter = await originalRequestAdapter(opts);
    if (rawAdapter === null) return rawAdapter;
    const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
    rawAdapter.requestDevice = async (desc) => {
      const dev = await originalRequestDevice(desc);
      if (sharedDevice === undefined) sharedDevice = dev;
      return dev;
    };
    return rawAdapter;
  };
  let renderTarget: GPUTexture | undefined;
  const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
    if (renderTarget !== undefined) return renderTarget;
    renderTarget = device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format,
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return renderTarget;
  };
  const canvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (renderTarget === undefined) {
            if (sharedDevice === undefined)
              throw new Error('render target requested before device captured');
            return ensureRenderTarget(sharedDevice, 'rgba8unorm');
          }
          return renderTarget;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  return { canvas, getDevice: () => sharedDevice };
}

/**
 * Cube occluder above a ground plane, lit by a near-vertical directional light.
 * The camera looks down the -Z axis (orthographic) so the full scene is in the
 * shadow atlas fit. `pcfKernelSize` is set on the single merged DirectionalLight.
 */
function buildShadowScene(world: World, pcfKernelSize: number): void {
  // Ground plane (flattened cube), top face at y=0. Empty MeshRenderer ->
  // engine default standard material (shadow-receiving forward pass).
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: 0,
          posY: -0.005,
          posZ: 0,
          quatW: 1,
          scaleX: GROUND_SIZE,
          scaleY: 0.01,
          scaleZ: GROUND_SIZE,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();

  // Occluder cube, 2x2x2 centred at y=1.5 (bottom at y=0.5).
  world
    .spawn(
      {
        component: Transform,
        data: { posX: 0, posY: 1.5, posZ: 0, quatW: 1, scaleX: 2, scaleY: 2, scaleZ: 2 },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();

  world
    .spawn({
      component: DirectionalLight,
      data: {
        directionX: 0.2,
        directionY: -0.98,
        directionZ: 0,
        colorR: 1,
        colorG: 1,
        colorB: 1,
        intensity: 1.5,
        // Single cascade so the cube/ground land in the tile-0 slot the probe
        // samples (same migration the prior M2/M3 fixtures relied on).
        cascadeCount: 1,
        mapSize: 1024,
        shadowDistance: 50,
        pcfKernelSize,
      },
    })
    .unwrap();

  world
    .spawn(
      { component: Transform, data: { posX: 0, posY: 0, posZ: 10, quatW: 1 } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -5,
          right: 5,
          bottom: -5,
          top: 5,
          near: 0.1,
          far: 100,
          fov: 0,
          aspect: 1,
        } as Record<string, unknown> as never,
      },
    )
    .unwrap();
}

describe('shadow M3 dawn: merged DirectionalLight shadow params -> View UBO + variable PCF', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node binding injection failed", () => {
    expect(dawnReady).toBe(true);
  });

  it('composed default-standard-pbr drives shadow bias + PCF from View uniforms (D-1/D-2)', () => {
    const wgsl = composedStandardPbr();
    // D-1: bias is derived from the View UBO's normalBias (slope) + depthBias
    // (floor), replacing the prior hardcoded max(0.05*(1-N.L), 0.005).
    expect(wgsl).toContain('normalBias');
    expect(wgsl).toContain('depthBias');
    // D-2: the directional PCF loop is driven by view.pcfKernelSize via a
    // runtime-clamped kernel half-extent (constant trip count to MAX_PCF_HALF,
    // per-iteration radius clip — the variant-free pattern merged from
    // 5.3-production-shadow-demos AC-14), not a fixed 3x3.
    expect(wgsl).toContain('pcfKernelSize');
    // Composition inlines the MAX_PCF_HALF const (5u) and the kernel clamp; the
    // runtime kernel/half derivation survives as the observable wiring proof.
    expect(wgsl).toMatch(/let\s+kernel\s*[:=]\s*clamp\(/);
    expect(wgsl).toMatch(/let\s+half\s*[:=]/);
    // The fixed /9.0 divisor must be gone (replaced by the runtime tapCount).
    expect(wgsl).not.toMatch(/blocked\s*\/\s*9\.0/);
  });

  it.skipIf(!dawnReady)(
    'merged DirectionalLight casts a shadow (occluded < lit) via debugSampleShadowFactor',
    async () => {
      const { canvas, getDevice } = createMockCanvas();
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
      expect(renderer.backend).toBe('webgpu');
      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);

      const world = new World();
      buildShadowScene(world, 7);
      world.update();
      const draw = renderer.draw([world], { owner: 0 });
      expect(draw.ok).toBe(true);
      const device = getDevice();
      if (device !== undefined) await device.queue.onSubmittedWorkDone();

      // Occluded ground positions under the cube vs a lit position well outside
      // the shadow. The probe reads the shadow atlas the merged component's
      // shadow fields populated.
      const occluded: [number, number, number][] = [
        [0, 0, 0],
        [0.5, 0, 0],
      ];
      const lit: [number, number, number][] = [[-4, 0, 0]];
      const occRes = await renderer.debugSampleShadowFactor?.(occluded);
      const litRes = await renderer.debugSampleShadowFactor?.(lit);
      expect(occRes).not.toBeNull();
      expect(litRes).not.toBeNull();
      if (!occRes || !litRes) throw new Error('debugSampleShadowFactor returned null');

      for (const r of occRes) expect(r.shadowFactor).toBeLessThan(0.5);
      for (const r of litRes) expect(r.shadowFactor).toBeGreaterThan(0.9);
    },
  );

  it.skipIf(!dawnReady)(
    'all clamped kernel sizes render cleanly (View UBO byte layout intact, AC-08)',
    async () => {
      const { canvas, getDevice } = createMockCanvas();
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);
      const device = getDevice();

      // Walk every host-clamp target {1,3,5} plus an over-cap value (9 -> 5);
      // each must drive a valid View UBO write + draw without a structured
      // RhiError / device loss. A byte layout out of sync with the WGSL struct
      // would fail compile/validate.
      for (const ks of [1, 3, 5, 9]) {
        const world = new World();
        buildShadowScene(world, ks);
        world.update();
        const draw = renderer.draw([world], { owner: 0 });
        expect(draw.ok, `draw failed at pcfKernelSize=${ks}`).toBe(true);
        if (device !== undefined) await device.queue.onSubmittedWorkDone();
      }
    },
  );
});
