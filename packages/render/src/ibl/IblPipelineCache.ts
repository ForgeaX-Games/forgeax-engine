// IblPipelineCache.ts -- Per-device WeakMap pipeline cache for IBL precompute.
//
// Plan-strategy D-1/D-7: cache for 4 GPU passes (equirect->cube /
// irradiance / prefilter / BRDF LUT). M2 provides the cache skeleton;
// M3 (t18/t20) wires real shader math from ibl.wgsl.
//
// Structure mirrors mipmap-generator.ts per-device WeakMap pattern:
//   WeakMap<device, IblPipelineCachePerDevice>
//
// Public surface (M3):
//   - getOrCreateIblCache(device): get or initialize per-device cache
//   - iblCacheSize(): introspection hook
//   - hasIblCache(device): introspection hook
//   - setIblWgslSource(source): set the ibl.wgsl WGSL source string
//   - createIblShaderModules(device, factory): create shader modules from ibl.wgsl
//   - createIblPipelines(device, factory, modules): create 4 render pipelines
//   - runIblPrecompute(opts): execute 4 GPU precompute passes (M3 t20)
//
// M3 t20: pipeline slots are filled with real render pipelines loaded from
// ibl.wgsl, replacing the M2 stub undefined slots. The 4 GPU passes are
// executed in the standard order (equirect->cube -> irradiance -> prefilter
// -> BRDF LUT), with counters set post-execution per AC-04/05/06.

// ─── Device shim shapes ──────────────────────────────────────────────────────

import { cubemapCaptureProjection } from './cubemap-projection';

/**
 * Shader module factory (async, injected via configureGpuDevice).
 * Mirrors `MipmapShaderModuleFactory` from mipmap-generator.
 */
export type IblShaderModuleFactory = (
  device: object,
  desc: { code: string; label?: string },
) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;

/**
 * Per-device IBL pipeline cache instance.
 *
 * M3.5 (round-2 t52): the 4 pipeline slots are mutable so createIblPipelines
 * can fill them after construction. The 4 textures + their views are also
 * cached here so runIblPrecompute targets are stable across calls
 * (idempotent).
 */
export interface IblPipelineCachePerDevice {
  /** Color format shared by all precompute outputs for this device. */
  outputFormat?: string;
  /** Equirectangular-to-cubemap pipeline. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU pipeline handle
  equirectToCubePipeline?: any;
  /** Diffuse irradiance convolution pipeline. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU pipeline handle
  irradiancePipeline?: any;
  /** Specular prefilter pipeline. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU pipeline handle
  prefilterPipeline?: any;
  /** BRDF integration LUT pipeline. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU pipeline handle
  brdfLutPipeline?: any;

  /** Face uniforms BGL (shared across equirect/irradiance/prefilter, D-9). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque BGL
  faceUniformsBgl?: any;
  /** group(1) BGL for the equirect-to-cube pass (texture_2d + sampler). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque BGL
  equirectGroup1Bgl?: any;
  /** group(1) BGL for irradiance + prefilter (texture_cube + sampler). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque BGL
  cubeGroup1Bgl?: any;
  /** group(0) BGL for prefilter (face + prefilter uniforms). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque BGL
  prefilterGroup0Bgl?: any;

  /** Irradiance cubemap texture (32x32; outputFormat, cube). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture
  irradianceTexture?: any;
  /** Irradiance cubemap view (dimension:cube). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture view
  irradianceView?: any;
  /** Per-face 2D views for irradiance (render-attachment use). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture views
  irradianceFaceViews?: ReadonlyArray<any>;
  /** Specular prefilter cubemap (128x128, 5 mip levels). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture
  prefilterTexture?: any;
  /** Prefilter cubemap view (dimension:cube, all mips). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture view
  prefilterView?: any;
  /** Per-face 2D views per mip for prefilter (5 mips x 6 faces). */
  // biome-ignore lint/suspicious/noExplicitAny: nested mip x face views
  prefilterFaceViewsByMip?: ReadonlyArray<ReadonlyArray<any>>;
  /** BRDF LUT (256x256; outputFormat). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture
  brdfLutTexture?: any;
  /** BRDF LUT view. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture view
  brdfLutView?: any;

  /** Counter: times irradiance pass has executed. AC-04: == 1 after first cook. */
  irradianceBakeCount: number;
  /** Counter: times prefilter pass has executed. AC-05: == 1 after first cook. */
  prefilterBakeCount: number;
  /** Counter: times BRDF LUT pass has executed. AC-06: == 1 after first cook. */
  brdfLutBakeCount: number;
}

/**
 * Per-device cache map. The WeakMap key is the opaque device object;
 * destroying the device naturally clears its cache entry.
 */
const deviceCache: WeakMap<object, IblPipelineCachePerDevice> = new WeakMap();

/**
 * Get or create the per-device IBL pipeline cache.
 */
export function getOrCreateIblCache(device: object): IblPipelineCachePerDevice {
  const existing = deviceCache.get(device);
  if (existing !== undefined) return existing;

  const cache: IblPipelineCachePerDevice = {
    irradianceBakeCount: 0,
    prefilterBakeCount: 0,
    brdfLutBakeCount: 0,
  };
  deviceCache.set(device, cache);
  return cache;
}

/**
 * Number of cached per-device instances (introspection hook for tests).
 */
export function iblCacheSize(): number {
  // WeakMap doesn't expose size; approximate by iteration.
  let count = 0;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: WeakMap iteration hack
    for (const _ of deviceCache as any) {
      count++;
    }
  } catch {
    // WeakMap is not iterable; this is expected.
  }
  return count;
}

/**
 * Check whether a device has an active cache entry (introspection for tests).
 */
export function hasIblCache(device: object): boolean {
  return deviceCache.has(device);
}

/**
 * Clear the per-device cache entry for the given device, if any.
 *
 * feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5: called from
 * `Renderer.dispose()` step 4 (plan-strategy D-2 6-step walk) so the IBL
 * pipelines / textures attached to a torn-down device do not survive in the
 * runtime cache. The underlying GPU pipeline / texture handles are not
 * separately destroyed here -- they were created on the same RhiDevice the
 * dispose chain is about to release at step 5 (`context.unconfigure`); the
 * spec contract is that releasing the device tears down its child pipelines
 * implicitly. Clearing the WeakMap entry simply lets GC reclaim the JS-side
 * cache record.
 *
 * Idempotent (architecture-principles §6): a second call after the entry
 * was deleted is a no-op.
 */
export function clearIblCacheForDevice(device: object): void {
  deviceCache.delete(device);
}

// ─── IBL WGSL source management ──────────────────────────────────────────────

let iblWgslSourceCache: string | undefined;

/**
 * Set the ibl.wgsl source string. Called once by the consumer
 * (e.g., AssetRegistry) when the shader module source is loaded.
 */
export function setIblWgslSource(source: string): void {
  iblWgslSourceCache = source;
}

/**
 * Get the cached ibl.wgsl source string.
 * Throws if not yet loaded.
 */
export function getIblWgslSource(): string {
  if (iblWgslSourceCache === undefined) {
    throw new Error(
      'ibl.wgsl source not loaded -- call setIblWgslSource before using IBL pipelines',
    );
  }
  return iblWgslSourceCache;
}

// ─── M3.5 composed ibl-* shader source registry ─────────────────────────────
//
// 4 composed WGSL strings -- one per render pipeline. Each string is the
// output of @forgeax/engine-naga composeShader after merging ibl_shared +
// the per-pass module. Built by ShaderRegistry / vite-plugin-shader at
// build-time so the runtime cache never reaches into engine-naga
// (AGENTS.md grep gate forbids).

export interface IblComposedShaders {
  /** ibl-equirect-to-cube composed (cubemap_vs + equirectToCube_fs). */
  readonly equirectToCube: string;
  /** ibl-irradiance composed (cubemap_vs + irradianceConvolve_fs). */
  readonly irradiance: string;
  /** ibl-prefilter composed (cubemap_vs + prefilterEnv_fs). */
  readonly prefilter: string;
  /** ibl-brdf-lut composed (fullscreen_vs + brdfLutBake_fs). */
  readonly brdfLut: string;
}

let iblComposedShadersCache: IblComposedShaders | undefined;

/**
 * Inject the composed ibl-* shader sources used by createIblPipelines.
 * Called once by the engine bootstrap (createRenderer step "shader-load")
 * with the 4 composed entries from ShaderRegistry.
 */
export function setIblComposedShaders(sources: IblComposedShaders): void {
  iblComposedShadersCache = sources;
}

/**
 * Retrieve the cached composed shader bundle.
 * Returns undefined when the runtime is operating without a real shader
 * source (mock device unit tests that exercise pipeline dispatch surface
 * only).
 */
export function getIblComposedShaders(): IblComposedShaders | undefined {
  return iblComposedShadersCache;
}

// ─── Standard cube vertices for cubemap face rendering ───────────────────────
// 36 vertices (6 faces * 2 triangles * 3 vertices), vec3<f32> format.
// Unit cube [-1, 1]^3 centered at origin.
export const CUBEMAP_FACE_VERTICES = new Float32Array([
  // +X face (+1, 0, 0)
  1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0,
  // -X face (-1, 0, 0)
  -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0,
  1.0,
  // +Y face (0, +1, 0)
  -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0,
  // -Y face (0, -1, 0)
  -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0,
  1.0,
  // +Z face (0, 0, +1)
  -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0,
  // -Z face (0, 0, -1)
  1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, -1.0,
  -1.0,
]);

// 6 capture view-projection matrices (right-handed, from origin).
// Projection Y is negated for WebGPU top-left framebuffer origin.
// Target directions: +X, -X, +Y, -Y, +Z, -Z.
// Up vectors: -Y for X/Z faces, +Z for +Y, -Z for -Y.
export const CAPTURE_VIEW_PROJS = buildCaptureViewProjs();

function buildCaptureViewProjs(): Float32Array[] {
  const targets: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const ups: [number, number, number][] = [
    [0, -1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, -1, 0],
    [0, -1, 0],
  ];

  const proj = cubemapCaptureProjection(Math.PI / 2, 0.1, 10.0);

  return targets.map((_t, i) => {
    const t = _t;
    const u = ups[i] ?? [0, -1, 0];
    const view = lookAtMatrix([0, 0, 0], t, u);
    return mulMat4(proj, view);
  });
}

function lookAtMatrix(
  eye: readonly number[],
  target: readonly number[],
  up: readonly number[],
): Float32Array {
  const [ex, ey0, ez] = [eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0];
  const [tx, ty, tz] = [target[0] ?? 0, target[1] ?? 0, target[2] ?? 0];
  const [upx, upy, upz] = [up[0] ?? 0, up[1] ?? 0, up[2] ?? 0];
  let fx = ex - tx,
    fy = ey0 - ty,
    fz = ez - tz;
  const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz);
  fx /= fLen;
  fy /= fLen;
  fz /= fLen;

  let rx = upy * fz - upz * fy;
  let ry = upz * fx - upx * fz;
  let rz = upx * fy - upy * fx;
  const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  rx /= rLen;
  ry /= rLen;
  rz /= rLen;

  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;

  return new Float32Array([
    rx,
    ux,
    fx,
    0,
    ry,
    uy,
    fy,
    0,
    rz,
    uz,
    fz,
    0,
    -(rx * ex + ry * ey0 + rz * ez),
    -(ux * ex + uy * ey0 + uz * ez),
    -(fx * ex + fy * ey0 + fz * ez),
    1,
  ]);
}

// Column-major matrix product `r = a * b` where each Float32Array stores
// 4 contiguous column vectors of 4 floats (WGSL `mat4x4<f32>` uniform
// layout). For column-major storage `flat[c*4 + row] = M[col=c, row]`, so:
//   (a * b)[col=c, row=r] = sum_k a[col=k, row=r] * b[col=c, row=k]
//   flat_out[c*4 + r]     = sum_k a[k*4 + r] * b[c*4 + k]
//
// The prior row-major iteration silently transposed the result, producing
// `b * a` in WGSL's view -- IBL equirect-to-cube vertices then projected
// to clip with w=0 / w=-1, every face fell outside the [-1,1] frustum, no
// fragments drew, and every downstream IBL texture (irradiance / prefilter)
// inherited the clearValue=(0,0,0,1). Demo 3x3 sphere matrix rendered
// pure black because `ambient = kD * 0 + specular * 0 = 0` and there are
// no direct lights in the IBL demo scene.
function mulMat4(a: Float32Array, b: Float32Array): Float32Array {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (a[k * 4 + row] ?? 0) * (b[c * 4 + k] ?? 0);
      }
      r[c * 4 + row] = sum;
    }
  }
  return r;
}

// ─── M3.5 t52: createIblPipelines (4 independent GPURenderPipelines) ─────────

// IBL output texture sizes (plan D-10 SSOT, mirrored in ibl-brdf-lut.wgsl).
export const IRRADIANCE_SIZE = 32;
export const PREFILTER_SIZE = 128;
export const PREFILTER_MIP_LEVELS = 5;
export const BRDF_LUT_SIZE = 256;

const GPU_SHADER_STAGE_VERTEX = 0x1;
const GPU_SHADER_STAGE_FRAGMENT = 0x2;

/**
 * Minimal device shape used by createIblPipelines + runIblPrecompute. The
 * surface is intentionally narrow so unit-level mock devices can exercise
 * the dispatch path without standing up the full RHI shim.
 */
export interface IblPipelineDevice {
  // biome-ignore lint/suspicious/noExplicitAny: shim shapes
  createBindGroupLayout(desc: any): { ok: true; value: any } | { ok: false; error: unknown };
  // biome-ignore lint/suspicious/noExplicitAny: shim shapes
  createPipelineLayout(desc: any): { ok: true; value: any } | { ok: false; error: unknown };
  // biome-ignore lint/suspicious/noExplicitAny: shim shapes
  createRenderPipeline(desc: any): { ok: true; value: any } | { ok: false; error: unknown };
  // biome-ignore lint/suspicious/noExplicitAny: shim shapes
  createBuffer(desc: any): { ok: true; value: any } | { ok: false; error: unknown };
  // biome-ignore lint/suspicious/noExplicitAny: shim shapes
  createTexture(desc: any): { ok: true; value: any } | { ok: false; error: unknown };
  createTextureView(
    // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture
    texture: any,
    // biome-ignore lint/suspicious/noExplicitAny: shim shapes
    desc: any,
    // biome-ignore lint/suspicious/noExplicitAny: shim shapes
  ): { ok: true; value: any } | { ok: false; error: unknown };
  // biome-ignore lint/suspicious/noExplicitAny: shim shapes
  createSampler(desc?: any): { ok: true; value: any } | { ok: false; error: unknown };
  // biome-ignore lint/suspicious/noExplicitAny: shim shapes
  createBindGroup(desc: any): { ok: true; value: any } | { ok: false; error: unknown };
  // biome-ignore lint/suspicious/noExplicitAny: shim shapes
  createCommandEncoder(desc?: any): { ok: true; value: any } | { ok: false; error: unknown };
  readonly queue: {
    // biome-ignore lint/suspicious/noExplicitAny: shim shapes
    submit(buffers: ReadonlyArray<any>): unknown;
    // biome-ignore lint/suspicious/noExplicitAny: shim shapes
    writeBuffer?: (...args: any[]) => unknown;
  };
}

/**
 * Create 4 independent GPURenderPipelines + their shared / per-pass bind
 * group layouts. Pipeline slots are stored on the per-device cache and
 * survive across calls (D-1 startup-once cook).
 *
 * D-9: faceUniforms BGL (@group(0) for equirect/irradiance/prefilter) is
 * a single instance reused across 3 pipelines (binary-compatible).
 * group(1) is per-pipeline: texture_2d for equirect, texture_cube for
 * irradiance + prefilter, none for brdf-lut.
 */
export async function createIblPipelines(
  device: IblPipelineDevice,
  factory: IblShaderModuleFactory,
  // biome-ignore lint/suspicious/noExplicitAny: cubemap output format opaque
  cubeOutputFormat: any = 'rgba16float',
): Promise<
  | {
      ok: true;
      value: {
        // biome-ignore lint/suspicious/noExplicitAny: opaque GPU pipelines
        equirectToCubePipeline: any;
        // biome-ignore lint/suspicious/noExplicitAny: opaque GPU pipelines
        irradiancePipeline: any;
        // biome-ignore lint/suspicious/noExplicitAny: opaque GPU pipelines
        prefilterPipeline: any;
        // biome-ignore lint/suspicious/noExplicitAny: opaque GPU pipelines
        brdfLutPipeline: any;
      };
    }
  | { ok: false; error: unknown }
> {
  const cache = getOrCreateIblCache(device);
  if (cache.equirectToCubePipeline !== undefined) {
    return {
      ok: true,
      value: {
        equirectToCubePipeline: cache.equirectToCubePipeline,
        irradiancePipeline: cache.irradiancePipeline,
        prefilterPipeline: cache.prefilterPipeline,
        brdfLutPipeline: cache.brdfLutPipeline,
      },
    };
  }
  // Keep the output format on the per-device cache so the four pipelines and
  // their lazily-created side textures cannot drift. WebGL2 may need the
  // renderable rgba8 fallback even when the source equirect remains float.
  const outputFormat = cubeOutputFormat;
  cache.outputFormat = outputFormat;

  const composed = iblComposedShadersCache;
  // Mock-device path: factory returns synthetic modules. Both production
  // (composed) and unit-test (placeholder code) paths converge here.
  const fallbackCode = '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }';
  const src = composed ?? {
    equirectToCube: fallbackCode,
    irradiance: fallbackCode,
    prefilter: fallbackCode,
    brdfLut: fallbackCode,
  };

  // M5-amend Bug 1: normalise shim/raw return shapes. See runIblPrecompute
  // for full rationale -- same helper applied across both functions so
  // dawn-node (raw GPUDevice) + browser (rhi-shim) both succeed.
  // biome-ignore lint/suspicious/noExplicitAny: union of shim/raw return shapes
  const unwrap = (r: any): any => {
    if (r === null || r === undefined) return undefined;
    if (typeof r === 'object' && 'ok' in r) return r.ok ? r.value : undefined;
    return r;
  };

  const modules = await Promise.all([
    factory(device, { code: src.equirectToCube, label: 'ibl-equirect-to-cube' }),
    factory(device, { code: src.irradiance, label: 'ibl-irradiance' }),
    factory(device, { code: src.prefilter, label: 'ibl-prefilter' }),
    factory(device, { code: src.brdfLut, label: 'ibl-brdf-lut' }),
  ]);
  for (const m of modules) {
    if (!m.ok) return { ok: false, error: m.error };
  }
  // biome-ignore lint/style/noNonNullAssertion: checked above
  const [mEq, mIr, mPr, mBr] = modules.map((m) => m.value!) as [unknown, unknown, unknown, unknown];

  // D-9: faceUniforms BGL shared across 3 pipelines (equirect / irradiance /
  // prefilter). The prefilter additionally needs binding(1) for prefUniforms;
  // we keep a separate BGL for the prefilter group(0) to honour the WGSL
  // declaration in ibl-prefilter.wgsl.
  const faceBgl = unwrap(
    device.createBindGroupLayout({
      label: 'ibl-face-uniforms-bgl',
      entries: [{ binding: 0, visibility: GPU_SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }],
    }),
  );
  if (faceBgl === undefined) return { ok: false, error: 'ibl-face-uniforms-bgl' };
  cache.faceUniformsBgl = faceBgl;

  const prefilterGroup0 = unwrap(
    device.createBindGroupLayout({
      label: 'ibl-prefilter-group0-bgl',
      entries: [
        { binding: 0, visibility: GPU_SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
      ],
    }),
  );
  if (prefilterGroup0 === undefined) return { ok: false, error: 'ibl-prefilter-group0-bgl' };
  cache.prefilterGroup0Bgl = prefilterGroup0;

  const equirectGroup1 = unwrap(
    device.createBindGroupLayout({
      label: 'ibl-equirect-group1-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    }),
  );
  if (equirectGroup1 === undefined) return { ok: false, error: 'ibl-equirect-group1-bgl' };
  cache.equirectGroup1Bgl = equirectGroup1;

  const cubeGroup1 = unwrap(
    device.createBindGroupLayout({
      label: 'ibl-cube-group1-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: 'cube' },
        },
        {
          binding: 1,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    }),
  );
  if (cubeGroup1 === undefined) return { ok: false, error: 'ibl-cube-group1-bgl' };
  cache.cubeGroup1Bgl = cubeGroup1;

  // Pipeline layouts.
  const equirectLayout = unwrap(
    device.createPipelineLayout({
      label: 'ibl-equirect-pipeline-layout',
      bindGroupLayouts: [cache.faceUniformsBgl, cache.equirectGroup1Bgl],
    }),
  );
  if (equirectLayout === undefined) return { ok: false, error: 'ibl-equirect-pipeline-layout' };
  const irradianceLayout = unwrap(
    device.createPipelineLayout({
      label: 'ibl-irradiance-pipeline-layout',
      bindGroupLayouts: [cache.faceUniformsBgl, cache.cubeGroup1Bgl],
    }),
  );
  if (irradianceLayout === undefined) return { ok: false, error: 'ibl-irradiance-pipeline-layout' };
  const prefilterLayout = unwrap(
    device.createPipelineLayout({
      label: 'ibl-prefilter-pipeline-layout',
      bindGroupLayouts: [prefilterGroup0, cache.cubeGroup1Bgl],
    }),
  );
  if (prefilterLayout === undefined) return { ok: false, error: 'ibl-prefilter-pipeline-layout' };
  const brdfLutLayout = unwrap(
    device.createPipelineLayout({
      label: 'ibl-brdf-lut-pipeline-layout',
      bindGroupLayouts: [],
    }),
  );
  if (brdfLutLayout === undefined) return { ok: false, error: 'ibl-brdf-lut-pipeline-layout' };

  const vertexLayout3F = {
    arrayStride: 12,
    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as const }],
  };

  const pipeEquirect = unwrap(
    device.createRenderPipeline({
      label: 'ibl-equirect-to-cube-pipeline',
      layout: equirectLayout,
      vertex: { module: mEq, entryPoint: 'cubemap_vs', buffers: [vertexLayout3F] },
      fragment: {
        module: mEq,
        entryPoint: 'equirectToCube_fs',
        targets: [{ format: cubeOutputFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    }),
  );
  if (pipeEquirect === undefined) return { ok: false, error: 'ibl-equirect-to-cube-pipeline' };
  cache.equirectToCubePipeline = pipeEquirect;

  const pipeIrradiance = unwrap(
    device.createRenderPipeline({
      label: 'ibl-irradiance-pipeline',
      layout: irradianceLayout,
      vertex: { module: mIr, entryPoint: 'cubemap_vs', buffers: [vertexLayout3F] },
      fragment: {
        module: mIr,
        entryPoint: 'irradianceConvolve_fs',
        targets: [{ format: cubeOutputFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    }),
  );
  if (pipeIrradiance === undefined) return { ok: false, error: 'ibl-irradiance-pipeline' };
  cache.irradiancePipeline = pipeIrradiance;

  const pipePrefilter = unwrap(
    device.createRenderPipeline({
      label: 'ibl-prefilter-pipeline',
      layout: prefilterLayout,
      vertex: { module: mPr, entryPoint: 'cubemap_vs', buffers: [vertexLayout3F] },
      fragment: {
        module: mPr,
        entryPoint: 'prefilterEnv_fs',
        targets: [{ format: cubeOutputFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    }),
  );
  if (pipePrefilter === undefined) return { ok: false, error: 'ibl-prefilter-pipeline' };
  cache.prefilterPipeline = pipePrefilter;

  const pipeBrdfLut = unwrap(
    device.createRenderPipeline({
      label: 'ibl-brdf-lut-pipeline',
      layout: brdfLutLayout,
      vertex: { module: mBr, entryPoint: 'fullscreen_vs', buffers: [] },
      fragment: {
        module: mBr,
        entryPoint: 'brdfLutBake_fs',
        targets: [{ format: cubeOutputFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    }),
  );
  if (pipeBrdfLut === undefined) return { ok: false, error: 'ibl-brdf-lut-pipeline' };
  cache.brdfLutPipeline = pipeBrdfLut;

  return {
    ok: true,
    value: {
      equirectToCubePipeline: cache.equirectToCubePipeline,
      irradiancePipeline: cache.irradiancePipeline,
      prefilterPipeline: cache.prefilterPipeline,
      brdfLutPipeline: cache.brdfLutPipeline,
    },
  };
}

// ─── M3.5 t53: runIblPrecompute (4-pass dispatch + queue.submit) ─────────────

/**
 * Options consumed by runIblPrecompute. The caller (the internal
 * GpuResourceStore equirect-to-cubemap projection) provides the equirect input
 * + cubemap target GPU resources; the face-uniform / prefilter-uniform buffers
 * come from the t55 helpers.
 */
export interface RunIblPrecomputeOptions {
  readonly device: IblPipelineDevice;
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture (input equirect)
  readonly equirectGpuTex: any;
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture view (input equirect 2D view)
  readonly equirectView: any;
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture (output cube)
  readonly cubeGpuTex: any;
  // biome-ignore lint/suspicious/noExplicitAny: opaque cube view (for sampling)
  readonly cubeView: any;
  // biome-ignore lint/suspicious/noExplicitAny: per-face 2D views (6) for render attachments
  readonly cubeFaceViews: ReadonlyArray<any>;
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU buffer (6 x 256-byte face uniforms)
  readonly faceUniformsBuffer: any;
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU buffer (30 x 256-byte prefilter uniforms)
  readonly prefilterUniformsBuffer: any;
  // biome-ignore lint/suspicious/noExplicitAny: opaque vertex buffer (36 cube verts)
  readonly cubeVertexBuffer: any;
}

/**
 * Execute the 4 IBL precompute passes (equirect-to-cube / irradiance /
 * prefilter / brdf-lut) in a single CommandEncoder and submit.
 *
 * Counter invariant (AC-20, plan D-7 / N-3): the
 * `irradiance/prefilter/brdfLut BakeCount` counters are incremented
 * AFTER queue.submit returns. If submit throws or returns Result.err, the
 * counters stay at 0 -- this is the prime safety guard against the
 * round-1 "counter += 1 as dispatch proxy" anti-pattern.
 *
 * Returns Result.err with code='ibl-precompute-not-dispatched' when the
 * underlying device lacks queue.submit or any of the 4 pipelines was not
 * created (createIblPipelines must run first).
 */
export function runIblPrecompute(
  opts: RunIblPrecomputeOptions,
):
  | { ok: true; value: { submitted: boolean } }
  | { ok: false; error: { code: string; expected: string; hint: string } } {
  const { device } = opts;
  const cache = getOrCreateIblCache(device);
  const outputFormat = cache.outputFormat ?? 'rgba16float';

  // M5-amend Bug 1: support both rhi-shim path (Result<T, RhiError>) and raw
  // GPUDevice path (returns value directly). The shim returns
  // `{ok, value}`; raw devices return the GPU resource handle directly.
  // Same root cause + remedy as the mesh-upload raw-device fix at
  // uploadMeshById. Without this normalisation, every `device.createXxx(...)`
  // call inside this function bails on `!res.ok` (== !undefined == true)
  // when invoked from dawn-node / native bindings, silently skipping the
  // entire dispatch chain.
  // biome-ignore lint/suspicious/noExplicitAny: union of shim/raw return shapes
  const unwrap = (r: any): any => {
    if (r === null || r === undefined) return undefined;
    if (typeof r === 'object' && 'ok' in r) return r.ok ? r.value : undefined;
    return r;
  };

  // M5-amend Bug 1: detect raw GPUDevice vs rhi-shim. The shim's
  // `createBindGroup` accepts the forgeax tagged-union resource shape
  // (`{kind: 'buffer', value: {buffer, offset, size}}` etc.); raw
  // GPUDevice strictly requires WebGPU spec shape (`{buffer, offset,
  // size}` directly as `resource` for buffer bindings, raw view/sampler
  // handles directly for the other kinds). Probe by creating a no-op
  // empty BGL: shim wraps in `{ok, value}`; raw returns the BGL handle
  // directly. We discard the probe result; the cache already has BGLs.
  // biome-ignore lint/suspicious/noExplicitAny: probe call
  const probe: any = device.createBindGroupLayout({
    label: 'ibl-shape-probe',
    entries: [],
  });
  const isRawDevice =
    probe === null || probe === undefined || typeof probe !== 'object' || !('ok' in probe);

  // biome-ignore lint/suspicious/noExplicitAny: spec buffer-binding shape
  type SpecBgEntry = { binding: number; resource: any };
  // biome-ignore lint/suspicious/noExplicitAny: forgeax tagged-union resource
  const toSpecResource = (r: any): any => {
    if (r === null || r === undefined) return r;
    if (typeof r !== 'object' || !('kind' in r)) return r;
    if (r.kind === 'sampler') return r.value;
    if (r.kind === 'textureView') return r.value;
    if (r.kind === 'externalTexture') return r.value;
    if (r.kind === 'buffer') {
      const v = r.value;
      if (v !== null && typeof v === 'object' && 'buffer' in v) return v;
      // legacy shape -- shouldn't occur after Bug 1 fix but tolerate
      return { buffer: v };
    }
    return r;
  };
  // biome-ignore lint/suspicious/noExplicitAny: descriptor builder
  const buildBgDesc = (desc: any): any => {
    if (!isRawDevice) return desc;
    const entries: SpecBgEntry[] = (
      desc.entries as ReadonlyArray<{ binding: number; resource: unknown }>
    ).map((e) => ({
      binding: e.binding,
      resource: toSpecResource(e.resource),
    }));
    const out: { label?: string; layout: unknown; entries: SpecBgEntry[] } = {
      layout: desc.layout,
      entries,
    };
    if ('label' in desc && desc.label !== undefined) out.label = desc.label;
    return out;
  };

  if (
    cache.equirectToCubePipeline === undefined ||
    cache.irradiancePipeline === undefined ||
    cache.prefilterPipeline === undefined ||
    cache.brdfLutPipeline === undefined
  ) {
    return {
      ok: false,
      error: {
        code: 'ibl-precompute-not-dispatched',
        expected: '4 IBL pipelines created via createIblPipelines',
        hint: 'check IblPipelineCache.createIblPipelines was called before runIblPrecompute; counters must not increment before queue.submit',
      },
    };
  }
  if (typeof device.queue?.submit !== 'function') {
    return {
      ok: false,
      error: {
        code: 'ibl-precompute-not-dispatched',
        expected: 'device.queue.submit callable',
        hint: 'check IblPipelineCache.runIblPrecompute is called inside the GpuResourceStore equirect-to-cubemap projection; counters must not increment before queue.submit',
      },
    };
  }

  // Allocate side textures (irradiance / prefilter / brdf-lut) lazily.
  const TEXTURE_BINDING = 0x4;
  const COPY_DST = 0x2;
  const RENDER_ATTACHMENT = 0x10;
  // M5-amend Bug 1: dawn readback (t51 + reference baker) copies the
  // side textures back to a buffer via copyTextureToBuffer, which
  // requires the TextureUsage::CopySrc bit on the source. Without it
  // Dawn fails-fast "usage doesn't include CopySrc".
  const COPY_SRC = 0x1;

  // M5-amend Bug 1: helper that normalises shim/raw texture-view creation.
  // Raw GPUDevice exposes `gpuTexture.createView(desc)` on the texture
  // object itself; the rhi-shim exposes `device.createTextureView(tex, desc)`
  // and returns Result<T>.
  // biome-ignore lint/suspicious/noExplicitAny: shim/raw device split
  const makeView = (texture: any, desc: any): any => {
    // biome-ignore lint/suspicious/noExplicitAny: device shim shape
    const dev = device as any;
    if (typeof dev.createTextureView === 'function') {
      const r = dev.createTextureView(texture, desc);
      const u = unwrap(r);
      if (u !== undefined) return u;
    }
    if (texture !== null && texture !== undefined && typeof texture.createView === 'function') {
      try {
        return texture.createView(desc);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  if (cache.irradianceTexture === undefined) {
    const tRaw = device.createTexture({
      label: 'ibl-irradiance-cube',
      size: { width: IRRADIANCE_SIZE, height: IRRADIANCE_SIZE, depthOrArrayLayers: 6 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage: TEXTURE_BINDING | RENDER_ATTACHMENT | COPY_DST | COPY_SRC,
      viewFormats: [],
    });
    const tVal = unwrap(tRaw);
    if (tVal === undefined) return { ok: false, error: badAlloc('irradiance-texture') };
    cache.irradianceTexture = tVal;
    const cubeView = makeView(tVal, {
      label: 'ibl-irradiance-cube-view',
      dimension: 'cube',
      arrayLayerCount: 6,
    });
    if (cubeView === undefined) return { ok: false, error: badAlloc('irradiance-view') };
    cache.irradianceView = cubeView;
    // biome-ignore lint/suspicious/noExplicitAny: opaque GPU views
    const faceViews: any[] = [];
    for (let f = 0; f < 6; f++) {
      const v = makeView(tVal, {
        label: `ibl-irradiance-face-${f}`,
        dimension: '2d',
        baseArrayLayer: f,
        arrayLayerCount: 1,
      });
      if (v === undefined) return { ok: false, error: badAlloc('irradiance-face-view') };
      faceViews.push(v);
    }
    cache.irradianceFaceViews = faceViews;
  }

  if (cache.prefilterTexture === undefined) {
    const tRaw = device.createTexture({
      label: 'ibl-prefilter-cube',
      size: { width: PREFILTER_SIZE, height: PREFILTER_SIZE, depthOrArrayLayers: 6 },
      mipLevelCount: PREFILTER_MIP_LEVELS,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage: TEXTURE_BINDING | RENDER_ATTACHMENT | COPY_DST | COPY_SRC,
      viewFormats: [],
    });
    const tVal = unwrap(tRaw);
    if (tVal === undefined) return { ok: false, error: badAlloc('prefilter-texture') };
    cache.prefilterTexture = tVal;
    const cubeView = makeView(tVal, {
      label: 'ibl-prefilter-cube-view',
      dimension: 'cube',
      arrayLayerCount: 6,
      baseMipLevel: 0,
      mipLevelCount: PREFILTER_MIP_LEVELS,
    });
    if (cubeView === undefined) return { ok: false, error: badAlloc('prefilter-view') };
    cache.prefilterView = cubeView;
    // biome-ignore lint/suspicious/noExplicitAny: opaque GPU views
    const mipViews: any[][] = [];
    for (let m = 0; m < PREFILTER_MIP_LEVELS; m++) {
      // biome-ignore lint/suspicious/noExplicitAny: opaque GPU views
      const faces: any[] = [];
      for (let f = 0; f < 6; f++) {
        const v = makeView(tVal, {
          label: `ibl-prefilter-mip${m}-face${f}`,
          dimension: '2d',
          baseMipLevel: m,
          mipLevelCount: 1,
          baseArrayLayer: f,
          arrayLayerCount: 1,
        });
        if (v === undefined) return { ok: false, error: badAlloc('prefilter-face-view') };
        faces.push(v);
      }
      mipViews.push(faces);
    }
    cache.prefilterFaceViewsByMip = mipViews;
  }

  if (cache.brdfLutTexture === undefined) {
    const tRaw = device.createTexture({
      label: 'ibl-brdf-lut',
      size: { width: BRDF_LUT_SIZE, height: BRDF_LUT_SIZE, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage: TEXTURE_BINDING | RENDER_ATTACHMENT | COPY_DST | COPY_SRC,
      viewFormats: [],
    });
    const tVal = unwrap(tRaw);
    if (tVal === undefined) return { ok: false, error: badAlloc('brdf-lut-texture') };
    cache.brdfLutTexture = tVal;
    const v = makeView(tVal, {
      label: 'ibl-brdf-lut-view',
      dimension: '2d',
    });
    if (v === undefined) return { ok: false, error: badAlloc('brdf-lut-view') };
    cache.brdfLutView = v;
  }

  // Shared sampler (filtering, linear-linear).
  // U=repeat because equirect wraps horizontally (atan2 seam at ±π);
  // V=clamp because equirect poles are clamped vertically.
  const samplerRaw = device.createSampler({
    label: 'ibl-precompute-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  });
  const sampler = unwrap(samplerRaw);
  if (sampler === undefined) return { ok: false, error: badAlloc('sampler') };

  const encoderRaw = device.createCommandEncoder({ label: 'ibl-precompute-encoder' });
  const encoder = unwrap(encoderRaw);
  if (encoder === undefined) return { ok: false, error: badAlloc('encoder') };

  // Bind group: equirect group(1).
  const equirectBg = unwrap(
    device.createBindGroup(
      buildBgDesc({
        label: 'ibl-equirect-bg',
        layout: cache.equirectGroup1Bgl,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: opts.equirectView } },
          { binding: 1, resource: { kind: 'sampler', value: sampler } },
        ],
      }),
    ),
  );
  if (equirectBg === undefined) return { ok: false, error: badAlloc('equirect-bg') };

  // Bind group: cube group(1) for irradiance + prefilter.
  const cubeBg = unwrap(
    device.createBindGroup(
      buildBgDesc({
        label: 'ibl-cube-bg',
        layout: cache.cubeGroup1Bgl,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: opts.cubeView } },
          { binding: 1, resource: { kind: 'sampler', value: sampler } },
        ],
      }),
    ),
  );
  if (cubeBg === undefined) return { ok: false, error: badAlloc('cube-bg') };

  // (a) equirect-to-cube: 6 face draws.
  const cubeFaceViews = opts.cubeFaceViews;
  for (let face = 0; face < 6; face++) {
    const pass = encoder.beginRenderPass({
      label: 'ibl-equirect-to-cube',
      colorAttachments: [
        {
          view: cubeFaceViews[face],
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    // Face uniform: dynamic offset = face * 256.
    const faceBg = unwrap(
      device.createBindGroup(
        buildBgDesc({
          label: `ibl-face-bg-${face}`,
          layout: cache.faceUniformsBgl,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: opts.faceUniformsBuffer,
                  offset: face * 256,
                  size: 64,
                },
              },
            },
          ],
        }),
      ),
    );
    if (faceBg === undefined) return { ok: false, error: badAlloc('face-bg') };
    pass.setPipeline(cache.equirectToCubePipeline);
    pass.setBindGroup(0, faceBg);
    pass.setBindGroup(1, equirectBg);
    pass.setVertexBuffer(0, opts.cubeVertexBuffer);
    pass.draw(6, 1, face * 6, 0);
    pass.end();
  }

  // (b) irradiance convolve: 6 face draws.
  const irrFaceViews = cache.irradianceFaceViews ?? [];
  for (let face = 0; face < 6; face++) {
    const pass = encoder.beginRenderPass({
      label: 'ibl-irradiance',
      colorAttachments: [
        {
          view: irrFaceViews[face],
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    const faceBg = unwrap(
      device.createBindGroup(
        buildBgDesc({
          label: `ibl-irr-face-bg-${face}`,
          layout: cache.faceUniformsBgl,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: opts.faceUniformsBuffer,
                  offset: face * 256,
                  size: 64,
                },
              },
            },
          ],
        }),
      ),
    );
    if (faceBg === undefined) return { ok: false, error: badAlloc('irr-face-bg') };
    pass.setPipeline(cache.irradiancePipeline);
    pass.setBindGroup(0, faceBg);
    pass.setBindGroup(1, cubeBg);
    pass.setVertexBuffer(0, opts.cubeVertexBuffer);
    pass.draw(6, 1, face * 6, 0);
    pass.end();
  }

  // (c) prefilter env: 5 mips x 6 faces = 30 sub-passes.
  const prefMipViews = cache.prefilterFaceViewsByMip ?? [];
  for (let mip = 0; mip < PREFILTER_MIP_LEVELS; mip++) {
    const mipFaceViews = prefMipViews[mip] ?? [];
    for (let face = 0; face < 6; face++) {
      const subIdx = mip * 6 + face;
      const pass = encoder.beginRenderPass({
        label: 'ibl-prefilter',
        colorAttachments: [
          {
            view: mipFaceViews[face],
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      const bg = unwrap(
        device.createBindGroup(
          buildBgDesc({
            label: `ibl-pref-bg-${subIdx}`,
            layout: prefilterGroup0LayoutOf(cache),
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: {
                    buffer: opts.faceUniformsBuffer,
                    offset: face * 256,
                    size: 64,
                  },
                },
              },
              {
                binding: 1,
                resource: {
                  kind: 'buffer',
                  value: {
                    buffer: opts.prefilterUniformsBuffer,
                    offset: subIdx * 256,
                    size: 16,
                  },
                },
              },
            ],
          }),
        ),
      );
      if (bg === undefined) return { ok: false, error: badAlloc('pref-bg') };
      pass.setPipeline(cache.prefilterPipeline);
      pass.setBindGroup(0, bg);
      pass.setBindGroup(1, cubeBg);
      pass.setVertexBuffer(0, opts.cubeVertexBuffer);
      pass.draw(6, 1, face * 6, 0);
      pass.end();
    }
  }

  // (d) brdf-lut: fullscreen triangle.
  {
    const pass = encoder.beginRenderPass({
      label: 'ibl-brdf-lut',
      colorAttachments: [
        {
          view: cache.brdfLutView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(cache.brdfLutPipeline);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  // Finish + submit. Counter increments are STRICTLY after submit; if
  // submit throws or fails, counters stay at 0 (AC-20 critical invariant).
  const finishRes = encoder.finish();
  // biome-ignore lint/suspicious/noExplicitAny: command buffer opaque
  let cmdBuffer: any;
  if (
    finishRes !== null &&
    finishRes !== undefined &&
    typeof finishRes === 'object' &&
    'ok' in finishRes
  ) {
    if (!finishRes.ok) return { ok: false, error: badAlloc('finish') };
    cmdBuffer = finishRes.value;
  } else {
    cmdBuffer = finishRes;
  }

  // Submit -- may throw on mock devices in failure-injection tests, or
  // return a structured Result.err on the rhi shim path. AC-20 critical:
  // counters are incremented ONLY if submit returns cleanly (no throw +
  // no .ok === false).
  let submitOk = true;
  let submitError: unknown;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: submit returns Result|undefined
    const submitRes = device.queue.submit([cmdBuffer]) as any;
    if (
      submitRes !== null &&
      submitRes !== undefined &&
      typeof submitRes === 'object' &&
      'ok' in submitRes &&
      submitRes.ok === false
    ) {
      submitOk = false;
      submitError = submitRes.error;
    }
  } catch (e) {
    submitOk = false;
    submitError = e;
  }

  if (!submitOk) {
    return {
      ok: false,
      error: {
        code: 'ibl-precompute-not-dispatched',
        expected: 'device.queue.submit returned successfully',
        hint: `queue.submit failed: ${String(submitError)}; counters must not increment before queue.submit`,
      },
    };
  }

  // POST-SUBMIT counter increments (AC-20).
  cache.irradianceBakeCount += 1;
  cache.prefilterBakeCount += 1;
  cache.brdfLutBakeCount += 1;

  return { ok: true, value: { submitted: true } };
}

// Local helper -- structured error payload shared across allocation paths.
function badAlloc(stage: string): { code: string; expected: string; hint: string } {
  return {
    code: 'ibl-precompute-not-dispatched',
    expected: `${stage} allocated successfully`,
    hint: `check queue.submit path is reachable and ${stage} GPU resource creation did not fail; counters must not increment before queue.submit`,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: opaque BGL return
function prefilterGroup0LayoutOf(cache: IblPipelineCachePerDevice): any {
  return cache.prefilterGroup0Bgl;
}
