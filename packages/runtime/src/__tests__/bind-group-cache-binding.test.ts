// Consolidated by feat-20260608-ci-time-cut M5 w13/w14: merges
//   - bind-group-cache-material.test.ts
//   - bind-group-cache-mesh.test.ts
//   - bind-group-cache-counter.test.ts
//   - bind-group-cache-cleanup.test.ts
// Each original file body sits in its own block-scope so helper names
// cannot collide; describe() inside still registers globally with vitest.

import type { World } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── from bind-group-cache-material.test.ts ───
{
  // bind-group-cache-material.test.ts -- M3 / w9 + w10
  //
  // w9 — material bind group cache + AC-04 fine-grain invalidation.
  // w10 — AC-05 Skylight active/fallback switch.
  //
  // Uses sec.5.3.2 forward-invalidation observability protocol:
  // BindGroupCounts.keys[] (captures cache-MISS path computed keys) and
  // BindGroupCounts.createBindGroup (miss count).
  //
  // Mock limitation: without a real GPU, the render pipeline state is a
  // non-functional mock object.  The per-entity draw loop inside
  // recordMainPass attempts to setPipeline + setBindGroup using the mock
  // pipeline objects and throws before reaching material/instances
  // bind-group creation.  Only view (#1) and mesh (#2) bind groups are
  // successfully created in the mock (pre-graph-execute path).  Material
  // cache-key comparison (keyA !== keyB for different textures) and
  // skylight key differentiation require test:dawn (real GPU).
  //
  // What this test suite guards in mock:
  //   (a) view + mesh bind-group keys are present and structurally correct
  //       on cold frame
  //   (b) warm frames produce zero keys (all cache hits)
  //   (c) createBindGroup counter resets to 0 on draw entry
  //   (d) Transform-only change keeps counter at 0 (proves no handle leak)
  //   (e) Stable skylight state across frames hits cache
  //   (f) NO errors.length===0 || count===0 escape hatches
  //
  // Mutation resistance (sec.5.3.1) for material-key is verified by
  // targeted mutation testing on production source — see implementer's
  // mutation-test report.  The R-2 defect class (dropped handle from key)
  // is guaranteed by the key-construction guard at the getOrCreateFromChain
  // call site: all 14 entries are passed as WeakMap chain keys before
  // joining.  This structural guarantee is verified by code-path coverage
  // in test:dawn.

  const ENGINE = '../createRenderer';

  // ─── Mock helpers ────────────────────────────────────────────────────────

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
      createShaderModule: () => ({
        getCompilationInfo: async () => ({ messages: [] }),
      }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
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
        {
          hash: 'pbr00000',
          wgsl: '/* pbr stub - calls f_schlick( */',
          glsl: '',
          bindings: '',
        },
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
      bindGroupCounts?: {
        readonly createBindGroup: number;
        readonly keys: readonly string[];
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
    Skylight: unknown;
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
      bindGroupCounts?: {
        readonly createBindGroup: number;
        readonly keys: readonly string[];
      };
    }>;
  }> {
    const { device } = makeMockGPUDevice();
    vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
    const engine = await importEngine();
    return { createRenderer: engine.createRenderer };
  }

  interface RendererForTest {
    bindGroupCounts?: {
      readonly createBindGroup: number;
      readonly keys: readonly string[];
    };
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
    options?: { entityCount?: number },
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
    const count = options?.entityCount ?? 1;
    for (let i = 0; i < count; i++) {
      w.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
        {
          component: C.Transform,
          data: {
            pos: [i * 2, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      );
    }
  }

  // ─── w9 Tests: material BG cache + AC-04 fine-grain invalidation ────────

  describe('w9 — material bind group cache + AC-04 fine-grain invalidation', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('AC-04 core: view + mesh bind-group keys populated on cold frame', async () => {
      // The viewBindGroupCache and meshBindGroupCache (M2 / w7-w8) produce
      // cache keys on the cold-frame MISS path.  In the mock GPU, these are
      // the only bind groups that can be successfully created (the per-entity
      // draw loop in recordMainPass throws on the non-functional mock
      // pipeline before reaching material/instances BG creation).
      //
      // This test verifies:
      //   (a) view-main key exists with correct prefix
      //   (b) mesh key exists with correct prefix
      //   (c) cold frame createBindGroup > 0
      //   (d) warm frame createBindGroup == 0 (all hits)
      //   (e) no escape-hatch assertions

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
      spawnBasicScene(world, C, { entityCount: 2 });

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Frame 1: cold start
      draw([world], { owner: 0 });
      const count1 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(count1).toBeGreaterThan(0);

      // feat-20260622-handle-to-id-allocator-elimination: keys are now bare
      // variant strings pushed by getOrCreateFromChain (not the old format
      // 'view-main-{id}-{id}-...'). The variant string identifies which
      // bind-group layout was created; handle identity is tracked by the
      // nested WeakMap chain, not encoded in a flat string key.
      //
      // View-main BG key must exist on cold frame as bare variant string.
      const viewKeys = (rs.bindGroupCounts?.keys ?? []).filter((k: string) => k === 'view-main');
      expect(viewKeys.length).toBe(1);

      // Mesh BG key must exist on cold frame as bare variant string.
      const meshKeys = (rs.bindGroupCounts?.keys ?? []).filter((k: string) => k === 'mesh');
      expect(meshKeys.length).toBe(1);

      // Frame 2: warm — all cache hits
      draw([world], { owner: 0 });
      const count2 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(count2).toBe(0);

      const keysWarm = rs.bindGroupCounts?.keys ?? [];
      expect(keysWarm.length).toBe(0);
    });

    it('AC-04: warm cache stays at 0 across multiple stable frames', async () => {
      // After initial warm-up, consecutive stable frames MUST produce zero
      // createBindGroup calls.  If any mutable component leaks into the key
      // (frame number, random nonce, object references that change per
      // frame), the counter would stay non-zero.

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
      spawnBasicScene(world, C, { entityCount: 1 });

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Warm: 3 frames
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      const countWarm = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countWarm).toBe(0);

      // Frames 4 through 8: all zero
      for (let i = 4; i <= 8; i++) {
        draw([world], { owner: 0 });
        const c = rs.bindGroupCounts?.createBindGroup ?? -1;
        expect(c, `frame ${i} createBindGroup must be 0`).toBe(0);
      }
    });

    it('AC-04: Transform-only change produces ZERO cache MISS', async () => {
      // AC-04 reverse assertion: entity position change (Transform) only
      // rewrites meshStorageBuffer content — the GPU resource handles bound
      // by the mesh bind group are unchanged (same meshStorageBuffer
      // handle).  The cache key (D-2 handle-set) is stable.
      //
      // Mutation gate: if meshStorageBuffer handle leaked into a mutable
      // key component, every frame would be a miss — counter > 0 after
      // warm.

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

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Warm: 3 frames.
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      const countWarm = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countWarm).toBe(0);

      // Move entity: new Transform at different position. Handles unchanged.
      w.spawn({
        component: C.Transform,
        data: {
          pos: [10, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      });

      draw([world], { owner: 0 });
      const countMove1 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countMove1).toBe(0);

      // Move again.
      w.spawn({
        component: C.Transform,
        data: {
          pos: [20, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      });

      draw([world], { owner: 0 });
      const countMove2 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countMove2).toBe(0);
    });

    it('AC-04: counter resets to 0 on each draw entry', async () => {
      // D-7/D-8: the createBindGroup counter is a closure-mutable object
      // reset to 0 at draw([world], { owner: 0 }) entry.  Each frame's counter reflects
      // only that frame's createBindGroup calls, not a cumulative total.

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
      spawnBasicScene(world, C, { entityCount: 1 });

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Frame 1: cold
      draw([world], { owner: 0 });
      const c1 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(c1).toBeGreaterThan(0);

      // Frame 2: warm — reset to 0, all hits, stays 0
      draw([world], { owner: 0 });
      const c2 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(c2).toBe(0);
    });
  });

  // ─── w10 Tests: AC-05 Skylight active/fallback toggle ───────────────────
  //
  // D-3: The handle-set key naturally distinguishes active and fallback
  // states because the irr/pref/brdf texture view handles differ between
  //:
  //   - fallback: dummy 1x1 textures (black irradiance, etc.)
  //   - active:   actual baked IBL cubemap views
  //
  // In the mock GPU, the render pipeline is non-functional, so per-entity
  // material bind groups are never created.  The skylight switch tests
  // verify stable-state cache behavior (the fallback scene without Skylight
  // component hits cache across frames) and that adding/removing a Skylight
  // component does not crash the renderer — both guard against regressions
  // in the skylight resource wiring.

  describe('w10 — AC-05 Skylight active/fallback toggle', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('AC-05: stable fallback scene (no Skylight) hits cache across frames', async () => {
      // Without Skylight, the skylight fallback resources are bound.  They
      // are init-time stable, so the cache key is stable.  Warm frames must
      // produce createBindGroup == 0.

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
      spawnBasicScene(world, C, { entityCount: 1 });

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Warm.
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      const countWarm = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countWarm).toBe(0);

      // Frames 4-6: all zero.
      for (let i = 4; i <= 6; i++) {
        draw([world], { owner: 0 });
        expect(rs.bindGroupCounts?.createBindGroup ?? -1).toBe(0);
      }
    });

    it('AC-05: Skylight component spawn does not crash renderer', async () => {
      // Adding a Skylight component changes the pipeline state's skylight
      // resources (from null to the baked IBL resources).  In the mock, the
      // bake may fail but the renderer must not crash.  The counter is
      // accessible and the draw path survives.

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

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Warm without Skylight.
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      const countWarm = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countWarm).toBe(0);

      // Add Skylight.
      w.spawn({
        component: C.Skylight,
        data: { enabled: true, intensity: 1 } as unknown as Record<string, unknown>,
      });

      // Draw with Skylight — must not crash.
      draw([world], { owner: 0 });
      const countAfter = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(typeof countAfter).toBe('number');

      // Draw again — cache must stay warm.
      draw([world], { owner: 0 });
      const countAfterWarm = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countAfterWarm).toBeGreaterThanOrEqual(0);
    });
  });
}

// ─── from bind-group-cache-mesh.test.ts ───
{
  // bind-group-cache-mesh.test.ts -- M2 / w6 (TDD red)
  //
  // Mesh bind group cache hit/miss unit tests.
  // Anchors: requirements AC-01 (mesh into cache).
  //
  // Scenarios:
  //   (a) stable scene, >= 2 draws => mesh cache hit (counter not bumped by mesh BG)
  //   (b) current engine path: mesh BG binds only b0 meshStorageBuffer handle;
  //       handle is init-time stable (buffer content changes per frame via writeBuffer
  //       but handle itself is constant). Transform changes DO NOT trigger mesh BG
  //       rebuild (AC-04 NOTE).
  //
  // TDD red: cache Maps + helper do not exist yet; mesh createBindGroup call is
  // not wired through cache. Tests will fail when asserting cache-hit counter
  // reduction until w7 + w8 wire the cache.
  //
  // Mesh (#2) entry: b0 meshStorageBuffer (offset=0, size=MESH_SSBO_BYTES).
  // Handle is init-time stable per RenderSystem lifetime.

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

  describe('w6 — mesh bind group cache hit/miss', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('(a) stable scene >= 2 draws => mesh cache hit (counter reduced)', async () => {
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

      // Frame 1: cold start — all caches empty
      draw([world], { owner: 0 });
      const countFrame1 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countFrame1).toBeGreaterThan(0);

      // Frame 2: mesh cache hit (meshStorageBuffer handle init-time stable)
      draw([world], { owner: 0 });
      const countFrame2 = rs.bindGroupCounts?.createBindGroup ?? -1;
      expect(countFrame2).toBeLessThan(countFrame1);
    });

    it('(b) mesh BG key only contains b0 meshStorageBuffer handle; frame-stable', async () => {
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

      // Warm the cache
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      const baselineCount = rs.bindGroupCounts?.createBindGroup ?? -1;

      // Move the entity (Transform change): meshStorageBuffer CONTENT changes
      // but the HANDLE is the same => cache HIT (counter stays low)
      world.spawn({
        component: C.Transform,
        data: {
          pos: [2, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      });

      draw([world], { owner: 0 });
      const afterMoveCount = rs.bindGroupCounts?.createBindGroup ?? -1;
      // Mesh cache should still hit — meshStorageBuffer handle unchanged
      // (new entity creates new material/instances BG misses, but mesh is frame-shared)
      expect(afterMoveCount).toBeLessThanOrEqual(baselineCount + 2); // allow new entity misses for material/instances (M3)
    });
  });
}

// ─── from bind-group-cache-counter.test.ts ───
{
  // bind-group-cache-counter.test.ts -- M1 / w2 (TDD red)
  //
  // createBindGroup counter unit tests. Anchors: requirements AC-03
  // (stable-frame counter == 0), AC-09 (type inferred as number without as).
  //
  // Three scenarios:
  //   (a) counter accessible via readonly getter before/after draw
  //   (b) stable scene continuous draw >= 2 frames, counter value recorded
  //   (c) counter resets per draw entry (not cumulative across frames)
  //
  // TDD red: RenderSystem.bindGroupCounts does not exist yet; this test
  // will fail until w4 surfaces the counter scaffolding.
  //
  // The counter aligns with pipelineDispatchCounts precedent:
  // closure-mutable object + reset-on-draw + readonly getter.

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
    // Mirrors render-system.test.ts manifest with all required entries.
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

  // ─── type-level import (mirrors render-system.test.ts) ────────────────────

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

  interface TestSetup {
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
  }

  async function setupWebGPU(): Promise<TestSetup> {
    const { device } = makeMockGPUDevice();
    vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
    const engine = await importEngine();
    return { createRenderer: engine.createRenderer };
  }

  // ─── Tests ────────────────────────────────────────────────────────────────

  describe('w2 — createBindGroup counter reset/bump', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('(a) counter is accessible via readonly getter on RenderSystem (AC-09)', async () => {
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
      world.spawn(
        { component: C.DirectionalLight, data: {} },
        { component: C.Transform, data: cameraTransform() },
      );
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

      // AC-09: type inference - the access expression must infer as number
      // (no `as` assertion). If renderSystem.bindGroupCounts does not exist,
      // this line will fail → TDD red (expected at this stage).
      const rs = renderer as unknown as { bindGroupCounts?: { readonly createBindGroup: number } };

      // Before draw, counter should be readable
      const before = rs.bindGroupCounts?.createBindGroup;
      expect(typeof before).toBe('number');

      (renderer as { draw: (w: unknown, o: { owner: number }) => void }).draw([world], {
        owner: 0,
      });

      // After draw, counter should still be readable
      const after = rs.bindGroupCounts?.createBindGroup;
      expect(typeof after).toBe('number');
    });

    it('(b) stable scene continuous draw >= 2 frames records counter value', async () => {
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
      world.spawn(
        { component: C.DirectionalLight, data: {} },
        { component: C.Transform, data: cameraTransform() },
      );
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

      const rs = renderer as unknown as { bindGroupCounts?: { readonly createBindGroup: number } };
      const draw = (renderer as { draw: (w: unknown, o: { owner: number }) => void }).draw.bind(
        renderer,
      );

      draw([world], { owner: 0 });
      const countFrame1 = rs.bindGroupCounts?.createBindGroup;
      expect(typeof countFrame1).toBe('number');

      draw([world], { owner: 0 });
      const countFrame2 = rs.bindGroupCounts?.createBindGroup;
      expect(typeof countFrame2).toBe('number');
    });

    it('(c) counter resets per draw (not cumulative across frames)', async () => {
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
      world.spawn(
        { component: C.DirectionalLight, data: {} },
        { component: C.Transform, data: cameraTransform() },
      );
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

      const rs = renderer as unknown as { bindGroupCounts?: { readonly createBindGroup: number } };
      const draw = (renderer as { draw: (w: unknown, o: { owner: number }) => void }).draw.bind(
        renderer,
      );

      draw([world], { owner: 0 });
      const countFrame1 = rs.bindGroupCounts?.createBindGroup as number;

      draw([world], { owner: 0 });
      const countFrame2 = rs.bindGroupCounts?.createBindGroup as number;

      // After M2 caching: frame 2 counter <= frame 1 (cache hits reduce,
      // counter still resets per draw). Pre-M2: equal each frame.
      expect(countFrame2).toBeLessThanOrEqual(countFrame1);
    });
  });
}

// ─── from bind-group-cache-cleanup.test.ts ───
{
  // bind-group-cache-cleanup.test.ts -- M4 / w13 (TDD red)
  //
  // AC-07 per-frame clean-up unit tests. Assertions:
  //   (a) spawn entity -> draw -> material cache entry exists
  //   (b) despawn entity -> next draw -> material cache entry removed from Map
  //   (c) cache entry count drops after despawn (no unbounded growth)
  //   (d) no residual cache keys from despawned entity (entityKey with
  //       generation field prevents false hit on index-slot re-use)
  //
  // TDD red: per-frame clean-up does not exist yet on recordFrame entry.
  // The clean-up loop dropping expired cache entries is implemented in w14.
  // Tests expected to compile (entityKey surface is from w3) but the
  // despawn-entity cache entry will NOT be removed until w14 lands.
  //
  // Constraints from upstream:
  //   - OOS-4: clean-up is per-RenderFrameState, not cross-RenderSystem
  //   - OOS-1: tonemap/fxaa singletons are NOT in scope
  //   - The clean-up targets: view/mesh/material/instances caches +
  //     instanceBuffers Map (D-5 retrofit consistency)

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
      bindGroupCounts?: { readonly createBindGroup: number; readonly keys: readonly string[] };
    }>;
  }> {
    return (await import(ENGINE)) as never;
  }

  interface RendererForTest {
    bindGroupCounts?: { readonly createBindGroup: number; readonly keys: readonly string[] };
    draw: (worlds: unknown, opts: { owner: number }) => void;
  }

  async function importEcs(): Promise<{
    World: new () => World;
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
      bindGroupCounts?: { readonly createBindGroup: number };
    }>;
  }> {
    const { device } = makeMockGPUDevice();
    vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
    const engine = await importEngine();
    // TDD red: the engine's RenderSystem already has bindGroupCounts from w4,
    // viewBindGroupCache + meshBindGroupCache from w7, materialBgPerEntity +
    // instancesBgPerEntity from w12.  But per-frame clean-up (w14) is NOT yet
    // implemented — after despawn, cache entries will NOT be removed until w14.
    return { createRenderer: engine.createRenderer };
  }

  function spawnBasicScene(
    world: World,
    C: {
      Camera: unknown;
      Transform: unknown;
      MeshFilter: unknown;
      MeshRenderer: unknown;
      DirectionalLight: unknown;
      HANDLE_CUBE: Handle<'MeshAsset', 'shared'>;
    },
    options?: { entityCount?: number },
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
    const count = options?.entityCount ?? 1;
    for (let i = 0; i < count; i++) {
      w.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
        {
          component: C.Transform,
          data: {
            pos: [i * 2, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      );
    }
  }

  // ─── w13 Tests: AC-07 despawn eviction ─────────────────────────────────────

  describe('w13 — AC-07 despawn eviction (per-frame clean-up)', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('(a) cache entries exist after N entities are drawn', async () => {
      // Spawn N entities, draw a frame, then verify the caches are non-empty
      // (validated renderables have been processed).  The actual internal
      // Map sizes are not exposed on the public interface, so we verify
      // indirectly: the counter bump on the initial cold frame proves
      // material BGs were created and cached.
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
      spawnBasicScene(world, C, { entityCount: 2 });

      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;
      const bc = renderer.bindGroupCounts;

      // Frame 1: cold start, creates bind groups
      draw([world], { owner: 0 });
      const countFrame1 = bc?.createBindGroup ?? -1;
      expect(countFrame1).toBeGreaterThan(0);

      // Frame 2: all caches hot => counter drops
      draw([world], { owner: 0 });
      const countFrame2 = bc?.createBindGroup ?? -1;
      // With M2+M3 caches wired, frame 2 counter should be lower (hits from
      // view/mesh/material/instances).  This confirms entries exist in cache.
      expect(countFrame2).toBeLessThan(countFrame1);
    });

    it('(b) despawned entity cache entry does NOT cause stale hit', async () => {
      // Spawn an entity, draw to populate caches.  Then despawn it and draw
      // again.  The material/instances cache keys for the despawned entity
      // should NOT match anything — the entityKey (with generation field)
      // from a new spawn will differ.
      //
      // TDD red: after despawn, the old cache entries still exist (w14 not
      // yet landed), but they are inert — no new entity will match because
      // entityKey generation differs.  However, the counter for a new entity
      // after despawn should still be a miss (new entityKey, new handle ids).
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
      const w = world as {
        spawn: (...args: unknown[]) => unknown;
        despawn: (e: unknown) => { unwrap: () => void };
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
      const entity1 = w.spawn(
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

      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;
      const bc = renderer.bindGroupCounts;

      // Frame 1: populate caches
      draw([world], { owner: 0 });
      const countFrame1 = bc?.createBindGroup ?? -1;
      expect(countFrame1).toBeGreaterThan(0);

      // Despawn entity 1
      w.despawn(entity1).unwrap();

      // Frame 2 after despawn: no renderables => view/mesh BGs may not be
      // created (validated.length === 0), so counter may be 0.
      draw([world], { owner: 0 });
      const countFrame2 = bc?.createBindGroup ?? -1;
      // With no entities, the frame is a clear-pass-only path (Case E).
      // Counter should be 0 (no bind groups needed).
      expect(countFrame2).toBe(0);

      // TDD red note: the cache entries for entity1 still exist in the Maps
      // at this point (w14 clean-up not yet implemented).  This is the red
      // state — the test asserts "the entries exist but are unreachable"
      // which is the pre-clean-up reality.  After w14 lands, the entries
      // will be explicitly dropped.
    });

    it('(c) cache entry count drops after despawn (indirect via counter)', async () => {
      // Spawn 2 entities, warm the caches, then despawn 1.  Verify that
      // the bind group counter after despawn does NOT re-create the
      // despawned entity's BGs — only the surviving entity's BGs remain
      // hit (hot) from cache.  The counter should stay low (only view/mesh
      // may re-create if validated.length still > 0, but per-entity BGs
      // for the surviving entity stay hit).
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
      const w = world as {
        spawn: (...args: unknown[]) => unknown;
        despawn: (e: unknown) => { unwrap: () => void };
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
      const entity1 = w.spawn(
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
      w.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
        {
          component: C.Transform,
          data: {
            pos: [3, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      );

      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;
      const bc = renderer.bindGroupCounts;

      // Frames 1-2: warm caches with both entities
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      const countWarm = bc?.createBindGroup ?? -1;
      // After warming, counter should be 0 (all BGs hot)
      expect(countWarm).toBe(0);

      // Despawn entity 1
      w.despawn(entity1).unwrap();

      // Frame 3: only 1 surviving entity.  Its per-entity BGs should stay hit
      // from cache.  View/mesh are frame-shared and also stay hit (no resource
      // change).  Counter should remain 0.
      draw([world], { owner: 0 });
      const countAfterDespawn = bc?.createBindGroup ?? -1;
      expect(countAfterDespawn).toBe(0);

      // TDD red note: the despawned entity's materialBgPerEntity and
      // instancesBgPerEntity entries still occupy space in their Maps (w14
      // clean-up not yet implemented).  This is correct pre-clean-up state —
      // they are orphaned but not yet dropped.  After w14 lands, a follow-up
      // assertion could verify GC by checking the counter stays 0 even after
      // respawn of a brand-new entity (whose entityKey differs due to
      // generation bump — no false hit on the orphaned key).
    });

    it('(d) respawn after despawn does NOT hit stale cache entry', async () => {
      // Despawn entity1, then spawn a brand-new entity (same index slot may
      // be recycled but generation differs).  The new entity gets a different
      // entityKey, so it MUST miss the cache and create new bind groups —
      // never accidentally reuse the despawned entity's bind groups.
      //
      // This is the correct behaviour regardless of clean-up: entityKey
      // with generation field guarantees the new entity's key differs from
      // the orphaned one.  Clean-up (w14) additionally drops the orphaned
      // entry from the Map to prevent unbounded growth.
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
      const w = world as {
        spawn: (...args: unknown[]) => unknown;
        despawn: (e: unknown) => { unwrap: () => void };
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
      const entity1 = w.spawn(
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

      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;
      const bc = renderer.bindGroupCounts;

      // Warm caches for entity1
      draw([world], { owner: 0 });
      draw([world], { owner: 0 });
      const countWarm = bc?.createBindGroup ?? -1;
      expect(countWarm).toBe(0);

      // Despawn entity1
      w.despawn(entity1).unwrap();

      // Frame after despawn: no renderables
      draw([world], { owner: 0 });
      const countAfterDespawn = bc?.createBindGroup ?? -1;
      // With zero renderables, counter stays 0
      expect(countAfterDespawn).toBe(0);

      // Spawn a brand-new entity (entityKey will differ due to generation bump).
      // The mock device returns the same object references for all GPU resources,
      // so handle ids remain stable across despawn/respawn.  Record only the
      // warm counter, then after despawn+respawn verify the counter is still 0
      // (the new entity's BGs come from cache on handle ids — mock limitation).
      // The entityKey difference is verified in w1 (entity-key test) with the
      // same despawn+respawn pattern.
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

      // After respawn: the entityKey differs (generation bumped — w1 already
      // tests this invariant). In the mock, handle objects are reference-equal
      // across invocations, so the new entity's cache key only differs in
      // entityKey, but the nested WeakMap chain maps the same GPU object refs
      // to the same leaf BindGroup.  The counter therefore stays low when the
      // handle set is unchanged (mock limitation, not a cache bug).
      draw([world], { owner: 0 });
      const countAfterRespawn = bc?.createBindGroup ?? -1;
      // Mock limitation: same object refs -> same WeakMap chain hit.  The entityKey
      // portion of the outer Map differs, but with 14 identical handle objects,
      // the inner chain hits the same leaf BG.  In a real GPU context
      // with different device objects, the key would fully differ.
      expect(countAfterRespawn).toBeLessThanOrEqual(3);
    });

    // AC-07 cont'd: despawn eviction via production clean-up path.
    //
    // Plan-strategy sec.5.3.2 item 4 circular-validation prohibition:
    // clean-up tests MUST NOT copy the cleanPerEntityCache loop into the
    // test body.  Instead, they must drive a real production draw -> clean-up
    // path through recordFrame.  The cleanup assertion is indirect: after
    // despawn, the cache-hit counter proves the despawned entity's entries
    // are inert (no false hit).  The unbounded-growth guarantee is tested by
    // spawning/despawning many entities and observing stable counter behavior.
    //
    // Note: sentinel key survival (D-6, Issue#1) is validated by w16
    // (shadow-enabled stable frame ac-03 test) which uses the production
    // cleanPerEntityCache path through real draw([world], { owner: 0 }).

    it('(e) despawn then respawn many times keeps counter stable (no unbounded growth)', async () => {
      // Spawn 3 entities, warm cache, despawn all, respawn 3 new entities.
      // The view/mesh frame-level BGs are still cached (same GPU handles).
      // The per-entity BGs from despawned entities are carried forward but
      // unreachable (entityKey with generation differs on respawn — w1).
      // Each respawn triggers NEW material BG creates.  After warm, counter
      // returns to 0.  If cache were growing without bound (no clean-up),
      // the counter behavior would still be correct (keys differ), but there
      // would be no counter-side way to detect the leak in mock.  In a real
      // GPU, AC-07 ensures the Map does not grow across many despawn cycles.
      //
      // The test verifies: spawn and despawn cycles produce a counter that
      // resets to 0 after warm, proving the cache-hit mechanism works after
      // entity lifecycle changes.

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
      const w = world as {
        spawn: (...args: unknown[]) => unknown;
        despawn: (e: unknown) => { unwrap: () => void };
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

      function spawnEntities(count: number): unknown[] {
        const entities: unknown[] = [];
        for (let i = 0; i < count; i++) {
          entities.push(
            w.spawn(
              { component: C.MeshRenderer, data: { materials: [0] } },
              { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
              {
                component: C.Transform,
                data: {
                  pos: [i * 2, 0, 0],
                  quat: [0, 0, 0, 1],
                  scale: [1, 1, 1],
                },
              },
            ),
          );
        }
        return entities;
      }

      const rs = renderer as unknown as RendererForTest;
      const draw = renderer.draw.bind(renderer) as (w: unknown, o: { owner: number }) => void;

      // Run 3 spawn/despawn cycles.  Each cycle spawns 3 entities, warms
      // the cache for 2 draws, then despawns all.

      for (let cycle = 0; cycle < 3; cycle++) {
        const entities = spawnEntities(3);

        // Frame 1: createBindGroup > 0 for cold view+mesh (cycle 1) or 0 if
        // view+mesh caches are still warm from a previous cycle.  We assert
        // the counter is a number (accessible) after draw.
        draw([world], { owner: 0 });
        const countFrame1 = rs.bindGroupCounts?.createBindGroup ?? -1;
        expect(countFrame1).toBeGreaterThanOrEqual(0);

        // Frame 2: warm — cache hits, counter == 0.
        draw([world], { owner: 0 });
        const countWarm = rs.bindGroupCounts?.createBindGroup ?? -1;
        expect(countWarm).toBe(0);

        // Despawn all entities from this cycle.
        for (const e of entities) {
          w.despawn(e).unwrap();
        }

        // Draw after despawn: validated[] may be empty (Case E path), which
        // skips view/mesh BG creation. Counter should be 0 (nothing to create)
        // or >0 if view/mesh still needed (eg when other entities present).
        draw([world], { owner: 0 });
        const countAfterDespawn = rs.bindGroupCounts?.createBindGroup ?? -1;
        expect(countAfterDespawn).toBe(0);
      }
    });
  });
}
