// pbr-pipeline.ts -- PBR / unlit pipeline-layout factories (M4 round-4 D-5).
//
// Anchors:
//   - plan-strategy D-5 (round-4 REVISED): the PBR pipeline keeps a 4-slot
//     pipeline layout `[view, material, mesh-array, instances]`. The
//     material BGL grows from 7 to 14 entries by appending the 7 Skylight
//     resources (binding 7..13) via `mergeSkylightIntoMaterialBgl`. The
//     unlit pipeline keeps its 7-entry material BGL (no Skylight binding
//     7..13 contamination) so unlit demos don't carry IBL state.
//   - charter P4: same pipeline layout shape drives Skylight present +
//     absent paths -- AI users do not branch on Skylight existence.
//   - feat-20260520-skylight-ibl-cubemap M4 / t59 (round-4): the
//     pipeline-layout construction migrates out of `createRenderer.ts`
//     into this dedicated module so M4 round-4 tests can mock the device
//     and inspect the captured descriptors without standing up the full
//     createRenderer + asset registry + manifest stack.
//
// The factory functions return both the captured handles AND the
// `bindGroupLayouts` array passed to `device.createPipelineLayout`. Callers
// (the createRenderer step that wires the standard + standard-HDR
// `RenderPipeline` instances) consume the result by name; tests inspect
// `device.createBindGroupLayout.mock.calls` to verify shape (t57).

import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayout,
  Buffer,
  PipelineLayout,
  Result,
  RhiError,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';

import { derive, type ParamSchemaEntry } from '@forgeax/engine-types';
import { buildBindGroupLayoutDescriptor, type PipelineSpec } from './pipeline-spec';

// Stub PipelineSpec used by the BGL-only call sites. The dispatcher only reads
// `spec.shader` when a registry is supplied for reflection; for caps-driven
// kinds (pbr-view / pbr-mesh-array / pbr-instances / pbr-skin-mesh-array) and
// for the no-registry material path the spec content is unused. A single
// frozen stub keeps the call sites readable and is allocation-free.
//
// D-13 round-2 dispatcher landing — see plan-decisions D-13.
const BGL_ONLY_SPEC_STUB: PipelineSpec = Object.freeze({
  shader: { id: '', passKind: 'forward', variantSet: undefined },
  attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
  geometry: { topology: 'triangle-list', vertexLayout: {} },
  renderState: undefined,
}) as PipelineSpec;

// WebGPU spec literal constants. The runtime never imports `GPUShaderStage`
// from `@webgpu/types` because the rhi shim accepts raw u32 bitmask values.
const GPU_SHADER_STAGE_VERTEX = 0x1;
const GPU_SHADER_STAGE_FRAGMENT = 0x2;

// ─── Device shim ────────────────────────────────────────────────────────────
//
// We accept the narrow structural subset of RhiDevice that the factory
// touches. Production callers pass the real RhiDevice; tests pass a
// vi.fn-based capture. The unwrap pattern matches createRenderer's
// `runShimSyncStep` -- the factory throws on Result.ok === false so the
// caller does not need to handle Result at every line.

export interface PbrPipelineDevice {
  createBindGroupLayout(desc: {
    label: string | undefined;
    entries: readonly GPUBindGroupLayoutEntry[];
  }): Result<BindGroupLayout, RhiError>;
  createPipelineLayout(desc: {
    label?: string;
    bindGroupLayouts: readonly BindGroupLayout[];
  }): Result<PipelineLayout, RhiError>;
}

// ─── Result shape ───────────────────────────────────────────────────────────

export interface PbrPipelineLayoutBundle {
  /** Pipeline layout passed to `createRenderPipeline({ layout })`. */
  readonly pipelineLayout: PipelineLayout;
  /** view BindGroupLayout (slot 0). */
  readonly viewBgl: BindGroupLayout;
  /**
   * PBR material BindGroupLayout (slot 1) -- 14 entries (material 0..6 +
   * Skylight 7..13 per D-5 round-4).
   */
  readonly materialBgl: BindGroupLayout;
  /** Per-entity mesh BindGroupLayout (slot 2). */
  readonly meshArrayBgl: BindGroupLayout;
  /** Per-instance storage BindGroupLayout (slot 3). */
  readonly instancesBgl: BindGroupLayout;
  /**
   * Same 4 layouts in slot order. Useful for assertion sites that check the
   * pipeline-layout `bindGroupLayouts` array shape (t57 (a) + (d)).
   */
  readonly bindGroupLayouts: readonly [
    BindGroupLayout,
    BindGroupLayout,
    BindGroupLayout,
    BindGroupLayout,
  ];
}

// ─── Base entries (round-4 SSOT) ────────────────────────────────────────────

/**
 * The built-in standard-PBR material paramSchema's texture/user-region shape,
 * used as the fallback when the material BGL is built without a registry
 * (the caps-driven `buildPbrPipelineLayouts` seam). Declares the 3 standard
 * user-region textures + a numeric UBO run; `derive()` collapses the numerics
 * into binding 0 and emits sampler/texture pairs at 1..6 — byte-equivalent to
 * the legacy fixed base-7. Kept here (not imported from the shader package) so
 * `buildPbrPipelineLayouts` has no shader-registry dependency.
 */
const DEFAULT_STANDARD_PBR_USER_REGION_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
];

/**
 * Build the PBR material BGL **user-region** from a paramSchema via the
 * `derive()` SSOT (D-1). The user-region is binding 0 (the run-merged material
 * UBO) followed by one sampler/texture pair per declared texture. Engine
 * injection (IBL + lightmap) is appended AFTER this region by the caller via
 * `appendInjection`, with start binding = `userRegion.length` — so a 4-texture
 * custom schema (e.g. parallax + heightTexture) shifts the injection region by
 * one sampler/texture pair automatically.
 *
 * The built-in `default-standard-pbr` paramSchema declares exactly 3 textures,
 * so this derives to binding 0 UBO + 3 pairs = 7 entries, byte-equivalent to
 * the legacy fixed base-7 (AC-06 bit-for-bit).
 *
 * One material-UBO convention is layered on top of the pure `derive()` output:
 * binding 0 is patched to `{ type: 'uniform', hasDynamicOffset: true }` with
 * `VERTEX | FRAGMENT` visibility. The material UBO is bound with a per-submesh
 * dynamic offset (`render-system-record.ts setBindGroup(1, bg, [offset])`) and
 * the vertex stage reads material params, so this is required for GPU
 * validation. `derive()` stays FRAGMENT-only / no-dynamic-offset for its other
 * consumers (it is the generic SSOT, not the material-UBO authority).
 *
 * @param paramSchema - the material shader's paramSchema (defaults to the
 *   built-in standard-PBR shape when omitted, for the caps-driven seam).
 */
export function buildPbrMaterialUserRegionEntries(
  paramSchema: readonly ParamSchemaEntry[] = DEFAULT_STANDARD_PBR_USER_REGION_SCHEMA,
): GPUBindGroupLayoutEntry[] {
  const derived = derive(paramSchema);
  // derive() returns the engine BindGroupLayoutEntry (exactOptionalPropertyTypes
  // makes its optional fields `T | undefined`, structurally distinct from the
  // DOM GPUBindGroupLayoutEntry surface). The two-step `as unknown as` is the
  // sanctioned known-unsafe opt-in (AC-08 gate (j) allows it; single-step
  // `as GPU...` is the forbidden shim-leak pattern).
  const entries = derived.bglEntries.map((e) => ({ ...e })) as unknown as GPUBindGroupLayoutEntry[];
  // Patch binding 0 (the material UBO) to the dynamic-offset, vertex-visible
  // material-UBO contract. derive() emits binding 0 as the first numeric run's
  // merged UBO; an empty schema has no binding-0 UBO and needs no patch.
  const ubo = entries[0];
  if (ubo !== undefined && ubo.binding === 0 && ubo.buffer !== undefined) {
    entries[0] = {
      binding: 0,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: 'uniform', hasDynamicOffset: true },
    };
  }
  return entries;
}

// ─── appendInjection — generic engine-injection BGL appender (M3 / w15) ──────
//
// Decision anchors (plan-strategy §2):
//   - D-6 appendInjection(bgl, kind) replaces the previous hardcoded
//        emissive/AO start-binding literal (=14). The starting binding
//        number is computed from `bgl.length`, byte-equivalent to
//        `derive(schema).userRegionBindingEnd` when `bgl` is the BGL list
//        derive returned for the user paramSchema.
//   - R-1 the 14-slot user-region assumption breaks once D-3 merges UBO;
//        appendInjection lets the material BGL grow / shrink without
//        churning every injection site.
//
// Closed union of injection kinds (plan-strategy §2 D-6):
//   - 'shadow'   reserved for future material-level shadow injection
//                (sampler_comparison + texture_depth_2d, 2 entries).
//                The active shadow bindings live in the view BGL today
//                (group(0) bindings 3..7); this kind is the seam for
//                any per-material shadow override surface a future feat
//                wires onto group(1).
//   - 'ibl'      the 7 IBL / Skylight entries (irradiance / prefilter
//                cube + brdfLut 2d + 3 samplers + intensity uniform).
//                Used by `buildPbrPipelineLayouts` after the user-region
//                user paramSchema entries are emitted.
//   - 'lightmap' the 4 emissive + occlusion entries (sampler + texture
//                pair x 2). The historical name is "emissive/AO"; we
//                keep that meaning under the generic 'lightmap' label
//                (per-surface secondary-lighting injection) so future
//                lightmap support lands without renaming the kind.
export type InjectionKind = 'shadow' | 'ibl' | 'lightmap';

const IBL_INJECTION_LENGTH = 7;
const LIGHTMAP_INJECTION_LENGTH = 4;
const SHADOW_INJECTION_LENGTH = 2;

/**
 * Append the engine-injection BGL entries for the given `kind` after the
 * user-region BGL entries, with binding numbers starting at `bgl.length`.
 *
 * The function reads `bgl.length` (NOT a hardcoded constant) so any
 * user-region size — derived from `derive(schema).userRegionBindingEnd` or
 * computed manually — flows through to the injection start binding without
 * a coupled edit.
 *
 * Returns ONLY the injected entries; the caller spreads them after `bgl`:
 *
 * ```ts
 * const merged = [...userBgl, ...appendInjection(userBgl, 'ibl')];
 * device.createBindGroupLayout({ entries: merged });
 * ```
 */
export function appendInjection(
  bgl: readonly GPUBindGroupLayoutEntry[],
  kind: InjectionKind,
): GPUBindGroupLayoutEntry[] {
  const start = bgl.length;
  switch (kind) {
    case 'ibl':
      return [
        // binding start+0: irradianceMap (texture_cube)
        {
          binding: start,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: 'cube' },
        },
        // binding start+1: irradianceSampler
        {
          binding: start + 1,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'filtering' },
        },
        // binding start+2: prefilterMap (texture_cube)
        {
          binding: start + 2,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: 'cube' },
        },
        // binding start+3: prefilterSampler
        {
          binding: start + 3,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'filtering' },
        },
        // binding start+4: brdfLut (texture_2d)
        {
          binding: start + 4,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        // binding start+5: brdfLutSampler
        {
          binding: start + 5,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'filtering' },
        },
        // binding start+6: uniform { intensity: f32 }
        {
          binding: start + 6,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ];
    case 'lightmap':
      return [
        // emissive sampler + texture pair
        {
          binding: start,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: start + 1,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        // occlusion sampler + texture pair
        {
          binding: start + 2,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: start + 3,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
      ];
    case 'shadow':
      return [
        {
          binding: start,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          sampler: { type: 'comparison' },
        },
        {
          binding: start + 1,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'depth', viewDimension: '2d' },
        },
      ];
  }
}

// Closed-set length sentinels — exported for test inspection.
export const INJECTION_KIND_LENGTHS: Readonly<Record<InjectionKind, number>> = {
  shadow: SHADOW_INJECTION_LENGTH,
  ibl: IBL_INJECTION_LENGTH,
  lightmap: LIGHTMAP_INJECTION_LENGTH,
};

/**
 * Caps shape consumed by the BGL factory functions for storage-buffer vs
 * uniform-buffer branching. Mirrors the two fields the engine reads from
 * `RhiCaps` (plan D-4 + D-5).
 */
export interface PbrCaps {
  readonly storageBuffer: boolean;
}

/**
 * The view BGL entry list. binding 0 = view UBO (vertex + fragment);
 * binding 1 = pointLights (storage or uniform, per caps);
 * binding 2 = spotLights (storage or uniform, per caps);
 * binding 3 = directional shadowMap atlas (texture_depth_2d, vertex+fragment).
 *   feat-20260613-csm-cascaded-shadow-maps: this is the CSM atlas — N
 *   cascades tiled into one 2D depth texture, sampled via per-cascade UV
 *   mapping in `lighting-directional.wgsl`. Single binding survives N=1..4
 *   (no array-layer form; cascades live in viewport offsets per the
 *   check-csm-unique-shadow-path grep gate).
 * binding 4 = shadow comparison sampler (shared by directional + point);
 * binding 5 = point shadow cube_array depth atlas (texture_depth_cube_array;
 *   fragment-only). feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1.
 * binding 6 = point shadow params UBO (`array<vec4<f32>, 4>`, 64 B;
 *   fragment-only). One lane per shadow-casting point light slot
 *   (shadowAtlasLayer in [0, 4)) carrying `(near, far, 1/(far-near), 0)`.
 * binding 7 = shadowCasterCascade UBO (16 B; vertex + fragment). Per-pass
 *   cascade-index uniform consumed exclusively by `shadow_caster.wgsl` to
 *   pick `view.lightViewProj_X` for the cascade currently being rasterized
 *   (feat-20260613-csm-cascaded-shadow-maps M5 / w28). Forward PBR shaders
 *   declare the binding via `common.wgsl` but do not reference it; WebGPU
 *   still requires a populated entry on every view BG so the host writes a
 *   stable singleton buffer.
 * binding 8 = spot shadow atlas (texture_depth_2d; fragment-only).
 *   feat-20260625-spot-light-shadow-mapping M3 / w14 (D-5). A single 2D depth
 *   texture holding up to 4 spot shadows in a 2x2 tile grid. ALWAYS-ON (no caps
 *   gate — `texture_depth_2d` is compat-safe everywhere), matching the
 *   unconditional `spotShadowMap` WGSL declaration in common.wgsl. Reuses the
 *   comparison sampler at binding 4 (no binding 9). Every view BG must populate
 *   binding 8 (real spotShadowDepth view when spot shadows run, else a 1x1
 *   fallback depth view cleared to fully-lit).
 *
 * Mirrors feat-20260519-light-casters M3 D-S1 layout +
 * feat-20260520-directional-light-shadow-mapping M2 / w14 (D-1) shadow
 * map binding +
 * feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1 BGL hookup
 * (always-on bindings 5/6 paired with the unconditional `POINT_SHADOW_AVAILABLE`
 * define registered in vite-plugin-shader) +
 * feat-20260613-csm-cascaded-shadow-maps M5 / w28 (binding 7 cascade UBO).
 * Isolated here so M4 round-4 tests can recreate the layout.
 *
 * feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w9:
 * caps.storageBuffer===false switches bindings 1+2 from
 * 'read-only-storage' to 'uniform'.
 */
export function buildPbrViewBglEntries(caps: PbrCaps): GPUBindGroupLayoutEntry[] {
  const lightBufType: GPUBufferBindingType = caps.storageBuffer ? 'read-only-storage' : 'uniform';
  return [
    {
      binding: 0,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: 'uniform' },
    },
    {
      binding: 1,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: lightBufType },
    },
    {
      binding: 2,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: lightBufType },
    },
    {
      binding: 3,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'depth', viewDimension: '2d' },
    },
    {
      binding: 4,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      sampler: { type: 'comparison' },
    },
    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: point shadow
    // cube_array depth atlas. Bound to either the real ShadowAtlas
    // cube_array view (when point shadows are active) or a 1x1x6 fallback
    // cube_array view cleared to 1.0 (fully lit). Visibility is FRAGMENT
    // only -- the directional binding 3 is VERTEX|FRAGMENT for shadow
    // probe-debug sampling, but the cube atlas has no host-side probe path.
    {
      binding: 5,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'depth', viewDimension: 'cube-array' },
    },
    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: point shadow
    // params UBO. Carries `array<vec4<f32>, 4>` = 64 B with one lane per
    // shadow-casting point light slot (shadowAtlasLayer in [0, 4)). Each
    // lane stores `(near, far, 1/(far-near), 0)` so the fragment-shader
    // depth-ref reconstruction (lighting-punctual.wgsl evalPointShadowed)
    // can avoid sampling LightSlot for the URP path. HDRP rides the same
    // constants on `LightSlot.kind_and_pad.zw` so binding 6 is unused on
    // HDRP shaders even though the BGL declares it (charter P4 single SSOT
    // BGL across pipelines; the HDRP variant simply doesn't reference the
    // binding in WGSL, which is allowed).
    {
      binding: 6,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: 'uniform' },
    },
    // feat-20260613-csm-cascaded-shadow-maps M5 / w28: shadowCasterCascade
    // UBO (16 B). Carries the 0-based cascade index of the shadow pass
    // currently being rasterized so `shadow_caster.wgsl` can index into
    // `view.lightViewProj_X` per cascade. Shifted from binding 5 to
    // binding 7 on 2026-06-13 to make room for point-shadow bindings 5/6
    // (they predate this feat in main; CSM's slot was the optimal-yield
    // give since point-shadow needs FRAGMENT-only and the cascade UBO
    // needs vertex-stage too — keeping cascade higher avoids interleaving
    // visibility flags within the contiguous shadow-binding cluster).
    {
      binding: 7,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: 'uniform' },
    },
    // feat-20260625-spot-light-shadow-mapping M3 / w14 (D-5): spot shadow
    // atlas. A single `texture_depth_2d` holding up to 4 spot shadows in a 2x2
    // tile grid (urp-pipeline.ts spotShadowDepth). FRAGMENT-only — the spot
    // shadow factor is reconstructed at fragment time via perspective-divide in
    // `evalSpotShadowed` (lighting-punctual.wgsl).
    //
    // ALWAYS-ON (no caps gate, unlike the point cube_array atlas at binding 5
    // which rides POINT_SHADOW_AVAILABLE): spot uses `texture_depth_2d` which is
    // compat-safe in every WebGPU profile, so the binding is unconditionally
    // declared. The matching WGSL declaration is `spotShadowMap` at @group(0)
    // binding 8 in common.wgsl (also unconditional) — the two must stay in
    // lock-step or WebGPU validation rejects the bind group at smoke time
    // (memory: BGL shape mismatch is a browser-path-only bug). No binding 9
    // sampler: spot reuses the comparison sampler at binding 4.
    // feat-20260625-spot-light-shadow-mapping M3 / w14 (D-5): spot shadow 2D
    // atlas, the LAST view-BG binding. The per-spot fragment-read perspective
    // lightViewProj matrices that w24 originally declared at a standalone
    // binding 9 uniform buffer were folded into the View UBO (binding 0,
    // `view.spotLightViewProj`) in w25 (scope-amend webkit-fallback): the
    // standalone binding pushed the WebGL2 fallback fragment uniform-buffer
    // count to 12, over GLES 3.0's `max_uniform_buffers_per_shader_stage = 11`,
    // crashing pipeline-layout creation on the compat path (this feat's target).
    {
      binding: 8,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'depth', viewDimension: '2d' },
    },
  ];
}

// ─── PBR pipeline layout factory ────────────────────────────────────────────

/**
 * Build the PBR pipeline layout under D-5 round-4: 4 slots `[view,
 * material, mesh-array, instances]`; the material BGL holds 18 entries
 * (material 0..6 + Skylight 7..13 + emissive/AO 14..17).
 *
 * `caps.storageBuffer===false` switches every storage-buffer BGL entry
 * (view bindings 1+2, mesh-array, instances) to `uniform`.
 *
 * Throws on any `createBindGroupLayout` / `createPipelineLayout` Result
 * failure -- the engine bootstrap path (createRenderer) wraps the call in
 * `runShimSyncStep` to fold the throw into the structured error pipe.
 */
export function buildPbrPipelineLayouts(
  device: PbrPipelineDevice,
  caps: PbrCaps,
): PbrPipelineLayoutBundle {
  // D-13 round-2: 4 BGLs route through buildBindGroupLayoutDescriptor.
  // The dispatcher reads kind + caps; spec content is unused without a
  // registry (no shader-axis reflection at this seam — the 4 BGLs are
  // caps-driven literals + the deterministic Skylight + lightmap merge
  // sequence that has no dependency on shader.id).
  const viewBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, { kind: 'pbr-view', caps }),
  );
  if (!viewBglRes.ok) throw viewBglRes.error;

  // material BGL (18 entries -- material 0..6 + Skylight 7..13 + emissive/AO 14..17).
  // feat-20260613 fix-issue-5: drop the buildPbrMaterialEmissiveAoEntries
  // shim. The lightmap injection start binding is computed from the post-
  // skylight BGL length (= 14) directly inside appendInjection.
  const materialBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, { kind: 'pbr-material-merged' }),
  );
  if (!materialBglRes.ok) throw materialBglRes.error;

  // mesh-array BGL.
  const meshArrayBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, { kind: 'pbr-mesh-array', caps }),
  );
  if (!meshArrayBglRes.ok) throw meshArrayBglRes.error;

  // instances BGL.
  const instancesBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, { kind: 'pbr-instances', caps }),
  );
  if (!instancesBglRes.ok) throw instancesBglRes.error;

  // Pipeline layout (4 slots).
  const layouts: readonly [BindGroupLayout, BindGroupLayout, BindGroupLayout, BindGroupLayout] = [
    viewBglRes.value,
    materialBglRes.value,
    meshArrayBglRes.value,
    instancesBglRes.value,
  ];
  const pipelineLayoutRes = device.createPipelineLayout({
    label: 'pbr-pl',
    bindGroupLayouts: layouts,
  });
  if (!pipelineLayoutRes.ok) throw pipelineLayoutRes.error;

  return {
    pipelineLayout: pipelineLayoutRes.value,
    viewBgl: viewBglRes.value,
    materialBgl: materialBglRes.value,
    meshArrayBgl: meshArrayBglRes.value,
    instancesBgl: instancesBglRes.value,
    bindGroupLayouts: layouts,
  };
}

// ─── PBR skin material-shader identifier (SSOT) ────────────────────────────

/**
 * SSOT for the skin material shader's registered identifier. The shader
 * package registers under this string (see register-default-standard-pbr-skin.ts
 * `RESERVED_ID`); runtime dispatch sites import this constant rather than
 * carrying a literal so a future rename is a one-line change. AC-09 grep
 * gate: the body of `selectPipelineLayoutForVariant` MUST NOT contain a
 * literal `'forgeax::pbr-skin'` -- callers map this constant to
 * `LayoutKind = 'pbr-skin'` upstream.
 */
export const SKIN_MATERIAL_SHADER_ID = 'forgeax::pbr-skin' as const;

// ─── PBR skin pipeline layout factory (bug-20260611) ───────────────────────
//
// The skin material shader (`forgeax::pbr-skin`, registered by
// `register-default-standard-pbr-skin.ts`) needs the same 4-slot layout shape
// as standard PBR EXCEPT for slot 2: its mesh-array BGL declares **2**
// dynamic-offset entries (binding 0 = meshes, binding 1 = palette) versus
// standard PBR's single binding 0. Without a dedicated pipeline layout the
// skin shader's `@group(2) @binding(1) palette : array<mat4x4<f32>>` reference
// trips a `Binding doesn't exist in [BindGroupLayoutInternal "pbr-mesh-array-bgl"]`
// validation error in `device.createRenderPipeline`, surfaced as
// `RhiError limit-exceeded` and an invalid command buffer (Playwright TDD trace
// captured 2026-06-11 in apps/hello/skin).
//
// The factory **reuses** view / material / instances BGL handles produced by
// `buildPbrPipelineLayouts` (charter P4: a single SSOT BGL for each slot the
// shapes actually share) and only creates a new mesh-array BGL + new pipeline
// layout. This keeps the per-binding-shape SSOT in one place and avoids an
// alternate skin-only material BGL (the skin shader's group(0) and group(1)
// are byte-for-byte the standard-PBR contract).

/**
 * Build the PBR skin pipeline layout (4 slots `[view, material,
 * mesh-array(2-entry), instances]`). View / material / instances BGLs are
 * shared with the standard-PBR layout (passed in via `pbr` bundle); the only
 * new BGL is the 2-entry mesh-array slot for `meshes` + `palette`.
 *
 * Throws on any `createBindGroupLayout` / `createPipelineLayout` Result
 * failure -- the engine bootstrap path wraps the call in `runShimSyncStep`
 * to fold the throw into the structured error pipe.
 */
export function buildPbrSkinLayouts(
  device: PbrPipelineDevice,
  caps: PbrCaps,
  pbr: PbrPipelineLayoutBundle,
): PbrPipelineLayoutBundle {
  // 2-entry mesh-array BGL: binding 0 meshes + binding 1 palette. Both
  // dynamic-offset (palette window per-entity, like meshes window).
  const skinMeshArrayBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, {
      kind: 'pbr-skin-mesh-array',
      caps,
    }),
  );
  if (!skinMeshArrayBglRes.ok) throw skinMeshArrayBglRes.error;

  const layouts: readonly [BindGroupLayout, BindGroupLayout, BindGroupLayout, BindGroupLayout] = [
    pbr.viewBgl,
    pbr.materialBgl,
    skinMeshArrayBglRes.value,
    pbr.instancesBgl,
  ];
  const pipelineLayoutRes = device.createPipelineLayout({
    label: 'pbr-skin-pl',
    bindGroupLayouts: layouts,
  });
  if (!pipelineLayoutRes.ok) throw pipelineLayoutRes.error;

  return {
    pipelineLayout: pipelineLayoutRes.value,
    viewBgl: pbr.viewBgl,
    materialBgl: pbr.materialBgl,
    meshArrayBgl: skinMeshArrayBglRes.value,
    instancesBgl: pbr.instancesBgl,
    bindGroupLayouts: layouts,
  };
}

// ─── Unlit material BGL factory ─────────────────────────────────────────────

/**
 * Build a stand-alone 7-entry unlit material BGL. Round-4 D-5 keeps unlit
 * material BG isolated from Skylight binding 7..13 -- unlit demos do not
 * pay for IBL state. The unlit pipeline still binds material at slot 1,
 * just with a 7-entry layout.
 *
 * Note: at the moment the runtime still routes both unlit + standard
 * through a single 14-entry pipeline layout; the unlit material BG
 * carries fallback identity resources at binding 7..13. This factory is
 * exported as a future-proof seam for the moment when unlit demos own
 * their own pipeline layout (t57 (e) test pins the contract today so the
 * eventual split has a green target).
 */
export function buildUnlitMaterialBgl(device: PbrPipelineDevice): BindGroupLayout {
  const res = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(BGL_ONLY_SPEC_STUB, { kind: 'unlit-material' }),
  );
  if (!res.ok) throw res.error;
  return res.value;
}

// ─── Material BG assembly helpers (unlit) ───────────────────────────────────

/**
 * Inputs for `buildUnlitMaterialBindGroupEntries`. The fields mirror the
 * record-stage's local variables; isolating the assembler here lets t58
 * (e) test exercise the contract without recreating the entire record
 * stage.
 */
export interface UnlitMaterialBindGroupEntryInputs {
  readonly materialUniform: Buffer;
  readonly materialOffset: number;
  readonly materialSize: number;
  readonly defaultSampler: Sampler;
  readonly baseColorView: TextureView;
  readonly defaultWhiteView: TextureView;
}

/**
 * Build the 7 BindGroupEntry values for the unlit material BG (binding
 * 0..6). Output flows into `device.createBindGroup({ layout:
 * unlitMaterialBgl, entries })`.
 */
export function buildUnlitMaterialBindGroupEntries(
  inputs: UnlitMaterialBindGroupEntryInputs,
): BindGroupEntry[] {
  return [
    {
      binding: 0,
      resource: {
        kind: 'buffer' as const,
        value: {
          buffer: inputs.materialUniform,
          offset: inputs.materialOffset,
          size: inputs.materialSize,
        },
      },
    },
    { binding: 1, resource: { kind: 'sampler' as const, value: inputs.defaultSampler } },
    { binding: 2, resource: { kind: 'textureView' as const, value: inputs.baseColorView } },
    { binding: 3, resource: { kind: 'sampler' as const, value: inputs.defaultSampler } },
    { binding: 4, resource: { kind: 'textureView' as const, value: inputs.defaultWhiteView } },
    { binding: 5, resource: { kind: 'sampler' as const, value: inputs.defaultSampler } },
    { binding: 6, resource: { kind: 'textureView' as const, value: inputs.defaultWhiteView } },
  ];
}

// Surface re-export so consumers can build a complete BindGroup pipeline
// without reaching into multiple modules.
export type { BindGroup };
