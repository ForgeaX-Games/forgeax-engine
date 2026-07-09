// instances-uniform-fallback.dawn.test.ts -- feat-20260604-instances-per-instance-transform-shader-group3-bin
// M1 / w6.
//
// AC-07: storage-buffer path + uniform-fallback path both compile and render
// correctly for <=128 instances.
//
// Primary path: dawn-node renders <=128 instances through the normal storage
// buffer path (caps.storageBuffer===true on dawn) and asserts frames are
// non-clear (proves the storage variant renders).
//
// Degraded path (research R-C partial): dawn-node always has
// caps.storageBuffer===true, so we cannot force the uniform-fallback variant
// at the GPU level. Instead, we verify that:
//   (a) The uniform-fallback #else form `var<uniform> instances : array<InstanceData, 128>`
//       is present in common.wgsl (source-level structural check).
//   (b) The variant count stays at 2 (verified by w1 unit test).
//   (c) A non-trivial Instances render (<=128) works on the storage path.
//
// This is the best-effort degraded path per research R-C: "if dawn cannot
// construct caps.storageBuffer===false, fall back to a vitest unit that
// asserts the #else uniform array<..,128> form compiles, with reason
// recorded."

import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

// Source-level structural check: common.wgsl must carry both the storage
// and uniform declarations of the instances binding under #ifdef / #else
// STORAGE_BUFFER_AVAILABLE.

interface NodeFsW6 {
  readFileSync: (p: string, enc: string) => string;
}
interface NodePathW6 {
  resolve: (...parts: string[]) => string;
  dirname: (p: string) => string;
}
interface NodeModuleW6 {
  createRequire: (filename: string | URL) => { resolve: (id: string) => string };
}

const STORAGE_PATTERN =
  /@group\(3\)\s+@binding\(0\)\s+var<storage,\s*read>\s+instances\s*:\s*array<InstanceData>/;
const UNIFORM_PATTERN =
  /@group\(3\)\s+@binding\(0\)\s+var<uniform>\s+instances\s*:\s*array<InstanceData,\s*128>/;

describe('w6 -- AC-07 storage+uniform variant test (degraded best-effort)', () => {
  it('(a) common.wgsl declares uniform-fallback array<InstanceData,128> under #else', async () => {
    const fsId = 'node:fs';
    const pathId = 'node:path';
    const moduleId = 'node:module';
    const fs = (await import(/* @vite-ignore */ fsId)) as NodeFsW6;
    const path = (await import(/* @vite-ignore */ pathId)) as NodePathW6;
    const mod = (await import(/* @vite-ignore */ moduleId)) as NodeModuleW6;
    const req = mod.createRequire(import.meta.url);
    const pkg = req.resolve('@forgeax/engine-shader/package.json');
    const srcDir = path.resolve(path.dirname(pkg), 'src');
    const commonSrc = fs.readFileSync(path.resolve(srcDir, 'common.wgsl'), 'utf8');

    // Both forms must be present
    expect(commonSrc).toMatch(STORAGE_PATTERN);
    expect(commonSrc).toMatch(UNIFORM_PATTERN);

    // The #if/#else must wrap the instances declaration.
    // bug-20260610: switched `#ifdef X` → `#if X == true` (naga_oil's
    // `#ifdef` only checks key presence, not the value; ==/!= is needed
    // to make the false branch actually live).
    expect(commonSrc).toMatch(/#if\s+STORAGE_BUFFER_AVAILABLE\s*==\s*true[\s\S]*@group\(3\)/);
    expect(commonSrc).toMatch(/#else[\s\S]*@group\(3\)/);
    expect(commonSrc).toMatch(/@group\(3\)[\s\S]*#endif/);
  });

  it('(a) common.wgsl InstanceData struct is declared', async () => {
    const fsId = 'node:fs';
    const pathId = 'node:path';
    const moduleId = 'node:module';
    const fs = (await import(/* @vite-ignore */ fsId)) as NodeFsW6;
    const path = (await import(/* @vite-ignore */ pathId)) as NodePathW6;
    const mod = (await import(/* @vite-ignore */ moduleId)) as NodeModuleW6;
    const req = mod.createRequire(import.meta.url);
    const pkg = req.resolve('@forgeax/engine-shader/package.json');
    const srcDir = path.resolve(path.dirname(pkg), 'src');
    const commonSrc = fs.readFileSync(path.resolve(srcDir, 'common.wgsl'), 'utf8');

    // InstanceData struct has localFromInstance mat4 field
    expect(commonSrc).toMatch(/struct\s+InstanceData\s*\{/);
    expect(commonSrc).toMatch(/localFromInstance\s*:\s*mat4x4<f32>/);
  });

  // (b) deg-path rationale: dawn-node always has caps.storageBuffer===true, so
  // the uniform-fallback path cannot be exercised at the GPU level in this
  // dawn test. The uniform-fallback variant is structurally verified via:
  //   - w1 source-level variant=2 unit test (AC-11)
  //   - w6 (a) source-level uniform array<..,128> form check above
  //   - naga_oil compiles both variants at build-time (vite-plugin-shader)
  // Restore as a real `it()` if a dawn-side uniform-fallback path becomes
  // reachable (feat-20260608-ci-time-cut converted from `expect(true)`).
  it.todo('(b) deg-path rationale recorded: dawn-node always storageBuffer=true');

  it('(c) storage path renders Instances (dawn smoke integration)', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
    }

    // Render <=128 instances on the storage path and assert non-clear output.
    // This proves the storage-buffer variant of @group(3) instances works
    // end-to-end on dawn.

    const { World } = await import('@forgeax/engine-ecs');
    const {
      AssetRegistry,
      Camera,
      createRenderer,
      HANDLE_CUBE,
      Instances,
      MeshFilter,
      MeshRenderer,
      Transform,
    } = await import('@forgeax/engine-runtime');
    const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
    const ENGINE_MANIFEST_W6 = await buildEngineShaderManifest();
    const ENGINE_MANIFEST_URL_W6 = `data:application/json,${encodeURIComponent(
      JSON.stringify(ENGINE_MANIFEST_W6),
    )}`;

    const W6_WIDTH = 256;
    const W6_HEIGHT = 256;

    let sharedDevice: GPUDevice | undefined;
    const origReq = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
    globalThis.navigator.gpu.requestAdapter = async (opts) => {
      const rawAdapter = await origReq(opts);
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
    const ensureTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
      if (renderTarget !== undefined) return renderTarget;
      renderTarget = device.createTexture({
        size: { width: W6_WIDTH, height: W6_HEIGHT, depthOrArrayLayers: 1 },
        format,
        usage: 0x10 | 0x01,
        viewFormats: ['rgba8unorm-srgb'],
      });
      return renderTarget;
    };
    const mockCanvas = {
      width: W6_WIDTH,
      height: W6_HEIGHT,
      getContext(kind: string): unknown {
        if (kind !== 'webgpu') return null;
        return {
          configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
            ensureTarget(desc.device, desc.format ?? 'rgba8unorm');
          },
          unconfigure() {},
          getCurrentTexture(): GPUTexture {
            if (renderTarget === undefined) {
              if (sharedDevice === undefined)
                throw new Error('render target requested before device captured');
              return ensureTarget(sharedDevice, 'rgba8unorm');
            }
            return renderTarget;
          },
        };
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;

    let renderer: Awaited<ReturnType<typeof createRenderer>>;
    try {
      renderer = await createRenderer(
        mockCanvas,
        {},
        { shaderManifestUrl: ENGINE_MANIFEST_URL_W6 },
      );
    } finally {
      globalThis.navigator.gpu.requestAdapter = origReq;
    }
    expect(renderer.backend).toBe('webgpu');

    const assets = renderer.assets;
    if (assets === null) throw new Error('AssetRegistry null');
    expect(assets).toBeInstanceOf(AssetRegistry);

    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    const matAsset: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-unlit',
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      ],
      paramValues: { baseColor: [0.9, 0.2, 0.2, 1], metallic: 0, roughness: 0.5 },
    } as MaterialAsset;

    // Build ~60 instances (well under 128 uniform cap), 2D grid
    const GRID = 8;
    const COUNT = GRID * GRID; // 64
    const SP = 3.0;
    const transforms = new Float32Array(COUNT * 16);
    let idx = 0;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const base = idx * 16;
        transforms[base + 0] = 1;
        transforms[base + 5] = 1;
        transforms[base + 10] = 1;
        transforms[base + 12] = (x - (GRID - 1) / 2) * SP;
        transforms[base + 13] = (y - (GRID - 1) / 2) * SP;
        transforms[base + 14] = 0;
        transforms[base + 15] = 1;
        idx++;
      }
    }

    const world = new World();
    const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      matAsset,
    );
    world.spawn(
      {
        component: Transform,
        data: {
          posX: 0,
          posY: 0,
          posZ: 0,
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: 0.3,
          scaleY: 0.3,
          scaleZ: 0.3,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
      { component: Instances, data: { transforms } },
    );
    world.spawn(
      {
        component: Transform,
        data: {
          posX: 0,
          posY: 0,
          posZ: 25,
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
          fov: (45 * Math.PI) / 180,
          aspect: 1,
          near: 0.1,
          far: 200,
          // feat-20260608 TASK-007: clearColor moved from createRenderer to
          // Camera component. Clear values must match the (13, 13, 20) sRGB
          // bytes referenced at line ~316-318 (linear [0.05, 0.05, 0.08]).
          clearR: 0.05,
          clearG: 0.05,
          clearB: 0.08,
          clearA: 1,
        },
      },
    );

    for (let i = 0; i < 5; i++) {
      const r = renderer.draw([world], { owner: 0 });
      if (!r.ok) throw new Error(`draw frame ${i} error: ${r.error.code}`);
    }
    await sharedDevice?.queue.onSubmittedWorkDone();

    expect(renderTarget).toBeDefined();
    if (renderTarget === undefined) return;

    if (sharedDevice === undefined) return;
    const device = sharedDevice;
    const bytesPerRow = Math.ceil((W6_WIDTH * 4) / 256) * 256;
    const readbackBuf = device.createBuffer({
      size: bytesPerRow * W6_HEIGHT,
      usage: 0x01 | 0x08,
    });
    {
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: renderTarget },
        { buffer: readbackBuf, bytesPerRow, rowsPerImage: W6_HEIGHT },
        { width: W6_WIDTH, height: W6_HEIGHT, depthOrArrayLayers: 1 },
      );
      device.queue.submit([enc.finish()]);
    }
    await readbackBuf.mapAsync(0x01);
    const mapped = readbackBuf.getMappedRange();
    const bytes = new Uint8Array(mapped.slice(0));
    readbackBuf.unmap();
    readbackBuf.destroy();

    // Sample multiple positions — the 8x8 grid should fill a substantial
    // portion of the frame. Center should NOT be clear-color.
    const cx = W6_WIDTH >> 1;
    const cy = W6_HEIGHT >> 1;
    const readPixel = (px: number, py: number): [number, number, number] => {
      const off = py * bytesPerRow + px * 4;
      return [bytes[off + 2] ?? 0, bytes[off + 1] ?? 0, bytes[off + 0] ?? 0];
    };
    const [cr, cg, cb] = readPixel(cx, cy);
    // Clear color is ~(13, 13, 20) in sRGB bytes. Center should be
    // significantly different (red cubes).
    const distFromClear = Math.sqrt((cr - 13) ** 2 + (cg - 13) ** 2 + (cb - 20) ** 2);
    expect(distFromClear).toBeGreaterThan(30);
  });
});
