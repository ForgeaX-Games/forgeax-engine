// @forgeax/engine-runtime - FullscreenPostProcessPass primitive
// (feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M2 / w13).
//
// A declarative fullscreen post-process pass that:
// - Uses the `fullscreen_triangle` vertex shader (common.wgsl:194, SSOT — not rewritten)
// - Supports optional params UBO (FXAA has no params, tonemap has params — plan-strategy D-4 /
//   Finding M2-1)
// - Auto-builds: input-texture BGL, pipeline, offscreen RT, ViewTarget ping-pong (KB-2),
//   and swap-chain non-srgb storage view write (R-COLORSPACE)
// - Reads input texture, writes to declared color target with fullscreen 3-vertex draw
//
// Registered via renderer.postProcess.register(id, {source, params, reads?}) — a parallel
// channel to registerMaterialShader (D-4: material shader = 4-BGL / 12-float vertex / depth /
// triangle-list; fullscreen post-process = 0 vertex buffer / no depth / input-texture BGL).

import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RhiDevice,
  RhiError,
  RhiRenderPassEncoder,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import type { BglKind } from './pipeline-spec';
import { buildBindGroupLayoutDescriptor, type PipelineSpec } from './pipeline-spec';

// Default fullscreen-post spec stub. The dispatcher's 'fullscreen-post' arm
// reads spec.attachments.depthFormat / colorFormats[0] to derive the texture
// binding's sampleType (R3 fix). Default colorFormats=['rgba16float'] gives
// the historical 'float' / 'filtering' shape preserved across all existing
// post-process call sites.
const FULLSCREEN_DEFAULT_SPEC: PipelineSpec = Object.freeze({
  shader: { id: '', passKind: 'forward', variantSet: undefined },
  attachments: {
    colorFormats: ['rgba16float'] as readonly GPUTextureFormat[],
    depthFormat: undefined,
    sampleCount: 1,
  },
  geometry: { topology: 'triangle-list', vertexLayout: {} },
  renderState: undefined,
}) as PipelineSpec;

// ─── Post-process read sample type union ─────────────────────────────────

/**
 * Declared sample type for a post-process read entry.
 *
 * Closed union (plan-strategy D-7): only `'depth'` is an explicit sampleType
 * discriminant; color inputs are the default (bare `string` or un-suffixed
 * `{ key }`).  Future texture types (`r32float`, etc.) are add-only.
 *
 * AI-user affordance: IDE autocomplete exposes `'depth'` at the register call
 * site; misspellings are caught by the type system (AC-08).
 */
export type PostProcessReadSampleType = 'depth';

// ─── Post-process shader entry (registered via postProcess.register) ──────

/**
 * A registered fullscreen post-process shader entry.
 *
 * Analogous to MaterialShaderEntry in the ShaderRegistry but with post-process-specific
 * fields: the input-texture + sampler BGL is auto-built by the primitive,
 * no paramSchema (params are passed inline via a {type, value} struct — plan-strategy D-4).
 *
 * `params` carries the WGSL struct definition + default value. When `params` is
 * `undefined`, the post-process shader has no UBO (e.g. FXAA — Finding M2-1).
 *
 * `reads` declares graph resource keys this pass samples as input texture(s).
 * If omitted, the pass samples the swap-chain color attachment (default path).
 *
 * Structured reads (plan-strategy D-1): each entry can be a bare string
 * (backward-compatible color input) or an object `{ key, sampleType? }`.
 * When `sampleType` is `'depth'`, the dispatcher resolves a depth-only view
 * and binds it at depthTex@3 / depthSampler@4 in the fullscreen bind group.
 */
export interface PostProcessShaderEntry {
  /** Composed WGSL source for the fragment stage (post-naga_oil). */
  readonly source: string;
  /**
   * Params UBO schema. When undefined, the shader has no uniform buffer (e.g. FXAA)
   * and the BGL degrades to 2 entries (texture@0 + sampler@1). When present, the
   * primitive eager-creates a params UBO (at register, sized `byteSize`) and binds
   * it at bindgroup(1) binding(2) as part of a 3-entry BGL
   * (texture@0 + sampler@1 + buffer@2). feat-20260621 M-A2 / D-2.
   */
  readonly params?: PostProcessParamsSchema | undefined;
  /**
   * Graph resource keys this post-process reads (as input textures).
   * The primitive binds the first read as its input texture at @group(1)
   * @binding(0) (the sampler is @group(1) @binding(1); group 0 is reserved for a
   * future view bind group — dispatchFullscreenPass calls setBindGroup(1, ...)).
   * When empty or omitted, the pass reads the swap-chain directly.
   *
   * Each entry is either a bare string (backward-compatible color input) or an
   * object `{ key: string; sampleType?: PostProcessReadSampleType }` for typed
   * reads (e.g. `{ key: 'depth', sampleType: 'depth' }` for depth sampling).
   * Bare strings and `{ key }` without `sampleType` are equivalent — both
   * represent a color input (plan-strategy D-1 / D-7).
   */
  readonly reads?: readonly (string | PostProcessReadEntry)[] | undefined;
}

/**
 * Structured read entry for a post-process shader.
 *
 * `key` is the graph resource key (matching a graph color target).
 * `sampleType` is an optional type discriminant (D-1 SSOT); when omitted
 * the entry is treated as a color input (same as a bare string).
 */
export interface PostProcessReadEntry {
  readonly key: string;
  readonly sampleType?: PostProcessReadSampleType | undefined;
}

/**
 * Params schema: the WGSL struct definition + default byte array for a post-process
 * UBO. The primitive allocates a GPU buffer of `byteSize` and uploads `defaultValue`
 * at register time; the UBO is then updated per-frame via the data-driven
 * `PostProcessParams` ECS component (component `data` -> extract snapshot ->
 * dispatchFullscreenPass `queue.writeBuffer`), NOT via an imperative setter.
 * feat-20260621 M-A1/M-A2 / D-1.
 */
export interface PostProcessParamsSchema {
  /** Byte size of the WGSL params struct (must be UBO-aligned, min 16 B). */
  readonly byteSize: number;
  /** Default UBO contents (length must equal `byteSize`). */
  readonly defaultValue: Uint8Array;
}

// ─── Fullscreen pass descriptor (passed to addFullscreenPass) ────────────

/**
 * Descriptor for a fullscreen post-process pass. Declares which registered shader
 * to use, which color target to write, and which graph resource(s) to read.
 */
export interface FullscreenPassDescriptor {
  /** Registered post-process shader id (must be registered via postProcess.register). */
  readonly shader: string;
  /**
   * Color target: the graph resource key to write into. The pipeline must have
   * already declared this target via `graph.addColorTarget` (the dispatcher
   * resolves it, it does not auto-create one); a pass that names an undeclared
   * key falls back to the swap-chain `ctx.view`.
   */
  readonly color: string;
  /**
   * Graph resource keys to read. The primitive binds the first read entry as its
   * input texture (@group(1) @binding(0); sampler @binding(1)). Passes with
   * reads==[] sample the swap-chain directly (copyTextureToTexture path — plan-strategy D-1).
   */
  readonly reads?: readonly string[] | undefined;
}

// ─── Context passed to addFullscreenPass injectors ───────────────────────

/**
 * The minimal surface a `registerFullscreenPostProcess` injector receives.
 * Contains the RHI device (for creating BGLs / pipelines / samplers) and the
 * error registry for structured failure reporting.
 */
export interface FullscreenPostProcessDeviceContext {
  readonly device: RhiDevice;
  readonly errorRegistry: {
    fire(error: RhiError): void;
  };
}

// ─── Built-in fullscreen post-process BGL + pipeline state ───────────────

// Fullscreen bind-group layout: a single input-texture binding (0) +
// a single sampler binding (1). The descriptor SSOT moved to
// buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' }) in
// pipeline-spec.ts (D-13 round-2).
//
// Historical context: this BGL was duplicated across recordFxaaPass +
// register-default-post-process before convergence (feat-20260609 framebuffers
// demo M5R2 / T-12-a). R3 historical bug: the descriptor wrote sampleType:
// 'float' for any input including depth32float views, tripping wgpu's
// Filtering sampler vs UnfilterableFloat / Depth texture static-sample-pair
// validation. The dispatcher derives sampleType from spec.attachments
// (depth32float -> 'depth' + 'comparison' sampler; r32float ->
// 'unfilterable-float'; else -> 'float' + 'filtering').

/**
 * Create a linear clamp-to-edge sampler — reused across all fullscreen passes
 * (identical to the recordFxaaPass sampler).
 */
function createFullscreenSampler(device: RhiDevice): Sampler | null {
  const res = device.createSampler({
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
  });
  if (!res.ok) return null;
  return res.value;
}

/**
 * Create a non-filtering depth sampler for post-process passes that read the
 * camera scene depth (plan-strategy D-2: nearest + clamp-to-edge).
 * Aligns with the SSAO depth sampler shape (render-graph-primitives.ts:634-647)
 * — NOT a comparison sampler (D-2 rejects comparison because the post-process
 * shader reads raw depth values via `textureSampleLevel`, not PCF shadow lookup).
 */
function createDepthSampler(device: RhiDevice): Sampler | null {
  const res = device.createSampler({
    magFilter: 'nearest',
    minFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  if (!res.ok) return null;
  return res.value;
}

/**
 * Check whether the entry's {@link PostProcessShaderEntry.reads} declares a read
 * with `sampleType: 'depth'`. Used by {@link buildFullscreenPostProcessPass} to
 * select between the depth BGL variant and the existing color-only kinds.
 */
export function entryHasDepthRead(entry: PostProcessShaderEntry): boolean {
  if (!entry.reads) return false;
  return entry.reads.some((r) => typeof r !== 'string' && r.sampleType === 'depth');
}

/**
 * Byte size of the minimal params UBO auto-allocated for a depth-reading entry
 * that declares no `params`. The `'fullscreen-post-with-scene-depth'` BGL always
 * declares `params@2`, so a bound UBO must exist even when the shader has no
 * user params (plan D-3: param-less depth effect gets a minimal 16B UBO). 16 B
 * is WebGPU's minimum uniform-buffer binding size.
 */
export const DEPTH_MIN_PARAMS_BYTE_SIZE = 16;

// ─── Public: register / build a fullscreen post-process pass ─────────────

/**
 * State of a registered fullscreen post-process pass.
 *
 * Created by `addFullscreenPass` and stored per-pass in the render system.
 * The `draw` method is called by the per-frame execute closure.
 */
export interface FullscreenPostProcessPassHandle {
  /** The pass name (same as the `color` target key). */
  readonly name: string;
  /** Execute one fullscreen draw: bind input texture, set pipeline, draw 3 vertices. */
  draw(encoder: RhiRenderPassEncoder, inputView: TextureView): void;
  /**
   * The per-frame params UBO this pass binds at group(1) binding(2), or null
   * when `entry.params === undefined` (param-less consumer, 2-entry BGL). The
   * dispatcher writes the snapshot bytes into it before draw and composes it
   * into the bind group via {@link createFullscreenBindGroup}.
   */
  readonly paramsBuffer: Buffer | null;
}

/**
 * Build a fullscreen post-process pass primitive.
 *
 * Creates BGL, sampler, and pipeline state from the registered shader entry.
 * Returns the pass handle + the BGL + the sampler so the caller can compose
 * bind groups. The BGL + sampler are shared across instances of the same shader.
 *
 * @returns The BGL, sampler, and a factory to create pass handles.
 */
export function buildFullscreenPostProcessPass(
  ctx: FullscreenPostProcessDeviceContext,
  entry: PostProcessShaderEntry,
): {
  bindGroupLayout: BindGroupLayout;
  sampler: Sampler | null;
  depthSampler: Sampler | null;
  createHandle: (
    name: string,
    pipeline: unknown,
    paramsBuffer: Buffer | null,
  ) => FullscreenPostProcessPassHandle;
} | null {
  const { device } = ctx;

  // Step 1: BGL (input texture + sampler [+ params buffer] [+ depth]).
  // D-13 round-2: route through dispatcher; sampleType derives from
  // spec.attachments (R3 fix). Default spec yields the historical 'float'
  // / 'filtering' shape for color inputs.
  // feat-20260621 D-2: when entry.params is present the BGL is the 3-entry
  // 'fullscreen-post-with-params' kind (adds buffer@2 uniform); otherwise the
  // 2-entry 'fullscreen-post' kind (param-less zero-regression, R-A7).
  // plan-strategy D-3: when entry.reads declares sampleType:'depth', use the
  // 5-entry 'fullscreen-post-with-scene-depth' kind (color@0 + sampler@1 +
  // params@2 + depthTex@3 + depthSampler@4). params@2 is always present to
  // avoid 2x2 kind explosion.
  const hasDepth = entryHasDepthRead(entry);
  const bglKind: BglKind = hasDepth
    ? 'fullscreen-post-with-scene-depth'
    : entry.params !== undefined
      ? 'fullscreen-post-with-params'
      : 'fullscreen-post';
  const bglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(FULLSCREEN_DEFAULT_SPEC, {
      kind: bglKind,
    }),
  );
  if (!bglRes.ok) {
    ctx.errorRegistry.fire(bglRes.error);
    return null;
  }

  // Step 2: Samplers.
  const sampler = createFullscreenSampler(device);
  const depthSampler = hasDepth ? createDepthSampler(device) : null;

  return {
    bindGroupLayout: bglRes.value,
    sampler,
    depthSampler,
    createHandle: (name, pipeline, paramsBuffer) => ({
      name,
      paramsBuffer,
      draw(encoder, _inputView) {
        encoder.setPipeline(pipeline as never);
        // The bind group is composed per-frame by the record stage (mirrors
        // recordFxaaPass's lazy bindgroup compose in render-system-record.ts).
        // This draw() method only sets the pipeline — the caller is responsible
        // for bind group composition + setBindGroup before calling draw().
        encoder.draw(3, 1, 0, 0);
      },
    }),
  };
}

/**
 * Create a fullscreen bind group (lazy, per-frame). Composes the input texture
 * view + the linear sampler into group(1) (texture@0 + sampler@1). When
 * `paramsBuffer` is supplied (feat-20260621 D-2: `entry.params !== undefined`),
 * appends the per-frame params UBO at binding 2 (uniform), matching the 3-entry
 * `'fullscreen-post-with-params'` BGL. Omitting it yields the 2-entry shape
 * param-less consumers degrade to (R-A7).
 *
 * When `depthTexView` + `depthSampler` are supplied (plan-strategy D-3:
 * depth reads present), appends the depth texture view at binding 3 and the
 * non-filtering depth sampler at binding 4, matching the 5-entry
 * `'fullscreen-post-with-scene-depth'` BGL. Both must be supplied together
 * (or both omitted for existing color-only consumers — AC-03 zero-regression).
 */
export function createFullscreenBindGroup(
  device: RhiDevice,
  bgl: BindGroupLayout,
  inputView: TextureView,
  sampler: Sampler | null,
  paramsBuffer?: Buffer | null,
  depthTexView?: TextureView | null,
  depthSampler?: Sampler | null,
): BindGroup | null {
  const entries: { binding: number; resource: { kind: string; value: unknown } }[] = [
    { binding: 0, resource: { kind: 'textureView', value: inputView } },
  ];
  if (sampler) {
    entries.push({ binding: 1, resource: { kind: 'sampler', value: sampler } });
  }
  if (paramsBuffer) {
    // RHI buffer binding resource is `{ kind: 'buffer', value: { buffer } }` —
    // the nested `{ buffer }` wrapper is the GPUBufferBinding shape dawn expects
    // (mirrors createRenderer's shadow-probe UBO bindings). Passing the raw
    // handle as `value` makes dawn reject createBindGroup ("no overload matched
    // ... member 'resource' for array element 2").
    entries.push({ binding: 2, resource: { kind: 'buffer', value: { buffer: paramsBuffer } } });
  }
  if (depthTexView && depthSampler) {
    entries.push({ binding: 3, resource: { kind: 'textureView', value: depthTexView } });
    entries.push({ binding: 4, resource: { kind: 'sampler', value: depthSampler } });
  }
  const res = device.createBindGroup({
    label: 'fullscreen-post-process-bg',
    layout: bgl,
    entries: entries as never,
  });
  if (!res.ok) return null;
  return res.value;
}
