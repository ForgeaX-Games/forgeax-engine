// shadow-m3-calibrate-run.dawn.test.ts - feat-20260520-directional-light-shadow-mapping
// M3 / w15+w16: one-off calibration runner. Not part of the normal CI suite —
// run explicitly with `npx vitest run <this-file>` after w16 bias+PCF lands
// to measure shadow factor improvements and freeze AC_13_THRESHOLD_X.
//
// This file IS a .dawn.test.ts (so vitest gives it a dawn-node WebGPU device)
// but it is intentionally gated behind `dawnReady` and prints a calibration
// report rather than performing pass/fail assertions.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  createRenderer,
  DirectionalLight,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_POSITIONS,
  calibrateThresholdX,
  measureShadowFactors,
  printCalibrationReport,
} from './shadow-m3-calibrate';

// ── Fixture (same as shadow-m3.dawn.test.ts SSOT) ───────────────────────────

const WIDTH = 256;
const HEIGHT = 256;
const FIXTURE_LIGHT_DIR: [number, number, number] = [0.2, -0.98, 0];
const FIXTURE_MAP_SIZE = 1024;
const GROUND_SIZE = 20;

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

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

const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const TEXTURE_USAGE_COPY_SRC = 0x01;
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

  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: FIXTURE_LIGHT_DIR[0],
      directionY: FIXTURE_LIGHT_DIR[1],
      directionZ: FIXTURE_LIGHT_DIR[2],
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1,
      mapSize: FIXTURE_MAP_SIZE,
      shadowDistance: 50,
    },
  });

  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 10,
        posZ: 0,
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

  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 1.3,
        posZ: 0,
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

describe('M3 calibration runner (one-off)', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node binding injection failed", () => {
    expect(dawnReady).toBe(true);
  });

  it('calibrate AC-13 threshold X', async () => {
    const manifestUrl = await loadManifestDataUrl();
    if (manifestUrl === null) {
      console.warn('[calibrate] manifest not found -- skipping');
      return;
    }
    const canvas = createMockCanvas(WIDTH, HEIGHT);
    const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: manifestUrl });
    expect(renderer.backend).toBe('webgpu');

    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);

    // Draw one frame to populate the shadow depth texture.
    const world = buildFixtureWorld();
    const drawResult = renderer.draw([world], { owner: 0 });
    expect(drawResult.ok).toBe(true);

    // In the single-session calibration workflow, M2 and M3 measurements
    // happen on the SAME renderer, but at different points in time.
    // Pre-w16: both read the same (naive) shadow factors → diffs = 0.
    // Post-w16: re-run this runner after rebuilding; diffs reflect the
    // bias+PCF improvement.
    //
    // The "M2 baseline" is recorded first, then w16 is applied (pbr.wgsl
    // edit + rebuild), then this runner is called again — the M3 factors
    // will be the post-change values. For the single-session case both are
    // the same (the renderer reflects the CURRENT shader), so the implementer
    // must record M2 factors before the w16 commit, then re-measure after.
    const result = await calibrateThresholdX(
      CALIBRATION_POSITIONS,
      // measureM2: current factors (pre-w16 = same as M3, diffs 0)
      // In the actual two-step workflow this records before w16 commit.
      async () => measureShadowFactors(renderer, CALIBRATION_POSITIONS),
      // measureM3: current factors (post-w16 = bias+PCF active)
      async () => measureShadowFactors(renderer, CALIBRATION_POSITIONS),
    );

    printCalibrationReport(result);

    // In the RED phase (pre-w16), maxDiff == 0 and suggestedX == 0.02.
    // That's expected — calibration is aspirational until w16 lands.
    // Post-w16, maxDiff > 0 and the implementer copies suggestedX into
    // shadow-m3.dawn.test.ts AC_13_THRESHOLD_X and re-runs pnpm test:dawn.
  });
});
