// bug-20260610-sponza-per-submesh-bg-textureviews D2 regression test (M3 / m3-1).
//
// State at C2 (this commit, parent f4bf5cda + M2 rename):
//   The non-sprite branch in render-system-record.ts builds the material BG
//   ONCE per entity using materials[0]'s textureViews, then the per-submesh
//   loop only varies the dynamic UBO offset. With 1 entity x 3 submeshes x
//   3 distinct PBR materials, only one createBindGroup call lands with
//   label 'pbr-material-skylight-bg'; all three submeshes share that BG and
//   thus share materials[0]'s baseColor textureView. Sponza renders one
//   material's albedo across all submeshes (single-material demos can never
//   surface this bug -- the materialBgKey collapses on entityKey).
//
// State at C3 (next commit, M4 7d fix):
//   BG construction moves inside the per-submesh draw loop and reads
//   materials[smIdx]'s textureViews. The cache key drops entityKey so
//   identical-material submeshes still dedup, but distinct-material submeshes
//   each get their own BG with their own baseColor textureView.
//
// Therefore at C2 the three assertions below MUST FAIL (TDD red phase). The
// failure shape is: createBindGroup is called once with the PBR label
// (not >= 3); the binding-2 textureView set has size 1 (not 3); the BG
// sentinel set has size 1 (not 3). M4 turns them GREEN.
//
// Plan anchors: AC-03 + plan D-2 + R2 risk; falsification check from
// plan-strategy 5.4. The three redundant assertions catch three independent
// failure modes after a future "half port" regression (e.g. someone moves
// the BG construction inside the loop but forgets to re-resolve textureViews
// per-material -- assertion (b) catches that even if (a) passes).

import type { Handle, MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Test fixtures ──────────────────────────────────────────────────────────

interface BindGroupEntryRecord {
  readonly binding: number;
  readonly resource: unknown;
}

interface CreateBindGroupCall {
  readonly label: string | undefined;
  readonly entries: readonly BindGroupEntryRecord[];
  readonly returned: object;
}

interface DeviceSpies {
  readonly createBindGroupCalls: CreateBindGroupCall[];
  readonly textureViewByTextureId: Map<object, object>;
}

function makeSpies(): DeviceSpies {
  return {
    createBindGroupCalls: [],
    textureViewByTextureId: new Map(),
  };
}

function makeMockGL2(): unknown {
  return {
    __mockTag: 'webgl2',
    getExtension: () => null,
    getParameter: () => 1,
    isContextLost: () => false,
  };
}

function makeMockCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 800,
    height: 600,
    getContext(kind: string): unknown {
      if (kind === 'webgl2') return makeMockGL2();
      if (kind === 'webgpu') {
        return {
          __mockTag: 'webgpu-canvas-context',
          configure: () => undefined,
          unconfigure: () => undefined,
          // Each frame must hand back a fresh swap-chain texture view; the
          // test only cares about per-material textureViews so we return a
          // stable sentinel here.
          getCurrentTexture: () => ({
            createView: () => ({ __role: 'swap-chain-view' }),
          }),
        };
      }
      return null;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
}

function makeMockGPUDevice(spies: DeviceSpies): { device: unknown } {
  const lost = new Promise<unknown>(() => undefined);
  let nextTextureId = 0;
  let nextBindGroupId = 0;
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
    // The bug surface: capture every createBindGroup call's label + entries
    // so tests can assert per-material BGs were built with per-material
    // textureViews. Returns a per-call sentinel so identity comparisons
    // (assertion c) are meaningful.
    createBindGroup: (desc: {
      label?: string;
      entries?: readonly { binding: number; resource: unknown }[];
    }) => {
      const sentinel = { __role: 'bg', __id: nextBindGroupId++, __label: desc.label };
      spies.createBindGroupCalls.push({
        label: desc.label,
        entries: (desc.entries ?? []).map((e) => ({ binding: e.binding, resource: e.resource })),
        returned: sentinel,
      });
      return sentinel;
    },
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
        setStencilReference: () => undefined,
        setViewport: () => undefined,
        setScissorRect: () => undefined,
        draw: () => undefined,
        drawIndexed: () => undefined,
        end: () => undefined,
      }),
      finish: () => ({}),
    }),
    // Each createTexture call gets a unique view sentinel so binding-2
    // textureView resources are distinguishable across materials. Without
    // this, every texture's view collapses to `{}` and assertion (b) cannot
    // fire even when the bug is fixed.
    createTexture: () => {
      const myId = nextTextureId++;
      const view = { __role: 'tex-view', __texId: myId };
      const tex = {
        __role: 'texture',
        __texId: myId,
        createView: () => view,
      };
      spies.textureViewByTextureId.set(tex, view);
      return tex;
    },
    createSampler: () => ({}),
    destroy: () => undefined,
  };
  return { device };
}

function makeMockGPU(deviceObj: unknown): unknown {
  return {
    requestAdapter: async () => ({ requestDevice: async () => deviceObj }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

const baseNavigator: Navigator = {
  userAgent: 'mock-engine-test',
} as Partial<Navigator> as Navigator;

function buildManifestDataUrl(): string {
  const materialShaderStub = (identifier: string, paramSchema = '[]') => ({
    identifier,
    sourcePath: `${identifier}.wgsl`,
    composedWgsl: '/* stub */',
    paramSchema,
    variants: [],
  });
  // The standard-PBR shader declares baseColorTexture / metallicRoughnessTexture
  // / normalTexture as texture2d params. Texture resolution is now schema-driven
  // (derive(paramSchema).textureFieldNames is the SSOT), so the stub MUST carry
  // the real schema -- an empty '[]' would yield zero user-region textures and
  // collapse all 3 distinct-baseColor materials onto one bind group.
  const pbrParamSchema = JSON.stringify([
    { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
    { name: 'metallic', type: 'f32', default: 0 },
    { name: 'roughness', type: 'f32', default: 0.5 },
    { name: 'baseColorTexture', type: 'texture2d' },
    { name: 'metallicRoughnessTexture', type: 'texture2d' },
    { name: 'normalTexture', type: 'texture2d' },
  ]);
  const manifest = {
    schemaVersion: '1.0.0',
    entries: [
      // Stub WGSL must satisfy the runtime's compatibility heuristics; the
      // pbr stub references f_schlick to mark the shader as PBR-shaped, the
      // tonemap stub declares TonemapParams to mark it as tonemap-shaped.
      // Mirrors the harness in render-system-multi-material.test.ts.
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
      materialShaderStub('forgeax::default-standard-pbr', pbrParamSchema),
      materialShaderStub('forgeax::default-unlit'),
    ],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

interface RendererLike {
  ready: Promise<unknown>;
  draw: (world: unknown) => void;
  onError: (cb: (err: { code: string }) => void) => () => void;
}

async function importEngine(): Promise<{
  createRenderer: (canvas: unknown, opts?: unknown, opts2?: unknown) => Promise<RendererLike>;
}> {
  return (await import('../createRenderer')) as never;
}

async function importEcs(): Promise<{
  World: new () => {
    spawn: (...componentDatas: unknown[]) => unknown;
    allocSharedRef: <Target extends string, T>(target: Target, payload: T) => number;
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
}> {
  return (await import('../index')) as never;
}

function cameraTransform() {
  return {
    posX: 0,
    posY: 0,
    posZ: 5,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 1,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  };
}

function originTransform() {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 1,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  };
}

function makeChequerTexture(): TextureAsset {
  // A minimal 2x2 RGBA8 texture; data values do not matter -- the test
  // only cares that each registered handle resolves to a distinct GPU
  // textureView sentinel.
  return {
    kind: 'texture',
    width: 2,
    height: 2,
    // colorSpace=linear+rgba8unorm to satisfy the runtime's
    // srgb-format consistency validator (layer 7c-1: srgb requires
    // rgba8unorm-srgb). The test only cares that each texture's
    // GPU view resolves to a distinct sentinel, not its colorSpace.
    format: 'rgba8unorm',
    data: new Uint8Array(2 * 2 * 4),
    colorSpace: 'linear',
    mipmap: false,
  } as unknown as TextureAsset;
}

function threeSubmeshMesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(9 * 12),
    indices: new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    attributes: {},
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
      { indexOffset: 3, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
      { indexOffset: 6, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
    ],
  };
}

// ─── Setup helpers ──────────────────────────────────────────────────────────

async function setupRenderer(spies: DeviceSpies): Promise<{ renderer: RendererLike }> {
  const { device } = makeMockGPUDevice(spies);
  vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
  const { createRenderer } = await importEngine();
  const renderer = await createRenderer(
    makeMockCanvas(),
    {},
    {
      shaderManifestUrl: buildManifestDataUrl(),
    },
  );
  await renderer.ready;
  return { renderer };
}

async function spawnPbrMultiMaterialScene(): Promise<unknown> {
  const { World } = await importEcs();
  const C = await importComponents();
  const world = new World();

  // Mint the 3-submesh mesh as a user-tier column handle.
  const meshHandle = world.allocSharedRef('MeshAsset', threeSubmeshMesh()) as unknown as Handle<
    'MeshAsset',
    'shared'
  >;

  // Mint 3 distinct texture assets, each producing a unique GPU textureView
  // sentinel via the createTexture mock. allocSharedRef returns the bare
  // handle (a u32 slot id), which the extract stage accepts directly in
  // paramValues.baseColorTexture.
  const textureHandles: Handle<'TextureAsset', 'shared'>[] = [];
  for (let i = 0; i < 3; i++) {
    textureHandles.push(
      world.allocSharedRef('TextureAsset', makeChequerTexture()) as unknown as Handle<
        'TextureAsset',
        'shared'
      >,
    );
  }
  // Use numeric handles directly in paramValues. Strings are not resolved
  // by render-system-extract (which gates on
  // `typeof pv.baseColorTexture === 'number'`); only the disk-pack
  // materialLoader resolves refs[]-index. Tests targeting the in-memory
  // extract path must pass numeric handles.

  // Mint 3 distinct PBR materials, each pointing at a different
  // baseColorTexture handle. shadingModel is 'standard' so the non-sprite
  // branch in record fires; this is the branch that builds the BG with
  // label 'pbr-material-skylight-bg'.
  const materialHandles: Handle<'MaterialAsset', 'shared'>[] = [];
  for (let i = 0; i < 3; i++) {
    const matHandle = world.allocSharedRef('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-standard-pbr',
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      ],
      paramValues: {
        baseColor: [1, 1, 1],
        metallic: 0,
        roughness: 0.5,
        baseColorTexture: textureHandles[i] as unknown as number,
      },
    } as unknown as MaterialAsset) as unknown as Handle<'MaterialAsset', 'shared'>;
    materialHandles.push(matHandle);
  }

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
    { component: C.MeshRenderer, data: { materials: materialHandles } },
    { component: C.MeshFilter, data: { assetHandle: meshHandle } },
    { component: C.Transform, data: originTransform() },
  );
  return world;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('record: per-submesh PBR material BG textureView (bug-20260610 D2 regression)', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', baseNavigator);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1 entity x 3 submeshes x 3 distinct PBR materials: BGs are per-material with distinct baseColor textureViews', async () => {
    const spies = makeSpies();
    const { renderer } = await setupRenderer(spies);
    const errors: string[] = [];
    renderer.onError((e) => errors.push(e.code));

    const world = await spawnPbrMultiMaterialScene();
    renderer.draw(world);

    // Filter to the PBR-bucket BG creations only. Sprite / shadow / tonemap
    // BGs use different labels and would falsely inflate the count.
    const pbrBgCalls = spies.createBindGroupCalls.filter(
      (c) => c.label === 'pbr-material-skylight-bg',
    );

    // Assertion (a): one createBindGroup per distinct material slot.
    // RED at C2: only 1 call (perSubmeshBg cache hit on entityKey-keyed key);
    // GREEN at C3: 3 calls, one per submesh's distinct material.
    expect(pbrBgCalls.length).toBeGreaterThanOrEqual(3);

    // Assertion (b): the binding-2 (baseColor) textureView resources are
    // pairwise distinct across the 3 calls. RED at C2: only one call exists
    // so the set size is 1; GREEN at C3: each call's binding-2 references a
    // different GPU textureView sentinel because BG is rebuilt per-submesh
    // with materials[smIdx].baseColorTexture.
    // The RHI translator flattens `{ kind: 'textureView', value: view }` to the
    // raw view object before reaching the GPU device, so the recorded entry's
    // `resource` IS the textureView (e.g. `{ __role: 'tex-view', __texId: 22 }`),
    // not a `{ kind, value }` wrapper. Compare resources directly.
    const baseColorViews = new Set<unknown>();
    for (const call of pbrBgCalls) {
      const binding2 = call.entries.find((e) => e.binding === 2);
      expect(binding2, 'every PBR BG must declare binding 2 (baseColor)').toBeDefined();
      baseColorViews.add(binding2?.resource);
    }
    expect(baseColorViews.size).toBeGreaterThanOrEqual(3);

    // Assertion (c): the 3 calls return distinct BG sentinels (proves the
    // materialBgKey cache MISSED for each distinct-material submesh; if the
    // key still includes entityKey and not handle-specific slot data, the
    // first call populates the cache and the next two hit it -- the mock
    // wouldn't even invoke createBindGroup again so this assertion would
    // also fire alongside (a)). Recorded redundantly so a future "half
    // port" that fixes (a) but not the cache key still surfaces here.
    const bgSentinels = new Set<unknown>(pbrBgCalls.map((c) => c.returned));
    expect(bgSentinels.size).toBeGreaterThanOrEqual(3);

    // Sanity: no upstream extract-stage errors leaked in.
    expect(errors).toEqual([]);
  });
});
