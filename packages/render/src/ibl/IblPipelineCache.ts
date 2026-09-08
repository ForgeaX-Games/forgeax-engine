// IblPipelineCache.ts -- DeviceScope-generation cache for IBL precompute.
//
// Plan-strategy D-1/D-7: cache for 4 GPU passes (equirect->cube /
// irradiance / prefilter / BRDF LUT). M2 provides the cache skeleton;
// M3 (t18/t20) wires real shader math from ibl.wgsl.
//
// The cache is keyed by the renderer-owned DeviceScope generation. Raw device
// handles are inputs to pipeline creation, never cache or lifecycle owners.
//
// Public surface (M3):
//   - getOrCreateIblCache(scope): get or initialize the generation cache
//   - iblCacheSize(): introspection hook
//   - hasIblCache(scope): introspection hook
//   - setIblWgslSource(source): set the ibl.wgsl WGSL source string
//   - createIblShaderModules(device, factory): create shader modules from ibl.wgsl
//   - createIblPipelines(scope, device, factory, modules): create 4 render pipelines
//   - runIblPrecompute(opts): execute 4 GPU precompute passes (M3 t20)
//
// M3 t20: pipeline slots are filled with real render pipelines loaded from
// ibl.wgsl, replacing the M2 stub undefined slots. The 4 GPU passes are
// executed in the standard order (equirect->cube -> irradiance -> prefilter
// -> BRDF LUT), with counters set post-execution per AC-04/05/06.

// ─── RHI-owned handles ───────────────────────────────────────────────────────

import {
  type BindGroup,
  type BindGroupLayout,
  type Buffer,
  type CommandBuffer,
  err,
  ok,
  type RenderPipeline,
  type Result,
  type RhiCommandEncoder,
  type RhiDevice,
  type RhiError,
  type RhiRenderPassEncoder,
  type Sampler,
  type ShaderModule,
  type Texture,
  type TextureFormat,
  type TextureView,
} from '@forgeax/engine-rhi';
import type { DeviceScope } from '../device/device-scope';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
} from '../gpu-texture-usage';

/**
 * Shader module factory (async, injected via configureGpuDevice).
 * Mirrors `MipmapShaderModuleFactory` from mipmap-generator.
 */
/**
 * IBL is assembled by the renderer's device owner, so it consumes the full
 * opaque RHI device rather than a structurally-compatible raw/shim split.
 * Keeping the owner as RhiDevice makes the backend boundary explicit: raw
 * GPU handles can only exist inside an RHI implementation or a test readback.
 */
export type IblRhiOwner = RhiDevice;

export type IblShaderModuleFactory = (
  device: IblRhiOwner,
  desc: { code: string; label?: string },
) => Promise<Result<ShaderModule, RhiError>>;

export interface IblPipelineSet {
  readonly equirectToCubePipeline: RenderPipeline;
  readonly irradiancePipeline: RenderPipeline;
  readonly prefilterPipeline: RenderPipeline;
  readonly brdfLutPipeline: RenderPipeline;
}

export interface IblPipelineError {
  readonly code: 'ibl-pipeline-create-failed' | 'ibl-shader-module-missing';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly stage: string; readonly rhiCode?: RhiError['code'] };
}

/**
 * Per-DeviceScope-generation IBL pipeline cache instance.
 *
 * M3.5 (round-2 t52): the 4 pipeline slots are mutable so createIblPipelines
 * can fill them after construction. The 4 textures + their views are also
 * cached here so runIblPrecompute targets are stable across calls
 * (idempotent).
 */
export interface IblPipelineCache {
  /** Color format shared by all precompute outputs for this device. */
  outputFormat?: TextureFormat;
  /** Equirectangular-to-cubemap pipeline. */
  equirectToCubePipeline?: RenderPipeline;
  /** Diffuse irradiance convolution pipeline. */
  irradiancePipeline?: RenderPipeline;
  /** Specular prefilter pipeline. */
  prefilterPipeline?: RenderPipeline;
  /** BRDF integration LUT pipeline. */
  brdfLutPipeline?: RenderPipeline;

  /** Face uniforms BGL (shared across equirect/irradiance/prefilter, D-9). */
  faceUniformsBgl?: BindGroupLayout;
  /** group(1) BGL for the equirect-to-cube pass (texture_2d + sampler). */
  equirectGroup1Bgl?: BindGroupLayout;
  /** group(1) BGL for irradiance + prefilter (texture_cube + sampler). */
  cubeGroup1Bgl?: BindGroupLayout;
  /** group(0) BGL for prefilter (face + prefilter uniforms). */
  prefilterGroup0Bgl?: BindGroupLayout;

  /** Irradiance cubemap texture (32x32; outputFormat, cube). */
  irradianceTexture?: Texture;
  /** Irradiance cubemap view (dimension:cube). */
  irradianceView?: TextureView;
  /** Per-face 2D views for irradiance (render-attachment use). */
  irradianceFaceViews?: ReadonlyArray<TextureView>;
  /** Specular prefilter cubemap (128x128, 5 mip levels). */
  prefilterTexture?: Texture;
  /** Prefilter cubemap view (dimension:cube, all mips). */
  prefilterView?: TextureView;
  /** Per-face 2D views per mip for prefilter (5 mips x 6 faces). */
  prefilterFaceViewsByMip?: ReadonlyArray<ReadonlyArray<TextureView>>;
  /** BRDF LUT (256x256; outputFormat). */
  brdfLutTexture?: Texture;
  /** BRDF LUT view. */
  brdfLutView?: TextureView;

  /** Counter: times irradiance pass has executed. AC-04: == 1 after first cook. */
  irradianceBakeCount: number;
  /** Counter: times prefilter pass has executed. AC-05: == 1 after first cook. */
  prefilterBakeCount: number;
  /** Counter: times BRDF LUT pass has executed. AC-06: == 1 after first cook. */
  brdfLutBakeCount: number;
}

/**
 * Cache ownership follows the renderer's DeviceScope generation. A cache is
 * never recovered by looking up an opaque device handle, so every pipeline and
 * side texture is born under the same lifecycle owner as the rest of the
 * renderer resources.
 */
const scopeCaches: WeakMap<DeviceScope, IblPipelineCache> = new WeakMap();

/**
 * Get or create the current-generation IBL pipeline cache.
 */
export function getOrCreateIblCache(scope: DeviceScope): IblPipelineCache {
  const existing = scopeCaches.get(scope);
  if (existing !== undefined) return existing;

  const cache: IblPipelineCache = {
    irradianceBakeCount: 0,
    prefilterBakeCount: 0,
    brdfLutBakeCount: 0,
  };
  scopeCaches.set(scope, cache);
  return cache;
}

/**
 * Check whether a DeviceScope generation has an active cache entry.
 */
export function hasIblCache(scope: DeviceScope): boolean {
  return scopeCaches.has(scope);
}

// ─── M3.5 composed ibl-* shader source registry ─────────────────────────────
//
// 4 composed WGSL strings -- one per render pipeline. Each string is the
// output of @forgeax/engine-naga composeShader after merging ibl_shared +
// the per-pass module. Built by ShaderCatalog / vite-plugin-shader at
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
 * with the 4 composed entries from ShaderCatalog.
 */
export function setIblComposedShaders(sources: IblComposedShaders): void {
  iblComposedShadersCache = sources;
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

function cubemapCaptureProjection(fovy: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan(fovy / 2);
  const nf = 1.0 / (near - far);
  // biome-ignore format: manual column-major mat4
  return new Float32Array([
    f, 0, 0, 0,
    0, -f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
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
  scope: DeviceScope,
  device: IblRhiOwner,
  factory: IblShaderModuleFactory,
  cubeOutputFormat: TextureFormat = 'rgba16float',
): Promise<Result<IblPipelineSet, RhiError | IblPipelineError>> {
  const cache = getOrCreateIblCache(scope);
  if (
    cache.equirectToCubePipeline !== undefined &&
    cache.irradiancePipeline !== undefined &&
    cache.prefilterPipeline !== undefined &&
    cache.brdfLutPipeline !== undefined
  ) {
    return ok({
      equirectToCubePipeline: cache.equirectToCubePipeline,
      irradiancePipeline: cache.irradiancePipeline,
      prefilterPipeline: cache.prefilterPipeline,
      brdfLutPipeline: cache.brdfLutPipeline,
    });
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

  const modules = await Promise.all([
    factory(device, { code: src.equirectToCube, label: 'ibl-equirect-to-cube' }),
    factory(device, { code: src.irradiance, label: 'ibl-irradiance' }),
    factory(device, { code: src.prefilter, label: 'ibl-prefilter' }),
    factory(device, { code: src.brdfLut, label: 'ibl-brdf-lut' }),
  ]);
  for (const m of modules) {
    if (!m.ok) return err(m.error);
  }
  const shaderModules = modules.flatMap((module) => (module.ok ? [module.value] : []));
  if (shaderModules.length !== 4) {
    return err(iblPipelineError('shader-modules', 'ibl-shader-module-missing'));
  }
  const [mEq, mIr, mPr, mBr] = shaderModules;
  if (mEq === undefined || mIr === undefined || mPr === undefined || mBr === undefined) {
    return err(iblPipelineError('shader-modules', 'ibl-shader-module-missing'));
  }

  // D-9: faceUniforms BGL shared across 3 pipelines (equirect / irradiance /
  // prefilter). The prefilter additionally needs binding(1) for prefUniforms;
  // we keep a separate BGL for the prefilter group(0) to honour the WGSL
  // declaration in ibl-prefilter.wgsl.
  const faceBgl = device.createBindGroupLayout({
    label: 'ibl-face-uniforms-bgl',
    entries: [{ binding: 0, visibility: GPU_SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }],
  });
  if (!faceBgl.ok) return err(faceBgl.error);
  cache.faceUniformsBgl = faceBgl.value;

  const prefilterGroup0 = device.createBindGroupLayout({
    label: 'ibl-prefilter-group0-bgl',
    entries: [
      { binding: 0, visibility: GPU_SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  if (!prefilterGroup0.ok) return err(prefilterGroup0.error);
  cache.prefilterGroup0Bgl = prefilterGroup0.value;

  const equirectGroup1 = device.createBindGroupLayout({
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
  });
  if (!equirectGroup1.ok) return err(equirectGroup1.error);
  cache.equirectGroup1Bgl = equirectGroup1.value;

  const cubeGroup1 = device.createBindGroupLayout({
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
  });
  if (!cubeGroup1.ok) return err(cubeGroup1.error);
  cache.cubeGroup1Bgl = cubeGroup1.value;

  // Pipeline layouts.
  const equirectLayout = device.createPipelineLayout({
    label: 'ibl-equirect-pipeline-layout',
    bindGroupLayouts: [faceBgl.value, equirectGroup1.value],
  });
  if (!equirectLayout.ok) return err(equirectLayout.error);
  const irradianceLayout = device.createPipelineLayout({
    label: 'ibl-irradiance-pipeline-layout',
    bindGroupLayouts: [faceBgl.value, cubeGroup1.value],
  });
  if (!irradianceLayout.ok) return err(irradianceLayout.error);
  const prefilterLayout = device.createPipelineLayout({
    label: 'ibl-prefilter-pipeline-layout',
    bindGroupLayouts: [prefilterGroup0.value, cubeGroup1.value],
  });
  if (!prefilterLayout.ok) return err(prefilterLayout.error);
  const brdfLutLayout = device.createPipelineLayout({
    label: 'ibl-brdf-lut-pipeline-layout',
    bindGroupLayouts: [],
  });
  if (!brdfLutLayout.ok) return err(brdfLutLayout.error);

  const vertexLayout3F = {
    arrayStride: 12,
    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as const }],
  };

  const pipeEquirect = device.createRenderPipeline({
    label: 'ibl-equirect-to-cube-pipeline',
    layout: equirectLayout.value,
    vertex: { module: mEq, entryPoint: 'cubemap_vs', buffers: [vertexLayout3F] },
    fragment: {
      module: mEq,
      entryPoint: 'equirectToCube_fs',
      targets: [{ format: cubeOutputFormat }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  if (!pipeEquirect.ok) return err(pipeEquirect.error);
  cache.equirectToCubePipeline = pipeEquirect.value;

  const pipeIrradiance = device.createRenderPipeline({
    label: 'ibl-irradiance-pipeline',
    layout: irradianceLayout.value,
    vertex: { module: mIr, entryPoint: 'cubemap_vs', buffers: [vertexLayout3F] },
    fragment: {
      module: mIr,
      entryPoint: 'irradianceConvolve_fs',
      targets: [{ format: cubeOutputFormat }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  if (!pipeIrradiance.ok) return err(pipeIrradiance.error);
  cache.irradiancePipeline = pipeIrradiance.value;

  const pipePrefilter = device.createRenderPipeline({
    label: 'ibl-prefilter-pipeline',
    layout: prefilterLayout.value,
    vertex: { module: mPr, entryPoint: 'cubemap_vs', buffers: [vertexLayout3F] },
    fragment: {
      module: mPr,
      entryPoint: 'prefilterEnv_fs',
      targets: [{ format: cubeOutputFormat }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  if (!pipePrefilter.ok) return err(pipePrefilter.error);
  cache.prefilterPipeline = pipePrefilter.value;

  const pipeBrdfLut = device.createRenderPipeline({
    label: 'ibl-brdf-lut-pipeline',
    layout: brdfLutLayout.value,
    vertex: { module: mBr, entryPoint: 'fullscreen_vs', buffers: [] },
    fragment: {
      module: mBr,
      entryPoint: 'brdfLutBake_fs',
      targets: [{ format: cubeOutputFormat }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  if (!pipeBrdfLut.ok) return err(pipeBrdfLut.error);
  cache.brdfLutPipeline = pipeBrdfLut.value;

  return ok({
    equirectToCubePipeline: pipeEquirect.value,
    irradiancePipeline: pipeIrradiance.value,
    prefilterPipeline: pipePrefilter.value,
    brdfLutPipeline: pipeBrdfLut.value,
  });
}

function iblPipelineError(
  stage: string,
  code: IblPipelineError['code'],
  cause?: RhiError,
): IblPipelineError {
  return {
    code,
    expected: `${stage} completed through the RHI Result contract`,
    hint: `inspect the ${stage} RHI error before retrying IBL pipeline creation`,
    detail: { stage, ...(cause === undefined ? {} : { rhiCode: cause.code }) },
  };
}

// ─── M3.5 t53: runIblPrecompute (4-pass dispatch + queue.submit) ─────────────

/**
 * Options consumed by runIblPrecompute. The caller (the internal
 * GpuResidencyCache equirect-to-cubemap projection) provides the equirect input
 * + cubemap target GPU resources; the face-uniform / prefilter-uniform buffers
 * come from the t55 helpers.
 */
export interface RunIblPrecomputeOptions {
  readonly scope: DeviceScope;
  readonly device: IblRhiOwner;
  readonly equirectGpuTex: Texture;
  readonly equirectView: TextureView;
  readonly cubeGpuTex: Texture;
  readonly cubeView: TextureView;
  readonly cubeFaceViews: ReadonlyArray<TextureView>;
  readonly faceUniformsBuffer: Buffer;
  readonly prefilterUniformsBuffer: Buffer;
  readonly cubeVertexBuffer: Buffer;
}

export interface IblPrecomputeError {
  readonly code: 'ibl-precompute-not-dispatched';
  readonly expected: string;
  readonly hint: string;
  readonly detail?: { readonly stage: string; readonly rhiCode?: RhiError['code'] };
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
 * underlying device lacks queue.submit or one of the 4 pipelines was not
 * created (createIblPipelines must run first).
 */
export function runIblPrecompute(
  opts: RunIblPrecomputeOptions,
): Result<{ submitted: boolean }, IblPrecomputeError> {
  const { device, scope } = opts;
  const cache = getOrCreateIblCache(scope);
  const outputFormat = cache.outputFormat ?? 'rgba16float';

  if (
    cache.equirectToCubePipeline === undefined ||
    cache.irradiancePipeline === undefined ||
    cache.prefilterPipeline === undefined ||
    cache.brdfLutPipeline === undefined
  ) {
    return err({
      code: 'ibl-precompute-not-dispatched',
      expected: '4 IBL pipelines created via createIblPipelines',
      hint: 'check IblPipelineCache.createIblPipelines was called before runIblPrecompute; counters must not increment before queue.submit',
      detail: { stage: 'pipeline-cache' },
    });
  }

  // Allocate side textures (irradiance / prefilter / brdf-lut) lazily.
  // M5-amend Bug 1: dawn readback (t51 + reference baker) copies the
  // side textures back to a buffer via copyTextureToBuffer, which
  // requires the TextureUsage::CopySrc bit on the source. Without it
  // Dawn fails-fast "usage doesn't include CopySrc".

  if (cache.irradianceTexture === undefined) {
    const textureResult = device.createTexture({
      label: 'ibl-irradiance-cube',
      size: { width: IRRADIANCE_SIZE, height: IRRADIANCE_SIZE, depthOrArrayLayers: 6 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage:
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_COPY_SRC,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!textureResult.ok) return err(badAlloc('irradiance-texture', textureResult.error));
    cache.irradianceTexture = textureResult.value;
    const cubeViewResult = device.createTextureView(textureResult.value, {
      label: 'ibl-irradiance-cube-view',
      dimension: 'cube',
      arrayLayerCount: 6,
    });
    if (!cubeViewResult.ok) return err(badAlloc('irradiance-view', cubeViewResult.error));
    cache.irradianceView = cubeViewResult.value;
    const faceViews: TextureView[] = [];
    for (let f = 0; f < 6; f++) {
      const viewResult = device.createTextureView(textureResult.value, {
        label: `ibl-irradiance-face-${f}`,
        dimension: '2d',
        baseArrayLayer: f,
        arrayLayerCount: 1,
      });
      if (!viewResult.ok) return err(badAlloc('irradiance-face-view', viewResult.error));
      faceViews.push(viewResult.value);
    }
    cache.irradianceFaceViews = faceViews;
  }

  if (cache.prefilterTexture === undefined) {
    const textureResult = device.createTexture({
      label: 'ibl-prefilter-cube',
      size: { width: PREFILTER_SIZE, height: PREFILTER_SIZE, depthOrArrayLayers: 6 },
      mipLevelCount: PREFILTER_MIP_LEVELS,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage:
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_COPY_SRC,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!textureResult.ok) return err(badAlloc('prefilter-texture', textureResult.error));
    cache.prefilterTexture = textureResult.value;
    const cubeViewResult = device.createTextureView(textureResult.value, {
      label: 'ibl-prefilter-cube-view',
      dimension: 'cube',
      arrayLayerCount: 6,
      baseMipLevel: 0,
      mipLevelCount: PREFILTER_MIP_LEVELS,
    });
    if (!cubeViewResult.ok) return err(badAlloc('prefilter-view', cubeViewResult.error));
    cache.prefilterView = cubeViewResult.value;
    const mipViews: TextureView[][] = [];
    for (let m = 0; m < PREFILTER_MIP_LEVELS; m++) {
      const faces: TextureView[] = [];
      for (let f = 0; f < 6; f++) {
        const viewResult = device.createTextureView(textureResult.value, {
          label: `ibl-prefilter-mip${m}-face${f}`,
          dimension: '2d',
          baseMipLevel: m,
          mipLevelCount: 1,
          baseArrayLayer: f,
          arrayLayerCount: 1,
        });
        if (!viewResult.ok) return err(badAlloc('prefilter-face-view', viewResult.error));
        faces.push(viewResult.value);
      }
      mipViews.push(faces);
    }
    cache.prefilterFaceViewsByMip = mipViews;
  }

  if (cache.brdfLutTexture === undefined) {
    const textureResult = device.createTexture({
      label: 'ibl-brdf-lut',
      size: { width: BRDF_LUT_SIZE, height: BRDF_LUT_SIZE, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage:
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_COPY_SRC,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!textureResult.ok) return err(badAlloc('brdf-lut-texture', textureResult.error));
    cache.brdfLutTexture = textureResult.value;
    const viewResult = device.createTextureView(textureResult.value, {
      label: 'ibl-brdf-lut-view',
      dimension: '2d',
    });
    if (!viewResult.ok) return err(badAlloc('brdf-lut-view', viewResult.error));
    cache.brdfLutView = viewResult.value;
  }

  // Shared sampler (filtering, linear-linear).
  // U=repeat because equirect wraps horizontally (atan2 seam at ±π);
  // V=clamp because equirect poles are clamped vertically.
  const samplerResult = device.createSampler({
    label: 'ibl-precompute-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  });
  if (!samplerResult.ok) return err(badAlloc('sampler', samplerResult.error));
  const sampler: Sampler = samplerResult.value;

  const encoderResult = device.createCommandEncoder({ label: 'ibl-precompute-encoder' });
  if (!encoderResult.ok) return err(badAlloc('encoder', encoderResult.error));
  const encoder: RhiCommandEncoder = encoderResult.value;

  const faceUniformsBgl = cache.faceUniformsBgl;
  const equirectGroup1Bgl = cache.equirectGroup1Bgl;
  const cubeGroup1Bgl = cache.cubeGroup1Bgl;
  const prefilterGroup0Bgl = cache.prefilterGroup0Bgl;
  const equirectPipeline = cache.equirectToCubePipeline;
  const irradiancePipeline = cache.irradiancePipeline;
  const prefilterPipeline = cache.prefilterPipeline;
  const brdfLutPipeline = cache.brdfLutPipeline;
  const irrFaceViews = cache.irradianceFaceViews;
  const prefMipViews = cache.prefilterFaceViewsByMip;
  const brdfLutView = cache.brdfLutView;
  if (
    faceUniformsBgl === undefined ||
    equirectGroup1Bgl === undefined ||
    cubeGroup1Bgl === undefined ||
    prefilterGroup0Bgl === undefined ||
    equirectPipeline === undefined ||
    irradiancePipeline === undefined ||
    prefilterPipeline === undefined ||
    brdfLutPipeline === undefined ||
    irrFaceViews === undefined ||
    prefMipViews === undefined ||
    brdfLutView === undefined
  ) {
    return err(badAlloc('ibl-cache-resources'));
  }

  // Bind group: equirect group(1).
  const equirectBgResult = device.createBindGroup({
    label: 'ibl-equirect-bg',
    layout: equirectGroup1Bgl,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: opts.equirectView } },
      { binding: 1, resource: { kind: 'sampler', value: sampler } },
    ],
  });
  if (!equirectBgResult.ok) return err(badAlloc('equirect-bg', equirectBgResult.error));
  const equirectBg: BindGroup = equirectBgResult.value;

  // Bind group: cube group(1) for irradiance + prefilter.
  const cubeBgResult = device.createBindGroup({
    label: 'ibl-cube-bg',
    layout: cubeGroup1Bgl,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: opts.cubeView } },
      { binding: 1, resource: { kind: 'sampler', value: sampler } },
    ],
  });
  if (!cubeBgResult.ok) return err(badAlloc('cube-bg', cubeBgResult.error));
  const cubeBg: BindGroup = cubeBgResult.value;

  // (a) equirect-to-cube: 6 face draws.
  const cubeFaceViews = opts.cubeFaceViews;
  for (let face = 0; face < 6; face++) {
    const cubeFaceView = cubeFaceViews[face];
    if (cubeFaceView === undefined) return err(badAlloc('cube-face-view'));
    const pass: RhiRenderPassEncoder = encoder.beginRenderPass({
      label: 'ibl-equirect-to-cube',
      colorAttachments: [
        {
          view: cubeFaceView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    // Face uniform: dynamic offset = face * 256.
    const faceBgResult = device.createBindGroup({
      label: `ibl-face-bg-${face}`,
      layout: faceUniformsBgl,
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
    });
    if (!faceBgResult.ok) return err(badAlloc('face-bg', faceBgResult.error));
    pass.setPipeline(equirectPipeline);
    pass.setBindGroup(0, faceBgResult.value);
    pass.setBindGroup(1, equirectBg);
    pass.setVertexBuffer(0, opts.cubeVertexBuffer);
    pass.draw(6, 1, face * 6, 0);
    pass.end();
  }

  // (b) irradiance convolve: 6 face draws.
  for (let face = 0; face < 6; face++) {
    const irrFaceView = irrFaceViews[face];
    if (irrFaceView === undefined) return err(badAlloc('irradiance-face-view'));
    const pass: RhiRenderPassEncoder = encoder.beginRenderPass({
      label: 'ibl-irradiance',
      colorAttachments: [
        {
          view: irrFaceView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    const faceBgResult = device.createBindGroup({
      label: `ibl-irr-face-bg-${face}`,
      layout: faceUniformsBgl,
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
    });
    if (!faceBgResult.ok) return err(badAlloc('irr-face-bg', faceBgResult.error));
    pass.setPipeline(irradiancePipeline);
    pass.setBindGroup(0, faceBgResult.value);
    pass.setBindGroup(1, cubeBg);
    pass.setVertexBuffer(0, opts.cubeVertexBuffer);
    pass.draw(6, 1, face * 6, 0);
    pass.end();
  }

  // (c) prefilter env: 5 mips x 6 faces = 30 sub-passes.
  for (let mip = 0; mip < PREFILTER_MIP_LEVELS; mip++) {
    const mipFaceViews = prefMipViews[mip];
    if (mipFaceViews === undefined) return err(badAlloc('prefilter-mip-views'));
    for (let face = 0; face < 6; face++) {
      const subIdx = mip * 6 + face;
      const mipFaceView = mipFaceViews[face];
      if (mipFaceView === undefined) return err(badAlloc('prefilter-face-view'));
      const pass: RhiRenderPassEncoder = encoder.beginRenderPass({
        label: 'ibl-prefilter',
        colorAttachments: [
          {
            view: mipFaceView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      const bgResult = device.createBindGroup({
        label: `ibl-pref-bg-${subIdx}`,
        layout: prefilterGroup0Bgl,
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
      });
      if (!bgResult.ok) return err(badAlloc('pref-bg', bgResult.error));
      pass.setPipeline(prefilterPipeline);
      pass.setBindGroup(0, bgResult.value);
      pass.setBindGroup(1, cubeBg);
      pass.setVertexBuffer(0, opts.cubeVertexBuffer);
      pass.draw(6, 1, face * 6, 0);
      pass.end();
    }
  }

  // (d) brdf-lut: fullscreen triangle.
  {
    const pass: RhiRenderPassEncoder = encoder.beginRenderPass({
      label: 'ibl-brdf-lut',
      colorAttachments: [
        {
          view: brdfLutView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(brdfLutPipeline);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  // Finish + submit. Counter increments are STRICTLY after submit; if
  // submit throws or fails, counters stay at 0 (AC-20 critical invariant).
  const finishRes = encoder.finish();
  if (!finishRes.ok) return err(badAlloc('finish', finishRes.error));
  const cmdBuffer: CommandBuffer = finishRes.value;
  const submitRes = device.queue.submit([cmdBuffer]);
  if (!submitRes.ok) return err(badAlloc('queue.submit', submitRes.error));

  // POST-SUBMIT counter increments (AC-20).
  cache.irradianceBakeCount += 1;
  cache.prefilterBakeCount += 1;
  cache.brdfLutBakeCount += 1;

  return ok({ submitted: true });
}

// Local helper -- structured error payload shared across allocation paths.
function badAlloc(stage: string, cause?: RhiError): IblPrecomputeError {
  return {
    code: 'ibl-precompute-not-dispatched',
    expected: `${stage} allocated successfully`,
    hint: `check the RHI Result for ${stage}; counters must not increment before queue.submit`,
    ...(cause === undefined ? {} : { detail: { stage, rhiCode: cause.code } }),
  };
}
