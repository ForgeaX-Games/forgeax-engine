// pipeline-builder.ts -- runtime-internal helper for building per-MaterialShader
// render pipelines (feat-20260523-shader-template-instance-split M9-T01).
//
// Anchors:
//   - plan-strategy D-PipelineBuilder: M9 introduces a runtime-internal
//     pipeline builder helper. `render-system-record` calls it once per
//     `materialShaderId` cache miss; the cache (M9-T03) is owned by the
//     record stage, not this helper.
//   - requirements AC-08: record on cache miss correctly constructs pipeline.
//   - requirements AC-14: the visible-pulse demo's per-frame paramValues.time
//     mutation depends on a real GPU pipeline being built for the user
//     shader (`my-game::pulse-material`).
//   - plan-strategy R-H: pipeline construction must reuse the existing
//     4-BindGroupLayout chain so existing PBR-heavy demos do not regress.
//
// API shape (per plan-task M9-T01 acceptanceCheck):
//   buildPipelineForMaterialShader(id, entry, ctx) -> Result<RenderPipeline, RhiError>
//
// The helper is intentionally **pure**: it does not cache, does not look up
// the registry, does not maintain state. The caller (render-system-record's
// per-MaterialShader pipeline cache, M9-T03) is responsible for both the
// `ShaderRegistry.lookupMaterialShader(id)` call and the
// `Map<materialShaderId, RenderPipeline>` cache. Splitting the concerns
// keeps the helper trivially mockable (M9-T02 covers it with vi.fn-based
// mocks; no real device required).
//
// Pipeline shape:
//   - layout       = caller-supplied PipelineLayout (forgeax R-H: same
//                    4-BGL chain `[view, material, mesh-array, instances]`
//                    reused across all MaterialShader entries; D-5 round-4)
//   - vertex stage = entry.source compiled as a ShaderModule, entry point
//                    `vs_main`, vertex buffer layout from ctx
//   - fragment     = same ShaderModule, entry point `fs_main`, color
//                    attachment format from ctx
//   - depth        = ctx.depthFormat with `less` compare + `depthWriteEnabled`
//   - primitive    = `geometry.topology` (default `triangle-list`) + `back`
//                    cull + `ccw` front face; strip topologies also bake
//                    `stripIndexFormat`
//
// Capability gating: device.caps deviates only at the call site that
// computes ctx; the helper consumes the resolved `ctx` without further
// branching (charter P4 consistent abstraction).

import {
  err,
  type PipelineLayout,
  type RenderPipeline,
  type Result,
  type RhiDevice,
  RhiError,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import type { MaterialShaderEntry } from '@forgeax/engine-shader';
import {
  AssetError,
  type MaterialRenderState,
  type PassKind,
  type PrimitiveTopology,
} from '@forgeax/engine-types';
import { buildPipelineDescriptor, type PipelineSpec } from './pipeline-spec';

/**
 * feat-20260604-mesh-topology-debug-draw M3 / w8: per-mesh geometry facts that
 * are baked into the immutable GPURenderPipeline `primitive` block. Distinct
 * from {@link MaterialRenderState} (material-authored state); these are
 * geometry properties of the mesh being drawn (requirements D-2 / D-A3).
 */
export interface PipelineGeometry {
  /** Primitive topology baked into `primitive.topology`. Defaults to 'triangle-list'. */
  readonly topology?: PrimitiveTopology;
  /**
   * Index format for strip topologies (`line-strip` / `triangle-strip`), baked
   * into `primitive.stripIndexFormat`. WebGPU spec: only valid for strip
   * topologies; ignored (left undefined in the descriptor) for list topologies.
   */
  readonly stripIndexFormat?: 'uint16' | 'uint32';
}

/**
 * Sync shader-module factory consumed by `buildPipelineForMaterialShader`.
 * Mirrors `ShaderRegistryDevice.createShaderModule` (sync Result shape) so
 * the same `makeShaderDeviceAdapter` in `createRenderer.ts` can satisfy
 * both surfaces (charter P4 consistent abstraction). The adapter caches
 * the underlying async `pack.createShaderModule` so subsequent sync calls
 * return cached modules; first call typically returns
 * `Result.err('rhi-not-available')` while the async build is in flight,
 * letting the caller fall back to the existing `standardPipeline` for
 * one frame and retry on the next (matches `render-system-record`'s
 * 1-frame-warmup idiom).
 */
export interface PipelineBuilderShaderModuleFactory {
  createShaderModule(desc: {
    readonly code: string;
    readonly label?: string | undefined;
  }): Result<ShaderModule, RhiError>;
}

/**
 * Build context for `buildPipelineForMaterialShader`. Caller (createRenderer
 * + render-system-record) computes this once per renderer and reuses across
 * cache misses; the values mirror the existing PBR pipeline construction
 * (createRenderer.ts ~line 2712 standardPipelineResult) so user shaders
 * land on the same 4-BindGroupLayout chain (charter P4 + plan-strategy
 * R-H).
 */
export interface PipelineBuilderContext {
  /** RHI device that owns the pipeline allocation. */
  readonly device: RhiDevice;
  /**
   * Sync shader-module factory (see {@link PipelineBuilderShaderModuleFactory}).
   * In production the engine wires the same `makeShaderDeviceAdapter` it
   * already uses for `ShaderRegistry.get(hash)`; tests pass a
   * `vi.fn`-based stub.
   */
  readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
  /**
   * Shared pipeline layout (4 BindGroupLayouts: view + material + mesh-array
   * + instances). User shaders bind through the same slots as
   * default-standard-pbr; D-5 round-4 SSOT.
   */
  readonly pipelineLayout: PipelineLayout;
  /**
   * Color attachment format. The LDR / HDR variants pick `bgra8unorm-srgb` /
   * `rgba16float` respectively; record-stage gate matches the camera's
   * tonemap field (M9 keeps the LDR shape; HDR variants are OOS-M9).
   */
  readonly colorFormat: GPUTextureFormat;
  /** Depth attachment format (`depth24plus-stencil8` engine SSOT). */
  readonly depthFormat: GPUTextureFormat;
  /**
   * Vertex buffer layout descriptors. Procedural geometry uses the 12-floats
   * stride (position + normal + uv + tangent); user shaders share this
   * layout for v1 (OOS-9 leaves alternative vertex layouts for a follow-up
   * feat).
   */
  readonly vertexBuffers: readonly GPUVertexBufferLayout[];
  /** Pipeline label (for GPU debug captures); defaults to `pbr-pipeline-${id}`. */
  readonly label?: string | undefined;
  /**
   * feat-20260604-mesh-topology-debug-draw w16-b: the shader-MODULE cache
   * identity, decoupled from the PSO `label` and the `id` arg. The WGSL module
   * depends ONLY on (source + defines), NOT on topology / renderState / isHdr /
   * indexFormat -- all of which WebGPU bakes into the immutable PSO, never the
   * module. `makeShaderDeviceAdapter` keys its `moduleCache` on this label, so
   * passing a stable per-(shader-source, defines) value here lets every
   * topology / renderState / HDR pipeline variant of the same shader SHARE one
   * compiled module: the first variant warms it, every later variant reuses it
   * synchronously (no per-variant async recompile, no event-loop yield).
   * Falls back to `shader-${id}` when omitted (pre-w16-b behaviour: the `id`
   * arg doubled as both PSO cache key and module label). The defines dimension
   * is NOT folded in here because the engine pre-resolves define variants into
   * distinct registered `source` strings (createRenderer.ts variant
   * resolution); callers that thread `defines` directly must include them in
   * `moduleLabel` so two `#define` prefixes do not collide on one module.
   */
  readonly moduleLabel?: string | undefined;
}

/**
 * Build a render pipeline for a material shader entry. Returns
 * `Result.err(RhiError)` on shader-module compile failure or pipeline
 * descriptor rejection (closed union RhiErrorCode pattern; AGENTS.md
 * "Errors are structured" + charter P3 explicit failure).
 *
 * Caller flow (M9-T03):
 * ```ts
 * let pipeline = pipelineCache.get(materialShaderId);
 * if (pipeline === undefined) {
 *   const lookup = registry.lookupMaterialShader(materialShaderId);
 *   if (!lookup.ok) {
 *     // fallback to default-standard-pbr pipelineState.standardPipeline
 *   } else {
 *     const built = buildPipelineForMaterialShader(materialShaderId, lookup.value, ctx);
 *     if (built.ok) pipelineCache.set(materialShaderId, built.value);
 *     else if (built.error.code === 'rhi-not-available') {
 *       // shader module still compiling async; retry next frame.
 *     }
 *   }
 * }
 * ```
 */
export function buildPipelineForMaterialShader(
  id: string,
  entry: MaterialShaderEntry,
  ctx: PipelineBuilderContext,
  renderState?: MaterialRenderState,
  geometry?: PipelineGeometry,
  vertexEntry?: string,
  fragmentEntry?: string,
  defines?: Record<string, string>,
  passKind: PassKind = 'forward',
  // bug-20260615 M2 / m2-1: sampleCount is a CAMERA fact (per-frame antialias
  // setting) threaded from getMaterialShaderPipeline -> buildAndCachePipeline
  // -> here. Default 1 produces `multisample: undefined` — byte-identical to
  // the pre-M2 descriptor for every existing count=1 caller. count > 1 sets
  // `multisample: { count: sampleCount }` matching the `createMsaaVariant`
  // shape on the built-in geometry side.
  sampleCount: number = 1,
): Result<RenderPipeline, RhiError> {
  const label = ctx.label ?? `pbr-pipeline-${id}`;
  const vsEntry = vertexEntry ?? 'vs_main';
  const fsEntry = fragmentEntry ?? 'fs_main';

  let source = entry.source;
  if (defines !== undefined && Object.keys(defines).length > 0) {
    const defineKeyRe = /^[A-Z_][A-Z0-9_]*$/;
    for (const key of Object.keys(defines)) {
      if (!defineKeyRe.test(key)) {
        return err(
          new AssetError({
            code: 'asset-invalid-value',
            expected: `define key matching /^[A-Z_][A-Z0-9_]*$/`,
            hint: `illegal define key '${key}' — must be uppercase letters, digits, and underscores, starting with a letter or underscore`,
            detail: { key, legalPattern: '^[A-Z_][A-Z0-9_]*$' },
          }),
        ) as unknown as ReturnType<typeof buildPipelineForMaterialShader>;
      }
    }
    const prefix = `${Object.entries(defines)
      .map(([k, v]) => `#define ${k} ${v}`)
      .join('\n')}\n`;
    source = prefix + source;
  }

  const moduleResult = ctx.shaderModuleFactory.createShaderModule({
    code: source,
    label: ctx.moduleLabel ?? `shader-${id}`,
  });
  if (!moduleResult.ok) {
    return moduleResult;
  }
  const shaderModule = moduleResult.value;

  // feat-20260609 M4 / R3-fixup: shadow-caster branch.
  // The shadow render pass beginRenderPass desc is `{ colorAttachments: [],
  // depthStencilAttachment: { format: 'depth32float', ... } }` (see
  // recordShadowPass / pipelineState.shadowTexture allocation). The PSO's
  // attachment state must match exactly — no color targets, depth32float
  // depth — otherwise WebGPU emits "Attachment state of [pipeline] is not
  // compatible with [RenderPassEncoder]". Ground truth descriptor was the
  // hardcoded shadowCasterPipeline removed in T-009 (commit 6416e9de~);
  // this branch reconstructs that exact shape via the lazy cache path.
  // Vertex layout is position-only (12-float stride, shaderLocation 0 vec3)
  // — the shadow_caster.wgsl vs_main reads only @location(0) position.
  if (passKind === 'shadow-caster') {
    // bug-20260619-csm RC-3 (AC-10): a material may supply a custom
    // ShadowCaster pass shader that carries a fragment stage (e.g. an
    // alpha-test cutout that calls `discard` and returns
    // `@builtin(frag_depth)`). The built-in `forgeax::default-shadow-caster`
    // is vertex-only — the GPU writes depth from `gl_Position.z` with no
    // fragment. To run the cutout discard, the PSO MUST include the
    // fragment stage when the shader declares one; otherwise the fragment
    // never executes and the shadow comes out solid. The depth pass has no
    // color attachments, so the fragment stage targets an empty list (it
    // only writes `@builtin(frag_depth)`).
    const hasFragmentStage = source.includes('@fragment');
    const shadowPipelineResult = ctx.device.createRenderPipeline({
      label,
      layout: ctx.pipelineLayout as unknown as GPUPipelineLayout,
      vertex: {
        module: shaderModule as unknown as GPUShaderModule,
        entryPoint: vsEntry,
        buffers: [
          {
            arrayStride: 12 * 4,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as const }],
          },
        ],
      } as unknown as GPUVertexState,
      // Vertex-only depth pass writes `fragment: undefined` (GPU derives
      // depth from gl_Position.z). A custom ShadowCaster shader with a
      // fragment stage (cutout discard) gets the empty-target fragment
      // stage so its `discard` / `@builtin(frag_depth)` actually run.
      fragment: hasFragmentStage
        ? ({
            module: shaderModule as unknown as GPUShaderModule,
            entryPoint: fsEntry,
            targets: [],
          } as unknown as GPUFragmentState)
        : undefined,
      primitive: {
        topology: geometry?.topology ?? 'triangle-list',
        cullMode: renderState?.cullMode ?? 'back',
        frontFace: renderState?.frontFace ?? 'ccw',
      },
      depthStencil: {
        // depth32float (matches shadow RT format), NOT ctx.depthFormat
        // (which is depth24plus-stencil8 for the main pass).
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
    });
    if (!shadowPipelineResult.ok) {
      if (shadowPipelineResult.error.code === 'shader-compile-failed') {
        return shadowPipelineResult;
      }
      return err(
        new RhiError({
          code: 'shader-compile-failed',
          expected: `shadow-caster pipeline for material shader '${id}' builds successfully`,
          hint: `inspect compiler messages on the shader module; verify pipeline layout matches shader bindings (cause: ${shadowPipelineResult.error.code})`,
        }),
      );
    }
    return shadowPipelineResult;
  }

  // feat-20260615-pipeline-spec-ssot M2-T3: delegate PSO descriptor assembly
  // to buildPipelineDescriptor(spec, modules). The spec is derived from the
  // forward-branch parameters; multisample is derived from sampleCount (1 → absent,
  // 4 → {count:4}). This replaces the inline literal formerly at :290-344.
  const forwardSpec: PipelineSpec = {
    shader: { id, passKind, variantSet: undefined },
    attachments: {
      colorFormats: [ctx.colorFormat],
      depthFormat: ctx.depthFormat,
      sampleCount: (sampleCount === 4 ? 4 : 1) as 1 | 4,
    },
    geometry: {
      topology: geometry?.topology ?? 'triangle-list',
      stripIndexFormat: geometry?.stripIndexFormat,
      vertexLayout: {}, // vertexLayout not used at this layer; caller provides vertexBuffers
    },
    renderState,
  };
  const baseDesc = buildPipelineDescriptor(forwardSpec, {
    vertex: shaderModule,
    fragment: shaderModule,
  }) as Record<string, unknown>;

  // Merge pipeline-builder-specific fields (label, layout, vertexBuffers, entryPoint names)
  const pipelineResult = ctx.device.createRenderPipeline({
    label,
    layout: ctx.pipelineLayout as unknown as GPUPipelineLayout,
    vertex: {
      ...(baseDesc.vertex as Record<string, unknown>),
      entryPoint: vsEntry,
      buffers: ctx.vertexBuffers as unknown as GPUVertexBufferLayout[],
    } as unknown as GPUVertexState,
    fragment: (baseDesc.fragment !== undefined
      ? {
          ...(baseDesc.fragment as Record<string, unknown>),
          entryPoint: fsEntry,
        }
      : undefined) as unknown as GPUFragmentState,
    primitive: baseDesc.primitive as unknown as GPUPrimitiveState,
    ...(baseDesc.depthStencil !== undefined
      ? { depthStencil: baseDesc.depthStencil as unknown as GPUDepthStencilState }
      : {}),
    ...(baseDesc.multisample !== undefined
      ? { multisample: baseDesc.multisample as unknown as GPUMultisampleState }
      : {}),
  });

  if (!pipelineResult.ok) {
    // Wrap the underlying RhiError with a `shader-compile-failed` envelope
    // when the originating code is not already canonical -- this preserves
    // the canonical error code consumers expect at the standard-pipeline
    // build site (createRenderer.ts standardPipelineResult).
    if (pipelineResult.error.code === 'shader-compile-failed') {
      return pipelineResult;
    }
    return err(
      new RhiError({
        code: 'shader-compile-failed',
        expected: `pipeline for material shader '${id}' builds successfully`,
        hint: `inspect compiler messages on the shader module; verify pipeline layout matches shader bindings (cause: ${pipelineResult.error.code})`,
      }),
    );
  }
  return pipelineResult;
}
