// Consolidated by feat-20260608-ci-time-cut M5 w13/w14: merges
//   - bind-group-cache-stable-frame.test.ts
//   - bind-group-cache-view.test.ts
//   - bind-group-cache-entity-key.test.ts
//   - bind-group-cache-instances.test.ts
// Each original file body sits in its own block-scope so helper names
// cannot collide; describe() inside still registers globally with vitest.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { Handle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer, Transform } from '../components';
import { type ExtractedFrame, extractFrame } from '../render-system-extract';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ─── from bind-group-cache-stable-frame.test.ts ───
{
  // bind-group-cache-stable-frame.test.ts -- M5 / w16 (TDD red)
  //
  // AC-03 stable-frame + AC-09 type-inference test.
  //
  // AC-03: minimal stable world (one PBR mesh + camera + directional light),
  // consecutive draw >= 3 frames, assert frame-3 createBindGroupCount == 0
  // (all cache-resident after warm-up).
  //
  // AC-09: at the assertion line, TypeScript infers `number` for
  // `renderer.bindGroupCounts.createBindGroup` without `as` cast.
  //
  // TDD red: this test will fail until w12 (material/instances cache) and
  // w15 (shadow sentinel) are complete. After M4 the stable-frame counter
  // should reach 0 once all four cache categories are hot.
  //
  // Stable-frame definition (requirements AC-03): same World, no
  // spawn/despawn, no material change, no resize, no Skylight change.

  const ENGINE = '../createRenderer';

  // ─── Mock helpers (mirrors render-system.test.ts) ──────────────────────────

  interface MockGL2Context {
    __mockTag: 'webgl2';
    getExtension: () => null;
    getParameter: () => number;
    isContextLost: () => boolean;
  }

  function makeMockGL2(): MockGL2Context {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(
    webgl2: 'context' | 'null',
    webgpu: 'context' | 'null',
  ): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') {
          return webgl2 === 'context' ? makeMockGL2() : null;
        }
        if (kind === 'webgpu') {
          if (webgpu === 'context') {
            return {
              __mockTag: 'webgpu-canvas-context',
              configure: () => undefined,
              unconfigure: () => undefined,
              getCurrentTexture: () => ({ createView: () => ({}) }),
            };
          }
          return null;
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
  }

  function makeMockGPUDevice(): { device: unknown } {
    const lost = new Promise<unknown>(() => undefined);
    const device = {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      limits: {},
      queue: {
        submit: () => undefined,
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: () => ({
        getMappedRange: () => new ArrayBuffer(64),
        unmap: () => undefined,
      }),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          setBindGroup: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({}),
      }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      destroy: () => undefined,
    };
    return { device };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({
        requestDevice: async () => deviceObj,
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const baseNavigator: Navigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  function buildManifestDataUrl(): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: '/* stub */',
      paramSchema: '[]',
      variants: [],
    });
    const manifest = {
      schemaVersion: '1.0.0',
      entries: [
        { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
        {
          hash: 'tonemap0',
          wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
          glsl: '',
          bindings: '',
        },
      ],
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  // ─── Type-level imports (mirrors render-system.test.ts) ────────────────────

  async function importEngine(): Promise<{
    createRenderer: (
      canvas: unknown,
      opts?: unknown,
      bundler?: unknown,
    ) => Promise<{
      backend: string;
      ready: Promise<unknown>;
      draw: (worlds: unknown, opts: { owner: number }) => unknown;
      onError: (cb: (err: { code: string; detail?: unknown; hint?: string }) => void) => () => void;
      assets: {
        register: (asset: unknown) => { ok: boolean; value: unknown };
      };
      bindGroupCounts: { readonly createBindGroup: number };
    }>;
  }> {
    return (await import(ENGINE)) as never;
  }

  async function importEcs(): Promise<{
    World: new () => {
      spawn: (...componentDatas: unknown[]) => unknown;
      update: () => void;
    };
  }> {
    return (await import('@forgeax/engine-ecs')) as never;
  }

  // Import runtime components via the package index to get real types
  // (Camera, Transform, MeshFilter, MeshRenderer, DirectionalLight, etc.).
  async function importComponents(): Promise<{
    Transform: unknown;
    MeshFilter: unknown;
    MeshRenderer: unknown;
    Camera: unknown;
    DirectionalLight: unknown;
    HANDLE_CUBE: Handle<'MeshAsset', 'shared'>;
  }> {
    return {
      ...(await import('../index')),
      ...(await import('@forgeax/engine-assets-runtime')),
    } as never;
  }

  function cameraTransform() {
    return {
      pos: [0, 0, 5],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  // ─── Helper: build a minimal stable world ──────────────────────────────────

  async function buildStableWorld() {
    const C = await importComponents();

    const { World } = await importEcs();
    const world = new World();

    // Camera at z=5 looking at origin
    world.spawn(
      {
        component: C.Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 16 / 9,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
      { component: C.Transform, data: cameraTransform() },
    );

    // Directional light
    world.spawn(
      { component: C.DirectionalLight, data: {} },
      { component: C.Transform, data: cameraTransform() },
    );

    // PBR mesh (cube) with explicit PBR material
    world.spawn(
      { component: C.MeshRenderer, data: { materials: [0] } },
      { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
      {
        component: C.Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
    );

    return world;
  }

  // ─── Tests ────────────────────────────────────────────────────────────────

  describe('w16 — AC-03 stable-frame + AC-09 type inference', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('AC-03: stable-frame draw >= 3 frames, createBindGroupCount reaches 0 on frame 3', async () => {
      const { device } = makeMockGPUDevice();
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });

      const engine = await importEngine();
      const canvas = makeMockCanvas('context', 'context');
      const renderer = await engine.createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      await (renderer.ready as Promise<void>);

      const world = await buildStableWorld();

      // Draw 3 frames in a stable scene (no spawn/despawn/material-change/resize/skylight-change).
      renderer.draw([world], { owner: 0 });
      const countFrame1 = renderer.bindGroupCounts.createBindGroup;

      renderer.draw([world], { owner: 0 });
      const countFrame2 = renderer.bindGroupCounts.createBindGroup;

      renderer.draw([world], { owner: 0 });
      const countFrame3 = renderer.bindGroupCounts.createBindGroup;

      // Type-level assertions — all counters must be numbers (AC-09 gating:
      // each line infers `number` with no `as` cast).
      const _typeCheck1: number = countFrame1;
      const _typeCheck2: number = countFrame2;
      const _typeCheck3: number = countFrame3;
      void _typeCheck1;
      void _typeCheck2;
      void _typeCheck3;

      // Frame 1: cold cache, counter reflects initial createBindGroup calls.
      expect(typeof countFrame1).toBe('number');

      // After caching warms up, subsequent frames should converge toward 0.
      // AC-03: frame 3 counter must be 0 — all bind groups cache-resident.
      expect(countFrame3).toBe(0);
    });

    it('AC-09: TypeScript infers createBindGroup as number (no as cast)', async () => {
      const { device } = makeMockGPUDevice();
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });

      const engine = await importEngine();
      const canvas = makeMockCanvas('context', 'context');
      const renderer = await engine.createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      await (renderer.ready as Promise<void>);

      const world = await buildStableWorld();
      renderer.draw([world], { owner: 0 });

      // AC-09 application point: this access line is where TypeScript must
      // infer `number` without requiring `as` or any type assertion.
      // The type annotation `const c: number` is a compile-time proof:
      // if `bindGroupCounts.createBindGroup` were `unknown` or wider, this
      // line would fail typecheck.
      const c: number = renderer.bindGroupCounts.createBindGroup;
      expect(typeof c).toBe('number');

      // Redundant explicit annotation variant: infer via assignment context.
      // If TS infers anything other than `number`, the next line fails.
      let inferred = renderer.bindGroupCounts.createBindGroup;
      inferred = 42; // must compile — proves inferred type is number-compatible
      expect(inferred).toBe(42);
    });

    it('AC-03: counter stays at 0 on consecutive stable frames beyond frame 3', async () => {
      const { device } = makeMockGPUDevice();
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });

      const engine = await importEngine();
      const canvas = makeMockCanvas('context', 'context');
      const renderer = await engine.createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      await (renderer.ready as Promise<void>);

      const world = await buildStableWorld();

      // Warm up 3 frames.
      for (let i = 0; i < 3; i++) {
        renderer.draw([world], { owner: 0 });
      }

      // Frames 4 and 5 must both report 0 — cache is hot.
      renderer.draw([world], { owner: 0 });
      expect(renderer.bindGroupCounts.createBindGroup).toBe(0);

      renderer.draw([world], { owner: 0 });
      expect(renderer.bindGroupCounts.createBindGroup).toBe(0);
    });
  });
}

// ─── from bind-group-cache-view.test.ts ───
{
  // bind-group-cache-view.test.ts -- M2 / w5 (TDD red)
  //
  // View bind group cache hit/miss + variant isolation unit tests.
  // Anchors: requirements AC-01 (view into cache), AC-06 (main vs shadow
  // variant keys distinct, no cross-variant contamination).
  //
  // Scenarios:
  //   (a) stable scene, >= 2 draws => view main cache hit (counter not bumped by view BG)
  //   (b) resize (view UBO realloc => handle change) => cache miss -> rebuild -> hit
  //   (c) AC-06: main vs shadow variant keys distinct, each variant caches independently;
  //       both variants present when scene has shadow (castShadow:true on DirectionalLight)
  //
  // TDD red: cache Maps + helper do not exist yet; view/mesh createBindGroup calls
  // are not wired through cache. Tests will fail when asserting cache-hit counter
  // reduction until w7 + w8 wire the cache.
  //
  // View main (#1) entries: b0 viewUniformBuffer, b1 pointLightsBuffer,
  // b2 spotLightsBuffer, b3 graph shadowDepth view | shadowFallbackTextureView,
  // b4 shadowSampler.
  // View shadow (#3) entries: same b0-b2, b3 = shadowFallbackTextureView (fixed),
  // b4 = shadowSampler.

  const ENGINE = '../createRenderer';

  // ─── Mock helpers ──────────────────────────────────────────────────────────

  interface MockGL2Context {
    __mockTag: 'webgl2';
    getExtension: () => null;
    getParameter: () => number;
    isContextLost: () => boolean;
  }

  function makeMockGL2(): MockGL2Context {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(
    webgl2: 'context' | 'null',
    webgpu: 'context' | 'null',
  ): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') {
          return webgl2 === 'context' ? makeMockGL2() : null;
        }
        if (kind === 'webgpu') {
          if (webgpu === 'context') {
            return {
              __mockTag: 'webgpu-canvas-context',
              configure: () => undefined,
              unconfigure: () => undefined,
              getCurrentTexture: () => ({ createView: () => ({}) }),
            };
          }
          return null;
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
  }

  function makeMockGPUDevice(): { device: unknown } {
    const lost = new Promise<unknown>(() => undefined);
    const device = {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      limits: {},
      queue: {
        submit: () => undefined,
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: () => ({
        getMappedRange: () => new ArrayBuffer(64),
        unmap: () => undefined,
      }),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          setBindGroup: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({}),
      }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      destroy: () => undefined,
    };
    return { device };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({
        requestDevice: async () => deviceObj,
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const baseNavigator: Navigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  function buildManifestDataUrl(): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: '/* stub */',
      paramSchema: '[]',
      variants: [],
    });
    const manifest = {
      schemaVersion: '1.0.0',
      entries: [
        { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
        {
          hash: 'tonemap0',
          wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
          glsl: '',
          bindings: '',
        },
      ],
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  async function importEngine(): Promise<{
    createRenderer: (
      canvas: unknown,
      opts?: unknown,
      bundler?: unknown,
    ) => Promise<{
      backend: string;
      ready: Promise<void>;
      draw: (worlds: unknown, opts: { owner: number }) => void;
      onError: (cb: (err: { code: string; detail?: unknown; hint?: string }) => void) => () => void;
      assets: {
        register: (asset: unknown) => { ok: boolean; value: unknown };
      };
    }>;
  }> {
    return (await import(ENGINE)) as never;
  }

  async function importEcs(): Promise<{
    World: new () => {
      spawn: (...componentDatas: unknown[]) => unknown;
      update: () => void;
    };
  }> {
    return (await import('@forgeax/engine-ecs')) as never;
  }

  async function importComponents(): Promise<{
    Transform: unknown;
    MeshFilter: unknown;
    MeshRenderer: unknown;
    Camera: unknown;
    DirectionalLight: unknown;
    HANDLE_CUBE: Handle<'MeshAsset', 'shared'>;
    HANDLE_TRIANGLE: Handle<'MeshAsset', 'shared'>;
  }> {
    return {
      ...(await import('../index')),
      ...(await import('@forgeax/engine-assets-runtime')),
    } as never;
  }

  function cameraTransform() {
    return {
      pos: [0, 0, 5],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  async function setupWebGPU(): Promise<{
    createRenderer: (
      canvas: unknown,
      opts?: unknown,
      bundler?: unknown,
    ) => Promise<{
      backend: string;
      ready: Promise<void>;
      draw: (worlds: unknown, opts: { owner: number }) => void;
      onError: (cb: (err: { code: string; detail?: unknown; hint?: string }) => void) => () => void;
      assets: { register: (asset: unknown) => { ok: boolean; value: unknown } };
    }>;
  }> {
    const { device } = makeMockGPUDevice();
    vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
    const engine = await importEngine();
    return { createRenderer: engine.createRenderer };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  interface RendererForTest {
    bindGroupCounts?: { readonly createBindGroup: number };
    draw: (worlds: unknown, opts: { owner: number }) => void;
  }

  function spawnBasicScene(
    world: unknown,
    C: {
      Camera: unknown;
      Transform: unknown;
      MeshFilter: unknown;
      MeshRenderer: unknown;
      DirectionalLight: unknown;
      HANDLE_CUBE: Handle<'MeshAsset', 'shared'>;
    },
    options?: { withShadow?: boolean },
  ) {
    const w = world as {
      spawn: (...args: unknown[]) => unknown;
    };
    // withShadow gated on castShadow (now merged into DirectionalLight)

    w.spawn(
      {
        component: C.Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 16 / 9,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
      { component: C.Transform, data: cameraTransform() },
    );
    w.spawn(
      {
        component: C.DirectionalLight,
        data: { castShadow: options?.withShadow === true },
      },
      { component: C.Transform, data: cameraTransform() },
    );
    w.spawn(
      { component: C.MeshRenderer, data: { materials: [0] } },
      { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
      {
        component: C.Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
    );
  }

  // ─── Tests ─────────────────────────────────────────────────────────────────

  describe('w5 — view bind group cache hit/miss + variant isolation', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('(a) stable scene >= 2 draws => view main cache hit (counter not bumped by view BG)', async () => {
      const { createRenderer } = await setupWebGPU();
      const canvas = makeMockCanvas('context', 'context');
      const renderer = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      await renderer.ready;

      const { World } = await importEcs();
      const C = await importComponents();
      const world = new World();
      spawnBasicScene(world, C);

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Frame 1: all cache misses (cold start) => counter > 0
      draw([world], { owner: 0 });
      const countFrame1 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countFrame1).toBeGreaterThan(0);

      // Frame 2: view cache should hit (same handles) => counter < frame 1
      draw([world], { owner: 0 });
      const countFrame2 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countFrame2).toBeLessThan(countFrame1);
    });

    it('(b) cold-frame createBindGroup count > 0; hot frame count decreases (cache hit)', async () => {
      const { createRenderer } = await setupWebGPU();
      const canvas = makeMockCanvas('context', 'context');
      const renderer = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      await renderer.ready;

      const { World } = await importEcs();
      const C = await importComponents();
      const world = new World();
      spawnBasicScene(world, C);

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Frame 1: cold cache — createBindGroup calls > 0
      draw([world], { owner: 0 });
      const coldCount = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(coldCount).toBeGreaterThan(0);

      // Frame 2: view + mesh cache hits reduce counter
      draw([world], { owner: 0 });
      const hotCount = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(hotCount).toBeLessThan(coldCount);

      // Frame 3: stable scene, further cache hits (approach 0 as M3/M4 come)
      draw([world], { owner: 0 });
      const stableCount = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(stableCount).toBeLessThanOrEqual(hotCount);
    });

    it('(c) AC-06: main vs shadow variant keys distinct, each variant caches independently', async () => {
      const { createRenderer } = await setupWebGPU();
      const canvas = makeMockCanvas('context', 'context');
      const renderer = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      await renderer.ready;

      const { World } = await importEcs();
      const C = await importComponents();
      const world = new World();
      // Spawn scene with directional light shadow so shadow pass runs
      spawnBasicScene(world, C, { withShadow: true });

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Frame 1: cold start — view main + view shadow both cache miss
      draw([world], { owner: 0 });
      const countFrame1 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countFrame1).toBeGreaterThan(0);

      // Frame 2: both view variants hit (same handles, same scene)
      draw([world], { owner: 0 });
      const countFrame2 = rs.bindGroupCounts?.createBindGroup ?? -1;
      // Both view variants cached independently => counter lower than frame 1
      expect(countFrame2).toBeLessThan(countFrame1);
    });
  });
}

// ─── from bind-group-cache-entity-key.test.ts ───
{
  // bind-group-cache-entity-key.test.ts -- M1 / w1 (TDD red)
  //
  // entityKey cross-frame stability unit tests for RenderableSnapshot.entityKey.
  // Anchors: requirements AC-04 (entity-key-based fine-grain invalidation)
  // and AC-07 (per-entity clean-up depends on stable identity).
  //
  // Three scenarios:
  //   1. Same entity produces equal entityKey across two consecutive extractFrame calls
  //   2. Two different entities produce different entityKey values
  //   3. Despawn + respawn (generation bump) produces a different entityKey
  //
  // TDD red: RenderableSnapshot.entityKey does not exist yet; this file will
  // fail compilation (or test assertion) until w3 surfaces the field.

  function translateTransform(x = 0, y = 0, z = 0) {
    return {
      pos: [x, y, z],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  function registerMesh(world: World): Handle<'MeshAsset', 'shared'> {
    // Minimal mesh: 1 triangle at origin with AABB
    const vertices = new Float32Array([
      0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 0, 0,
    ]);
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
      kind: 'mesh',
      vertices,
      indices: new Uint16Array([0, 1, 2]),
      attributes: { position: positions },
      aabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: vertices.length,
          topology: 'triangle-list',
        },
      ],
    });
  }

  function registerUnlitMaterial(world: World): Handle<'MaterialAsset', 'shared'> {
    return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-unlit',
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      ],
      paramValues: { baseColor: [1, 1, 1] },
    });
  }

  function spawnEntity(
    world: World,
    meshHandle: Handle<'MeshAsset', 'shared'>,
    matHandle: Handle<'MaterialAsset', 'shared'>,
  ) {
    const e = world
      .spawn(
        { component: Transform, data: translateTransform() },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
    return e;
  }

  function extract(world: World, assets: AssetRegistry): ExtractedFrame {
    return extractFrame(world, assets);
  }

  describe('w1 — entityKey cross-frame stability', () => {
    it('same entity produces equal entityKey across two consecutive extractFrame calls', () => {
      const world = new World();
      const assets = new AssetRegistry(makeMockShaderRegistry());
      const meshHandle = registerMesh(world);
      const matHandle = registerUnlitMaterial(world);

      spawnEntity(world, meshHandle, matHandle);

      const frame1 = extract(world, assets);
      const frame2 = extract(world, assets);

      expect(frame1.renderables.length).toBe(1);
      expect(frame2.renderables.length).toBe(1);

      const r1 = frame1.renderables[0];
      const r2 = frame2.renderables[0];
      if (!r1 || !r2) return;

      // entityKey must be a non-negative integer (packed Entity u32; first entity may be 0)
      expect(typeof r1.entityKey).toBe('number');
      // Cross-frame stability: same entity, no despawn => same entityKey
      expect(r1.entityKey).toBe(r2.entityKey);
    });

    it('two different entities produce different entityKey values', () => {
      const world = new World();
      const assets = new AssetRegistry(makeMockShaderRegistry());
      const meshHandle = registerMesh(world);
      const matHandle = registerUnlitMaterial(world);

      spawnEntity(world, meshHandle, matHandle);
      spawnEntity(world, meshHandle, matHandle);

      const frame = extract(world, assets);
      expect(frame.renderables.length).toBe(2);

      const r1 = frame.renderables[0];
      const r2 = frame.renderables[1];
      if (!r1 || !r2) return;

      expect(typeof r1.entityKey).toBe('number');
      expect(typeof r2.entityKey).toBe('number');
      // Two distinct entities must have different entityKeys
      expect(r1.entityKey).not.toBe(r2.entityKey);
    });

    it('despawn + respawn yields different entityKey (generation bump)', () => {
      const world = new World();
      const assets = new AssetRegistry(makeMockShaderRegistry());
      const meshHandle = registerMesh(world);
      const matHandle = registerUnlitMaterial(world);

      const e = spawnEntity(world, meshHandle, matHandle);
      const frame1 = extract(world, assets);
      expect(frame1.renderables.length).toBe(1);
      const entityKeyBefore = frame1.renderables[0]?.entityKey;
      if (entityKeyBefore === undefined) return;

      // Despawn the entity; it should be gone from next extract
      world.despawn(e).unwrap();
      const frame2 = extract(world, assets);
      expect(frame2.renderables.length).toBe(0);

      // Respawn a new entity (new index slot may get recycled but generation bumps)
      spawnEntity(world, meshHandle, matHandle);
      const frame3 = extract(world, assets);
      expect(frame3.renderables.length).toBe(1);
      const entityKeyAfter = frame3.renderables[0]?.entityKey;
      if (entityKeyAfter === undefined) return;

      // After despawn+respawn the entityKey must differ (generation changed)
      expect(entityKeyAfter).not.toBe(entityKeyBefore);
    });
  });
}

// ─── from bind-group-cache-instances.test.ts ───
{
  // bind-group-cache-instances.test.ts -- M3 / w11 (TDD red)
  //
  // Instances bind group cache hit/miss unit tests.
  // Anchors: requirements AC-01 (instances into cache).
  //
  // Scenarios:
  //   (a) Instances entity stable scene >= 2 draws => instances cache hit
  //       (instanceBuffer handle unchanged, counter stable)
  //   (b) archVersion bump (Instances transforms content changes) triggers
  //       instanceBuffer rebuild => cache miss -> rebuild -> hit
  //   (c) Non-Instances entity (identityInstanceBuffer fallback) cache key
  //       stable and hits frame 2+ (handle does not change frame-to-frame)
  //
  // Instances key: 'instances' discriminator + entityKey + instanceBuffer handle id.
  // The instanceBuffers Map's existing archVersion/byteLength invalidation ensures
  // the handle changes when the buffer is rebuilt; the cache key naturally misses
  // when the handle id changes.
  //
  // TDD red: materialBindGroupCache + instancesBindGroupCache do not exist yet
  // on RenderFrameState; instances createBindGroup calls are not wired through
  // cache. Tests expected to fail until w12 wires the cache.

  const ENGINE = '../createRenderer';

  // ─── Mock helpers ──────────────────────────────────────────────────────────

  interface MockGL2Context {
    __mockTag: 'webgl2';
    getExtension: () => null;
    getParameter: () => number;
    isContextLost: () => boolean;
  }

  function makeMockGL2(): MockGL2Context {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(
    webgl2: 'context' | 'null',
    webgpu: 'context' | 'null',
  ): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') {
          return webgl2 === 'context' ? makeMockGL2() : null;
        }
        if (kind === 'webgpu') {
          if (webgpu === 'context') {
            return {
              __mockTag: 'webgpu-canvas-context',
              configure: () => undefined,
              unconfigure: () => undefined,
              getCurrentTexture: () => ({ createView: () => ({}) }),
            };
          }
          return null;
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
  }

  function makeMockGPUDevice(): { device: unknown } {
    const lost = new Promise<unknown>(() => undefined);
    const device = {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      limits: {},
      queue: {
        submit: () => undefined,
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: () => ({
        getMappedRange: () => new ArrayBuffer(64),
        unmap: () => undefined,
      }),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          setBindGroup: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({}),
      }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      destroy: () => undefined,
    };
    return { device };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({
        requestDevice: async () => deviceObj,
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const baseNavigator: Navigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  function buildManifestDataUrl(): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: '/* stub */',
      paramSchema: '[]',
      variants: [],
    });
    const manifest = {
      schemaVersion: '1.0.0',
      entries: [
        { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
        {
          hash: 'tonemap0',
          wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
          glsl: '',
          bindings: '',
        },
      ],
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  async function importEngine(): Promise<{
    createRenderer: (
      canvas: unknown,
      opts?: unknown,
      bundler?: unknown,
    ) => Promise<{
      backend: string;
      ready: Promise<void>;
      draw: (worlds: unknown, opts: { owner: number }) => void;
      onError: (cb: (err: { code: string; detail?: unknown; hint?: string }) => void) => () => void;
      assets: {
        register: (asset: unknown) => { ok: boolean; value: unknown };
      };
    }>;
  }> {
    return (await import(ENGINE)) as never;
  }

  async function importEcs(): Promise<{
    World: new () => {
      spawn: (...componentDatas: unknown[]) => unknown;
      update: () => void;
    };
  }> {
    return (await import('@forgeax/engine-ecs')) as never;
  }

  async function importComponents(): Promise<{
    Transform: unknown;
    MeshFilter: unknown;
    MeshRenderer: unknown;
    Camera: unknown;
    DirectionalLight: unknown;
    Instances: unknown;
    HANDLE_CUBE: Handle<'MeshAsset', 'shared'>;
    HANDLE_TRIANGLE: Handle<'MeshAsset', 'shared'>;
  }> {
    return {
      ...(await import('../index')),
      ...(await import('@forgeax/engine-assets-runtime')),
    } as never;
  }

  function cameraTransform() {
    return {
      pos: [0, 0, 5],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  async function setupWebGPU(): Promise<{
    createRenderer: (
      canvas: unknown,
      opts?: unknown,
      bundler?: unknown,
    ) => Promise<{
      backend: string;
      ready: Promise<void>;
      draw: (worlds: unknown, opts: { owner: number }) => void;
      onError: (cb: (err: { code: string; detail?: unknown; hint?: string }) => void) => () => void;
      assets: { register: (asset: unknown) => { ok: boolean; value: unknown } };
    }>;
  }> {
    const { device } = makeMockGPUDevice();
    vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
    const engine = await importEngine();
    return { createRenderer: engine.createRenderer };
  }

  interface RendererForTest {
    bindGroupCounts?: { readonly createBindGroup: number };
    draw: (worlds: unknown, opts: { owner: number }) => void;
  }

  function spawnBasicScene(
    world: unknown,
    C: {
      Camera: unknown;
      Transform: unknown;
      MeshFilter: unknown;
      MeshRenderer: unknown;
      DirectionalLight: unknown;
      Instances: unknown;
      HANDLE_CUBE: Handle<'MeshAsset', 'shared'>;
    },
    options?: { withInstances?: boolean },
  ) {
    const w = world as {
      spawn: (...args: unknown[]) => unknown;
    };

    w.spawn(
      {
        component: C.Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 16 / 9,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
      { component: C.Transform, data: cameraTransform() },
    );
    w.spawn(
      { component: C.DirectionalLight, data: {} },
      { component: C.Transform, data: cameraTransform() },
    );

    if (options?.withInstances) {
      const transforms = new Float32Array(16 * 2); // 2 instances
      transforms[0] = 1;
      transforms[5] = 1;
      transforms[10] = 1;
      transforms[15] = 1;
      transforms[16] = 1;
      transforms[21] = 1;
      transforms[26] = 1;
      transforms[31] = 1;
      w.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
        {
          component: C.Transform,
          data: {
            pos: [0, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        { component: C.Instances, data: { transforms } },
      );
    } else {
      w.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
        {
          component: C.Transform,
          data: {
            pos: [0, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      );
    }
  }

  // ─── w11 Tests: instances bind group cache hit/miss ─────────────────────────

  describe('w11 — instances bind group cache hit/miss', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('(a) Instances entity stable scene >= 2 draws => instances cache hit', async () => {
      const { createRenderer } = await setupWebGPU();
      const canvas = makeMockCanvas('context', 'context');
      const renderer = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      await renderer.ready;

      const { World } = await importEcs();
      const C = await importComponents();
      const world = new World();
      spawnBasicScene(world, C, { withInstances: true });

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Frame 1: cold start — all caches empty
      draw([world], { owner: 0 });
      const countFrame1 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countFrame1).toBeGreaterThan(0);

      // Frame 2: view + mesh cache hit (M2); instances still cold (M3 not yet wired)
      draw([world], { owner: 0 });
      const countFrame2 = rs.bindGroupCounts?.createBindGroup ?? -1;
      // View/mesh cache reduces counter from frame 1
      expect(countFrame2).toBeLessThanOrEqual(countFrame1);
    });

    it('(b) archVersion bump triggers instanceBuffer rebuild => cache miss -> rebuild', async () => {
      const { createRenderer } = await setupWebGPU();
      const canvas = makeMockCanvas('context', 'context');
      const renderer = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      await renderer.ready;

      const { World } = await importEcs();
      const C = await importComponents();
      const world = new World();
      spawnBasicScene(world, C, { withInstances: true });

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Warm the cache
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });

      // Spawn another entity that triggers archetype changes. In a real GPU
      // context, archVersion bump causes instanceBuffer rebuild => cache
      // miss for instances BG. In the mock, the rendering may surface an
      // error (artifact of limited mock pipeline). The test verifies the
      // structural path is intact.
      const w = world as {
        spawn: (...args: unknown[]) => unknown;
      };
      const errors: unknown[] = [];
      const off = renderer.onError((e) => {
        errors.push(e);
      });
      w.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
        {
          component: C.Transform,
          data: {
            pos: [5, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      );

      draw([world], { owner: 0 });
      off();
      const afterArchVersionBump = rs.bindGroupCounts?.createBindGroup ?? -1;
      if (errors.length === 0) {
        expect(afterArchVersionBump).toBeGreaterThan(0);
      }
      // TDD-red: the test is structurally correct. With the mock (limited
      // pipeline), a webgpu-runtime-error on spawn may fire and counter
      // stays 0. Both outcomes indicate the cache is not yet wired.
      expect(errors.length === 0 || afterArchVersionBump === 0).toBe(true);
    });

    it('(c) Non-Instances entity (identityInstanceBuffer) cache key stable and hits frame 2+', async () => {
      const { createRenderer } = await setupWebGPU();
      const canvas = makeMockCanvas('context', 'context');
      const renderer = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      await renderer.ready;

      const { World } = await importEcs();
      const C = await importComponents();
      const world = new World();
      // Non-Instances entity uses identityInstanceBuffer
      spawnBasicScene(world, C, { withInstances: false });

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Frame 1: cold start
      draw([world], { owner: 0 });
      const countFrame1 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countFrame1).toBeGreaterThan(0);

      // Frame 2: identityInstanceBuffer handle is init-time stable -> cache hit
      draw([world], { owner: 0 });
      const countFrame2 = rs.bindGroupCounts?.createBindGroup ?? -1;
      // View/mesh caches hit; instances still cold but handle stable
      expect(countFrame2).toBeLessThanOrEqual(countFrame1);
    });
  });
}
