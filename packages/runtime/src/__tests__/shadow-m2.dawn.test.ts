// shadow-m2.dawn.test.ts - feat-20260520-directional-light-shadow-mapping
// M2 / w12+fix: AC-12 naive shadow factor sampling, fixture with occluder
// cube above ground plane, acne expected as M2 baseline artifact.
//
// AC anchor: requirements AC-12 (shadow factor < 1 for occluded, approx 1
// for non-occluded, acne presence as M2 expected artifact). plan-strategy
// D-6 (M2 red-green gate), research F3 (ShadowCalculation 5 steps, acne is
// contractual).
//
// Fixture: single DirectionalLight pointing straight down + ground plane at
// y=0 + cube occluder centred at y=1.3 (1x1x1). Shadow factor is sampled
// via renderer.debugSampleShadowFactor which reads the GPU shadow depth
// texture (copyTextureToBuffer + mapAsync) and computes the projection +
// depth comparison on the CPU.
//
// The test reads the pre-built hello-triangle shader manifest (with real
// composed WGSL for pbr + unlit + tonemap + shadow_caster) so dawn-node's
// real WebGPU device can compile the shadow pipeline and populate the
// shadow depth texture on the first draw() call.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  createRenderer,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';

// ── Fixture constants SSOT (plan-strategy section 8.1 test anchor) ─────────

/** Canvas size for the mock HTMLCanvasElement. */
const WIDTH = 256;
const HEIGHT = 256;

/** Directional light points approximately down with a slight horizontal tilt to avoid lookAt degeneracy (dir parallel to up vector). See shadow-m1.dawn.test.ts AC-11 comment on the (0,-1,0) degeneracy. */
const FIXTURE_LIGHT_DIR: [number, number, number] = [0.2, -0.98, 0];

/** Shadow map resolution. */
const FIXTURE_MAP_SIZE = 1024;

/** Ground-plane scale (flattened cube, top face at y=0). */
const GROUND_SIZE = 20;

/**
 * World-space sample positions. Light direction (0.2, -0.98, 0) = mostly
 * down with a slight +X tilt. 2x2 cube occluder at (0, 1.5, 0) casts
 * shadow toward +X on the ground (y=0). Ground points at -X are lit;
 * ground points near x=0 within the cube footprint are occluded.
 *
 * M3 probe upgrade (feat-20260520 w16): PCF with 3x3 kernel replaces the
 * naive comparison sampler; positions use ground-plane sampling to detect
 * shadow from the 2x2 cube.
 *
 * - SAMPLE_LIT_*: ground (-X, 0.0, *) — outside the cube's shadow.
 * - SAMPLE_OCCLUDED_*: ground (0, 0.0, 0) — inside the cube's shadow core.
 */
const SAMPLE_LIT_A: [number, number, number] = [-3, 0.0, 0];
const SAMPLE_LIT_B: [number, number, number] = [-2, 0.0, 1];
const SAMPLE_LIT_C: [number, number, number] = [-1.5, 0.0, -1];
const SAMPLE_OCCLUDED_A: [number, number, number] = [0.2, 0.0, 0];
const SAMPLE_OCCLUDED_B: [number, number, number] = [0.5, 0.0, 0];

// ── Manifest: pre-built hello-triangle composed WGSL ──────────────────────

/**
 * The shadow depth pass needs a valid shader manifest with WGSL for
 * `shadow_caster`. We read the hello-triangle demo's `pnpm build` output
 * `dist/shaders/manifest.json`. The manifest is loaded once per vitest
 * module via vitest's native ESM `import()` (supports both JSON and
 * top-level await in vitest's pool). We then encode it as a `data:` URL
 * so ShaderRegistry can fetch it via Node.js native fetch().
 *
 * Precondition: `pnpm -r build` (or `pnpm -F hello-triangle build`).
 *
 * Vitest dawn runs tests in Node.js ESM context, so `import()` resolves
 * relative to the source file. The relative path goes up 4 levels from
 * `packages/runtime/src/__tests__/` to the repo root, then down into
 * `apps/hello/triangle/dist/shaders/`.
 */
async function loadManifestDataUrl(): Promise<string | null> {
  // fs.readFileSync (not `await import('...json')`) so tsc does not try
  // to statically resolve the path — the manifest is a build artifact only
  // present after `pnpm -F hello-triangle build` and CI's typecheck phase
  // runs before any app build (would error TS2307 on dynamic JSON import).
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

// ── Helpers ────────────────────────────────────────────────────────────────

const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const TEXTURE_USAGE_COPY_SRC = 0x01;

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

/** Shared GPUDevice captured during adapter hook for render target creation. */
let sharedDevice: GPUDevice | undefined;

/**
 * Create a minimal offscreen render target so dawn-node can run beginRenderPass.
 */
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

/**
 * Spawn the full fixture world: light + shadow, camera, ground plane, cube
 * occluder. Components are registered, entities spawned, ready for
 * `renderer.draw(world)`.
 */
function buildFixtureWorld(): World {
  const world = new World();

  // Light + shadow on same entity.
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [FIXTURE_LIGHT_DIR[0], FIXTURE_LIGHT_DIR[1], FIXTURE_LIGHT_DIR[2]],
      color: [1, 1, 1],
      intensity: 1,
      // feat-20260613-csm M6 / w22: shadow-m2 fixture predates CSM and
      // expects all geometry to land in cascade 0 (the test reads
      // debug.center, which always samples the cascade-0 tile -- see
      // debugReadbackShadowDepth in createRenderer.ts). With cascadeCount=4
      // (CSM default), PSSM splits between [camera near,
      // shadowDistance=50] place cascade 0 in view-space z [~0.1, 3.5];
      // the fixture's geometry sits at world z=0 (camera at z=10), which
      // is in view-space z=10 -> cascade 2/3, leaving cascade 0 empty.
      // Pinning cascadeCount=1 keeps the AC-12 single-shadow contract.
      cascadeCount: 1,
      mapSize: FIXTURE_MAP_SIZE,
      shadowDistance: 50,
    },
  });

  // Camera at (0, 0, 10) identity quat looking along -Z, orthographic
  // projection wide enough to capture the ground plane (y in [-5, 5]) and
  // the cube occluder at y=1.5. feat-20260613-csm M6 / w20 fixture
  // migration: CSM fits the light-space AABB to the camera frustum, so
  // the camera must SEE the shadowable geometry for the atlas to capture
  // it (the prior fixture sat at (0,10,0) identity quat looking -Z, which
  // missed both the ground and the cube). An orthographic camera at the
  // origin's z+10 plane with extents [-5,5] x [-5,5] gives camera-space
  // frustum x in [-5,5], y in [-5,5], z in [-99.9, 9.9] -> contains the
  // cube and the ground.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 10],
        quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
    {
      component: Camera,
      data: {
        projection: 1, // orthographic
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

  // Ground plane -- flattened cube, top face at y=0.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, -0.005, 0],
        quat: [0, 0, 0, 1],
        scale: [GROUND_SIZE, 0.01, GROUND_SIZE],
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

  // Cube occluder: 2x2x2 centred at y=1.5 (matches M3 fixture).
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 1.5, 0],
        quat: [0, 0, 0, 1],
        scale: [2, 2, 2],
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('shadow M2 dawn (AC-12 real)', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node binding injection failed", () => {
    expect(dawnReady).toBe(true);
  });

  describe('AC-12 naive shadow factor sampling', () => {
    it('occluded positions measurably darker than lit, lit approx 1.0', async () => {
      const manifestUrl = await loadManifestDataUrl();
      if (manifestUrl === null) {
        // manifest not built; skip gracefully
        console.warn('[AC-12] hello-triangle manifest not found -- skipping shadow test');
        return;
      }
      const canvas = createMockCanvas(WIDTH, HEIGHT);
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: manifestUrl });
      expect(renderer.backend).toBe('webgpu');

      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);

      // Build fixture world and render at least one frame to populate
      // the shadow depth texture.
      const world = buildFixtureWorld();
      const drawResult = renderer.draw([world], { owner: 0 });
      expect(drawResult.ok).toBe(true);

      // Verify the shadow RT exists (shadow pass ran).
      const debug = await renderer.debugReadback?.();
      expect(debug).not.toBeNull();
      if (debug !== null && debug !== undefined) {
        expect(debug.mapSize).toBe(FIXTURE_MAP_SIZE);
        expect(debug.center).toBeGreaterThanOrEqual(0);
        expect(debug.center).toBeLessThanOrEqual(1);
        console.warn('[AC-12 debug] debugReadback:', JSON.stringify(debug));

        // ── Core fix (M1c gap): shadow depth must have non-zero, non-
        //    uniform values. These are load-bearing — they prove the
        //    shadow depth pass wrote real geometry to the depth32float
        //    attachment.
        // feat-20260613-csm M6 / w22: the legacy fixed-extent path placed
        // the cube at the tile centre; CSM AABB-fits the camera frustum
        // so the cube lands wherever its world-space projection maps under
        // the per-cascade ortho. The substantive AC-12 check is the
        // lit/occluded factor gap below (probe path is shader-identical
        // to the main pass). Replace centre/corner pixel checks with a
        // non-uniformity probe: at least one of the 5 sampled pixels must
        // have written cube depth (< 1), proving the depth pass ran.
        const samples = [
          debug.center,
          debug.corners.tl,
          debug.corners.tr,
          debug.corners.bl,
          debug.corners.br,
        ];
        expect(samples.some((s) => s < 0.99)).toBe(true);
        expect(samples.some((s) => s > 0.5)).toBe(true);
      }

      // Sample shadow factor at lit positions.
      const litPositions = [SAMPLE_LIT_A, SAMPLE_LIT_B, SAMPLE_LIT_C];
      const litResults = await renderer.debugSampleShadowFactor?.(litPositions);
      expect(litResults).not.toBeNull();
      if (!litResults) throw new Error('unreachable: debugSampleShadowFactor returned null');
      expect(litResults.length).toBe(3);

      // Sample shadow factor at occluded positions.
      const occPositions = [SAMPLE_OCCLUDED_A, SAMPLE_OCCLUDED_B];
      const occResults = await renderer.debugSampleShadowFactor?.(occPositions);
      expect(occResults).not.toBeNull();
      if (!occResults) throw new Error('unreachable: occluded debugSampleShadowFactor null');
      expect(occResults.length).toBe(2);

      const litFactors = litResults.map((r) => r.shadowFactor);
      const occFactors = occResults.map((r) => r.shadowFactor);

      console.warn('[AC-12 debug] litFactors:', JSON.stringify(litFactors));
      console.warn('[AC-12 debug] occFactors:', JSON.stringify(occFactors));

      // Also check directionalShadow for lightSpaceMatrix
      const ds = renderer.directionalShadow;
      console.warn('[AC-12 debug] directionalShadow mapSize:', ds?.mapSize);
      console.warn('[AC-12 debug] directionalShadow lightSpaceMatrix:', ds?.lightSpaceMatrix);

      // ── AC-12 numerical assertion (OOS-7 retired by feat-20260520 M2/w15).
      //
      // debugSampleShadowFactor now drives a fragment-stage GPU probe
      // pipeline that runs textureSampleCompareLevel byte-for-byte mirroring
      // pbr.wgsl::evalDirectional() — same UV remap, same OOB guard, same
      // PipelineState.shadowSampler. The factor returned for a world
      // position is the exact factor a fragment at that worldPos receives
      // in the main pass, so the lit-vs-occluded gap is load-bearing
      // semantic evidence the M2 shadow lookup is wired correctly.
      //
      // Lit positions land on the -X side of the light frustum where the
      // cube does not project; comparison returns 1 (fully lit). Occluded
      // positions land on the +X side under the cube's projected shadow;
      // comparison returns 0 (fully shadowed). M2 has no PCF (M3 work),
      // so values cluster at the discrete 0/1 endpoints and the gap is
      // the full unit interval.
      const litMin = Math.min(...litFactors);
      const occMax = Math.max(...occFactors);
      expect(litMin).toBeGreaterThan(0.5);
      expect(occMax).toBeLessThan(0.2);
      // The lit/occluded gap is the AC-12 semantic guarantee — that the
      // shadow term in the main pass actually responds to occluder
      // geometry (M3 probe with PCF preserves this gap).
      expect(litMin - occMax).toBeGreaterThan(0.3);
    });
  });
});
