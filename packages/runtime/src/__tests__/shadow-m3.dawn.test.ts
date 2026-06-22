// shadow-m3.dawn.test.ts - feat-20260520-directional-light-shadow-mapping
// M3 / w15: AC-13 slope-scaled bias + 3×3 PCF shadow factor calibration test.
// Fixture: same DirectionalLight + cube + ground as M2, plus additional
// ground-plane acne samples and edge-of-shadow penumbra samples.
//
// AC anchor: requirements AC-13 (M3 acne reduction threshold X calibrated;
// edge PCF produces intermediate (0,1) values). plan-strategy D-4
// (calibration-then-frozen threshold), D-6 (M3 red-green gate).
//
// The test is RED until w16 implements bias+PCF in pbr.wgsl and the
// calibration helper shadow-m3-calibrate.ts pins the AC_13_THRESHOLD_X
// constant. X = 0.05 is the pre-calibration placeholder.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  createRenderer,
  DirectionalLight,
  DirectionalLightShadow,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';

// ── Fixture constants SSOT ──────────────────────────────────────────────────

const WIDTH = 256;
const HEIGHT = 256;

/** Directional light: mostly down with slight +X horizontal tilt. Same as M2 to keep the shadow direction consistent across milestones. */
const FIXTURE_LIGHT_DIR: [number, number, number] = [0.2, -0.98, 0];

const FIXTURE_MAP_SIZE = 1024;

const GROUND_SIZE = 20;

// ── AC-13 threshold (placeholder → calibrated in w16 freeze commit) ─────────

/** Calibrated AC-13 threshold (D-4 protocol). Measured acne factors all 1.0; max(diff)=0 => X=floor(0*0.5*100)/100=0, floored to 0.02. Commit: after w16 bias+PCF. */
const AC_13_THRESHOLD_X = 0.02;

// ── Sample positions ────────────────────────────────────────────────────────

/**
 * Acne samples: positions on the ground plane (y=0.0) in the lit region (-X side)
 * where M2 naive comparison spuriously produces shadow factor < 1 due to
 * surface self-shadowing (depth precision / slope aliasing). M3 bias+PCF
 * should fix these to approximately 1.
 *
 * The 2x2 cube occluder shadow projects +X (light tilts (0.2, -0.98, 0)).
 * The lit -X region (x < -1) should be fully lit. Acne from ground-plane
 * self-shadowing in M2 is what M3 bias suppresses.
 */
const SAMPLE_ACNE_A: [number, number, number] = [-4, 0, 0];
const SAMPLE_ACNE_B: [number, number, number] = [-3, 0, 2];
const SAMPLE_ACNE_C: [number, number, number] = [-4, 0, -2];
const SAMPLE_ACNE_D: [number, number, number] = [-2.5, 0, -1];
const SAMPLE_ACNE_E: [number, number, number] = [-3.5, 0, 1];
const SAMPLE_ACNE_F: [number, number, number] = [-2, 0, -2.5];
const SAMPLE_ACNE_G: [number, number, number] = [-4.5, 0, -0.5];
const SAMPLE_ACNE_H: [number, number, number] = [-1.5, 0, 2.5];
const SAMPLE_ACNE_I: [number, number, number] = [-3, 0, -1.5];
const SAMPLE_ACNE_J: [number, number, number] = [-5, 0, 0.5];

/**
 * Edge / penumbra samples: positions near the shadow boundary on the ground
 * (y=0) where M2 binary lookup produces 0 or 1 but M3 3x3 PCF should soften
 * to intermediate values in (0, 1). These prove the PCF kernel is producing
 * non-trivial blended results.
 *
 * Geometry: 2x2x2 cube centred at (0, 1.5, 0). Cube footprint on ground
 * (y=0) extends x in [-1, 1]. Light direction (0.2, -0.98, 0) tilts +X.
 * Shadow displacement = y_bottom * tan(angle) = 0.5 * 0.2/0.98 ≈ 0.10.
 * Shadow core on ground: x in [0.5 - 1 + 0.1, 0.5 + 1 + 0.1] = [-0.4, 1.6].
 *
 * Penumbra width ~3 texels (PCF kernel) = 3 * 20/1024 ≈ 0.06 world units.
 * Edge samples placed at x ~ 1.50-1.70 near the projected shadow boundary.
 */
const SAMPLE_EDGE_A: [number, number, number] = [1.5, 0.0, 0.0];
const SAMPLE_EDGE_B: [number, number, number] = [1.55, 0.0, 0.1];
const SAMPLE_EDGE_C: [number, number, number] = [1.6, 0.0, -0.1];
const SAMPLE_EDGE_D: [number, number, number] = [1.65, 0.0, -0.2];
const SAMPLE_EDGE_E: [number, number, number] = [1.7, 0.0, 0.2];

/**
 * Occluded samples: positions well inside the shadow core of the 2x2 cube
 * on the ground (y=0). M3 should still report shadow factor = 0
 * (PCF shouldn't over-light deep shadow regions).
 */
const SAMPLE_OCCLUDED_A: [number, number, number] = [0.0, 0.0, 0.0];
const SAMPLE_OCCLUDED_B: [number, number, number] = [0.5, 0.0, 0.0];

// ── Manifest loader ─────────────────────────────────────────────────────────

async function loadManifestDataUrl(): Promise<string | null> {
  // fs.readFileSync (not dynamic JSON import) so tsc does not statically
  // resolve the path — manifest only exists after `pnpm -F hello-triangle build`.
  try {
    const here = fileURLToPath(import.meta.url);
    const manifestPath = resolve(
      here,
      '../../../../../apps/hello/triangle/dist/shaders/manifest.json',
    );
    const text = readFileSync(manifestPath, 'utf8');
    return `data:application/json,${encodeURIComponent(text)}`;
  } catch {
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const TEXTURE_USAGE_COPY_SRC = 0x01;

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

let sharedDevice: GPUDevice | undefined;

function createMockCanvas(width: number, height: number): HTMLCanvasElement {
  let renderTarget: GPUTexture | undefined;
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

  const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
    if (renderTarget !== undefined) return renderTarget;
    renderTarget = device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return renderTarget;
  };

  return {
    width,
    height,
    // biome-ignore lint/suspicious/noExplicitAny: HTMLCanvasElement mock for dawn-node
    getContext(kind: string): any {
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
}

function buildFixtureWorld(): World {
  const world = new World();

  world.spawn(
    {
      component: DirectionalLight,
      data: {
        directionX: FIXTURE_LIGHT_DIR[0],
        directionY: FIXTURE_LIGHT_DIR[1],
        directionZ: FIXTURE_LIGHT_DIR[2],
        colorR: 1,
        colorG: 1,
        colorB: 1,
        intensity: 1,
      },
    },
    {
      component: DirectionalLightShadow,
      data: {
        // feat-20260613-csm M6 / w22: pin cascadeCount=1 so the AC-13
        // single-shadow contract holds. CSM default (4 cascades) splits
        // [shadow.nearPlane=0.1, shadow.farPlane=50] in view-space depth
        // and would land the cube/ground in cascade 2 instead of the
        // tile-0 slot the M3 probe samples. Same migration as shadow-m2.
        cascadeCount: 1,
        mapSize: FIXTURE_MAP_SIZE,
        nearPlane: 0.1,
        farPlane: 50,
      },
    },
  );

  world.spawn(
    {
      component: Transform,
      data: {
        // feat-20260613-csm M6 / w22 fixture migration: camera moved from
        // (0, 10, 0) identity quat to (0, 0, 10). Identity quat -> look -Z;
        // the prior camera sat above the geometry but pointed at the +X/+Z
        // wall instead of the ground, so the CSM AABB-fit (which contains
        // the camera frustum, not the world origin) excluded both the
        // ground and the cube and the shadow atlas stayed empty.
        posX: 0,
        posY: 0,
        posZ: 10,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
    },
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
      },
    },
  );

  // Ground plane — flattened cube, top face at y=0.
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: -0.005,
        posZ: 0,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: GROUND_SIZE,
        scaleY: 0.01,
        scaleZ: GROUND_SIZE,
      },
    },
    {
      component: MeshFilter,
      data: { assetHandle: HANDLE_CUBE },
    },
    {
      component: MeshRenderer,
      data: {},
    },
  );

  // Cube occluder: 2x2x2 centred at y=1.5 (bottom at y=0.5, top at y=2.5).
  // Larger cube casts a wider shadow for easier PCF penumbra detection.
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 1.5,
        posZ: 0,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 2,
        scaleY: 2,
        scaleZ: 2,
      },
    },
    {
      component: MeshFilter,
      data: { assetHandle: HANDLE_CUBE },
    },
    {
      component: MeshRenderer,
      data: {},
    },
  );

  return world;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('shadow M3 dawn (AC-13)', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node binding injection failed", () => {
    expect(dawnReady).toBe(true);
  });

  describe('AC-13 M3 slope-scaled bias + 3x3 PCF', () => {
    it('acne samples are nearly unshadowed (shadow factor >= 1 - X)', async () => {
      const manifestUrl = await loadManifestDataUrl();
      if (manifestUrl === null) {
        console.warn('[AC-13] hello-triangle manifest not found -- skipping M3 test');
        return;
      }
      const canvas = createMockCanvas(WIDTH, HEIGHT);
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: manifestUrl });
      expect(renderer.backend).toBe('webgpu');

      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);

      const world = buildFixtureWorld();
      const drawResult = renderer.draw(world);
      expect(drawResult.ok).toBe(true);

      const acnePositions = [
        SAMPLE_ACNE_A,
        SAMPLE_ACNE_B,
        SAMPLE_ACNE_C,
        SAMPLE_ACNE_D,
        SAMPLE_ACNE_E,
        SAMPLE_ACNE_F,
        SAMPLE_ACNE_G,
        SAMPLE_ACNE_H,
        SAMPLE_ACNE_I,
        SAMPLE_ACNE_J,
      ];
      const acneResults = await renderer.debugSampleShadowFactor?.(acnePositions);
      expect(acneResults).not.toBeNull();
      if (!acneResults) throw new Error('unreachable: acne debugSampleShadowFactor null');
      expect(acneResults.length).toBe(acnePositions.length);

      const acneFactors = acneResults.map((r) => r.shadowFactor);
      console.warn('[AC-13 debug] acneFactors:', JSON.stringify(acneFactors));

      // AC-13: all acne positions should be ≥ 1 - X after bias+PCF.
      // M2 naive showed spurious sub-1 values; M3 should fix them.
      for (let i = 0; i < acneFactors.length; i++) {
        const f = acneFactors[i] as number;
        expect(f).toBeGreaterThanOrEqual(1 - AC_13_THRESHOLD_X);
      }
    });

    it('edge samples produce intermediate PCF values in (0, 1)', async () => {
      const manifestUrl = await loadManifestDataUrl();
      if (manifestUrl === null) {
        console.warn('[AC-13 edge] hello-triangle manifest not found -- skipping');
        return;
      }
      const canvas = createMockCanvas(WIDTH, HEIGHT);
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: manifestUrl });
      expect(renderer.backend).toBe('webgpu');

      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);

      const world = buildFixtureWorld();
      const drawResult = renderer.draw(world);
      expect(drawResult.ok).toBe(true);

      const edgePositions = [
        SAMPLE_EDGE_A,
        SAMPLE_EDGE_B,
        SAMPLE_EDGE_C,
        SAMPLE_EDGE_D,
        SAMPLE_EDGE_E,
      ];
      const edgeResults = await renderer.debugSampleShadowFactor?.(edgePositions);
      expect(edgeResults).not.toBeNull();
      if (!edgeResults) throw new Error('unreachable: edge debugSampleShadowFactor null');
      expect(edgeResults.length).toBe(edgePositions.length);

      const edgeFactors = edgeResults.map((r) => r.shadowFactor);
      console.warn('[AC-13 debug] edgeFactors:', JSON.stringify(edgeFactors));

      // At least one edge sample must produce a value strictly between 0 and 1,
      // proving the 3x3 PCF kernel softens the shadow edge instead of producing
      // binary 0/1 decisions.
      const hasIntermediate = edgeFactors.some((f) => f > 0.05 && f < 0.95);
      expect(hasIntermediate).toBe(true);
    });

    it('occluded samples stay deeply shadowed (<= 0.1)', async () => {
      const manifestUrl = await loadManifestDataUrl();
      if (manifestUrl === null) {
        console.warn('[AC-13 occ] hello-triangle manifest not found -- skipping');
        return;
      }
      const canvas = createMockCanvas(WIDTH, HEIGHT);
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: manifestUrl });
      expect(renderer.backend).toBe('webgpu');

      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);

      const world = buildFixtureWorld();
      const drawResult = renderer.draw(world);
      expect(drawResult.ok).toBe(true);

      const occPositions = [SAMPLE_OCCLUDED_A, SAMPLE_OCCLUDED_B];
      const occResults = await renderer.debugSampleShadowFactor?.(occPositions);
      expect(occResults).not.toBeNull();
      if (!occResults) throw new Error('unreachable: occluded debugSampleShadowFactor null');
      expect(occResults.length).toBe(occPositions.length);

      const occFactors = occResults.map((r) => r.shadowFactor);
      console.warn('[AC-13 debug] occFactors:', JSON.stringify(occFactors));

      // Deep-shadow positions must stay shadowed — PCF shouldn't blur the
      // entire shadow core away.
      for (const f of occFactors) {
        expect(f).toBeLessThanOrEqual(0.1);
      }
    });
  });
});
