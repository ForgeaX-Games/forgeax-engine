// PipelineSpec 4-axis SSOT — single-file type + derive-fn + entrypoint + error model.
//
// feat-20260615-pipeline-spec-ssot M1: Establish PipelineSpec 4-axis type SSOT.
// M1-T1: type definitions + KNOWN_PASS_KINDS + PipelineSpecError closed union.
// M1-T2: 6 pure derive functions.
// M1-T3: deriveBglShapeFromShader helper.
// M1-T4: getOrBuildPipeline entrypoint + PipelineCache.
// M1-T5: 12 SPEC_CONST boot-time table.
//
// Design axiom: PipelineSpec is business-agnostic — no 'pbr' / 'sprite' / 'skybox'
// / 'fullscreen-*' strings appear on the type surface (plan-strategy D-7).
// BGL shape taxonomy lives in ShaderRegistry internal reflection, not in spec.
//
// Charter alignment:
//   F1: single file entrypoint (getOrBuildPipeline) — AI user indexes once
//   P1: progressive disclosure — types at top, fns mid, error model bottom
//   P3: explicit failure — closed PipelineSpecError union, no silent routes
//   P4: consistent abstraction — 4-axis aligns with wgpu/Bevy/Three.js

import type { MaterialShaderEntry, ShaderRegistry } from '@forgeax/engine-shader';
import {
  type BindGroupLayoutEntry,
  derive,
  KNOWN_PASS_KINDS,
  type MaterialRenderState,
  type ParamSchemaEntry,
  type PrimitiveTopology,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { createHdrpBindGroupLayoutDescriptor } from './hdrp-buffers';
import {
  appendInjection,
  buildPbrMaterialUserRegionEntries,
  buildPbrViewBglEntries,
  type PbrCaps,
} from './pbr-pipeline';
import { deriveVertexBufferLayout } from './vertex-attribute-layout';

// Re-export KNOWN_PASS_KINDS from @forgeax/engine-types for single-file discoverability (charter F1).
export { KNOWN_PASS_KINDS };

// ══════════════════════════════════════════════════════════════════════════════
// PipelineSpec — immutable 4-axis data description (D-7: business-agnostic)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Pipeline specification — immutable 4-axis data that completely determines
 * what `device.createRenderPipeline(...)` does for a material shader pass.
 *
 * The 4 axes are:
 * - `shader`: which WGSL source + material param schema + pass kind + variant set
 * - `attachments`: color/depth/stencil formats + sample count (MSAA)
 * - `geometry`: primitive topology + vertex attribute layout + index format
 * - `renderState`: optional per-material render-state overrides (blend/cull/depth/stencil)
 *
 * Business-agnostic: no `'pbr'` / `'sprite'` / `'skybox'` strings pollute this
 * type. BGL shape taxonomy is derived from `ShaderRegistry` internal reflection
 * and never appears on the spec surface (plan-strategy D-7).
 *
 * @see plan-strategy §1 (4-axis) · D-7 (business-agnostic) · requirements §3.1
 */
export interface PipelineSpec {
  /** Shader identity + routing axis. */
  readonly shader: {
    /** Registered shader identifier (e.g. `'forgeax::default-standard-pbr'`). */
    readonly id: string;
    /** Pass kind for attachment shape selection. Must be in {@link KNOWN_PASS_KINDS} or registered. */
    readonly passKind: string;
    /** Shader variant set string (e.g. `'SKIN_AVAILABLE=1'`). `undefined` for no variant. */
    readonly variantSet: string | undefined;
  };
  /** Attachment format + sample-count axis. */
  readonly attachments: {
    /** Colour attachment formats in draw order. Empty for depth-only passes (shadow-caster). */
    readonly colorFormats: readonly GPUTextureFormat[];
    /** Depth-stencil format, or `undefined` when no depth target is bound. */
    readonly depthFormat: GPUTextureFormat | undefined;
    /** Sample count: 1 (no MSAA) or 4 (4x MSAA). */
    readonly sampleCount: 1 | 4;
  };
  /** Geometry layout axis. */
  readonly geometry: {
    /** Primitive topology baked into the PSO. */
    readonly topology: PrimitiveTopology;
    /** Strip index format (uint16 / uint32), only meaningful for strip topologies. */
    readonly stripIndexFormat?: 'uint16' | 'uint32' | undefined;
    /** Per-vertex attribute layout (position / normal / uv / tangent / skinIndex / skinWeight). */
    readonly vertexLayout: VertexAttributeMap;
    /**
     * Number of UV sets declared by the shader (derived from @location reflection).
     * Forwarded to deriveVertexBufferLayout for clamp-to-last alias (D-1 / D-4).
     * Undefined = fallback to mesh-provided UV count (no clamping).
     * feat-20260629-multi-uv-set-support m3-w5: plumbed placeholder.
     * TODO(M4/m4-w3): fill from naga reflection JSON when available.
     */
    readonly shaderUvSetCount?: number | undefined;
  };
  /** Per-material render-state overrides (optional — engine defaults applied when absent). */
  readonly renderState: MaterialRenderState | undefined;
}

// ══════════════════════════════════════════════════════════════════════════════
// PipelineSpecError — closed union (5 + 2 transit codes)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Closed union of PipelineSpec error codes.
 *
 * 5 business codes:
 * - `'spec-inconsistent'`: axis mutual exclusion violated
 * - `'unknown-pass-kind'`: passKind not in KNOWN_PASS_KINDS or registered
 * - `'shader-bgl-reflection-mismatch'`: reflected BGL shape != shader declaration
 * - `'attachment-format-incompatible'`: depth/stencil format vs PSO mismatch
 * - `'unsupported-vertex-layout'`: vertex attributes don't match shader vs_main
 *
 * 2 transit codes:
 * - `'pipeline-build-failed'`: wraps RhiError from device.createRenderPipeline
 * - `'shader-not-registered'`: ShaderRegistry.lookup returned undefined
 *
 * @see requirements §3.4 · AC-10 · charter P3
 */
export type PipelineSpecErrorCode =
  | 'spec-inconsistent'
  | 'unknown-pass-kind'
  | 'shader-bgl-reflection-mismatch'
  | 'attachment-format-incompatible'
  | 'unsupported-vertex-layout'
  | 'pipeline-build-failed'
  | 'shader-not-registered';

/**
 * Structured pipeline-spec error — carries `.code` (discriminated union) +
 * `.detail` (narrowed per code) + `.hint` (AI-user actionable prose).
 *
 * Inherits from `Error` so it integrates with existing catch blocks; the
 * `.code` field enables exhaustive `switch` narrowing without string parsing
 * (charter P3).
 */
export class PipelineSpecError extends Error {
  readonly code: PipelineSpecErrorCode;
  /**
   * Narrowed detail payload — shape depends on `code`.
   *
   * - `'spec-inconsistent'`: `{ reason: string }`
   * - `'unknown-pass-kind'`: `{ expected: readonly string[]; actual: string; hint?: string }`
   * - `'shader-bgl-reflection-mismatch'`: `{ reflected: unknown; declared: unknown }`
   * - `'attachment-format-incompatible'`: `{ reason: string; expected?: string; actual?: string }`
   * - `'unsupported-vertex-layout'`: `{ specAttrs: string[]; shaderAttrs: string[] }`
   * - `'pipeline-build-failed'`: `{ gpuMessage?: string; cause?: unknown }`
   * - `'shader-not-registered'`: `{ shaderId: string; hint?: string }`
   */
  readonly detail: Record<string, unknown>;

  constructor(args: {
    code: PipelineSpecErrorCode;
    detail: Record<string, unknown>;
    hint?: string;
  }) {
    super(
      args.hint !== undefined
        ? `PipelineSpecError [${args.code}]: ${args.hint}`
        : `PipelineSpecError [${args.code}]`,
    );
    this.name = 'PipelineSpecError';
    this.code = args.code;
    this.detail = args.detail;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BindGroupLayoutShape — reflection-derived BGL descriptor
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Bind group layout shape derived from ShaderRegistry reflection.
 *
 * `entries` mirrors `GPUBindGroupLayoutDescriptor.entries` — the binding
 * slot layout the shader expects for a given variantSet.
 */
export interface BindGroupLayoutShape {
  readonly entries: readonly BindGroupLayoutEntry[];
}

// ══════════════════════════════════════════════════════════════════════════════
// deriveBglShapeFromShader — reflection helper (D-1)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Derive BGL shape from a registered shader entry's paramSchema.
 *
 * Pure function: same `entry` always yields the same shape (no variant-set
 * dispatch — that role moved into `BglKind` after D-13's closed-union
 * dispatch landed; see plan-decisions.md). The `_variantSet` parameter is
 * preserved for backward signature compat but ignored — variant routing is
 * now explicit at the BglKind level (see `buildBindGroupLayoutDescriptor`
 * arms `pbr-skin-mesh-array` vs `hdrp-7-slot` vs `pbr-mesh-array`).
 *
 * This helper lives in `pipeline-spec.ts` (not ShaderRegistry) per D-1:
 * it wraps the existing `derive(paramSchema).bglEntries` from
 * `@forgeax/engine-types` so cacheKeyOf can hash BGL shape deterministically
 * without expanding the ShaderRegistry public interface.
 *
 * @param entry - material shader entry from ShaderRegistry.lookupMaterialShader
 * @param _variantSet - unused (post D-13); kept for backward signature compat
 * @returns the BGL shape for the given entry
 * @see plan-decisions.md D-13
 */
export function deriveBglShapeFromShader(
  entry: MaterialShaderEntry,
  _variantSet?: string | undefined,
): BindGroupLayoutShape {
  // derive() from @forgeax/engine-types is the actual SSOT; we invoke it
  // here so that cacheKeyOf can hash BGL shape deterministically.
  const derived = derive(entry.paramSchema);
  return {
    entries: derived.bglEntries,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// renderStateHashSuffix — deterministic hash of MaterialRenderState
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic hash suffix for MaterialRenderState (sorted keys, JSON.stringify).
 *
 * Returns `''` when `renderState` is `undefined` or has zero entries,
 * preserving cache-key byte-compatibility with the pre-M1 shape.
 */
function renderStateHash(renderState: MaterialRenderState | undefined): string {
  if (renderState === undefined) return '';
  const sorted = Object.keys(renderState).sort();
  if (sorted.length === 0) return '';
  const payload: Record<string, unknown> = {};
  for (const k of sorted) {
    const v = renderState[k as keyof MaterialRenderState];
    if (v !== undefined) payload[k] = v;
  }
  return `:${JSON.stringify(payload)}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 6 pure derive functions (M1-T2)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Hash for deterministic cache-key ordering of strings.
 *
 * Simple DJB2 derivative — fast, deterministic, collision-resistant enough
 * for the closed set of PipelineSpec values in a renderer lifetime.
 */
function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * Compute a deterministic cache key from a PipelineSpec.
 *
 * The key covers all 4 axes + BGL shape hash (derived from ShaderRegistry
 * reflection via {@link deriveBglShapeFromShader}). Two specs that produce
 * the same cache key MUST produce byte-identical PSO descriptors.
 *
 * Algorithm: concatenate each axis segment with `:` separators, hash the
 * BGL shape for compactness, and emit a single cache-key string.
 *
 * @see plan-strategy §3.1 · requirements AC-02
 */
export function cacheKeyOf(spec: PipelineSpec): string {
  const { shader, attachments, geometry, renderState } = spec;
  const topoSegment = geometry.topology;
  const stripSegment =
    (topoSegment === 'line-strip' || topoSegment === 'triangle-strip') &&
    geometry.stripIndexFormat !== undefined
      ? `:${geometry.stripIndexFormat}`
      : '';

  // Hash vertexLayout deterministically — Object.entries sorted for stability.
  const vlKeys = Object.keys(geometry.vertexLayout).sort();
  const vlHashParts: string[] = [];
  for (const k of vlKeys) {
    const buf = geometry.vertexLayout[k as keyof VertexAttributeMap];
    if (buf !== undefined) {
      vlHashParts.push(`${k}:${buf.byteLength ?? (buf as ArrayBuffer).byteLength}`);
    }
  }
  const vlDigest = djb2(vlHashParts.join('|'));

  const uvSetCountSegment =
    geometry.shaderUvSetCount !== undefined ? `:uvsc${geometry.shaderUvSetCount}` : '';

  return (
    [
      shader.id,
      shader.passKind,
      shader.variantSet ?? '',
      attachments.colorFormats.join(','),
      attachments.depthFormat ?? '',
      String(attachments.sampleCount),
      topoSegment,
      stripSegment,
      `vl:${vlDigest}`,
      renderStateHash(renderState),
    ].join(':') + uvSetCountSegment
  );
}

/**
 * Build a `GPURenderPipelineDescriptor` from a PipelineSpec + shader modules.
 *
 * Pure derivation: same (spec, modules) always produces the same descriptor.
 * Consumed by `getOrBuildPipeline` on cache miss; also available as a public
 * helper for AI users who want the descriptor shape without going through the
 * cache entrypoint.
 *
 * @param spec - the pipeline spec (4 axes)
 * @param modules - `{ vertex: GPUShaderModule; fragment: GPUShaderModule }`
 * @returns a complete WebGPU render-pipeline descriptor
 * @see plan-strategy §3.2 · requirements AC-02
 */
export function buildPipelineDescriptor(
  spec: PipelineSpec,
  modules: {
    vertex: unknown;
    fragment: unknown;
    vertexEntryPoint?: string;
    fragmentEntryPoint?: string;
    layout?: unknown;
  },
): Record<string, unknown> {
  // M2-T4: derive vertex buffers from spec.geometry.vertexLayout via
  // deriveVertexBufferLayout (imported from vertex-attribute-layout.ts).
  // Empty vertexLayout (fullscreen-post passes) → [].
  // Non-empty (material shaders) → interleaved single-buffer layout.
  //
  // Entry points default to 'vs_main' / 'fs_main' for the 3 standard material
  // shaders; fullscreen-post passes (skybox 'skybox_fs', SSAO 'vs_ssao' / 'fs_ssao_calc')
  // pass custom entry points through the modules parameter.
  //
  // The optional `layout` field, when present, is forwarded to the descriptor
  // so that the provider can detect it is already set and avoid overwriting.

  const { attachments, geometry, renderState } = spec;

  const isShadowCaster = spec.shader.passKind === 'shadow-caster';
  const isStrip = geometry.topology === 'line-strip' || geometry.topology === 'triangle-strip';

  // Derive vertex buffer layouts from the spec's vertexLayout axis (SSOT).
  // feat-20260629-multi-uv-set-support m3-w5: thread shaderUvSetCount for clamp-to-last alias.
  const vertexBuffers = deriveVertexBufferLayout(geometry.vertexLayout, {
    ...(geometry.shaderUvSetCount !== undefined
      ? { shaderUvSetCount: geometry.shaderUvSetCount }
      : {}),
  });

  const descriptor: Record<string, unknown> = {
    vertex: {
      module: modules.vertex,
      entryPoint: modules.vertexEntryPoint ?? 'vs_main',
      buffers: vertexBuffers,
    },
  };

  // Fragment stage: absent for shadow-caster (depth-only), present for forward.
  if (!isShadowCaster && attachments.colorFormats.length > 0) {
    descriptor.fragment = {
      module: modules.fragment,
      entryPoint: modules.fragmentEntryPoint ?? 'fs_main',
      targets: attachments.colorFormats.map((fmt) => {
        const target: Record<string, unknown> = { format: fmt };
        if (renderState?.blend !== undefined) {
          target.blend = renderState.blend;
        }
        return target;
      }),
    };
  }

  // Layout: forward if provided by caller (fullscreen-post passes set it).
  if (modules.layout !== undefined) {
    descriptor.layout = modules.layout;
  }

  // Primitive state.
  const primitive: Record<string, unknown> = {
    topology: geometry.topology,
    cullMode: renderState?.cullMode ?? 'back',
    frontFace: renderState?.frontFace ?? 'ccw',
  };
  if (isStrip && geometry.stripIndexFormat !== undefined) {
    primitive.stripIndexFormat = geometry.stripIndexFormat;
  }
  descriptor.primitive = primitive;

  // Depth-stencil state.
  if (attachments.depthFormat !== undefined) {
    const ds: Record<string, unknown> = {
      format: attachments.depthFormat,
      depthWriteEnabled: renderState?.depthWriteEnabled ?? true,
      depthCompare: renderState?.depthCompare ?? 'less',
    };
    if (renderState?.stencilReadMask !== undefined) {
      ds.stencilReadMask = renderState.stencilReadMask;
    }
    if (renderState?.stencilWriteMask !== undefined) {
      ds.stencilWriteMask = renderState.stencilWriteMask;
    }
    if (renderState?.stencil !== undefined) {
      ds.stencilFront = renderState.stencil;
      ds.stencilBack = renderState.stencil;
    }
    descriptor.depthStencil = ds;
  }

  // Multisample: absent for sampleCount=1 (undefined). For any value > 1,
  // emit { count: sampleCount } so forward-compat sample counts (2, 8, …)
  // flow through to the descriptor without requiring a type change.
  if (attachments.sampleCount > 1) {
    descriptor.multisample = { count: attachments.sampleCount };
  }

  return descriptor;
}

// ══════════════════════════════════════════════════════════════════════════════
// BglKind dispatch (M3 / D-13) — closed union of BGL shapes the runtime ships
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Closed union of bind-group-layout shapes the runtime constructs.
 *
 * Each kind names one physically distinct BGL the runtime has historically
 * built by hand. {@link buildBindGroupLayoutDescriptor} dispatches on this
 * union so every `device.createBindGroupLayout(...)` call site shares one
 * SSOT for entries / labels (plan-strategy §3.2; D-13 round-2 decision).
 *
 * Three groups by derivation source:
 * 1. Shader-derived (paramSchema reflection + injection chain):
 *    - `'pbr-material-merged'` — 18 entries: base 7 + Skylight 7 + lightmap 4
 *    - `'unlit-material'` — 7 entries: base PBR material only (no inject)
 *    - `'hdrp-7-slot'` — 7 entries (binding 0 + 3..8): HDRP cluster + SSAO group(2) BGL
 * 2. Caps-driven literal shapes (no shader):
 *    - `'pbr-view'` — 10 entries: view UBO + lights + 6 shadow bindings
 *      (directional 3/4, point 5/6, cascade 7, spot atlas 8, spot
 *      lightViewProj matrices 9 — feat-20260625)
 *    - `'pbr-mesh-array'` — 1 entry: per-entity mesh SSBO (dynamic-offset)
 *    - `'pbr-instances'` — 1 entry: per-instance SSBO (no dynamic-offset)
 *    - `'pbr-skin-mesh-array'` — 2 entries: meshes + skin palette
 * 3. Attachment-driven (fullscreen post-process):
 *    - `'fullscreen-post'` — 2 entries: input texture + sampler. The texture
 *      `sampleType` is derived from `spec.attachments` (plan §R3 fix):
 *      `'depth32float'` → `'depth'`; `'r32float'` → `'unfilterable-float'`;
 *      else → `'float'`.
 *    - `'fullscreen-post-with-params'` — 3 entries: the same texture@0 +
 *      sampler@1 as `'fullscreen-post'`, plus a `buffer@2` uniform for the
 *      per-frame params UBO (feat-20260621 D-2: `entry.params !== undefined`
 *      passes route here; the layout stays group(1), q3=B). `'fullscreen-post'`
 *      stays byte-identical so param-less consumers degrade with no change.
 */
export type BglKind =
  | 'pbr-view'
  | 'pbr-material-merged'
  | 'pbr-mesh-array'
  | 'pbr-instances'
  | 'pbr-skin-mesh-array'
  | 'unlit-material'
  | 'hdrp-7-slot'
  | 'fullscreen-post'
  | 'fullscreen-post-with-params';

/**
 * Output shape of {@link buildBindGroupLayoutDescriptor}: matches the RHI
 * `BindGroupLayoutDescriptor` (label + entries with `ExplicitUndefined`) so
 * the result can be passed directly to `device.createBindGroupLayout(...)`.
 *
 * `entries` is a mutable `Array` to match `GPUBindGroupLayoutDescriptor`
 * (WebGPU types declare it mutable). Callers MUST treat the array as
 * read-only — the dispatcher freezes neither the array nor its entries
 * for hot-path performance.
 */
export interface BindGroupLayoutDescriptorOutput {
  readonly label: string | undefined;
  readonly entries: GPUBindGroupLayoutEntry[];
}

// WebGPU shader-stage flags — mirrors pbr-pipeline.ts constants. Re-declared
// here so the dispatcher does not import bit-flag literals from a sibling
// module (charter F1: pipeline-spec.ts is the SSOT for the dispatcher).
const GPU_SHADER_STAGE_FRAGMENT = 0x2;

/**
 * Build a `GPUBindGroupLayoutDescriptor` from a PipelineSpec, dispatching on
 * `options.kind` to one of 8 closed BGL shapes (D-13 round-2).
 *
 * Shader-derived kinds (`'pbr-material-merged'` / `'unlit-material'` /
 * `'hdrp-7-slot'`) require `options.registry` to look up the shader entry
 * and reflect its `paramSchema` via {@link deriveBglShapeFromShader}; they
 * compose the per-entry injection chain (Skylight + lightmap for material;
 * HDRP variantSet for cluster-forward).
 *
 * Caps-driven kinds (`'pbr-view'` / `'pbr-mesh-array'` / `'pbr-instances'` /
 * `'pbr-skin-mesh-array'`) require `options.caps` for the storage-buffer
 * vs uniform-buffer fallback (RhiCaps.storageBuffer; PBR feat-20260526 M3 /
 * w9). They are wholly determined by the caps shape.
 *
 * Attachment-driven kind (`'fullscreen-post'`) reads
 * `spec.attachments.depthFormat` and `spec.attachments.colorFormats[0]` to
 * pick the texture binding's `sampleType` (R3 fix: `'depth32float'` → `'depth'`,
 * `'r32float'` → `'unfilterable-float'`, else → `'float'`).
 *
 * @param spec - the pipeline spec (axis source for reflection / caps fallback)
 * @param options.kind - which BGL shape to build (closed {@link BglKind} union)
 * @param options.registry - ShaderRegistry for shader-derived kinds
 * @param options.caps - caps shape for caps-driven kinds (storageBuffer)
 * @returns a WebGPU bind-group-layout descriptor (entries + label)
 * @see plan-strategy §3.2 · plan-decisions D-13 · requirements AC-02
 */
/**
 * Resolve the material paramSchema for a per-shader user-region BGL derivation.
 *
 * Priority (D-1): explicit `options.materialParamSchema` > registry lookup of
 * `spec.shader.id` > `undefined` (the user-region builder then falls back to
 * the built-in standard-PBR 3-texture schema, byte-equivalent to base-7).
 */
function resolveMaterialParamSchema(
  spec: PipelineSpec,
  options: { registry?: ShaderRegistry; materialParamSchema?: readonly ParamSchemaEntry[] },
): readonly ParamSchemaEntry[] | undefined {
  if (options.materialParamSchema !== undefined) return options.materialParamSchema;
  if (options.registry !== undefined) {
    const lookup = options.registry.lookupMaterialShader(spec.shader.id);
    if (lookup.ok) return lookup.value.paramSchema;
  }
  return undefined;
}

export function buildBindGroupLayoutDescriptor(
  spec: PipelineSpec,
  options: {
    kind: BglKind;
    registry?: ShaderRegistry;
    caps?: PbrCaps;
    /**
     * Material paramSchema for the per-shader user-region derivation
     * (`'pbr-material-merged'` / `'unlit-material'`). When supplied it is the
     * authoritative source for the user-region BGL shape (D-1); when omitted,
     * `buildPbrMaterialUserRegionEntries` falls back to the built-in
     * standard-PBR 3-texture schema (byte-equivalent to the legacy base-7), so
     * the caps-driven `buildPbrPipelineLayouts` seam keeps working unchanged.
     * A registry + resolvable shader id takes precedence over this field.
     */
    materialParamSchema?: readonly ParamSchemaEntry[];
  },
): BindGroupLayoutDescriptorOutput {
  switch (options.kind) {
    case 'pbr-view': {
      const caps = options.caps ?? { storageBuffer: true };
      return {
        label: 'pbr-view-bgl',
        entries: buildPbrViewBglEntries(caps),
      };
    }
    case 'pbr-mesh-array': {
      const caps = options.caps ?? { storageBuffer: true };
      const meshBufType: GPUBufferBindingType = caps.storageBuffer
        ? 'read-only-storage'
        : 'uniform';
      // feat-20260624-sprite-lit-shading-model-pure-2d-lighting: sprite-lit's
      // fs_main reads `meshes[0].worldFromLocal` to reconstruct per-fragment
      // worldPos for point/spot light NdotL + attenuation (`spriteLitWorldPos`
      // in sprite-lit.wgsl). Existing PBR/unlit/sprite shaders only read the
      // mesh SSBO from vs_main, so widening to VERTEX|FRAGMENT is a permissive
      // change for them (no perf cost — validation only) while making
      // sprite-lit's pipeline actually buildable. WebGPU rejects
      // createRenderPipeline when fragment-stage shader accesses a binding
      // whose BGL visibility excludes FRAGMENT.
      return {
        label: 'pbr-mesh-array-bgl',
        entries: [
          {
            binding: 0,
            visibility: 0x1 | 0x2,
            buffer: { type: meshBufType, hasDynamicOffset: true },
          },
        ],
      };
    }
    case 'pbr-instances': {
      const caps = options.caps ?? { storageBuffer: true };
      const meshBufType: GPUBufferBindingType = caps.storageBuffer
        ? 'read-only-storage'
        : 'uniform';
      return {
        label: 'pbr-instances-bgl',
        entries: [
          {
            binding: 0,
            visibility: 0x1,
            buffer: { type: meshBufType, hasDynamicOffset: false },
          },
        ],
      };
    }
    case 'pbr-skin-mesh-array': {
      const caps = options.caps ?? { storageBuffer: true };
      const meshBufType: GPUBufferBindingType = caps.storageBuffer
        ? 'read-only-storage'
        : 'uniform';
      return {
        label: 'pbr-skin-mesh-array-bgl',
        entries: [
          {
            binding: 0,
            visibility: 0x1,
            buffer: { type: meshBufType, hasDynamicOffset: true },
          },
          {
            binding: 1,
            visibility: 0x1,
            buffer: { type: meshBufType, hasDynamicOffset: true },
          },
        ],
      };
    }
    case 'pbr-material-merged': {
      // Material BGL: per-shader user-region (derive(paramSchema).bglEntries)
      // + IBL injection (7) + lightmap injection (4). The user-region size is
      // the only variable; injection start = userRegion.length so a 4-texture
      // custom schema shifts IBL/lightmap by one sampler/texture pair (D-1).
      // For the built-in 3-texture standard-PBR schema this is 7 + 7 + 4 = 18,
      // bit-for-bit the legacy fixed layout (D-2 / AC-06).
      //
      // Schema source priority (D-1): explicit materialParamSchema option >
      // registry lookup of spec.shader.id > built-in standard-PBR fallback.
      const resolvedSchema = resolveMaterialParamSchema(spec, options);
      const userRegion = buildPbrMaterialUserRegionEntries(resolvedSchema);
      const afterIbl = [...userRegion, ...appendInjection(userRegion, 'ibl')];
      const merged = [...afterIbl, ...appendInjection(afterIbl, 'lightmap')];
      return {
        label: 'pbr-material-skylight-bgl',
        entries: merged,
      };
    }
    case 'unlit-material': {
      // Unlit material BGL: per-shader user-region only. No IBL/lightmap
      // injection (D-5 round-4: unlit demos do not pay for IBL state).
      const resolvedSchema = resolveMaterialParamSchema(spec, options);
      return {
        label: 'unlit-material-bgl',
        entries: buildPbrMaterialUserRegionEntries(resolvedSchema),
      };
    }
    case 'hdrp-7-slot': {
      // HDRP unified BGL for group(2): 9 entries (binding 0 + 3..8). The
      // shape depends on caps.storageBuffer for the cluster-buffer fallback.
      const caps = options.caps ?? { storageBuffer: true };
      const desc = createHdrpBindGroupLayoutDescriptor(caps.storageBuffer);
      if (options.registry !== undefined) {
        const lookup = options.registry.lookupMaterialShader(spec.shader.id);
        if (lookup.ok) {
          deriveBglShapeFromShader(lookup.value, spec.shader.variantSet);
        }
      }
      return {
        label: desc.label ?? 'hdrp-unified-bgl-group2',
        entries: desc.entries ?? [],
      };
    }
    case 'fullscreen-post': {
      // Fullscreen post-process BGL: 2 entries (input texture + sampler).
      // R3 fix: derive sampleType from spec.attachments. Depth attachments
      // (depth32float) need `sampleType: 'depth'`; r32float needs
      // `'unfilterable-float'`; everything else (rgba8unorm-srgb, rgba16float,
      // bgra8unorm, …) is filterable `'float'`.
      return {
        label: 'fullscreen-post-bgl',
        entries: buildFullscreenPostInputEntries(spec),
      };
    }
    case 'fullscreen-post-with-params': {
      // feat-20260621 D-2: the same input texture@0 + sampler@1 as
      // 'fullscreen-post', plus binding 2 = per-frame params UBO (uniform).
      // The first two entries reuse buildFullscreenPostInputEntries so the
      // sampleType derivation stays a single SSOT; 'fullscreen-post' is
      // untouched (param-less zero-regression, R-A7).
      return {
        label: 'fullscreen-post-with-params-bgl',
        entries: [
          ...buildFullscreenPostInputEntries(spec),
          {
            binding: 2,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' },
          },
        ],
      };
    }
  }
}

/**
 * The shared texture@0 + sampler@1 entries for fullscreen post-process BGLs.
 * sampleType is derived from `spec.attachments` (R3 fix): depth attachments →
 * `'depth'` + `'comparison'` sampler; `'r32float'` → `'unfilterable-float'`;
 * else → `'float'` + `'filtering'`. Both `'fullscreen-post'` and
 * `'fullscreen-post-with-params'` reuse this so the derivation is one SSOT.
 */
function buildFullscreenPostInputEntries(spec: PipelineSpec): GPUBindGroupLayoutEntry[] {
  const inputFormat: GPUTextureFormat | undefined =
    spec.attachments.depthFormat ?? spec.attachments.colorFormats[0];
  const sampleType: GPUTextureSampleType =
    inputFormat === 'depth32float' ||
    inputFormat === 'depth24plus' ||
    inputFormat === 'depth24plus-stencil8' ||
    inputFormat === 'depth16unorm'
      ? 'depth'
      : inputFormat === 'r32float'
        ? 'unfilterable-float'
        : 'float';
  return [
    {
      binding: 0,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType, viewDimension: '2d' },
    },
    {
      binding: 1,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      sampler: {
        type: sampleType === 'depth' ? 'comparison' : 'filtering',
      },
    },
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// passKindPolicyTable — closed map: passKind → attachment shape + default ops
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Default colour-attachment ops carried by a passKind policy.
 *
 * `clearValue` is `undefined` for `loadOp='load'` policies (no clear value
 * is emitted into the descriptor when the prior contents are loaded).
 */
export interface AttachmentColorOps {
  readonly loadOp: 'clear' | 'load';
  readonly storeOp: 'store' | 'discard';
  readonly clearValue: GPUColor | undefined;
}

/**
 * Default depth-attachment ops carried by a passKind policy.
 *
 * `stencilLoadOp` / `stencilStoreOp` are absent on the policy itself — the
 * stencil-op gate is auto-derived from `specAttachments.depthFormat` at call
 * time (`'depth24plus-stencil8'` → `'clear'+'discard'`; everything else
 * elides stencil ops). This collapses the R3/R5 stencil-op duplicates that
 * previously lived inline at every forward-pass beginRenderPass call site.
 */
export interface AttachmentDepthOps {
  readonly loadOp: 'clear' | 'load';
  readonly storeOp: 'store' | 'discard';
  readonly clearValue: number;
}

/**
 * Attachment policy for a single passKind — declares the colour / depth shape
 * the pass produces and the default load/store ops. Per-call-site overrides
 * (skybox vs main forward differing on `colorLoadOp`, sprite-split forward
 * differing on both `colorLoadOp` and `depthLoadOp`) flow through the
 * `options` parameter of {@link buildBeginRenderPassDescriptor}.
 *
 * `shape` discriminator drives which attachment slots the descriptor emits:
 * - `'depth-only'` → empty `colorAttachments[]`, `depthStencilAttachment` set
 * - `'color-only'` → populated `colorAttachments[]`, no `depthStencilAttachment`
 * - `'color-and-depth'` → both
 */
export interface PassKindAttachmentPolicy {
  readonly shape: 'depth-only' | 'color-only' | 'color-and-depth';
  readonly defaultColorOps: AttachmentColorOps | undefined;
  readonly defaultDepthOps: AttachmentDepthOps | undefined;
}

/**
 * Closed map of passKind → attachment policy. Covers the 9 attachment shapes
 * the runtime ships (per plan-strategy M4):
 *
 * 1. `'forward'` — main geometry pass: color+depth(+stencil-gated)
 * 2. `'shadow-caster'` — directional shadow caster: depth-only
 * 3. `'point-shadow-caster'` — HDRP point-shadow caster: depth-only
 * 4. `'skybox'` — fullscreen skybox: color-only clear/store
 * 5. `'tonemap'` — HDR→LDR tonemap fullscreen: color-only clear/store
 * 6. `'bloom-bright'` / `'bloom-blur'` — bloom downsample/blur: color-only
 *    clear/store
 * 7. `'bloom-composite'` — bloom add-back: color-only load/store (NOT clear)
 * 8. `'fxaa'` — fullscreen FXAA: color-only clear/store
 * 9. `'post-process'` — generic fullscreen primitive (SSAO, render-graph
 *    fullscreen-post-process-pass dispatcher, M2 tonemap pre-warm slot):
 *    color-only clear/store
 *
 * Sprite-split forward sub-pass reuses the `'forward'` policy with
 * `options.colorLoadOp='load'` + `options.depthLoadOp='load'`.
 *
 * Stencil-op gate is NOT in this table — it is derived from
 * `specAttachments.depthFormat` inside the helper (depth24plus-stencil8
 * → emit `stencilLoadOp:'clear' / stencilStoreOp:'discard'`).
 */
export const passKindPolicyTable: Readonly<Record<string, PassKindAttachmentPolicy>> = {
  forward: {
    shape: 'color-and-depth',
    defaultColorOps: {
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    },
    defaultDepthOps: { loadOp: 'clear', storeOp: 'store', clearValue: 1 },
  },
  'shadow-caster': {
    shape: 'depth-only',
    defaultColorOps: undefined,
    defaultDepthOps: { loadOp: 'clear', storeOp: 'store', clearValue: 1 },
  },
  'point-shadow-caster': {
    shape: 'depth-only',
    defaultColorOps: undefined,
    defaultDepthOps: { loadOp: 'clear', storeOp: 'store', clearValue: 1 },
  },
  skybox: {
    shape: 'color-only',
    defaultColorOps: {
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    },
    defaultDepthOps: undefined,
  },
  tonemap: {
    shape: 'color-only',
    defaultColorOps: {
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    },
    defaultDepthOps: undefined,
  },
  'bloom-bright': {
    shape: 'color-only',
    defaultColorOps: {
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    },
    defaultDepthOps: undefined,
  },
  'bloom-blur': {
    shape: 'color-only',
    defaultColorOps: {
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    },
    defaultDepthOps: undefined,
  },
  'bloom-composite': {
    shape: 'color-only',
    defaultColorOps: {
      loadOp: 'load',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    },
    defaultDepthOps: undefined,
  },
  fxaa: {
    shape: 'color-only',
    defaultColorOps: {
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    },
    defaultDepthOps: undefined,
  },
  'post-process': {
    shape: 'color-only',
    defaultColorOps: {
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    },
    defaultDepthOps: undefined,
  },
};

/**
 * Build a `GPURenderPassDescriptor` from spec attachments + resolved views +
 * a passKind policy lookup.
 *
 * The helper is the single SSOT for `device.beginRenderPass(...)` descriptor
 * shape — every record-stage call site routes through it (plan-strategy M4
 * AC-06). It dispatches on `passKindPolicyTable[passKind]` to pick the
 * attachment shape (depth-only / color-only / color-and-depth) and applies
 * default color/depth load+store ops; per-call overrides (sprite-split's
 * `loadOp:'load'`, main pass's dynamic `mainColorLoadOp`, skybox's specific
 * clearColor) flow through `options`.
 *
 * Stencil-op gate is auto-derived from `specAttachments.depthFormat`:
 * - `'depth24plus-stencil8'` → emits `stencilLoadOp:'clear', stencilStoreOp:'discard'`
 * - any other depth format → omits stencil ops entirely
 *
 * This collapses the R3/R5 stencil-op duplicates that previously lived inline
 * at every forward-pass beginRenderPass site.
 *
 * @param specAttachments - the attachments axis from a PipelineSpec
 * @param viewBindings - resolved texture views: `{ colorViews, depthView?, resolveTargets? }`
 * @param passKind - one of the keys in {@link passKindPolicyTable}
 * @param options - per-call ops overrides (loadOp / clearValue / label)
 * @returns a WebGPU render-pass descriptor
 * @throws PipelineSpecError(`'unknown-pass-kind'`) when passKind is not registered
 * @see plan-strategy M4 · requirements AC-06
 */
export function buildBeginRenderPassDescriptor(
  specAttachments: PipelineSpec['attachments'],
  viewBindings: {
    readonly colorViews: readonly unknown[];
    readonly resolveTargets?: readonly (unknown | undefined)[];
    readonly depthView?: unknown;
  },
  passKind: string,
  options?: {
    readonly colorLoadOp?: 'clear' | 'load';
    readonly colorStoreOp?: 'store' | 'discard';
    readonly clearColor?: GPUColor;
    readonly depthLoadOp?: 'clear' | 'load';
    readonly depthStoreOp?: 'store' | 'discard';
    readonly label?: string;
  },
): Record<string, unknown> {
  const policy = passKindPolicyTable[passKind];
  if (policy === undefined) {
    throw new PipelineSpecError({
      code: 'unknown-pass-kind',
      detail: { expected: Object.keys(passKindPolicyTable), actual: passKind },
      hint: `passKind '${passKind}' is not in passKindPolicyTable; register an attachment policy or pick an existing one (e.g. 'post-process' for fullscreen-quad passes)`,
    });
  }

  const out: Record<string, unknown> = {};
  if (options?.label !== undefined) {
    out.label = options.label;
  }

  // Colour attachments: depth-only → empty array; otherwise iterate colorViews
  // and apply policy default ops + per-call overrides. resolveTargets[i] === undefined
  // means "no resolve for this slot"; only present slots emit a `resolveTarget`.
  if (policy.shape === 'depth-only') {
    out.colorAttachments = [];
  } else {
    const colorOps = policy.defaultColorOps;
    if (colorOps === undefined) {
      throw new PipelineSpecError({
        code: 'spec-inconsistent',
        detail: {
          reason: 'policy-shape-color-without-colorOps',
          actual: passKind,
        },
        hint: `passKind '${passKind}' has shape='${policy.shape}' but no defaultColorOps; fix passKindPolicyTable entry`,
      });
    }
    const loadOp = options?.colorLoadOp ?? colorOps.loadOp;
    const storeOp = options?.colorStoreOp ?? colorOps.storeOp;
    const clearValue = options?.clearColor ?? colorOps.clearValue;

    out.colorAttachments = viewBindings.colorViews.map((view, i) => {
      const slot: Record<string, unknown> = {
        view,
        loadOp,
        storeOp,
      };
      const resolveTarget = viewBindings.resolveTargets?.[i];
      if (resolveTarget !== undefined) {
        slot.resolveTarget = resolveTarget;
      }
      // Emit clearValue only when load is 'clear' AND a value is available.
      if (loadOp === 'clear' && clearValue !== undefined) {
        slot.clearValue = clearValue;
      }
      return slot;
    });
  }

  // Depth-stencil attachment: emitted iff policy declares depth ops AND
  // the spec carries a depthFormat. Stencil ops auto-derived from format.
  if (policy.shape !== 'color-only' && policy.defaultDepthOps !== undefined) {
    const dOps = policy.defaultDepthOps;
    const depthLoadOp = options?.depthLoadOp ?? dOps.loadOp;
    const depthStoreOp = options?.depthStoreOp ?? dOps.storeOp;
    const ds: Record<string, unknown> = {
      view: viewBindings.depthView,
      depthLoadOp,
      depthStoreOp,
    };
    if (depthLoadOp === 'clear') {
      ds.depthClearValue = dOps.clearValue;
    }
    // Stencil-op gate: only depth24plus-stencil8 carries a stencil aspect.
    if (specAttachments.depthFormat === 'depth24plus-stencil8') {
      ds.stencilClearValue = 0;
      ds.stencilLoadOp = 'clear';
      ds.stencilStoreOp = 'discard';
    }
    out.depthStencilAttachment = ds;
  }

  return out;
}

/**
 * Dev-mode equality check: two PipelineSpec instances are structurally equal
 * when every axis field is `===` (shallow compare).
 *
 * Not intended for runtime hot paths — use `cacheKeyOf(a) === cacheKeyOf(b)`
 * for cache-hit checks. This function exists for dev-time assertions
 * (`assert(specsEqual(specA, specB))`) and unit-test round-trip verification.
 *
 * @see plan-strategy §3.2 · requirements AC-02
 */
export function specsEqual(a: PipelineSpec, b: PipelineSpec): boolean {
  if (
    a.shader.id !== b.shader.id ||
    a.shader.passKind !== b.shader.passKind ||
    a.shader.variantSet !== b.shader.variantSet ||
    a.attachments.colorFormats.length !== b.attachments.colorFormats.length ||
    !a.attachments.colorFormats.every((f, i) => f === b.attachments.colorFormats[i]) ||
    a.attachments.depthFormat !== b.attachments.depthFormat ||
    a.attachments.sampleCount !== b.attachments.sampleCount ||
    a.geometry.topology !== b.geometry.topology ||
    a.geometry.stripIndexFormat !== b.geometry.stripIndexFormat
  ) {
    return false;
  }

  // VertexLayout: same reference or structurally equal keys + byte lengths
  if (a.geometry.vertexLayout !== b.geometry.vertexLayout) {
    const aKeys = Object.keys(a.geometry.vertexLayout).sort();
    const bKeys = Object.keys(b.geometry.vertexLayout).sort();
    if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i])) return false;
    for (const k of aKeys) {
      const aBuf = a.geometry.vertexLayout[k as keyof VertexAttributeMap];
      const bBuf = b.geometry.vertexLayout[k as keyof VertexAttributeMap];
      if (aBuf === bBuf) continue;
      if (aBuf === undefined || bBuf === undefined) return false;
      if ((aBuf as ArrayBuffer).byteLength !== (bBuf as ArrayBuffer).byteLength) return false;
    }
  }

  // RenderState: same reference or JSON-equal
  if (a.renderState !== b.renderState) {
    if (a.renderState === undefined || b.renderState === undefined) return false;
    const aSorted = Object.keys(a.renderState).sort();
    const bSorted = Object.keys(b.renderState).sort();
    if (aSorted.length !== bSorted.length || !aSorted.every((k, i) => k === bSorted[i]))
      return false;
    for (const k of aSorted) {
      if (
        a.renderState[k as keyof MaterialRenderState] !==
        b.renderState[k as keyof MaterialRenderState]
      )
        return false;
    }
  }

  return true;
}

/**
 * Validate a PipelineSpec before attempting to build.
 *
 * Fail-fast checks (charter P5) covering axis mutual-exclusion rules.
 * Returns `Result<void, PipelineSpecError>` — ok for valid specs,
 * err with structured code + detail for invalid ones.
 *
 * Checks:
 * 1. `sampleCount=4` with empty `colorFormats` → `'spec-inconsistent'`
 * 2. Pass kind not in `KNOWN_PASS_KINDS` → `'unknown-pass-kind'`
 * 3. `depthFormat` undefined but `renderState` implies depth testing →
 *    `'attachment-format-incompatible'`
 *
 * @see plan-strategy §3.2 · requirements AC-02 · charter P5
 */
export function validateSpec(
  spec: PipelineSpec,
):
  | { ok: true }
  | { ok: false; code: PipelineSpecErrorCode; detail: Record<string, unknown>; hint?: string } {
  // Check 1: sampleCount=4 with empty colorFormats is inconsistent —
  // multisample requires a colour target to resolve to.
  if (spec.attachments.sampleCount === 4 && spec.attachments.colorFormats.length === 0) {
    return {
      ok: false,
      code: 'spec-inconsistent',
      detail: { reason: 'sample-count-format-incompatible' },
      hint: 'sampleCount=4 requires at least one colorFormat; shadow-caster (depth-only) passes should use sampleCount=1',
    };
  }

  // Check 2: unknown pass kind
  if (!KNOWN_PASS_KINDS.includes(spec.shader.passKind)) {
    return {
      ok: false,
      code: 'unknown-pass-kind',
      detail: { expected: KNOWN_PASS_KINDS, actual: spec.shader.passKind },
      hint: `passKind '${spec.shader.passKind}' is not in KNOWN_PASS_KINDS; register custom pass kinds via ShaderRegistry`,
    };
  }

  // Check 3: depth-testing renderState without a depthFormat
  if (spec.attachments.depthFormat === undefined && spec.renderState?.depthCompare !== undefined) {
    return {
      ok: false,
      code: 'attachment-format-incompatible',
      detail: {
        reason: 'depth-compare-without-depth-format',
        expected: 'depthFormat must be set when renderState.depthCompare is defined',
        actual: `depthFormat=${String(spec.attachments.depthFormat)}, depthCompare=${spec.renderState.depthCompare}`,
      },
      hint: 'set attachments.depthFormat (e.g. depth24plus-stencil8 or depth32float) when renderState specifies depthCompare',
    };
  }

  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// PipelineCache — Map<string, RenderPipeline> container (D-12)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Pipeline cache — Map from cacheKeyOf(spec) to opaque RenderPipeline handle.
 *
 * Constructed once at createRenderer boot time; shared across all call sites.
 * Consumers call `getOrBuildPipeline(spec, deviceProvider, cache)` — the
 * entrypoint does cache lookup internally; consumers never touch the Map
 * directly.
 *
 * @see plan-strategy D-12 · requirements §3.2
 */
export type PipelineCache = Map<string, unknown>;

// ══════════════════════════════════════════════════════════════════════════════
// getOrBuildPipeline — single entrypoint (D-12)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Device factory interface consumed by {@link getOrBuildPipeline}.
 *
 * Slim abstraction: only `createRenderPipeline` is needed; the entrypoint
 * does not depend on the full `RhiDevice` interface so it can be tested
 * with a mock.
 */
export interface PipelineDeviceProvider {
  createRenderPipeline(
    descriptor: Record<string, unknown>,
  ): { ok: true; value: unknown } | { ok: false; error: unknown };
}

/**
 * Single entrypoint for obtaining a render pipeline from a spec.
 *
 * Cache-hit path: key = cacheKeyOf(spec), returns cached handle immediately.
 * Cache-miss path: validates spec → builds descriptor → calls device.createRenderPipeline
 * → caches result → returns handle.
 * Build failure: throws PipelineSpecError (charter P3 fail-fast, no silent fallback).
 *
 * Pure function: same (spec, deviceProvider, cache) always produces the same result.
 * Boot-time call site: createRenderer wires the real device; record-stage call site
 * uses ctx.runtime.device (same entrypoint, same signature).
 *
 * @param spec - immutable 4-axis pipeline specification
 * @param deviceProvider - factory with createRenderPipeline method
 * @param cache - the PipelineCache (shared across boot + record stage)
 * @returns a RenderPipeline handle (opaque, typed as unknown for M1)
 * @throws PipelineSpecError on validation failure or build failure
 * @see plan-strategy D-12 · requirements AC-03 · charter F1
 */
export function getOrBuildPipeline(
  spec: PipelineSpec,
  deviceProvider: PipelineDeviceProvider,
  cache: PipelineCache,
  modules?: {
    vertex: unknown;
    fragment: unknown;
    vertexEntryPoint?: string;
    fragmentEntryPoint?: string;
    layout?: unknown;
  },
): unknown {
  const key = cacheKeyOf(spec);

  // Cache hit — return immediately.
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // Cache miss — validate, build, cache, return.
  const validation = validateSpec(spec);
  if (!validation.ok) {
    throw new PipelineSpecError({
      code: validation.code,
      detail: validation.detail,
      ...(validation.hint !== undefined ? { hint: validation.hint } : {}),
    });
  }

  const descriptor = buildPipelineDescriptor(
    spec,
    modules ?? { vertex: undefined, fragment: undefined },
  );
  const result = deviceProvider.createRenderPipeline(descriptor);

  if (!result.ok) {
    throw new PipelineSpecError({
      code: 'pipeline-build-failed',
      detail: { cause: result.error },
      hint: 'device.createRenderPipeline failed for spec; inspect gpuMessage on the error detail',
    });
  }

  cache.set(key, result.value);
  return result.value;
}

// ══════════════════════════════════════════════════════════════════════════════
// SPEC_CONST_TABLE — 12 boot-time pre-warm variants (M1-T5)
// ══════════════════════════════════════════════════════════════════════════════

const PROCEDURAL_ATTR_LAYOUT: VertexAttributeMap = {
  position: new Float32Array(0),
  normal: new Float32Array(0),
  uv: new Float32Array(0),
  tangent: new Float32Array(0),
};

const HDR_FORMAT: GPUTextureFormat = 'rgba16float' as unknown as GPUTextureFormat;
const DEPTH_DS: GPUTextureFormat = 'depth24plus-stencil8' as unknown as GPUTextureFormat;

/**
 * Default LDR view format used when callers ask for the SPEC_CONST table
 * without an explicit swap-chain format. Kept for the backward-compatible
 * `SPEC_CONST_TABLE` export consumed by unit tests that exercise the
 * spec/cache-keying layer in isolation. Runtime callers always pass the
 * format selected by `selectSwapChainFormat` (Channel 2 BGRA / Channel 3
 * RGBA / dawn-node RGBA — see bug-20260615 fix-up note in `createRenderer`).
 */
const DEFAULT_LDR_FORMAT: GPUTextureFormat = 'bgra8unorm-srgb' as unknown as GPUTextureFormat;

const TRI_GEOMETRY = {
  topology: 'triangle-list' as PrimitiveTopology,
  stripIndexFormat: undefined,
  vertexLayout: PROCEDURAL_ATTR_LAYOUT,
};

// M6 fix-up: URP-variant key string for the standard PBR shader. Mirrors the
// boot-time variantSet computed at createRenderer.ts step 1b when
// `isHdrpActive=false` and `storageBufferCapable=true` (the URP default
// surface). The URP record path requests this exact string at every
// `getMaterialShaderPipeline` call site, so seeding the table with these
// variants keeps the URP cache lookup hot from frame 1 instead of
// skip-drawing the first ~1 frames while the async compile resolves.
const URP_PBR_VARIANT_SET = 'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true';

/**
 * Build the boot-time pre-warm table: 15 standard PipelineSpec variants.
 *
 * feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (AC-12): the
 * four `forgeax::default-sprite` entries (LDR S1 + LDR S4 + HDR S1 + HDR S4)
 * are gone — sprite PSO lands lazily through the generic
 * per-MaterialShader pipeline cache. Pre-feat count was 19; post-feat 15.
 *
 * Matrix:
 *   - 8 base material variants — {unlit, standard-pbr} x {LDR, HDR} x {S1, S4}
 *   - 4 URP-variant standard-pbr — standard-pbr (variantSet=URP_PBR_VARIANT_SET)
 *     x {LDR, HDR} x {S1, S4}; URP record path requests these specs by
 *     `getMaterialShaderPipeline` keying off `cacheKeyOf` so the boot-time
 *     prewarm seeds `materialShaderPipelineCache` and avoids a 1-frame
 *     async-compile skip-draw (M6 fix-up; see render-system-record.ts §URP)
 *   - 3 fullscreen-post — tonemap (LDR S1) + skybox (HDR S1, HDR S4)
 *
 * Total: 15. The URP variant is PBR-only because:
 *   - unlit URP record path passes `variantSet=undefined` (the no-variant
 *     boot-default entries already cover it; createRenderer.ts §unlitRsp)
 *   - sprite goes through `getMaterialShaderPipeline('forgeax::sprite', ...)`
 *     lazily at first transparent-LDR-split draw — no boot-time pre-warm.
 *   - HDRP variant (`variantSet=''` or compound `=true` form) is registered
 *     lazily on `installPipeline(hdrpAsset)`, not at boot — adding HDRP
 *     prewarm here would build PSOs against the URP layout (the boot-time
 *     `pbrModule` is the URP variant when `isHdrpActive=false`)
 *
 * `ldrViewFormat` parameterises the LDR color attachment format. Callers
 * pass the runtime-resolved swap-chain view format (Channel 2 typically
 * `bgra8unorm-srgb`; Channel 3 wgpu-wasm and dawn-node typically
 * `rgba8unorm-srgb`). Hard-coding `bgra8unorm-srgb` at module load made
 * the pre-warmed PSOs incompatible with the actual RenderPass color
 * attachment on Channel 3 / dawn-node, producing whole-commandBuffer
 * invalid errors on every frame (bug-20260615 fix-up — see
 * `createRenderer` boot-time pre-warm site).
 *
 * Fullscreen passes (fxaa / bloom x 3 / SSAO x 2) are lazy-build — they
 * use the same getOrBuildPipeline entrypoint but are not in this table.
 *
 * @see plan-strategy D-4 · research R-D4 · requirements AC-16
 * @see bug-20260612-webgpu-canvas-format-prefer-bgra-shipped (same trap shape)
 */
export function buildSpecConstTable(
  ldrViewFormat: GPUTextureFormat,
): readonly Readonly<PipelineSpec>[] {
  const TRI_ATTACHMENTS_LDR_S1 = {
    colorFormats: [ldrViewFormat],
    depthFormat: DEPTH_DS,
    sampleCount: 1 as const,
  };

  const TRI_ATTACHMENTS_LDR_S4 = {
    colorFormats: [ldrViewFormat],
    depthFormat: DEPTH_DS,
    sampleCount: 4 as const,
  };

  // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (AC-12 / D-7):
  // SPRITE_ATTACHMENTS_LDR_S1 / S4 (the dedicated non-srgb storage-format
  // attachments the sprite spec entries consumed) were deleted alongside the
  // four `forgeax::default-sprite` SPEC_CONST entries. The bgra8unorm storage
  // format itself is still enforced at the LDR sprite sub-pass attachment
  // level (the WebGPU pipeline `colorFormats` derive from the actual render
  // pass attachment view, which is built off `pipelineState.format` =
  // swap-chain storage format — see `render-system-record.ts` LDR split
  // beginRenderPass call). The triggering source migrated from the
  // spec-table id to `material.transparent` (derived by the extract stage
  // from `passes[0].renderState.blend !== undefined`, the
  // post-feat-20260626-collapse SSOT; w7 onwards).

  const TRI_ATTACHMENTS_HDR_S1 = {
    colorFormats: [HDR_FORMAT],
    depthFormat: DEPTH_DS,
    sampleCount: 1 as const,
  };

  const TRI_ATTACHMENTS_HDR_S4 = {
    colorFormats: [HDR_FORMAT],
    depthFormat: DEPTH_DS,
    sampleCount: 4 as const,
  };

  return [
    // unlit LDR S1
    {
      shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_LDR_S1,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // unlit LDR S4
    {
      shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_LDR_S4,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // unlit HDR S1
    {
      shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_HDR_S1,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // unlit HDR S4
    {
      shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_HDR_S4,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // standard LDR S1
    {
      shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_LDR_S1,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // standard LDR S4
    {
      shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_LDR_S4,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // standard HDR S1
    {
      shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_HDR_S1,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // standard HDR S4
    {
      shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_HDR_S4,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },

    // ── M6 fix-up: URP-variant standard-pbr prewarm ─────────────────────────
    // URP record path (`getMaterialShaderPipeline`) requests
    // `variantSet=URP_PBR_VARIANT_SET` for standard-shading entities; pre-M6
    // the silent `selectStandardFallbackPipeline` shim served the no-variant
    // boot prewarm during the 1-frame async-compile warmup. With M6's
    // explicit-failure surface, those URP requests must hit the boot prewarm
    // by their own variantSet — these 4 entries close that gap.

    // standard PBR URP LDR S1
    {
      shader: {
        id: 'forgeax::default-standard-pbr',
        passKind: 'forward',
        variantSet: URP_PBR_VARIANT_SET,
      },
      attachments: TRI_ATTACHMENTS_LDR_S1,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // standard PBR URP LDR S4
    {
      shader: {
        id: 'forgeax::default-standard-pbr',
        passKind: 'forward',
        variantSet: URP_PBR_VARIANT_SET,
      },
      attachments: TRI_ATTACHMENTS_LDR_S4,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // standard PBR URP HDR S1
    {
      shader: {
        id: 'forgeax::default-standard-pbr',
        passKind: 'forward',
        variantSet: URP_PBR_VARIANT_SET,
      },
      attachments: TRI_ATTACHMENTS_HDR_S1,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // standard PBR URP HDR S4
    {
      shader: {
        id: 'forgeax::default-standard-pbr',
        passKind: 'forward',
        variantSet: URP_PBR_VARIANT_SET,
      },
      attachments: TRI_ATTACHMENTS_HDR_S4,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },

    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (AC-12 / D-7):
    // the four `forgeax::default-sprite` boot-time pre-warm entries (LDR S1
    // + LDR S4 + HDR S1 + HDR S4) are gone. Sprite PSO lands lazily through
    // the generic per-MaterialShader pipeline cache keyed on
    // `forgeax::sprite` + premultiplied-alpha renderState; SPEC_CONST_TABLE
    // shrinks from 19 to 15 entries (-4 boot-time PSOs).

    // ── M2-T4: fullscreen-post boot-time pre-warm (tonemap + skybox) ──────────
    //
    // Tonemap (LDR S1): fullscreen triangle writes to swap-chain LDR view format
    // (parameterised — `ldrViewFormat`; see buildSpecConstTable jsdoc + bug-20260615).
    // Skybox (HDR S1 + S4): fullscreen triangle writes to rgba16float; MSAA variant
    // has sampleCount=4. Both use empty vertexLayout (fullscreen triangle, no
    // attributes) and cullMode='none' (forward cull for fullscreen-quad passthrough).
    //
    // Shadow-probe / fxaa / bloom 4-pass / SSAO 2-pass are lazy-build — not in
    // SPEC_CONST_TABLE (R-D4 decision: only passes that are always-present on
    // every boot).

    // tonemap LDR S1 (writes to runtime-resolved swap-chain LDR view format)
    {
      shader: { id: 'forgeax::post::tonemap', passKind: 'post-process', variantSet: undefined },
      attachments: {
        colorFormats: [ldrViewFormat],
        depthFormat: undefined,
        sampleCount: 1 as const,
      },
      geometry: {
        topology: 'triangle-list' as PrimitiveTopology,
        stripIndexFormat: undefined,
        vertexLayout: {},
      },
      renderState: {
        cullMode: 'none',
      },
    },

    // skybox HDR S1 (writes to rgba16float, no depth)
    {
      shader: { id: 'forgeax::skybox::cube', passKind: 'skybox', variantSet: undefined },
      attachments: {
        colorFormats: [HDR_FORMAT],
        depthFormat: undefined,
        sampleCount: 1 as const,
      },
      geometry: {
        topology: 'triangle-list' as PrimitiveTopology,
        stripIndexFormat: undefined,
        vertexLayout: {},
      },
      renderState: {
        cullMode: 'none',
      },
    },

    // skybox HDR S4 (MSAA variant)
    {
      shader: { id: 'forgeax::skybox::cube', passKind: 'skybox', variantSet: undefined },
      attachments: {
        colorFormats: [HDR_FORMAT],
        depthFormat: undefined,
        sampleCount: 4 as const,
      },
      geometry: {
        topology: 'triangle-list' as PrimitiveTopology,
        stripIndexFormat: undefined,
        vertexLayout: {},
      },
      renderState: {
        cullMode: 'none',
      },
    },
  ];
}

/**
 * Backward-compatible SPEC_CONST_TABLE — the table built with the default
 * LDR view format (`bgra8unorm-srgb`). Unit tests that exercise the
 * spec/cache-keying layer in isolation import this directly. Runtime
 * callers MUST call `buildSpecConstTable(swapChainFormats.view)` instead
 * so the pre-warmed PSO color format matches the actual RenderPass color
 * attachment on every backend (bug-20260615 fix-up).
 */
export const SPEC_CONST_TABLE: readonly Readonly<PipelineSpec>[] =
  buildSpecConstTable(DEFAULT_LDR_FORMAT);
