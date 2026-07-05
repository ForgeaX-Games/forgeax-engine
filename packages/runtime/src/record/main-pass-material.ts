// @forgeax/engine-runtime - RenderSystem record stage: main-pass-material.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  type BindGroup,
  type BindGroupEntry,
  err,
  ok,
  type RenderPipeline,
  type Result,
  RhiError,
} from '@forgeax/engine-rhi';
import type {
  Handle,
  MaterialRenderState,
  ParamSchemaEntry,
  PassKind,
  PrimitiveTopology,
  TextureAsset,
} from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { VideoUploadUnsupportedError } from '../errors/render';
import type { GpuResourceStore } from '../gpu-resource-store';
import {
  assembleMaterialWithSkylightEntries,
  type EmissiveAoBindGroupResources,
  type SkylightBindGroupResources,
} from '../ibl/skylight-bind-group';
import {
  type PipelineState,
  type RenderSystemRuntime,
  STANDARD_PBR_UBO_SIZE,
} from '../render-system';
import type { MaterialSnapshot } from '../render-system-extract';
import { resolveAssetHandle } from '../resolve-asset-handle';
import { VIDEO_ELEMENT_PROVIDER_KEY, type VideoElementProvider } from '../video-element-provider';
import type { BindGroupCounts } from './frame-snapshot';
import { extractEntryResourceHandle, getOrCreatePerEntity } from './mesh-ssbo';

// feat-20260601-customizable-render-pipeline-seam M2 / w12: the former
// `RecordPassContext` (26-field full surface, including the `internals` kitchen-sink and
// the 0-consumed `skyboxCount` residual) is DELETED. The per-frame shared state injected
// into the render-graph pass execute closures is now the clean `RenderPipelineContext`
// (defined in `render-pipeline-context.ts`): `internals` is gone (replaced by the named
// `assets` / `store` / `pipelineState` / `runtime` surfaces) so a pipeline author cannot
// reach the runtime kitchen-sink through the public ctx (AC-08). The graph is
// `RenderGraph<RenderPipelineContext>` so `execute(ctx)` forwards the object to each
// closure with no `as` assertion.
//
// Encoder ownership (RD-4): `ctx.encoder` is the SHARED frame encoder used by the main /
// tonemap / FXAA passes (finished + submitted once at frame end); the shadow pass opens
// its OWN encoder internally + submits independently (the runtime-side manual barrier for
// the depth write -> sample hazard).

// M1 / w7: ensureLazyTexture DELETED — GPU texture ownership moved to render-graph
// via addColorTarget + compile(device). The graph allocates transient/persistent
// render targets during the compile allocation phase; pass execute closures resolve
// TextureViews through resolve(name). PerPassResources texture slots still hold
// the last-used views for bindgroup-invalidation self-checks (D-3 physical texture
// identity), but the graph owns the create/destroy lifecycle.

/**
 * feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w9: pick the static
 * unlit geometry pipeline handle for a (tonemapActive x msaaActive)
 * combination. The four mode axes (LDR/HDR x single/MSAA) map to the 14 static
 * pipeline handles built in createRenderer (7 base + 7 count=4 variants). A
 * pipeline's `multisample.count` must match the colour-attachment sampleCount,
 * so the count=4 variant is required whenever the camera carries
 * `antialias === 'msaa'`. Returns null when the requested pipeline was not
 * built (empty-manifest path / MSAA variant build failure) -- the caller fires
 * a structured `shader-compile-failed` on the null-narrow.
 */
// feat-20260615-pipeline-spec-ssot M6-T1: the standard-shading fallback
// selector was deleted. The pre-M6 selector silently substituted the
// boot-time URP `pipelineState.standardPipeline*` whenever the per-
// MaterialShader cache returned null and HDRP was inactive -- masking
// real PipelineSpecError build failures behind a layout-compatible-but-
// wrong PSO. Charter P3 explicit-failure now governs: a missing cache
// entry surfaces as null, and the per-submesh
// `if (smPipelineHandle === null) continue` skip-draw (which already
// covered the HDRP-active and skin-shader miss-skip paths) is the single
// uniform recovery shape across URP / HDRP / skin.

export function selectGeometryPipeline(
  pipelineState: PipelineState,
  tonemapActive: boolean,
  msaaActive: boolean,
): RenderPipeline | null {
  if (tonemapActive) {
    return msaaActive ? pipelineState.unlitPipelineHdrMsaa : pipelineState.unlitPipelineHdr;
  }
  return msaaActive ? pipelineState.unlitPipelineMsaa : pipelineState.unlitPipeline;
}

/**
 * feat-city-glb Bug 5 (per-submesh transparency): true when EVERY submesh
 * material of the entity is transparent (blend). Used by the geometry pass to
 * decide whether to skip the whole entity (fully transparent → deferred to the
 * blend sub-pass) vs. draw its opaque submeshes and skip only the transparent
 * ones per-submesh.
 *
 * Falls back to the entity-level `material.transparent` when `materials` is
 * absent (single-material entities / test fixtures), byte-identical to the
 * pre-fix whole-entity gate.
 *
 * @internal
 */
export function isEntityFullyTransparent(source: {
  readonly material: MaterialSnapshot;
  readonly materials?: readonly MaterialSnapshot[];
}): boolean {
  const mats = source.materials;
  if (mats === undefined || mats.length === 0) return source.material.transparent === true;
  for (let j = 0; j < mats.length; j++) {
    if (mats[j]?.transparent !== true) return false;
  }
  return true;
}

/**
 * feat-city-glb Bug 5: true when the entity has at least one transparent AND at
 * least one opaque submesh — i.e. it must be drawn in BOTH the geometry pass
 * (opaque submeshes) and the blend sub-pass (transparent submeshes). A pure-
 * opaque or pure-transparent entity returns false (handled by the whole-entity
 * fast paths).
 *
 * @internal
 */
export function entityHasTransparentSubmesh(source: {
  readonly material: MaterialSnapshot;
  readonly materials?: readonly MaterialSnapshot[];
}): boolean {
  const mats = source.materials;
  if (mats === undefined) return source.material.transparent === true;
  for (let j = 0; j < mats.length; j++) {
    if (mats[j]?.transparent === true) return true;
  }
  return false;
}

/**
 * Selects the PSO for a transparent (or any generic materialShaderId) draw
 * via the runtime's per-MaterialShader pipeline cache. Returns a
 * structured RhiError on cache miss / pending build -- the caller MUST
 * surface this via the error registry rather than substituting a silent
 * fallback (charter P3 explicit failure).
 *
 * The `getMaterialShaderPipeline` argument mirrors
 * {@link RenderSystemRuntime.getMaterialShaderPipeline}'s 9-arg signature
 * but is injected so the helper is unit-testable with a plain
 * `() => null` stand-in. The helper threads only the inputs the caller
 * already has on the dispatch entry -- it never reads from
 * MaterialAsset internals (plan-strategy section 5.6 gate R-H).
 *
 * @internal
 */
export function selectMaterialPipelineForRender(args: {
  readonly materialShaderId: string;
  readonly isHdr: boolean;
  readonly renderState?: MaterialRenderState | undefined;
  readonly topology?: PrimitiveTopology | undefined;
  readonly indexFormat?: 'uint16' | 'uint32' | undefined;
  readonly variantSet?: string | undefined;
  readonly sampleCount?: number | undefined;
  readonly getMaterialShaderPipeline:
    | ((
        materialShaderId: string,
        isHdr: boolean,
        renderState?: MaterialRenderState,
        topology?: PrimitiveTopology,
        indexFormat?: 'uint16' | 'uint32',
        variantSet?: string,
        passKind?: PassKind,
        meshAttributes?: import('@forgeax/engine-types').VertexAttributeMap,
        sampleCount?: number,
      ) => RenderPipeline | null)
    | undefined;
}): Result<RenderPipeline, RhiError> {
  if (args.getMaterialShaderPipeline === undefined) {
    return err(
      new RhiError({
        code: 'internal-error',
        expected: `runtime.getMaterialShaderPipeline registered before draw of ${args.materialShaderId}`,
        hint: `material shader ${args.materialShaderId} has no resolver; the renderer was not initialised with a pipeline cache`,
      }),
    );
  }
  const pipeline = args.getMaterialShaderPipeline(
    args.materialShaderId,
    args.isHdr,
    args.renderState,
    args.topology,
    args.indexFormat,
    args.variantSet,
    undefined, // passKind defaults to 'forward'
    undefined, // meshAttributes -- transparent path uses the default vertex layout
    args.sampleCount,
  );
  if (pipeline === null) {
    return err(
      new RhiError({
        code: 'internal-error',
        expected: `pipeline cache hit for ${args.materialShaderId} (renderState=${args.renderState ? 'set' : 'unset'}, isHdr=${args.isHdr})`,
        hint: `material shader pipeline ${args.materialShaderId} missed the runtime cache; the underlying shader-module build may still be pending, or the id is not registered in ShaderRegistry`,
      }),
    );
  }
  return ok(pipeline);
}

// === end feat-20260625 M2 / w7 transparent-aware helpers ========================

/**
 * feat-20260601-gpu-resource-store-extraction M1 / D-9: resolve a texture's
 * GPU view through the pull-model residency store. The three steps replace the
 * pre-extraction single-call accessor on the registry:
 *   1. fetch the TextureAsset POD off the registry (CPU; registry keeps PODs)
 *   2. synchronously `ensureResident(handle, pod)` (first access builds the
 *      GPU texture + prewarmed mipmap blit; subsequent access is O(1))
 *   3. return the GPU view (or undefined on POD miss / ensureResident err)
 *
 * Returns `undefined` when the POD is absent (handle never registered) or the
 * upload fails (a structured error is fired). Callers then fall back to their
 * existing placeholder view, preserving the pre-extraction fallback semantics.
 */
// feat-20260601-gpu-resource-store-extraction M1 (D-1): builtin mesh handle
// ids 1-5 (CUBE/TRIANGLE/QUAD/SPHERE/NINESLICE_QUAD) are seeded + uploaded
// by createRenderer step-3 into `pipelineState.meshes`; they are not routed
// through the store's `ensureResident` pull path. Any handle id above this
// max is a user mesh. feat-20260527-sprite-nineslice M2 / w11: bumped to 5
// when HANDLE_NINESLICE_QUAD joined the builtin set.
export const BUILTIN_MESH_ID_MAX = 5;

// feat-20260527-sprite-nineslice M2 / w11 (D-2): raw u32 id of
// HANDLE_NINESLICE_QUAD used to look up the 16-vertex / 54-index mesh
// from `pipelineState.meshes` when a sprite material declares non-zero
// `slices`. Mirrors the literal in `asset-registry.ts:HANDLE_NINESLICE_QUAD`.
export const NINESLICE_QUAD_RAW_ID = 5;

export function residentTextureView(
  world: World,
  store: GpuResourceStore,
  runtime: RenderSystemRuntime,
  handle: Handle<'TextureAsset', 'shared'>,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture-view return
): any | undefined {
  const podRes = resolveAssetHandle<TextureAsset>(world, handle);
  if (!podRes.ok) return undefined;
  const residentRes = store.ensureResident(handle, podRes.value);
  if (!residentRes.ok) {
    // Only RhiError fans out to the onError channel (RhiError | RuntimeError);
    // a registered TextureAsset POD is format/colorSpace-consistent so the
    // ImageError consistency arm never fires here. Degrade to placeholder.
    if (residentRes.error instanceof RhiError) runtime.errorRegistry.fire(residentRes.error);
    return undefined;
  }
  return store.getTextureGpuView(handle);
}

// feat-20260623-world-space-video-asset M4 / w16 (D-3): resolve the
// current-frame GPU view for a video-sourced texture field through the
// transient DynamicTextureStore, NOT the static `residentTextureView` /
// `ensureResident` cache (video never enters that switch; AC-08).
//
// Per frame: ask the host-registered VideoElementProvider (World Resource,
// D-1) for this entity's HTMLVideoElement, upload its current frame via
// `store.uploadFrame` (copyExternalImageToTexture), and return the resulting
// view. When the provider is absent / returns no element / the element has no
// decodable dimensions yet, fall back to any previously-uploaded view and
// finally to `undefined` (caller binds the default view this frame — charter
// P3 graceful, no garbage sampling). A failed GPU upload fires the structured
// RhiError on the engine channel and degrades to the default view.
//
// `highPerfAvailable` is the w17 capability probe; the high-perf
// GPUExternalTexture branch is a reserved hook (OOS-5) — when it ever becomes
// available the upload would route there. Today it is always false so the
// general copyExternalImageToTexture path is the only one taken.
export function videoTextureView(
  world: World,
  store: import('../dynamic-texture-store').DynamicTextureStore | undefined,
  runtime: RenderSystemRuntime,
  entityKey: number,
  clip: Handle<'VideoAsset', 'shared'>,
  highPerfAvailable: boolean,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture-view return
): any | undefined {
  if (store === undefined) return undefined;
  const provider = world.hasResource(VIDEO_ELEMENT_PROVIDER_KEY)
    ? world.getResource<VideoElementProvider>(VIDEO_ELEMENT_PROVIDER_KEY)
    : undefined;
  const element = provider?.getElement(entityKey as unknown as EntityHandle, clip);
  // AC-10 double-miss: a VideoPlayer entity can reach NEITHER upload path this
  // frame — no host HTMLVideoElement (general copyExternalImageToTexture path)
  // AND no high-perf GPUExternalTexture path. This is the genuine "this backend
  // exposes no usable video upload path" case (no provider registered, or the
  // provider yields nothing while the high-perf reserved hook is unavailable —
  // OOS-5 keeps it always false today). Rather than silently binding the
  // default view, fire the structured VideoUploadUnsupportedError on the engine
  // error channel so an AI user can detect the dead path via `.code` / `.hint`
  // (charter P3; AC-10 signal lives on the REAL per-frame upload path, not an
  // orphan system). The default view is still bound this frame so the draw
  // does not crash (graceful degradation), but the failure is no longer silent.
  if (element === undefined && !highPerfAvailable) {
    runtime.errorRegistry.fire(new VideoUploadUnsupportedError());
    return store.getView(clip);
  }
  // D-2 / w17 high-perf reserved hook: a future GPUExternalTexture import path
  // would key off `highPerfAvailable` here. It is always false today
  // (importExternalTexture absent), so the general copyExternalImageToTexture
  // path below is the sole route end-to-end.
  if (element === undefined) return store.getView(clip);
  const width = element.videoWidth;
  const height = element.videoHeight;
  const uploaded = store.uploadFrame(clip, element, width, height);
  if (uploaded === undefined) return store.getView(clip);
  if (!uploaded.ok) {
    runtime.errorRegistry.fire(uploaded.error);
    return store.getView(clip);
  }
  return uploaded.value;
}

// feat-20260621-learn-render-5-5-parallax M2 / w8 (D-3): the built-in
// standard-PBR user-region texture field order, used when the shader is not
// resolvable through getParamSchema (cross-worktree late-register). Mirrors
// derive(default-standard-pbr).textureFieldNames.
export const BUILTIN_USER_REGION_TEXTURE_FIELDS: readonly string[] = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
];

/**
 * feat-20260621-learn-render-5-5-parallax M2 / w8 (D-3): ordered user-region
 * texture field names for a material's bind-group assembly, derived from the
 * shader's paramSchema via the `derive()` SSOT (insertion order = sampler/
 * texture pair order in derive().bglEntries). Falls back to the built-in 3
 * fields when the schema is unavailable.
 */
export function userRegionTextureFieldOrder(
  schema: Parameters<typeof derive>[0] | undefined,
): readonly string[] {
  if (schema === undefined) return BUILTIN_USER_REGION_TEXTURE_FIELDS;
  return [...derive(schema).textureFieldNames];
}

/**
 * feat-20260621-learn-render-5-5-parallax M2 / w8: the fallback texture view
 * for a user-region field when no handle is provided (graceful, charter P3).
 * normalTexture decodes to a flat tangent normal; everything else (baseColor,
 * MR, height, ...) uses the 1x1 white default (height white -> zero displacement).
 */
export function defaultViewForUserRegionField(
  field: string,
  pipelineState: PipelineState,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture-view
): any {
  if (field === 'normalTexture') return pipelineState.defaultNormalTextureView;
  if (field === 'baseColorTexture') return pipelineState.fallbackTextureView;
  return pipelineState.defaultWhiteTextureView;
}

/**
 * feat-20260527-sprite-nineslice M4 / w17 (AC-16): once-per-renderable
 * detection of "Transform.scale below the four 9-slice corner anchors". Pure
 * helper extracted out of recordFrame so unit tests can drive it without a
 * GPU device — the recordFrame loop calls this with its `transformWorld` /
 * `slices` / `renderableIndex` / `seenIndices` / `metrics` arguments.
 *
 * The scale-vs-anchor formula mirrors plan-strategy §D-3 — `scaleX` must
 * accommodate `|slices.x| + |slices.z|`, and `scaleY` must accommodate
 * `|slices.y| + |slices.w|`. Slices ≡ all zero is a no-op (legacy quad
 * path); a breach increments `nineslice.scale-too-small` exactly once per
 * `renderableIndex` per RenderSystem lifetime via the `seenIndices` Set
 * (the same warn-once anchor pattern used for missing-texture sprites).
 *
 * @param transformWorld The entity's resolved Transform.world mat4 (16 floats column-major).
 * @param slices         The four anchor distances `[left, top, right, bottom]`
 *                       (sentinel `bottom < 0` for tile mode is consumed via abs()).
 * @param renderableIndex The entity index into the validated renderables list.
 * @param seenIndices    The per-frame-state guard Set; entries are added on increment.
 * @param metrics        The per-Renderer EngineMetrics counter.
 * @internal — exported for unit-test access (w17).
 */
export function detectNineSliceScaleTooSmall(
  transformWorld: Float32Array,
  slices: readonly [number, number, number, number],
  renderableIndex: number,
  seenIndices: Set<number>,
  metrics: { increment(name: string): void },
): void {
  const anyNonZero = slices[0] !== 0 || slices[1] !== 0 || slices[2] !== 0 || slices[3] !== 0;
  if (!anyNonZero) return;
  const scaleX = Math.hypot(transformWorld[0] ?? 1, transformWorld[1] ?? 0, transformWorld[2] ?? 0);
  const scaleY = Math.hypot(transformWorld[4] ?? 0, transformWorld[5] ?? 1, transformWorld[6] ?? 0);
  const horizontalAnchor = Math.abs(slices[0]) + Math.abs(slices[2]);
  const verticalAnchor = Math.abs(slices[1]) + Math.abs(slices[3]);
  if (scaleX < horizontalAnchor || scaleY < verticalAnchor) {
    if (!seenIndices.has(renderableIndex)) {
      seenIndices.add(renderableIndex);
      metrics.increment('nineslice.scale-too-small');
    }
  }
}

/**
 * Build the 80-byte Material UBO payload for a PBR / unlit material entry
 * (feat-20260527-sprite-nineslice M2 / w11; D-7 regression-net helper).
 *
 * Byte-for-byte equivalent to the legacy hard-coded PBR write path; any
 * deviation is caught by `render-system-record-pbr-ubo-stable.test.ts`.
 * The schema-driven paramSnapshot overlay (feat-20260523 M9-T05; AC-14)
 * positions vec4 / f32 slots onto std140 [slot0 vec4, slot1 f32 metallic,
 * slot1 f32 roughness] mirroring the engine-shipped default-standard-pbr
 * Material struct.
 */
export function buildPbrMaterialUboPayload(material: MaterialSnapshot): ArrayBuffer {
  const buf = new ArrayBuffer(STANDARD_PBR_UBO_SIZE);
  const f32 = new Float32Array(buf);
  // Layout (issue-1: channelMap split per D-8) -- byte-equivalent to the
  // post-split sidecar paramSchema for default-standard-pbr (10 numeric
  // entries packed std140 into one merged UBO at binding(0)).
  //   f32[0..3]   baseColor          (offset 0,  vec4)
  //   f32[4]      metallic           (offset 16)
  //   f32[5]      roughness          (offset 20)
  //   f32[6]      metallicChannel    (offset 24)  -- glTF 2.0 default = B = 2
  //   f32[7]      roughnessChannel   (offset 28)  -- glTF 2.0 default = G = 1
  //   f32[8]      aoChannel          (offset 32)  -- glTF 2.0 default = R = 0
  //   f32[9]      extraChannel       (offset 36)  -- reserved = 0
  //                                  (offset 40..47 implicit pad: vec3 align=16)
  //   f32[12..14] emissive           (offset 48,  vec3)
  //   f32[15]     emissiveIntensity  (offset 60)
  //   f32[16]     occlusionStrength  (offset 64)
  //                                  (offset 68..79 trailing pad to 16 B align)
  // Total = 80 B, matches std140 derive(sidecar).uboLayout.totalBytes.
  f32[0] = material.baseColor[0] ?? 0;
  f32[1] = material.baseColor[1] ?? 0;
  f32[2] = material.baseColor[2] ?? 0;
  f32[3] = 1;
  f32[4] = material.metallic;
  f32[5] = material.roughness;
  // channelMap default = (B, G, R, _) per AGENTS.md + glTF 2.0
  // KHR_materials_pbrSpecularGlossiness ARM packing -- now 4 independent
  // f32 selectors; fragment casts each to u32 at the pick site.
  f32[6] = 2; // metallicChannel  <- B
  f32[7] = 1; // roughnessChannel <- G
  f32[8] = 0; // aoChannel        <- R
  f32[9] = 0; // extraChannel     <- reserved
  // emissive vec3 + emissiveIntensity (offset 48..63)
  const em = material.emissive;
  f32[12] = em?.[0] ?? 0;
  f32[13] = em?.[1] ?? 0;
  f32[14] = em?.[2] ?? 0;
  f32[15] = material.emissiveIntensity ?? 0;
  // occlusionStrength (offset 64)
  f32[16] = material.occlusionStrength ?? 1;
  // Schema-driven paramSnapshot overlay (feat-20260523 M9-T05, AC-14):
  // for user-shaders with a paramSnapshot, project the first vec4/color
  // entry onto slot 0 and the first two f32 entries onto slot 1's first
  // two floats. The default-standard-pbr path lands on the same offsets
  // via the explicit fields above, so the overlay is a no-op for the
  // engine's stock PBR shader (charter P4 + R-H regression fence).
  const paramSnap = material.paramSnapshot;
  if (paramSnap !== undefined) {
    const f32Snap = (name: string): number | undefined => {
      const v = paramSnap[name];
      return typeof v === 'number' ? v : undefined;
    };
    const colorSnap = (name: string): readonly number[] | undefined => {
      const v = paramSnap[name];
      return Array.isArray(v) && v.every((x) => typeof x === 'number')
        ? (v as readonly number[])
        : undefined;
    };
    // Walk schema in declared order, fill positional UBO slots.
    const materialShaderId = material.materialShaderId;
    // Note: schema lookup is the caller's job (it owns the runtime ref);
    // when the helper has no access to runtime, paramSnap is consumed
    // positionally without a schema walk. The inline caller (recordFrame)
    // still performs the schema-driven walk and writes the overlay before
    // queueing this payload, so this helper is only the byte-stable
    // baseline. To preserve byte-for-byte equivalence in the helper-only
    // unit-test path, the overlay pass is skipped when the helper is
    // called without an external schema reference.
    void materialShaderId;
    void f32Snap;
    void colorSnap;
  }
  return buf;
}

/**
 * Generic std140 UBO writer driven by `derive(paramSchema).uboLayout.entries`
 * (feat-20260625-refactor-sprite-as-transparent-mesh M1 / w3, plan-strategy
 * section 2 D-2).
 *
 * For each numeric entry in the schema, looks up the matching value in
 * `paramSnapshot` and writes it at the std140 offset `derive` computed.
 * Vec / color entries pull from `paramSnapshot[name]` as a `readonly number[]`
 * (writes `min(size/4, value.length)` floats, padding with 0 if shorter for
 * the field's declared width); scalar entries pull a single number.
 *
 * Behaviour:
 *   - schema or snapshot `undefined` -> no writes (caller may keep payload
 *     baseline).
 *   - missing snapshot field -> that field's bytes are left untouched
 *     (overlay semantics; same shape the legacy inline overlay had).
 *   - field type the writer cannot interpret (texture / sampler / storage_
 *     buffer / value-type mismatch) -> skipped silently; `derive` strips
 *     non-numeric entries from `uboLayout.entries` so the loop only iterates
 *     numeric fields.
 *
 * The writer reads `paramSnapshot` only -- it does NOT call
 * `runtime.assets.get<MaterialAsset>` or cast `firstMaterial`. Gate R-H
 * (plan-strategy section 5.6) bans those paths through
 * `scripts/forgeax/check-render-record-no-material-asset-get.mjs`.
 *
 * standard-pbr remains byte-identical to `buildPbrMaterialUboPayload`: the
 * engine's stock PBR material ships `paramSnapshot: undefined`, so this
 * writer is a no-op on that path; the explicit field writes in the helper
 * above cover every byte. User shaders (sprite-shaped 4 x vec4 or any other
 * paramSchema) get their fields written at the offsets declared by derive.
 *
 * @internal export-for-test (consumed inside `recordFrame` + render-system-
 * record.test.ts; not part of the package's public surface).
 */
export function applyParamSnapshotToUbo(
  payload: ArrayBuffer,
  paramSchema: readonly ParamSchemaEntry[] | undefined,
  paramSnapshot:
    | Readonly<Record<string, number | readonly number[] | string | undefined>>
    | undefined,
): void {
  if (paramSchema === undefined) return;
  if (paramSnapshot === undefined) return;
  const f32 = new Float32Array(payload);
  const { uboLayout } = derive(paramSchema);
  for (const entry of uboLayout.entries) {
    const value = paramSnapshot[entry.name];
    if (value === undefined) continue;
    const f32Offset = entry.offset / 4;
    const f32Width = entry.size / 4;
    if (typeof value === 'number') {
      // Scalar f32 / i32 / u32 -- single-slot write. (i32 / u32 still arrive
      // as a JS number; the GPU side reads the four bytes as the declared
      // type, so an f32 write is the correct bit pattern when the caller
      // already produced an integer value.)
      if (f32Width >= 1) f32[f32Offset] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const arr = value as readonly number[];
      const writeCount = Math.min(arr.length, f32Width);
      for (let i = 0; i < writeCount; i++) {
        const v = arr[i];
        if (typeof v === 'number') f32[f32Offset + i] = v;
      }
    }
    // string values (texture GUIDs) belong to texture bindings, not the
    // UBO; derive's uboLayout.entries already strips non-numeric schema
    // entries, so we will not see a uboLayout entry whose snapshot value
    // is a string under normal flow. Skip defensively if we do.
  }
}

/**
 * feat-20260704 M3/w19: shared per-submesh material bind-group assembly, hoisted
 * from the `buildPerSubmeshMaterialBg` closure inside recordMainPass so both the
 * geometry pass and the LDR blend sub-pass (extracted to separate functions)
 * call the identical layout.
 *
 * feat-city-glb Bug 5 (per-submesh transparency): a transparent PBR submesh
 * binds the identical metallic/roughness/normal/emissive/occlusion + uvSet +
 * Skylight layout the geometry pass uses (the sub-pass previously bound a
 * sprite-only BG, which cannot render a PBR decal). The per-frame closure state
 * (runtime / pipelineState / world / store / skylightResources / the shared
 * material BG cache + counters) is threaded through `deps`; the caller passes
 * the per-submesh material snapshot + entityKey (video texture routing) and sets
 * the dynamic UBO offset itself.
 *
 * @internal
 */
export interface PerSubmeshMaterialBgDeps {
  readonly runtime: RenderSystemRuntime;
  readonly pipelineState: PipelineState;
  readonly world: World;
  readonly store: GpuResourceStore;
  readonly materialSlice: number;
  readonly videoHighPerfAvailable: boolean;
  readonly skylightResources: SkylightBindGroupResources;
  readonly materialBgShared: Map<string, WeakMap<object, unknown>>;
  readonly bindGroupCounts: BindGroupCounts;
}

export function buildPerSubmeshMaterialBg(
  deps: PerSubmeshMaterialBgDeps,
  submeshMaterial: MaterialSnapshot,
  entityKey: number,
): BindGroup {
  const {
    runtime,
    pipelineState,
    world,
    store,
    materialSlice,
    videoHighPerfAvailable,
    skylightResources,
    materialBgShared,
    bindGroupCounts,
  } = deps;
  const smShaderId = submeshMaterial.materialShaderId;
  const smPerShaderBgl =
    smShaderId !== undefined ? runtime.getMaterialBindGroupLayout?.(smShaderId) : undefined;
  const smSchema = smShaderId !== undefined ? runtime.getParamSchema?.(smShaderId) : undefined;
  const smUserRegionFields = userRegionTextureFieldOrder(smSchema);
  const smBaseEntries: BindGroupEntry[] = [
    {
      binding: 0,
      resource: {
        kind: 'buffer' as const,
        value: {
          buffer: pipelineState.materialUniformBuffer.buffer,
          offset: 0,
          size: materialSlice,
        },
      },
    },
  ];
  const smBglPairCount =
    smPerShaderBgl !== undefined
      ? smUserRegionFields.length
      : BUILTIN_USER_REGION_TEXTURE_FIELDS.length;
  for (let fi = 0; fi < smBglPairCount; fi++) {
    const field = smUserRegionFields[fi];
    const samplerBinding = 1 + fi * 2;
    const textureBinding = samplerBinding + 1;
    let smView: unknown =
      field !== undefined
        ? defaultViewForUserRegionField(field, pipelineState)
        : pipelineState.defaultWhiteTextureView;
    const smVideoClip =
      field !== undefined ? submeshMaterial.videoTextureFields?.get(field) : undefined;
    if (smVideoClip !== undefined) {
      const view = videoTextureView(
        world,
        runtime.dynamicTextureStore,
        runtime,
        entityKey,
        smVideoClip,
        videoHighPerfAvailable,
      );
      if (view !== undefined) smView = view;
    } else {
      const smHandle = field !== undefined ? submeshMaterial.textureHandles?.get(field) : undefined;
      if (smHandle !== undefined) {
        const view = residentTextureView(world, store, runtime, smHandle);
        if (view !== undefined) smView = view;
      }
    }
    smBaseEntries.push(
      {
        binding: samplerBinding,
        resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
      },
      {
        binding: textureBinding,
        resource: { kind: 'textureView' as const, value: smView as never },
      },
    );
  }
  let smEmissiveView: unknown = pipelineState.defaultWhiteTextureView;
  const smEmissiveHandle = submeshMaterial.emissiveTexture;
  if (smEmissiveHandle !== undefined) {
    const view = residentTextureView(world, store, runtime, smEmissiveHandle);
    if (view !== undefined) smEmissiveView = view;
  }
  let smOcclusionView: unknown = pipelineState.defaultWhiteTextureView;
  const smOcclusionHandle = submeshMaterial.occlusionTexture;
  if (smOcclusionHandle !== undefined) {
    const view = residentTextureView(world, store, runtime, smOcclusionHandle);
    if (view !== undefined) smOcclusionView = view;
  }
  const smEmissiveAo: EmissiveAoBindGroupResources = {
    emissiveSampler: pipelineState.defaultSampler,
    emissiveView: smEmissiveView as never,
    occlusionSampler: pipelineState.defaultSampler,
    occlusionView: smOcclusionView as never,
  };
  const smMergedEntries = assembleMaterialWithSkylightEntries(
    smBaseEntries,
    skylightResources,
    smEmissiveAo,
  );
  const smMaterialBgl = smPerShaderBgl ?? pipelineState.materialBindGroupLayout;
  return getOrCreatePerEntity(
    materialBgShared,
    smShaderId ?? '',
    smMergedEntries.map((e) => extractEntryResourceHandle(e)),
    'material-shared',
    () => {
      const result = runtime.device.createBindGroup({
        label: 'pbr-material-skylight-bg',
        layout: smMaterialBgl,
        entries: smMergedEntries,
      });
      if (!result.ok) throw result.error;
      return result.value;
    },
    bindGroupCounts,
  );
}
