// @forgeax/engine-runtime - RenderSystem Extract stage (D-S2 + plan-strategy R-15
// fallback split). Pure ECS query phase: walks Camera / DirectionalLight /
// the merged-MeshRenderer renderable archetype and produces SoA-free snapshot
// arrays consumed by the Record stage.
//
// Carve-out from render-system.ts (review round 1 finding #3 - 505 line cap
// fallback split into 3 files; main + extract + record). Public API
// unchanged: AI users still import { RenderSystem } from '@forgeax/engine-runtime'.
//
// w15 (feat-20260511-asset-system-v1 M5 / plan-strategy D-P4) +
// feat-20260513-component-naming-bevy-align M3 / D-2 (merged) +
// feat-20260517-merge-mesh-renderer-material-renderer M2 / w5 (rename) +
// M3 / w9 (single-query convergence; this commit):
//   The previous 4-query alpha split (one full-archetype query gating on
//   Transform + MeshFilter + MeshRenderer without Instances; one direct
//   archetype-graph walk for the instanced variant; two fallback queries
//   on Transform+MeshFilter without MeshRenderer / MeshFilter without
//   Transform; one trailing dispatch query gating on MeshRenderer alone)
//   collapses into ONE archetype-graph walk gated on `MeshRenderer`
//   component presence (plan-strategy section 2.2 case A archetype-
//   natural-absence + section 3.2 sequence diagram "with: [MeshRenderer]
//   (sole)"). Inside the loop
//   the four D-Q7 dispositions land:
//     - case A (no MeshRenderer)  : not in domain; archetype absent. No
//                                   fire; no renderable; no dispatch.
//     - case B (material === 0)   : missing-spec sentinel; defaultMaterial
//                                   Snapshot fills the slot. No fire.
//     - case C (handle unresolved): assets.get(handle).err with the entity
//                                   carrying the full T+MF+MR renderable
//                                   archetype -> structured RhiError(
//                                   `asset-not-registered`) routed through
//                                   the World Layer-3 ErrorHandler + entity
//                                   skipped from RenderableSnapshot[] +
//                                   from MaterialDispatchSnapshot[]; with a
//                                   non-renderable archetype (MeshRenderer
//                                   only / lacking T or MF) the dangling
//                                   handle stays a silent skip (charter F1
//                                   surface minimization: AI users without
//                                   render intent should not see render
//                                   errors).
//     - resolved                  : populated MaterialSnapshot (5 fields)
//                                   + MaterialDispatchSnapshot dispatch
//                                   entry (regardless of T+MF presence,
//                                   preserving the dispatch-only counter
//                                   semantics).
//
// D-Q7 three-tier subtable (SSOT mirrored in `packages/runtime/README.md`
// §ECS render bridge D-Q7 `MeshRenderer` three-tier subtable +
// `components/mesh-renderer.ts` head JSDoc; AGENTS.md §Component naming
// + §Breaking changes 2026-05-17 row references this surface):
//   - case A archetype absent : silent skip; no onError; not in
//                               RenderableSnapshot[]; hint literal N/A
//                               (charter "ergonomic omission, not a
//                               misuse"; AC-09).
//   - case B missing-spec     : `material === undefined` ->
//                               `defaultMaterialSnapshot()` mid-grey
//                               unlit; no onError; entity present in
//                               RenderableSnapshot[] with default
//                               material; hint literal: `'pass
//                               undefined or omit field to request
//                               default material'` (AC-10).
//   - case C dangling-ref     : `assets.get(handle).err` (strict path,
//                               isRenderable === true) ->
//                               `RhiError({ code: 'asset-not-
//                               registered', detail: { assetHandle },
//                               hint: 'register material via
//                               assetRegistry.register(asset) before
//                               spawn, or remove the material field
//                               to fall back to default' })` routed
//                               through World Layer-3 ErrorHandler;
//                               entity skipped from
//                               RenderableSnapshot[] +
//                               MaterialDispatchSnapshot[]; mirrors
//                               `MeshFilter.assetHandle` dangling path
//                               (charter proposition 5; AC-11).
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15:
//   The legacy `Instances { buffer, count }` form (cross-coupled with the
//   deleted `AssetRegistry.createInstancedBuffer` triplet + the retired
//   `InstancedBufferAsset` POD) is gone. Per-entity instance transforms now
//   live inside the ECS `Instances { transforms: 'array<f32>' }` column;
//   extract materialises a `Float32Array` snapshot per Instances-bearing
//   entity (via `world.get(e, Instances).transforms`) so the record stage
//   can upload to a per-entity GPU storage buffer cached by entity packed
//   u32.
//
// feat-20260515-buffer-array-vocab-collapse M3 / w15: the component-level
// `arrayStride` hook on `Instances.transforms` was retired (decision section
// 2.3 stride responsibility migration -- AI users gate at the set / push
// call sites + RenderSystem extract entry holds a defensive fail-fast).
// The extract entry checks `transforms.length % 16 === 0` directly after
// the `world.get(entity, Instances)` snapshot is taken; violations route
// `InstanceTransformsStrideMismatchError`
// (`code: 'instance-transforms-stride-mismatch'`,
// `detail: { actualLength, expectedStride: 16 }`) through the World
// Layer-3 ErrorHandler and the renderable is skipped. The record stage
// trusts the invariant and does not re-check.

import type { Archetype, EntityHandle, ErrorContext, FieldView, World } from '@forgeax/engine-ecs';
import {
  createQueryState,
  Entity,
  InstanceTransformsStrideMismatchError,
  queryRun,
  Severity,
  SpriteInstancesCountMismatchError,
  SpriteInstancesMutuallyExclusiveWithInstancesError,
  SpriteInstancesRequiresSpriteShaderError,
} from '@forgeax/engine-ecs';
import { box3, frustum, type Mat4, mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import type {
  Asset,
  Handle,
  MaterialRenderState,
  MeshAsset,
  SkeletonAsset,
} from '@forgeax/engine-types';
import { ASSET_ERROR_HINTS, AssetError, toShared } from '@forgeax/engine-types';
import type { AssetRegistry } from './asset-registry';
import {
  Camera,
  DirectionalLight,
  Instances,
  Layer,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  PostProcessParams,
  Skin,
  SkyboxBackground,
  Skylight,
  SortKey,
  SpotLight,
  SpriteInstances,
  SpriteRegionOverride,
  Transform,
} from './components';
import {
  antialiasFromF32,
  bloomEnabledFromF32,
  cameraProjectionFromF32,
  tonemapFromF32,
  tonemapToU32,
} from './components/camera';
import { MaterialResolvedEmptyPassesError } from './errors/asset';
import { ShadowInvalidConfigError } from './errors/render';
import {
  JointCountMismatchError,
  JointEntityDanglingError,
  MaterialSkinAttrMissingError,
  SkeletonResolveFailedError,
  SkinInstancesCoexistForbiddenError,
  SkinMaterialMismatchError,
} from './errors/skin';
import { computeInvRangeSquared, degToCos } from './light-helpers';
import { resolveAssetHandle, walkMaterialPassesOverSharedRefs } from './resolve-asset-handle';
import { getActiveCamera, selectActiveCameraIndex } from './systems/active-camera';
import { selectPasses } from './systems/pass-selector';
import { propagateTransforms } from './systems/propagate-transforms';
import type { SkinPaletteAllocator } from './systems/skin-palette-allocator';
import { tilemapChunkExtractSystem } from './tilemap-chunk-extract-system';

export interface CameraSnapshot {
  /** World-space camera translation (mat4.getTranslation of Transform.world). */
  readonly position: Vec3;
  /**
   * Resolved world-space camera mat4 (column-major 16 floats), copied from the
   * entity's `Transform.world` view. The record stage derives the view matrix
   * as `mat4.invert(world)` (feat-20260601 D-3: read world mat4 -> invert; no
   * recompose from decomposed TRS).
   */
  readonly world: Float32Array;
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  /**
   * Camera projection variant (`'perspective'` | `'orthographic'`),
   * surfaced through the closed string-literal union narrowed from the
   * Camera schema's `projection` f32 discriminator. Drives the CSM
   * frustum-corner builder in render-system-extract: perspective uses
   * mat4.perspective(fov, aspect, ...); orthographic uses mat4.ortho
   * (left, right, bottom, top, ...). Without this discrimination an
   * orthographic camera (fov=0) would feed a degenerate matrix into
   * the CSM AABB-fit and the shadow atlas would never be written
   * (feat-20260613 M6 / w20 fix).
   */
  readonly projection: 'perspective' | 'orthographic';
  /** Orthographic left frustum plane (only consumed when projection === 'orthographic'). */
  readonly orthoLeft: number;
  /** Orthographic right frustum plane. */
  readonly orthoRight: number;
  /** Orthographic bottom frustum plane. */
  readonly orthoBottom: number;
  /** Orthographic top frustum plane. */
  readonly orthoTop: number;
  /**
   * feat-20260519-tonemap-reinhard-mvp / M3 / T-M3.1: tone-map mode
   * surfaced through the closed string-literal union (`tonemapFromF32`
   * narrows the schema's `f32` discriminator). The record stage branches
   * on this field to pick the geometry pipeline target format
   * (`bgra8unorm-srgb` for `'none'` / `'rgba16float'` for
   * `'reinhard-extended'`) and to decide whether to emit the post-process
   * tonemap fullscreen pass.
   */
  readonly tonemap: import('./components/camera').Tonemap;
  /** Linear pre-multiplier applied before the luminance compute (T-M3.3). */
  readonly exposure: number;
  /** Bright-end break point Lw for the extended Reinhard curve (T-M3.3). */
  readonly whitePoint: number;
  /**
   * feat-20260528-fxaa-post-processing / w3: anti-alias mode surfaced
   * through the closed string-literal union (antialiasFromF32 narrows
   * the schema's f32 discriminator). The record stage branches on this
   * field to decide whether to emit the FXAA post-process pass.
   */
  readonly antialias: import('./components/camera').Antialias;
  /**
   * feat-20260531-bloom-first-declarative-render-graph-pass / w4: bloom
   * enabled discriminator surfaced through the closed string-literal union
   * (bloomEnabledFromF32 narrows the schema's f32 discriminator). The record
   * stage branches on this field to decide whether to emit the bloom
   * post-process pipeline.
   */
  readonly bloom: import('./components/camera').BloomEnabled;
  /** HDR luminance threshold for bright-pass extraction (D-3 default 1.0). */
  readonly bloomThreshold: number;
  /** Multiplier applied to the blurred bloom contribution in composite (D-3 default 1.0). */
  readonly bloomIntensity: number;
  /** Gaussian blur kernel radius, clamped [1.0, 4.0] in shader (D-3 default 4.0). */
  readonly bloomBlurRadius: number;
  /**
   * feat-20260608-create-app-param-surface-trim / M1 / D-1 (q6-A):
   * clear-color quartet sourced from the Camera entity's SoA columns
   * (first-archetype-hit per OOS-2). Replaces the prior
   * `RendererOptions.clearColor` route that landed on
   * `RenderSystemInternals.clearColor`. AI users override per-camera by
   * setting `clearR/G/B/A` when spawning the Camera entity; default is
   * opaque black `[0, 0, 0, 1]` (D-8). The record stage reads these
   * values verbatim into the LoadOp::Clear color slot.
   */
  readonly clearR: number;
  readonly clearG: number;
  readonly clearB: number;
  readonly clearA: number;
}

/**
 * DirectionalLightSnapshot — sun-like infinite light variant of the
 * `LightSnapshot` discriminated union (M2 / w16 / AC-03). Host pre-multiplies
 * `color * intensity` so the shader sees the radiance term directly (charter
 * P4 host-side parity); `direction` stays in raw outgoing-vector form so the
 * shader can negate it once for BRDF (`let l = normalize(-light.direction)`).
 *
 * Plan-strategy D-S1 (3) (LightSnapshot to GPU buffer bucket 1:1 mapping).
 */
export interface DirectionalLightSnapshot {
  readonly kind: 'directional';
  readonly direction: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
}

/**
 * PointLightSnapshot — omnidirectional point variant. `position` from the
 * companion Transform; `invRangeSquared = 1 / range^2` host-folded via
 * `computeInvRangeSquared` (range = +Infinity -> 0; range = 0 -> 1e8 NaN
 * protection per D-S5).
 */
export interface PointLightSnapshot {
  readonly kind: 'point';
  readonly position: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
  readonly invRangeSquared: number;
  /**
   * feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-8 + M4 / T-M4-4:
   * cube_array atlas layer index for this light's shadow map (0..3 for shadow
   * casters; sentinel `-1` for non-shadow lights). Default `-1` per
   * plan-strategy §D-2 — record stage / shader skips shadow sampling when the
   * lane equals the sentinel. Joined with `pointShadow[]` by entity at the
   * end of extract; HDRP record stage threads `shadowAtlasLayer + shadowNear +
   * shadowFar` through `packLightSlot` as the §D-8 pad-lane payload.
   */
  readonly shadowAtlasLayer?: number;
  /**
   * Per-face perspective near plane (matches `PointLightShadow.nearPlane`).
   * Used by HDRP `evalPointShadowed` for depth-ref reconstruction; rides
   * `LightSlot.kind_and_pad.z` (byte 56..60) on the std430 std layout.
   */
  readonly shadowNear?: number;
  /**
   * Per-face perspective far plane (matches `PointLightShadow.farPlane`).
   * Rides `LightSlot.kind_and_pad.w` (byte 60..64).
   */
  readonly shadowFar?: number;
}

/**
 * PointShadowSnapshot — extract-stage view of one shadow-casting point light
 * (feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-7).
 *
 * `entity` is the spawning entity (joins PointLight + PointLightShadow on the
 * same archetype); `position` is the light world-space position resolved from
 * the companion Transform (mirrors PointLightSnapshot.position).
 * `shadowMatrices` is the 96-float packed mat4[6] table (column-major,
 * 6 mat4 * 16 floats = 384 bytes) ready for UBO upload.
 *
 * Plan-strategy §D-3: the record stage allocates a dynamic-offset uniform
 * buffer (384 B per-light, aligned to minUniformBufferOffsetAlignment, WebGPU
 * min 256 -> 512 B stride). Extract owns the host-side `Float32Array(96)`;
 * record owns the GPU `RhiBuffer` lifetime.
 *
 * `mapSize` / `nearPlane` / `farPlane` ride here so record stage can size the
 * cube atlas faces and feed shader the proj constants without re-querying ECS.
 * `shadowAtlasLayer` is assigned by extract in spawn order (0 .. cap-1) so the
 * downstream LightSlot / packPointLight packers carry the layer index in
 * pointPadW (T-M1-8 will rename to shadowAtlasLayer).
 */
export interface PointShadowSnapshot {
  /** Spawning entity index (joins PointLight + PointLightShadow + Transform). */
  readonly entity: number;
  /** World-space light position (sourced from companion Transform). */
  readonly position: Vec3;
  /** PointLightShadow.mapSize (per-face cube square dimension; 512 default). */
  readonly mapSize: number;
  readonly nearPlane: number;
  readonly farPlane: number;
  /**
   * Atlas layer assigned by extract in spawn order (0..cap-1, where cap=4
   * matches PointLightShadow cardinality). Sentinel -1 is reserved by the
   * shader-side LightSlot for no-shadow lights (T-M1-8).
   */
  readonly shadowAtlasLayer: number;
  /**
   * 6 view-proj mat4 in face order [+X, -X, +Y, -Y, +Z, -Z] packed into one
   * Float32Array(96). 16 floats per face = 64 B; 6 * 64 = 384 B raw. The
   * record stage pads each slot to 512 B (256 alignment) when packing into
   * the per-light dynamic-offset UBO (plan-strategy §D-3).
   */
  readonly shadowMatrices: Float32Array;
}

/**
 * SpotLightSnapshot — cone-restricted variant. `position` from companion
 * Transform; `direction` raw outgoing-vector; `cosInner` / `cosOuter` host
 * pre-converted via `degToCos` so the shader sees only cosines (D-S2).
 *
 * feat-20260625-spot-light-shadow-mapping M1 w5: added shadow fields.
 * castShadow (bool) gates shadow projection; lightViewProj is the perspective
 * light-view-projection matrix computed in extract (undefined when castShadow
 * is false, dir degenerates, or the light is clipped). shadowAtlasTile
 * (i32 sentinel -1) is the allocated tile index 0..3 or -1 for unassigned
 * (plan-strategy D-4). mapSize / nearPlane / farPlane are the source
 * component shadow parameters carried through to the record stage.
 */
export interface SpotLightSnapshot {
  readonly kind: 'spot';
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
  readonly invRangeSquared: number;
  readonly cosInner: number;
  readonly cosOuter: number;
  // ── shadow fields (feat-20260625-spot-light-shadow-mapping M1) ──
  readonly castShadow: boolean;
  readonly lightViewProj: Float32Array | undefined;
  readonly mapSize: number;
  readonly nearPlane: number;
  readonly farPlane: number;
  readonly shadowAtlasTile: number;
}

/**
 * LightSnapshot — discriminated union of the three KHR_lights_punctual
 * variants. AI users + the record stage perform an exhaustive switch on
 * `kind`; missing arms are caught at compile time (no `default`,
 * `assertNever`-style guards). Plan-strategy R-10.
 */
export type LightSnapshot = DirectionalLightSnapshot | PointLightSnapshot | SpotLightSnapshot;

/**
 * ExtractedLights — three-bucket output of the extractFrame three-query
 * union (M2 / w16 / AC-03). Plan-strategy section 3.1 EXT node:
 *   - `directional` — at most one (record-stage N>1 fail-fast lands in M3)
 *   - `point[]` — first-slice cap of 4 enforced at record stage (M3)
 *   - `spot[]`  — first-slice cap of 4 enforced at record stage (M3)
 * `directionalCount` exposes the raw count of DirectionalLight entities the
 * extract observed (so the record stage can fire `render-system-multi-light`
 * when N>1 without re-running the query). M3 / w19 will widen this with
 * pointCount / spotCount fields once the matching record-time fail-fast
 * lands; for M2 the field stays directional-only to keep AC-06 (a) intact.
 */
export interface ExtractedLights {
  readonly directional: DirectionalLightSnapshot | undefined;
  readonly directionalCount: number;
  readonly point: readonly PointLightSnapshot[];
  readonly spot: readonly SpotLightSnapshot[];
  /**
   * feat-20260613-csm-cascaded-shadow-maps M2 / w9: per-cascade light-view-
   * projection matrices (one per cascade, length 4 pre-allocated). Each matrix
   * is a column-major 16-float mat4 with atlas tile UV inset baked in
   * (plan-strategy D-3). cascadeCount < 4: unused slots are zero matrices.
   * Undefined when castShadow=false or no directional light.
   */
  readonly lightViewProj: readonly Float32Array[] | undefined;
  /**
   * feat-20260613-csm-cascaded-shadow-maps M2 / w9: view-space z depths
   * of the PSSM split planes (length 4, Float32Array). cascadeCount < 4:
   * unused slots are 0.0f. Undefined when castShadow=false or no directional
   * light.
   */
  readonly splitPlanes: Float32Array | undefined;
  /**
   * feat-20260613-csm-cascaded-shadow-maps M2 / w9: effective cascade count
   * from the DirectionalLight component (1..4). Undefined when castShadow=false
   * or no directional light.
   */
  readonly cascadeCount: number | undefined;
  /**
   * feat-20260613-csm-cascaded-shadow-maps M2 / w9: cascade blend width
   * from the DirectionalLight component (0..0.5). Undefined when castShadow=false
   * or no directional light.
   */
  readonly cascadeBlend: number | undefined;
  /**
   * feat-20260520-directional-light-shadow-mapping M1c / w8:
   * shadowMapSize from DirectionalLight.mapSize. Drives shadow RT
   * lazy-allocate (idempotency: same size -> no rebuild). Undefined when
   * castShadow=false or no directional light.
   */
  readonly shadowMapSize: number | undefined;
  /**
   * feat-20260621-merge-directionallightshadow-into-directionallight M2:
   * depthBias from the merged DirectionalLight (constant shadow-bias floor).
   * Populated when castShadow=true on the first-hit directional light;
   * undefined otherwise.
   */
  readonly depthBias: number | undefined;
  /**
   * feat-20260621-merge-directionallightshadow-into-directionallight M2:
   * normalBias from the merged DirectionalLight (slope-based shadow-bias
   * coefficient).
   * Populated when castShadow=true on the first-hit directional light;
   * undefined otherwise.
   */
  readonly normalBias: number | undefined;
  /**
   * feat-20260621-merge-directionallightshadow-into-directionallight M2:
   * pcfKernelSize from the merged DirectionalLight (PCF kernel width, odd>=1).
   * Populated when castShadow=true on the first-hit directional light;
   * undefined otherwise.
   */
  readonly pcfKernelSize: number | undefined;
  /**
   * feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-7:
   * shadow-casting point lights (PointLight + PointLightShadow + Transform
   * archetype join). Each entry carries the per-light 6-face VP matrices and
   * the assigned cube_array atlas layer (0..3 in spawn order; sentinel -1 is
   * reserved by the shader-side LightSlot for no-shadow point lights).
   *
   * Empty array when no PointLightShadow components exist (zero-cost gate per
   * AC-09; record stage skips atlas allocation + shadow pass dispatch).
   */
  readonly pointShadow: readonly PointShadowSnapshot[];
}

/**
 * SkylightSnapshot -- extract-stage view of one Skylight entity
 * (feat-20260520-skylight-ibl-cubemap M4 / t26).
 *
 * `equirectHandle` carries the packed u32 handle for
 * `Handle<EquirectAsset, 'shared'>`; the record stage drives the internal
 * lazy cubemap projection from it and resolves the projected GPU cubemap via
 * `GpuResourceStore.getCubemapGpuView(...)` and related helpers
 * (feat-20260630 M3 / w16-w18). The snapshot carries NO projection status
 * field: the status truth lives in the store's CubemapGpuEntry (D-3 SSOT);
 * record queries it once per frame.
 *
 * `intensity` defaults to 1.0 via the Skylight component token defaults
 * (plan-strategy D-6: Skylight data flows through existing extract->record
 * pipeline; no independent ECS system).
 */
export interface SkylightSnapshot {
  // 0 = no equirect supplied -> solid-color ambient via the white fallback
  // cube (record falls to fallback resources when no IBL views are cached).
  readonly equirectHandle: number;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  // feat-20260630 M3 / w19: the WINNING Skylight entity's packed handle (first
  // archetype hit). Carried so the multi-Skylight once-warn can name which
  // entity is used and which is ignored (F-8: warn carries conflicting entity
  // info). 0 only if the bundle had no live entity (never happens for a hit).
  readonly entityHandle: number;
}

/**
 * SkyboxSnapshot -- extract-stage view of one SkyboxBackground entity
 * (feat-20260531-skybox-env-background M2 / w5).
 *
 * `equirectHandle` carries the packed u32 handle for
 * `Handle<EquirectAsset, 'shared'>`; the record stage resolves the projected
 * GPU cubemap via `GpuResourceStore.getCubemapGpuView(...)`.
 *
 * `mode` carries the raw `f32` column value (`SKYBOX_MODE_CUBEMAP = 0`).
 * First hit wins per plan-strategy D-6; multi-entity once-warn in record stage.
 */
export interface SkyboxSnapshot {
  readonly equirectHandle: number;
  readonly mode: number;
  // feat-20260630 M3 / w19: the WINNING SkyboxBackground entity's packed handle
  // (first archetype hit), so the multi-SkyboxBackground once-warn can name the
  // used entity (F-8 parity with the Skylight warn).
  readonly entityHandle: number;
}

export interface RenderableSnapshot {
  readonly assetHandle: number;
  readonly transform: TransformSnapshot;
  /**
   * feat-20260608 M5 amend / w11-a: the entity's representative (first)
   * material snapshot, kept as a same-name shorthand for `materials[0]`.
   * Per-entity dispatch (shading model routing, sprite-vs-mesh split, the
   * D-1/D-3 pipeline-tag pick) is uniform across the entity's submeshes
   * today, so the existing 20+ `entry.source.material.X` consumers in the
   * record stage stay unchanged. Per-submesh material data (baseColor /
   * UBO payload / paramSnapshot) lives in `materials[i]`.
   */
  readonly material: MaterialSnapshot;
  /**
   * feat-20260608 M5 amend / w11-a: per-submesh MaterialSnapshot[]
   * positionally aligned with `MeshAsset.submeshes[]` (plan §3.2 sequence
   * step 6 + AC-08). Length always equals the entity's submesh count once
   * the extract stage's count-mismatch validator (M2 / w12) has filtered
   * misaligned spawns. The record stage reads `materials[i]` to upload the
   * i-th material UBO slot before drawing the i-th submesh.
   *
   * Backward-compat: `materials[0] === material` (the legacy mid-grey
   * default-material case-B path also routes through `materials = [default]`,
   * keeping the legacy single-mesh-no-material spawn shape working without
   * a special branch in record).
   */
  readonly materials: readonly MaterialSnapshot[];
  /**
   * feat-20260708-composited-multi-world-rendering M1 / D-1: the worldId
   * of the world this renderable was extracted from. Defaults to 0 in
   * single-world path (extractFrame always assigns 0). The merge layer
   * (extractFrames in M2) stamps the correct worldId per world before
   * the record stage consumes it. Combined with `entityKey` via
   * `worldEntityKey(worldId, entityKey)` to form per-entity cache keys.
   *
   * Never rewrite `entityKey` itself — consumers that need the real
   * entity handle (video provider, etc.) read the bare `entityKey`.
   */
  readonly worldId: number;
  /**
   * feat-20260531-per-frame-bind-group-cache M1 / w3: packed Entity u32
   * (encodeEntity(indexSlot, generation)) surface'd from the extract
   * stage. Stable per-entity identity for the record stage cache keys
   * (material / instances / per-frame clean-up) without re-querying the
   * World (charter P5 Pipeline Isolation: record stage only consumes
   * snapshot POD). Reuses the encodeEntity calculation already performed
   * at :1293 for the Instances path, and now also computed for plain
   * (non-Instances) renderables.
   *
   * Never rewrite this field — cache keys use `worldEntityKey(worldId, entityKey)`,
   * not the bare entityKey alone (D-1).
   */
  readonly entityKey: number;
  /**
   * feat-20260514 M3 (w15): when the entity carries an `Instances` component
   * the extract stage materialises a fresh `Float32Array` snapshot of the
   * packed mat4 transforms (16 f32 per instance, stride 16) plus a stable
   * `cacheKey` (the entity's packed u32) and the `archVersion` (used by the
   * record stage to invalidate its per-entity GPU buffer cache when the
   * archetype storage grew). Absent (`undefined`) means the record stage
   * falls back to the shared 1-element identity-mat4 storage buffer +
   * `drawIndexed(.., 1, ..)`.
   */
  readonly instances?: InstancesSnapshot;
  /**
   * feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w10
   * (plan-strategy D-1 + D-9): when the entity carries a `SpriteInstances`
   * component the extract stage materialises a paired snapshot — packed mat4
   * `transforms` (16 f32, stride 16) + per-instance UV `regions` (4 f32,
   * stride 4) — plus the same cache fingerprint pair (`cacheKey` = entity
   * packed u32, `archVersion` = archetype version stamp at snapshot time).
   * The record stage interleaves the two arrays into an 80B-per-instance
   * single GPU buffer routed through `@group(3) @binding(0)` (BGL unchanged,
   * D-1). Absent (`undefined`) means the entity is not a `SpriteInstances`
   * carrier; the record stage falls back to its existing sprite path
   * (material UBO region + identity-instance buffer).
   *
   * Three structured `EcsError` codes fire at extract entry and skip the
   * renderable on violation (charter P3 explicit failure):
   *   - `'sprite-instances-mutually-exclusive-with-instances'`
   *   - `'sprite-instances-requires-sprite-shading-model'`
   *   - `'sprite-instances-count-mismatch'`
   */
  readonly spriteInstances?: SpriteInstancesSnapshot;
  /**
   * feat-20260523-skin-skeleton-animation M2 / T-21: when the entity carries
   * a `Skin` component the extract stage populates this field with the
   * skin palette slice metadata. The record stage uses this to route the
   * draw to `forgeax::pbr-skin` pipeline + set the palette dynamic offset.
   * Absent (`undefined`) means the entity is not skinned.
   */
  readonly skin?: SkinPaletteSlice;
}

/**
 * feat-20260523-skin-skeleton-animation M2 / T-21 + T-24:
 * per-draw palette slice metadata. Joint count + byte offset into the
 * shared skin palette storage buffer.
 *
 * plan-strategy D-10: SkinPaletteSlice naming mirroring Bevy SkinByteOffset
 * but with forgeax vocabulary (byteOffset not offset, jointCount not joint_count).
 */
export interface SkinPaletteSlice {
  readonly jointCount: number;
  /**
   * Byte offset INTO `buffer` for this slice. On the storage path the
   * allocator returns one shared buffer + a per-entity cursor offset; on
   * the uniform fallback path each slice owns its own GPU buffer (cap
   * `maxUniformBufferBindingSize` 16 KiB cannot host shared dynOffset
   * windows for >1 entity), so `byteOffset === 0` for every slice and
   * `buffer` is the per-slice handle. Record stage reads both fields and
   * does not branch on the path -- BG cache key includes `buffer`, so
   * two paths converge at the same code.
   */
  readonly byteOffset: number;
  /**
   * Per-slice GPU buffer handle. M6: feat-20260612 collapsed the prior
   * shared-buffer assumption (record-stage read `pipelineState
   * .skinPaletteAllocator.buffer`) into a per-slice carrier so the
   * uniform fallback path can return a per-entity buffer without
   * branching the record stage.
   */
  readonly buffer: import('@forgeax/engine-rhi').Buffer;
}

export interface InstancesSnapshot {
  /** Packed column-major mat4 transforms (16 f32 per instance). */
  readonly transforms: Float32Array;
  /** Number of instances (transforms.length / 16). */
  readonly instanceCount: number;
  /** Stable per-entity GPU buffer cache key (the packed Entity u32). */
  readonly cacheKey: number;
  /**
   * Archetype version stamp at snapshot time. The record stage compares this
   * against its cached version per cacheKey; a bump means the underlying
   * BufferPool slot may have grown / been reallocated, forcing a fresh
   * `device.createBuffer + queue.writeBuffer` round.
   */
  readonly archVersion: number;
}

/**
 * feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w10:
 * extract-stage view of a `SpriteInstances` carrier (2D peer of
 * `InstancesSnapshot`).
 *
 * Field shapes mirror `InstancesSnapshot` so the record-stage cache protocol
 * (`(cacheKey, archVersion, byteLength)` fingerprint triple) is reused
 * verbatim. The byte length consumed at upload time is the sum
 * `transforms.byteLength + regions.byteLength` (= 80*N for N instances,
 * plan-strategy D-1 interleaved single-buffer); the record stage builds the
 * 80B/instance interleaved buffer once per (entity, archVersion, byteLength)
 * fingerprint change.
 */
export interface SpriteInstancesSnapshot {
  /** Packed column-major mat4 transforms (16 f32 per instance, stride 16). */
  readonly transforms: Float32Array;
  /** Per-instance UV vec4 regions (4 f32 per instance, stride 4). */
  readonly regions: Float32Array;
  /**
   * Number of instances. Derived from `transforms.length / 16` (equivalently
   * `regions.length / 4`); the extract-entry validator guarantees the two
   * derivations agree, otherwise it fires
   * `'sprite-instances-count-mismatch'` and skips the renderable.
   */
  readonly instanceCount: number;
  /** Stable per-entity GPU buffer cache key (the packed Entity u32, D-9). */
  readonly cacheKey: number;
  /** Archetype version stamp at snapshot time (cache invalidation fingerprint). */
  readonly archVersion: number;
}

/**
 * TransformSnapshot: extract-stage view of one entity's resolved world
 * transform (feat-20260601 D-3). Holds the single `world` mat4 (column-major
 * 16 floats, copied from the entity's `Transform.world` view written by
 * propagateTransforms). The record stage copies these 16 floats straight into
 * the mesh SSBO slot (zero `mat4.compose`); position / scale consumers derive
 * from the mat4 via `mat4.getTranslation` / basis-column lengths.
 */
export interface TransformSnapshot {
  readonly world: Float32Array;
}

/**
 * MaterialSnapshot: extract-stage view of one entity's material asset (M2 / w6
 * of feat-20260517-merge-mesh-renderer-material-renderer; plan-strategy section 2.3).
 *
 * Adds optional `baseColorTexture` + `sampler` slots (consumed by the record
 * stage's textured-material code path; M3 / w10 dropped the cast-over-firstMaterial
 * pattern in favour of direct snapshot field reads).
 *
 * feat-20260522-learn-render-3-1-sponza-model-loading-with-multi-l M4 extends
 * the snapshot with `metallicRoughnessTexture` and `normalTexture`
 * so the record stage can wire PBR texture bindings 4 and 6
 * from real GPU views instead of placeholder 1x1 white / flat-normal views.
 *
 * Bounded scope: the snapshot tracks only what the record stage actually
 * consumes today (charter proposition 5 consistent abstraction; YAGNI for
 * future-proof field bloat). Future MaterialAsset extensions (emissive / etc)
 * drive snapshot extensions when the record stage starts consuming them, not
 * vice-versa.
 *
 * tweak-20260701 M1: `shadingModel` field removed — shader identity via
 * {@link materialShaderId} is the single source of truth for material dispatch.
 */
export interface MaterialSnapshot {
  readonly baseColor: Vec3;
  readonly metallic: number;
  readonly roughness: number;
  /**
   * Schema-driven material shader identifier (feat-20260523 M4-T05).
   * Populated when the material asset uses the schema-driven path
   * (payload.materialShader set). Undefined for unlit/sprite legacy
   * materials and for case-B defaultMaterialSnapshot.
   *
   * The record stage uses this as the pipeline cache key first-level
   * discriminator (M4-T06).
   */
  readonly materialShaderId?: string | undefined;
  /**
   * Schema-driven parameter snapshot (feat-20260523 M4-T05).
   * Populated alongside materialShaderId. Maps param name to its
   * runtime-resolved value: number for scalar params, number[] for
   * vec/color params, string (GUID) for texture2d/sampler params.
   */
  readonly paramSnapshot?: Readonly<Record<string, number | number[] | string>> | undefined;
  /**
   * User-region texture handles keyed by paramSchema field name
   * (feat-20260621-learn-render-5-5-parallax M2 / w7). The SSOT carrier for
   * EVERY texture the shader's `derive(paramSchema).textureFieldNames`
   * declares — `baseColorTexture` / `metallicRoughnessTexture` /
   * `normalTexture` for built-in standard-PBR, plus any custom field such as
   * `heightTexture` (LO 5.5 parallax). The record stage iterates this map to
   * assemble the user-region bind group per the per-shader BGL (w8), so a 4th
   * (or Nth) texture flows end-to-end without a hardcoded field list.
   *
   * Populated by iterating `textureFieldNames`; absent keys mean the
   * paramValue was missing / mis-typed (record falls back to default white).
   * `emissiveTexture` / `occlusionTexture` are NOT here — they live in the
   * engine-injection lightmap region (their named fields below feed
   * `appendInjection('lightmap')`, not the user-region).
   */
  readonly textureHandles?: ReadonlyMap<string, Handle<'TextureAsset', 'shared'>> | undefined;
  /**
   * User-region texture field names whose paramValue resolved to a VideoAsset
   * (kind `'video'`) rather than a static TextureAsset
   * (feat-20260623-world-space-video-asset M4 / w14, D-5). The video GUID
   * occupies the same texture2d paramValues slot a static texture would (P4:
   * one binding shape), but extract routes it here instead of `textureHandles`
   * so the record stage pulls the current-frame view from the transient
   * DynamicTextureStore (D-3) instead of `GpuResourceStore.ensureResident`
   * (which has no `video` arm; AC-08). Each entry also carries the resolved
   * clip handle so the record stage can key the per-frame upload.
   *
   * Producer/consumer split (charter P5 / AC-07 gate): extract owns the
   * asset->snapshot translation; record consumes this POD field only — it never
   * reaches back into the MaterialAsset to learn a field is video-sourced.
   */
  readonly videoTextureFields?: ReadonlyMap<string, Handle<'VideoAsset', 'shared'>> | undefined;
  readonly baseColorTexture?: Handle<'TextureAsset', 'shared'> | undefined;
  readonly sampler?: Handle<'SamplerAsset', 'shared'> | undefined;
  /**
   * PBR metallic-roughness texture handle (present for PBR/sprite/skin
   * shaders). Undefined for the default-unlit shader
   * (materialShaderId === 'forgeax::default-unlit'). The record stage reads
   * this to write GPU view at material bind-group binding 4, falling
   * back to a 1x1 white placeholder when undefined.
   *
   * feat-20260522-learn-render-3-1-sponza-model-loading-with-multi-l M4:
   * field added so the record stage can wire real metallic-roughness
   * textures from Sponza glTF materials (M3 writes the handle into
   * SchemaDrivenMaterialAsset paramValues; M4 extract carries it through to the snapshot).
   */
  readonly metallicRoughnessTexture?: Handle<'TextureAsset', 'shared'> | undefined;
  /**
   * PBR tangent-space normal texture handle (present for PBR/sprite/skin
   * shaders). Undefined for the default-unlit shader
   * (materialShaderId === 'forgeax::default-unlit'). The record stage reads
   * this to write GPU view at material bind-group binding 6, falling
   * back to a (0.5,0.5,1.0) flat-normal placeholder when undefined.
   *
   * feat-20260522-learn-render-3-1-sponza-model-loading-with-multi-l M4:
   * field added symmetrically with metallicRoughnessTexture so the record
   * stage can wire real normal textures from Sponza glTF materials.
   */
  readonly normalTexture?: Handle<'TextureAsset', 'shared'> | undefined;
  readonly emissive?: readonly [number, number, number] | undefined;
  readonly emissiveIntensity?: number | undefined;
  readonly emissiveTexture?: Handle<'TextureAsset', 'shared'> | undefined;
  readonly occlusionTexture?: Handle<'TextureAsset', 'shared'> | undefined;
  readonly occlusionStrength?: number | undefined;
  /**
   * Transparent composition flag derived from the first pass's
   * `renderState.blend` presence on the underlying
   * {@link MaterialPassDescriptor} (feat-20260626-collapse M2: blend
   * presence is the SSOT after `MaterialPassDescriptor.transparent` was
   * dropped in M1).
   *
   * The record stage reads this to drive both the LDR split-pass
   * decision and the premultiplied-alpha blend resolution on the
   * generic materialShaderId pipeline path — shader-agnostic, decoupled
   * from the legacy `shadingModel` discriminant (feat-20260625 M2 D-3,
   * finalised in w15; `shadingModel` field removed in tweak-20260701 M1).
   *
   * Extract derives this from the first pass's `renderState.blend !==
   * undefined` (post-feat-20260626-collapse: blend presence is the
   * single SSOT for "this material is transparent on the geometry
   * pipeline cache key"). Multi-pass materials whose mix of opaque +
   * transparent passes need finer routing should split into separate
   * MaterialAsset entries (the normal forgeax pattern).
   *
   * Type is `boolean | undefined` (derived): `undefined` means "no
   * passes / unknown"; consumers must read `=== true` / `!== true` to
   * stay correct under both populated and absent cases.
   */
  readonly transparent?: boolean | undefined;
}

// === DispatchEntry — M3 / w26 single dispatch list (feat-20260526-material-asset-multipass-renderstate) ===
//
// Plan-strategy D-3: single dispatch list sorted by queue value,
// replacing the old three-bucket opaque/transparent/overlay dispatch.
// Each entry carries the per-pass render-state, defines, and entry-point
// data from the resolved MaterialPassDescriptor so the record stage
// reads them without re-resolving the material.

export interface DispatchEntry {
  readonly entityIndex: number;
  readonly materialHandle: number;
  readonly renderableIndex: number;
  readonly passIndex: number;
  readonly queue: number;
  /**
   * Signed i32 from the entity's {@link Layer} component value (default 0 for
   * entities without a Layer). Primary sort key for the transparent-dispatch
   * sort in {@link render-system.ts}: lower value = drawn first (behind).
   */
  readonly layer: number;
  readonly tags: Record<string, string>;
  readonly renderState: MaterialRenderState | undefined;
  readonly defines: Record<string, string> | undefined;
  readonly vertexEntry: string | undefined;
  readonly fragmentEntry: string | undefined;
  readonly materialShaderId: string | undefined;
  readonly paramSnapshot: Readonly<Record<string, number | number[] | string>> | undefined;
  /**
   * Stencil reference value from {@link MaterialPassDescriptor.stencilReference}
   * (draw-call dynamic state). Folded during extract for per-draw consumption
   * in the record stage. `undefined` when the pass does not set a reference
   * value (record stage falls back to WebGPU default 0).
   */
  readonly stencilReference?: number;
}

/**
 * Stable-sort dispatch entries by `queue` value ascending.
 * Returns a new sorted array (does not mutate the input).
 * Same-queue entries preserve insertion order (AC-11 stable-order guarantee).
 */
export function sortDispatchByQueue<E extends { readonly queue: number }>(
  entries: readonly E[],
): E[] {
  // Array.prototype.sort is stable per ES2019 spec (V8 7.0+ / Node 12+).
  return entries.slice().sort((a, b) => a.queue - b.queue);
}

export interface ExtractedFrame {
  readonly cameras: CameraSnapshot[];
  readonly lights: ExtractedLights;
  readonly renderables: RenderableSnapshot[];
  /**
   * Single dispatch list sorted by queue value (ascending, stable sort).
   * Replaces the old opaqueDispatch / transparentDispatch / overlayDispatch
   * three-bucket model per plan-strategy D-3.
   */
  readonly dispatch: DispatchEntry[];
  readonly skylight: SkylightSnapshot | undefined;
  readonly skylightCount: number;
  readonly skybox: SkyboxSnapshot | undefined;
  readonly skyboxCount: number;
  /**
   * feat-20260528-frustum-culling M3 / w11: frustum culling statistics
   * collected during the extract phase. `total` is the count of entities
   * that reached the culling decision point; `culled` is the count of
   * those that were removed from renderables by frustum culling.
   */
  readonly frustumStats: { readonly culled: number; readonly total: number };
  /**
   * Per-frame post-process params snapshot collected from PostProcessParams
   * entities (D-1: data-driven params channel). Maps shader id to the
   * raw data bytes (Uint8Array = FieldValueType<'buffer'>). Last-one-wins
   * when multiple entities bear the same shader id.
   * Empty map when no PostProcessParams entities exist.
   */
  readonly postProcessParams: ReadonlyMap<string, Uint8Array>;
}

/**
 * Transparent-bucket dispatch entry — extends the dispatch snapshot with
 * per-entity sort inputs precomputed at extract time.
 *
 * Field semantics:
 *   - `layer` — primary sort key (signed i32 from `Layer.value`; default 0
 *     for entities without a Layer component).
 *   - `posX` / `posY` / `posZ` — world position from the entity's Transform.
 *   - `pivotY` / `sizeY` — sprite's Y-axis foot offset inputs. `pivotY =
 *     SpriteMaterialAsset.pivot[1]` (default 0.5); `sizeY` = Transform's
 *     world scale Y (sprite quad's world-space height in unit-quad world
 *     space — `HANDLE_QUAD` is 1x1 so `Transform.scaleY` directly maps to
 *     world height). The foot-Y formula `posY - pivotY * sizeY` is the
 *     SSOT for the JRPG Y-sort path (mode=1, requirements §AC-10).
 *   - `sortKey` — optional per-entity override from `SortKey.value`. When
 *     present, `transparentSortEntries` uses it INSTEAD of the mode formula
 *     for this entry (still gated by `layer` as the primary key).
 *
 * Plan-strategy §3.3 interface example + §AC-10 sort path + §AC-19
 * derivation row 13 (this is the true new POD shape `@new-surface`; not a
 * mere rename of an existing snapshot).
 */
export interface TransparentEntry {
  readonly entityIndex: number;
  readonly materialHandle: number;
  readonly layer: number;
  readonly posX: number;
  readonly posY: number;
  readonly posZ: number;
  readonly pivotY: number;
  readonly sizeY: number;
  // `number | undefined` rather than the strict `?: number` form so AI
  // users that construct TransparentEntry literals with
  // `sortKey: maybeUndefined` (the typical SoA projection pattern) do
  // not trip `exactOptionalPropertyTypes: true` (the engine's tsconfig
  // base). Absent === undefined consumer semantics are identical; the
  // sort helper checks `e.sortKey !== undefined` either way.
  readonly sortKey?: number | undefined;
  /**
   * Index into the parallel `ExtractedFrame.renderables[]` array. M-3 /
   * w25 record stage uses this to look up the `RenderableSnapshot`
   * (Transform + mesh + material snapshot) belonging to this transparent
   * entry after `transparentSortEntries` reorders the bucket. Optional
   * for test fixtures that construct TransparentEntry literals by hand
   * (w16 sort tests bypass renderables[] correlation); the real extract
   * path always sets a non-negative integer index here.
   */
  readonly renderableIndex?: number | undefined;
}

/**
 * Internal world surface used by extract for archetype-graph traversal and
 * error routing. The packed `Entity` handle for a row is read directly from
 * the essential id=0 `Entity` column (`arch.columns.get(Entity.id).get('self')`)
 * -- no generation lookup / encodeEntity rebuild (feat-20260602 M2).
 */
type WorldInternalView = World & {
  _routeError(err: Error, ctx: ErrorContext): void;
  /**
   * @internal Column-level zero-copy view of an `array<T, N>` / `buffer<N>` field.
   * Returns a `FieldView` (a TypedArray) aliasing the inline stride-N column bytes;
   * used here to read the resolved `Transform.world` mat4 (a `Float32Array` in
   * practice, feat-20260602 inline columns) without a `world.get` `{}`
   * materialization. The generic `FieldView` return reflects that the column may
   * back any element type; `new Float32Array(view)` below copies the world mat4
   * out of whichever TypedArray backs it.
   */
  _getArrayView(
    entity: EntityHandle,
    component: typeof Transform,
    fieldName: string,
  ): FieldView | undefined;
  /**
   * @internal Archetype graph access. tweak-20260611 M1: retained for one
   * narrow purpose -- looking up the live `arch.version` for a queryRun
   * callback's archetype (used as the cache key in
   * `RenderableSnapshot.instances.archVersion`; the bundle does not surface
   * this number). All four archetype-walk segments otherwise route through
   * `createQueryState + queryRun`.
   */
  _getGraph: () => { readonly archetypes: ReadonlyArray<Archetype | undefined> };
};

/**
 * The user-region texture fields the built-in standard-PBR material declares.
 * Used as the fallback texture-field set when the shader id is not registered
 * (cross-worktree shader-late-register, plan R-4) so a built-in material still
 * resolves its 3 textures. Mirrors `derive(default-standard-pbr).textureFieldNames`.
 */
const BUILTIN_USER_REGION_TEXTURE_FIELDS: readonly string[] = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
];

/**
 * tweak-20260627-model-loading-smoke-build-perf M4: per-World intern cache for
 * the loadByGuid texture/sampler resolution path. A MaterialAsset's
 * texture/sampler paramValues remain embedded GUID strings (dash-form) after
 * loadByGuid; the extract stage re-resolves each GUID to a column handle every
 * frame. Before this cache each resolution called `world.allocSharedRef`, which
 * mints a NEW monotonically-increasing slot id per call. Because the GPU
 * residency cache (`GpuResourceStore.textureGpuHandles`) is keyed on
 * `handleSlot(handle)`, a fresh slot every frame meant the residency check
 * ALWAYS missed -> all textures re-uploaded to the GPU every frame, old GPU
 * textures never freed (refcount never hits 0). Unbounded GPU memory +
 * unbounded per-frame upload cost (628ms -> 2764ms over 12 frames, SIGKILL).
 *
 * The fix interns the GUID-string -> column-handle resolution: each unique
 * `(guid, brand)` pair mints EXACTLY ONE stable shared handle per World, reused
 * across frames (architecture-principle §6 idempotency: same GUID resolved N
 * times yields the same handle). The handle is intentionally long-lived -- it
 * lives as long as the World references the material, which is exactly the
 * desired lifetime; the `onLastRelease` -> `gpuStore.evictTexture` wiring stays
 * coherent because the handle is no longer churned per frame.
 *
 * Invariant boundary (asset-registry.ts:1958-1962): the AssetRegistry is a
 * GUID -> payload catalogue with NO handle/World concept -- it cannot mint a
 * column handle. So this intern cache lives in the extract/render layer, keyed
 * per-World via a WeakMap (the World owns the SharedRefStore that mints slots).
 *
 * Inner key is `${lowercasedGuid} ${brand}` -- a GUID catalogues to a
 * single asset kind in practice, but the brand keeps the key correct if the
 * same GUID is ever resolved under two brands.
 *
 * Boundary (OOS): this cache is NOT invalidated by `AssetRegistry.invalidate`
 * / `invalidateAll`. After re-cataloguing a GUID with new bytes the extract
 * would return the stale interned handle, so live texture hot-reload does not
 * reach the GPU through this path. `invalidate` already disclaims GPU coherence
 * (OOS-1); a future hot-reload feature should drop the per-world entry (or
 * stamp a generation) on invalidate. Static scenes (the only current consumer)
 * are unaffected.
 */
const guidHandleInternByWorld = new WeakMap<World, Map<string, number>>();

function internSharedRefFromGuid<B extends string>(
  world: World,
  assetsRef: AssetRegistry,
  guid: string,
  brand: B,
  onLastRelease?: (handle: Handle<B, 'shared'>) => void,
): Handle<B, 'shared'> | undefined {
  let perWorld = guidHandleInternByWorld.get(world);
  if (perWorld === undefined) {
    perWorld = new Map<string, number>();
    guidHandleInternByWorld.set(world, perWorld);
  }
  const key = `${guid.toLowerCase()} ${brand}`;
  const cached = perWorld.get(key);
  if (cached !== undefined) return cached as unknown as Handle<B, 'shared'>;
  const payload = assetsRef.lookup(guid);
  if (payload === undefined) return undefined;
  // Mint exactly once per (world, guid, brand). The onLastRelease deleter is
  // wired against this same long-lived handle; since the handle is interned it
  // is reused every frame and evicted only when the World drops it.
  let handle: Handle<B, 'shared'> = -1 as unknown as Handle<B, 'shared'>;
  handle = world.allocSharedRef(brand, payload, () => {
    if (onLastRelease !== undefined) onLastRelease(handle);
  });
  perWorld.set(key, handle as unknown as number);
  return handle;
}

/**
 * feat-20260623-world-space-video-asset M4 / w14 (D-5): if a user-region
 * texture field's paramValue is an embedded GUID string that catalogues to a
 * VideoAsset (`kind === 'video'`), mint a `VideoAsset`-branded column handle for
 * it and return that handle; otherwise return undefined (the field is a static
 * texture / sampler / scalar and flows through the normal TextureAsset path).
 *
 * The video GUID occupies the same texture2d paramValues slot a static texture
 * would (P4: identical binding shape) — extract just routes it to a different
 * GPU lifecycle (the transient DynamicTextureStore, D-3) instead of the static
 * `ensureResident` cache, whose switch has no `video` arm (AC-08). Minting a
 * brand-`VideoAsset` handle keeps the snapshot self-describing: the record stage
 * sees a video handle and resolves the per-frame view without reaching back into
 * the asset (charter P5).
 *
 * A `number` paramValue (already a minted column handle) is not a GUID string so
 * it cannot be a freshly-catalogued video; it passes through as undefined here.
 */
function resolveVideoFieldHandle(
  value: unknown,
  world: World,
  assetsRef: AssetRegistry,
): Handle<'VideoAsset', 'shared'> | undefined {
  if (typeof value !== 'string') return undefined;
  const payload = assetsRef.lookup(value);
  if (payload === undefined || payload.kind !== 'video') return undefined;
  // M4: intern so a video GUID mints one stable VideoAsset handle per World
  // instead of a fresh slot every frame. The transient per-frame view is
  // resolved downstream by this handle (DynamicTextureStore); minting the
  // handle once does not freeze the view (P5: handle != frame data).
  return internSharedRefFromGuid(world, assetsRef, value, 'VideoAsset');
}

/**
 * feat-20260621-learn-render-5-5-parallax M2 / w7 (D-3): collect the
 * user-region texture handles for a material by iterating the shader's
 * `derive(paramSchema).textureFieldNames` SSOT (via
 * `AssetRegistry.materialShaderTextureFieldNames`). Each declared texture
 * field whose paramValue resolves to a handle lands in the returned map keyed
 * by field name; this is the single path through which any number of user-region
 * textures (3 standard or 4+ custom, e.g. parallax `heightTexture`) flow.
 *
 * When the shader is not registered the built-in 3-field set is used so
 * standard materials still resolve. `emissiveTexture` / `occlusionTexture`
 * are engine-injection (lightmap) textures and are NOT part of this set.
 *
 * feat-20260623-world-space-video-asset M4 / w14 (D-5): a field whose paramValue
 * catalogues to a VideoAsset is routed into `videoOut` (a VideoAsset-branded
 * handle) instead of the TextureAsset map, so the record stage pulls its view
 * from the transient DynamicTextureStore (D-3) rather than the static
 * ensureResident cache (AC-08). The video GUID still has to be in this
 * `textureFieldNames` traversal set or it is never inspected (R-7) — that
 * membership is asserted in w13.
 */
function collectUserRegionTextureHandles(
  pv: Readonly<Record<string, number | number[] | string | undefined>>,
  shaderId: string | undefined,
  assetsRef: AssetRegistry,
  world: World,
  resolveTex: (
    value: unknown,
    brand: 'TextureAsset',
  ) => Handle<'TextureAsset', 'shared'> | undefined,
  videoOut: Map<string, Handle<'VideoAsset', 'shared'>>,
): Map<string, Handle<'TextureAsset', 'shared'>> {
  const fields =
    (shaderId !== undefined ? assetsRef.materialShaderTextureFieldNames(shaderId) : undefined) ??
    BUILTIN_USER_REGION_TEXTURE_FIELDS;
  const out = new Map<string, Handle<'TextureAsset', 'shared'>>();
  for (const field of fields) {
    // D-5: a video-kind paramValue is routed to the transient path (videoOut),
    // NOT minted as a TextureAsset (which would crash the record-stage
    // ensureResident, AC-08). A static field falls through to resolveTex.
    const videoHandle = resolveVideoFieldHandle(pv[field], world, assetsRef);
    if (videoHandle !== undefined) {
      videoOut.set(field, videoHandle);
      continue;
    }
    const handle = resolveTex(pv[field], 'TextureAsset');
    if (handle !== undefined) out.set(field, handle);
  }
  return out;
}

/**
 * feat-20260608 M5 amend / w11-a: resolve a single MaterialAsset handle into
 * a per-submesh MaterialSnapshot. Used by the extractFrame archetype loop to
 * build `RenderableSnapshot.materials[]` for indices >= 1 (the entity-level
 * snapshot at index 0 is built inline because it also drives multi-pass
 * DispatchEntry creation + sprite-region overrides; per-submesh secondary
 * materials are non-sprite + single-pass-equivalent for the record stage's
 * UBO upload, so this helper produces a plain MaterialSnapshot only).
 *
 * Returns `defaultMaterialSnapshot()` (mid-grey unlit) for handle=0 (case-B
 * sentinel, mirroring the inline path) and on any unresolved / non-material
 * asset (so a partially-mis-registered multi-material entity still renders
 * the resolvable submeshes; the count-mismatch validator already filtered
 * the count-disagreement case earlier).
 */
function resolveMaterialSnapshot(
  handleRaw: number,
  world: World,
  assetsRef: AssetRegistry,
  gpuStore?: import('./gpu-resource-store').GpuResourceStore,
): MaterialSnapshot {
  if (handleRaw === 0) return defaultMaterialSnapshot();
  const tagged = toShared<'MaterialAsset'>(handleRaw);
  const res = resolveAssetHandle(world, tagged);
  if (!res.ok) return defaultMaterialSnapshot();
  const asset = res.value;
  if (asset.kind !== 'material') return defaultMaterialSnapshot();
  const resolvedResult = walkMaterialPassesOverSharedRefs(world, tagged, assetsRef);
  if (!resolvedResult.ok) return defaultMaterialSnapshot();
  const resolved = resolvedResult.value;
  const pv = resolved.paramValues as Readonly<
    Record<string, number | number[] | string | undefined>
  >;
  const baseColorPv = pv.baseColor as readonly number[] | undefined;
  const baseColor = vec3.create(
    baseColorPv?.[0] ?? 1,
    baseColorPv?.[1] ?? 1,
    baseColorPv?.[2] ?? 1,
  );
  const metallicPv = typeof pv.metallic === 'number' ? pv.metallic : 0;
  const roughnessPv = typeof pv.roughness === 'number' ? pv.roughness : 0.5;

  const paramSnap: Record<string, number | number[] | string> = {};
  for (const [k, v] of Object.entries(pv)) {
    if (typeof v === 'number') paramSnap[k] = v;
    else if (typeof v === 'string') paramSnap[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
      paramSnap[k] = v as number[];
    }
  }
  const allPasses = resolved.passes;
  const firstPassShader = allPasses.length > 0 ? allPasses[0]?.shader : undefined;
  // feat-20260614 M8 (D-19): texture / sampler paramValues are embedded GUIDs
  // (dash-form strings) after loadByGuid. Resolve each to a user-tier column
  // handle by looking up the catalogued payload and minting via
  // world.allocSharedRef; a numeric value (already a column handle from a
  // directly-minted material) passes through unchanged.
  const resolveTexLike = <B extends string>(
    value: unknown,
    brand: B,
  ): Handle<B, 'shared'> | undefined => {
    if (typeof value === 'number') return value as unknown as Handle<B, 'shared'>;
    if (typeof value === 'string') {
      // M4: intern the GUID -> column-handle resolution so each unique
      // (world, guid, brand) mints exactly ONE stable handle reused across
      // frames (stops the per-frame slot churn that defeated the GPU
      // residency cache). feat-20260619 M2 / w8: TextureAsset brand wires
      // onLastRelease -> gpuStore.evictTexture; other brands (SamplerAsset)
      // bypass (releaseUnreferenced-fallback lifecycle).
      if (gpuStore !== undefined && brand === 'TextureAsset') {
        return internSharedRefFromGuid(world, assetsRef, value, brand, (handle) => {
          gpuStore.evictTexture(handle as Handle<'TextureAsset', 'shared'>);
        });
      }
      return internSharedRefFromGuid(world, assetsRef, value, brand);
    }
    return undefined;
  };
  // feat-20260621-learn-render-5-5-parallax M2 / w7 (D-3): iterate the
  // shader's derive(paramSchema).textureFieldNames SSOT instead of a hardcoded
  // user-region field list, so an Nth texture (e.g. parallax heightTexture)
  // resolves through the same path. emissive/occlusion are engine-injection
  // (lightmap) textures, NOT in textureFieldNames, so they keep named reads.
  const videoTextureFields = new Map<string, Handle<'VideoAsset', 'shared'>>();
  const textureHandles = collectUserRegionTextureHandles(
    pv,
    firstPassShader,
    assetsRef,
    world,
    resolveTexLike,
    videoTextureFields,
  );
  const samplerHandle = resolveTexLike(pv.sampler, 'SamplerAsset');
  const emissiveTextureHandle = resolveTexLike(pv.emissiveTexture, 'TextureAsset');
  const occlusionTextureHandle = resolveTexLike(pv.occlusionTexture, 'TextureAsset');
  // Named user-region fields are derived from the map (sprite + legacy reads).
  const baseColorTextureHandle = textureHandles.get('baseColorTexture');
  const metallicRoughnessTextureHandle = textureHandles.get('metallicRoughnessTexture');
  const normalTextureHandle = textureHandles.get('normalTexture');
  const emissivePv = pv.emissive as readonly number[] | undefined;
  return {
    baseColor,
    metallic: metallicPv,
    roughness: roughnessPv,
    materialShaderId: firstPassShader,
    paramSnapshot: paramSnap,
    ...(textureHandles.size > 0 && { textureHandles }),
    ...(videoTextureFields.size > 0 && { videoTextureFields }),
    ...(baseColorTextureHandle !== undefined && { baseColorTexture: baseColorTextureHandle }),
    ...(metallicRoughnessTextureHandle !== undefined && {
      metallicRoughnessTexture: metallicRoughnessTextureHandle,
    }),
    ...(normalTextureHandle !== undefined && { normalTexture: normalTextureHandle }),
    ...(samplerHandle !== undefined && { sampler: samplerHandle }),
    ...(emissivePv !== undefined && {
      emissive: [emissivePv[0] ?? 0, emissivePv[1] ?? 0, emissivePv[2] ?? 0] as readonly [
        number,
        number,
        number,
      ],
    }),
    ...(typeof pv.emissiveIntensity === 'number' && { emissiveIntensity: pv.emissiveIntensity }),
    ...(emissiveTextureHandle !== undefined && { emissiveTexture: emissiveTextureHandle }),
    ...(occlusionTextureHandle !== undefined && { occlusionTexture: occlusionTextureHandle }),
    ...(typeof pv.occlusionStrength === 'number' && { occlusionStrength: pv.occlusionStrength }),
    // feat-city-glb Bug 5 (per-submesh transparency): derive `transparent`
    // from the first pass's `renderState.blend` presence, identical to the
    // entity-level snapshot builder (extractFrame archetype loop). Without
    // this, per-submesh materials (materials[i>=1], e.g. a glTF BLEND decal
    // submesh on a multi-material mesh) never carry the transparent flag, so
    // the record stage's LDR split + blend routing treats them as opaque and
    // their alpha=0 texels composite as black.
    transparent: allPasses[0]?.renderState?.blend !== undefined,
  };
}

/**
 * feat-20260612-skin-palette-per-frame-upload M2 / m2-6: narrow per-frame
 * pipeline surface consumed by `extractFrame`. Today only `skinPaletteAllocator`
 * crosses the seam (the allocator owns the per-frame palette buffer + cursor;
 * extract calls `resetForFrame` at frame entry then `allocateSlice` +
 * `writeJointPalette` per skinned entity). Kept narrow on purpose — extract
 * does NOT see the rest of `PipelineState` to avoid a circular import via
 * `render-system.ts`.
 */
export interface ExtractPipelineSurface {
  readonly skinPaletteAllocator: SkinPaletteAllocator | null;
}

/**
 * PSSM (Parallel-Split Shadow Maps) split plane computation.
 *
 * Formula (plan-strategy D-8, research F1):
 *   C_i = λ·n·(f/n)^(i/m) + (1-λ)·(n + i/m·(f-n))
 *   where i = 1..m, n = near, f = far, m = cascadeCount
 *
 * The coverage range is [camera near, DirectionalLight.shadowDistance] — the
 * near end derives from the active camera, the far end is the shadowDistance
 * knob. Returns strictly monotonic view-space z depths (positive).
 *
 * When `far <= near + ε` (ε=1e-6), throws ShadowInvalidConfigError
 * (charter P3 explicit failure — research F2 guarantees formula stability
 * but degenerate configuration must be surfaced to the caller).
 *
 * @param nearPlane - near of the shadow casting range (from the camera near)
 * @param farPlane - far of the shadow casting range (DirectionalLight.shadowDistance)
 * @param cascadeCount - number of cascades (1..4)
 * @param splitLambda - PSSM split weight (0 = pure uniform, 1 = pure log)
 * @returns Array of m split depths (view-space z); length = cascadeCount,
 *   guaranteed strictly monotonic, last element = far.
 *
 * @internal exported for w6/w7 testing only; production callers route through
 *   extractFrame which validates cascadeCount/splitLambda via component schema.
 */
/**
 * Compute the 8 world-space corner points of a camera frustum slice.
 *
 * Uses mat4.unproject to map NDC cube corners back to world space.
 * The slice is defined by view-space nearZ and farZ depths.
 *
 * For a WebGPU perspective matrix, ndcZ(viewZ) = camFar * (viewZ - camNear) /
 * (viewZ * (camFar - camNear)). We compute the ndcZ for each slice boundary
 * and unproject directly.
 *
 * @param vp - camera view-projection matrix (column-major 16 floats)
 * @param camNear - camera near plane (used to derive NDC mapping)
 * @param camFar - camera far plane (used to derive NDC mapping)
 * @param nearZ - near depth of the frustum slice (view-space, positive)
 * @param farZ - far depth of the frustum slice (view-space, positive)
 * @returns Array of 8 Vec3 world-space corner positions.
 */
function computeFrustumCorners(
  vp: Mat4,
  camNear: number,
  camFar: number,
  nearZ: number,
  farZ: number,
  projection: 'perspective' | 'orthographic',
): Vec3[] {
  const invVP = mat4.create();
  mat4.invert(invVP, vp);
  const corners: Vec3[] = [];

  // NDC z mapping is projection-dependent (WebGPU clip-space z in [0,1]):
  //   perspective:  ndc(z) = camFar * (z - camNear) / (z * (camFar - camNear))
  //   orthographic: ndc(z) = (z - camNear) / (camFar - camNear)
  // feat-20260613-csm M6 / w22: orthographic cameras silently produced
  // garbage NDC z (perspective formula divides by viewZ, but ortho NDC is
  // linear), which mapped the cascade slab back to a degenerate world-space
  // corner set and the AABB-fit collapsed to near zero -- shadow_caster
  // wrote its triangles outside the [-1,1] clip volume so the depth
  // attachment stayed at clear=1.0 (root cause for shadow-m2 / shadow-m3 /
  // shadow-opt-out dawn red surfaced after w20's host-side ortho fix).
  const span = camFar - camNear;
  const ndcNear =
    projection === 'orthographic'
      ? (nearZ - camNear) / span
      : (camFar * (nearZ - camNear)) / (nearZ * span);
  const ndcFar =
    projection === 'orthographic'
      ? (farZ - camNear) / span
      : (camFar * (farZ - camNear)) / (farZ * span);

  const signs = [-1, 1];
  for (const sx of signs) {
    for (const sy of signs) {
      corners.push(unprojectNDC(invVP, sx, sy, ndcNear));
    }
  }
  for (const sx of signs) {
    for (const sy of signs) {
      corners.push(unprojectNDC(invVP, sx, sy, ndcFar));
    }
  }

  return corners;
}

/**
 * Unproject a single NDC point to world space.
 */
function unprojectNDC(invVP: Mat4, ndcX: number, ndcY: number, ndcZ: number): Vec3 {
  const ndc = vec3.create(ndcX, ndcY, ndcZ);
  const ws = vec3.create();
  mat4.unproject(ws, ndc, invVP);
  return ws;
}

export function pssmSplit(
  nearPlane: number,
  farPlane: number,
  cascadeCount: number,
  splitLambda: number,
): Float32Array {
  const EPS = 1e-6;
  if (farPlane <= nearPlane + EPS) {
    throw new ShadowInvalidConfigError('shadowDistance', farPlane, nearPlane + EPS);
  }

  const result = new Float32Array(cascadeCount);
  const m = cascadeCount;
  const n = nearPlane;
  const f = farPlane;
  const ratio = f / n;

  for (let i = 1; i <= m; i++) {
    const t = i / m;
    const logPart = n * ratio ** t;
    const uniformPart = n + t * (f - n);
    result[i - 1] = splitLambda * logPart + (1 - splitLambda) * uniformPart;
  }

  return result;
}

// feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-5 (plan-strategy §D-3,
// requirements §5.3): 6-face view-proj matrix table for one omnidirectional
// shadow caster.
//
// Face order matches WebGPU cube layer convention (also LearnOpenGL 5.3.2):
//   0 (+X) | look=(+1, 0, 0) | up=(0, -1, 0)
//   1 (-X) | look=(-1, 0, 0) | up=(0, -1, 0)
//   2 (+Y) | look=(0, +1, 0) | up=(0,  0, +1)
//   3 (-Y) | look=(0, -1, 0) | up=(0,  0, -1)
//   4 (+Z) | look=(0, 0, +1) | up=(0, -1, 0)
//   5 (-Z) | look=(0, 0, -1) | up=(0, -1, 0)
//
// Projection: WebGPU [0, 1] NDC perspective (mat4.perspective short name).
// fov=90deg, aspect=1, near/far from PointLightShadow component.
const POINT_SHADOW_FACE_LOOK: readonly Vec3[] = [
  vec3.create(1, 0, 0),
  vec3.create(-1, 0, 0),
  vec3.create(0, 1, 0),
  vec3.create(0, -1, 0),
  vec3.create(0, 0, 1),
  vec3.create(0, 0, -1),
];
const POINT_SHADOW_FACE_UP: readonly Vec3[] = [
  vec3.create(0, -1, 0),
  vec3.create(0, -1, 0),
  vec3.create(0, 0, 1),
  vec3.create(0, 0, -1),
  vec3.create(0, -1, 0),
  vec3.create(0, -1, 0),
];

/**
 * Build 6 face view-proj matrices for an omnidirectional shadow caster
 * (point-light cube map). Returns 6 mat4 (column-major 16-float each) in face
 * order [+X, -X, +Y, -Y, +Z, -Z] matching WebGPU cube layer convention.
 *
 * Each matrix is `proj * view` where:
 *   - `view = lookAt(lightPos, lightPos + faceLook[i], faceUp[i])`
 *   - `proj = perspective(PI/2, 1, near, far)` (WebGPU [0, 1] NDC short name)
 *
 * The returned `Mat4[]` length is always exactly 6. Caller can flatten into a
 * 96-float (6 mat4) Float32Array for UBO upload (T-M1-7).
 *
 * @param lightPos world-space position of the point light (from companion Transform)
 * @param near near plane distance (PointLightShadow.nearPlane)
 * @param far  far plane distance  (PointLightShadow.farPlane)
 */
export function buildPointShadowMatrices(lightPos: Vec3, near: number, far: number): Mat4[] {
  const fovY = Math.PI / 2; // 90 deg
  const aspect = 1;
  const proj = mat4.create();
  mat4.perspective(proj, fovY, aspect, near, far);

  const out: Mat4[] = [];
  for (let i = 0; i < 6; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i in [0..6) and arrays are length-6 const
    const look = POINT_SHADOW_FACE_LOOK[i]!;
    // biome-ignore lint/style/noNonNullAssertion: i in [0..6) and arrays are length-6 const
    const up = POINT_SHADOW_FACE_UP[i]!;
    const target = vec3.create(
      (lightPos[0] ?? 0) + (look[0] ?? 0),
      (lightPos[1] ?? 0) + (look[1] ?? 0),
      (lightPos[2] ?? 0) + (look[2] ?? 0),
    );
    const view = mat4.create();
    mat4.lookAt(view, lightPos, target, up);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    out.push(vp);
  }
  return out;
}

/**
 * feat-20260709-editor-world-partition M1 / w4 (AC-08, plan-strategy §2 D-3):
 * the owner index that previously served BOTH cameras and singleton render
 * resources (skylight / skybox / postProcessParams) is split into two
 * independent indices. `cameraOwner` selects the world whose cameras are
 * surfaced; `resourceOwner` selects the world whose singleton resources are
 * surfaced. A single number is accepted as the backward-compatible legacy form
 * where `cameraOwner === resourceOwner === owner` (single-world callers +
 * frame-loop stay byte-identical; the hard `{ owner }` cutover lands in M2).
 */
export interface ExtractFramesOwner {
  readonly cameraOwner: number;
  readonly resourceOwner: number;
}

export function extractFrames(
  worlds: readonly World[],
  owner: number | ExtractFramesOwner,
  assets?: AssetRegistry | null,
  pipelineState?: ExtractPipelineSurface | null,
  gpuStore?: import('./gpu-resource-store').GpuResourceStore,
): ExtractedFrame {
  // w4: normalize the owner argument. A bare number is the legacy single-owner
  // form (cameraOwner === resourceOwner); an object carries the two split
  // indices. When they coincide the code path is byte-identical to the pre-w4
  // single-owner behaviour (w1 contract combination 2).
  const cameraOwner = typeof owner === 'number' ? owner : owner.cameraOwner;
  const resourceOwner = typeof owner === 'number' ? owner : owner.resourceOwner;

  // ── D-2: frame-level side effects live here ────────────────────────────
  //
  // resetForFrame is called exactly once per frame, at the extractFrames
  // entry. The skinPaletteAllocator cursor is reset before any per-world
  // extract runs, so sequential per-world allocation yields non-overlapping
  // palette slices (AC-08).
  const skinPaletteAllocator = pipelineState?.skinPaletteAllocator ?? null;
  if (skinPaletteAllocator !== null) {
    skinPaletteAllocator.resetForFrame();
  }

  // ── D-2: per-world extract with error isolation ────────────────────────
  //
  // Each world runs propagateTransforms → tilemapChunkExtractSystem →
  // extractFrame. Failure in one world is caught, routed to that world's
  // _routeError (systemName carries worldId for source identification),
  // and the world's contribution is skipped (AC-09 graceful degradation).

  // Parallel arrays: frames[i] stores the frame from worlds[wi] where
  // wi appears in succeededIndices[i].
  const succeededFrames: ExtractedFrame[] = [];
  const succeededIndices: number[] = [];

  for (let wi = 0; wi < worlds.length; wi++) {
    const world = worlds[wi];
    if (world === undefined) continue;
    try {
      // Per-world propagate: guarantee Transform.world is fresh before extract.
      const propagateResult = propagateTransforms(world);
      if (!propagateResult.ok) {
        (world as World & { _routeError(err: Error, ctx: ErrorContext): void })._routeError(
          propagateResult.error as unknown as Error,
          {
            severity: Severity.Error,
            systemName: `RenderSystem.extractFrames(world[${wi}]) (propagateTransforms)`,
          },
        );
      }

      // Tilemap chunk streaming: materialize/evict chunks before extract.
      tilemapChunkExtractSystem(world, wi);

      // D-4: the cameraOwner world uses cull:'self' (normal frustum culling
      // against its own cameras — the cameras that are actually surfaced);
      // every other world uses cull:'none' to avoid its own cameras silently
      // culling geometry the surfaced camera would see. w4: frustum culling
      // follows cameraOwner (the camera source), not resourceOwner.
      const cullMode: 'self' | 'none' = wi === cameraOwner ? 'self' : 'none';
      const frame = extractFrame(world, assets, pipelineState, gpuStore, { cull: cullMode });

      succeededFrames.push(frame);
      succeededIndices.push(wi);
    } catch (err) {
      // Per-world failure: route to world's own error handler, skip contribution.
      try {
        (world as World & { _routeError(err: Error, ctx: ErrorContext): void })._routeError(
          err as Error,
          {
            severity: Severity.Error,
            systemName: `RenderSystem.extractFrames(world[${wi}])`,
          },
        );
      } catch {
        // If _routeError itself throws, the world already failed — skip silently.
      }
    }
  }

  // ── D-3: merge semantics ───────────────────────────────────────────────

  // AC-04: renderables — concat by worlds[] order, stamp worldId.
  const renderables: RenderableSnapshot[] = [];
  const dispatchEntries: DispatchEntry[] = [];

  for (let fi = 0; fi < succeededFrames.length; fi++) {
    const f = succeededFrames[fi];
    const wId = succeededIndices[fi];
    if (f === undefined || wId === undefined) continue;

    const base = renderables.length;
    for (const r of f.renderables) {
      renderables.push({ ...r, worldId: wId });
    }

    // D-3: dispatch — per-world renderableIndex rebased by base offset.
    for (const d of f.dispatch) {
      dispatchEntries.push({ ...d, renderableIndex: (d.renderableIndex ?? 0) + base });
    }
  }

  // Stable sort dispatch by queue value.
  dispatchEntries.sort((a, b) => (a.queue ?? 0) - (b.queue ?? 0));

  // AC-04: lights — point[]/spot[] concat; directional first-hit in
  // succeededFrames order (which preserves worlds[] order for successful
  // frames); directionalCount sum.
  const point: PointLightSnapshot[] = [];
  const spot: SpotLightSnapshot[] = [];
  let directional: DirectionalLightSnapshot | undefined;
  let directionalCount = 0;
  let lightViewProj: readonly Float32Array[] | undefined;
  let splitPlanes: Float32Array | undefined;
  let cascadeCount: number | undefined;
  let cascadeBlend: number | undefined;
  let shadowMapSize: number | undefined;
  let depthBias: number | undefined;
  let normalBias: number | undefined;
  let pcfKernelSize: number | undefined;
  const pointShadow: PointShadowSnapshot[] = [];
  for (const f of succeededFrames) {
    for (const p of f.lights.point) point.push(p);
    for (const s of f.lights.spot) spot.push(s);
    for (const ps of f.lights.pointShadow) pointShadow.push(ps);
    if (directional === undefined && f.lights.directional !== undefined) {
      directional = f.lights.directional;
      // Carry CSM shadow fields from the first-hit directional's world.
      lightViewProj = f.lights.lightViewProj;
      splitPlanes = f.lights.splitPlanes;
      cascadeCount = f.lights.cascadeCount;
      cascadeBlend = f.lights.cascadeBlend;
      shadowMapSize = f.lights.shadowMapSize;
      depthBias = f.lights.depthBias;
      normalBias = f.lights.normalBias;
      pcfKernelSize = f.lights.pcfKernelSize;
    }
    directionalCount += f.lights.directionalCount;
  }
  const lights: ExtractedLights = {
    directional,
    directionalCount,
    point,
    spot,
    lightViewProj,
    splitPlanes,
    cascadeCount,
    cascadeBlend,
    shadowMapSize,
    depthBias,
    normalBias,
    pcfKernelSize,
    pointShadow,
  };

  // AC-05/06 + w4 owner split (D-3 / R-6): cameras come from the cameraOwner
  // world; skylight / skybox / postProcessParams come from the resourceOwner
  // world (holistic snapshot selection). Scan succeededIndices once to locate
  // each owner's surviving frame. When cameraOwner === resourceOwner both
  // resolve to the same frame — byte-identical to the pre-w4 single-owner path.
  let cameraOwnerFrame: ExtractedFrame | undefined;
  let resourceOwnerFrame: ExtractedFrame | undefined;
  for (let fi = 0; fi < succeededFrames.length; fi++) {
    if (succeededIndices[fi] === cameraOwner) cameraOwnerFrame = succeededFrames[fi];
    if (succeededIndices[fi] === resourceOwner) resourceOwnerFrame = succeededFrames[fi];
  }
  const cameras = cameraOwnerFrame !== undefined ? [...cameraOwnerFrame.cameras] : [];
  const skylight = resourceOwnerFrame?.skylight;
  const skylightCount = resourceOwnerFrame?.skylightCount ?? 0;
  const skybox = resourceOwnerFrame?.skybox;
  const skyboxCount = resourceOwnerFrame?.skyboxCount ?? 0;
  const postProcessParams = new Map(resourceOwnerFrame?.postProcessParams);

  // D-3: frustumStats — culled/total summed across worlds.
  const frustumStats = {
    culled: succeededFrames.reduce((s, f) => s + f.frustumStats.culled, 0),
    total: succeededFrames.reduce((s, f) => s + f.frustumStats.total, 0),
  };

  return {
    cameras,
    lights,
    renderables,
    dispatch: dispatchEntries,
    skylight,
    skylightCount,
    skybox,
    skyboxCount,
    frustumStats,
    postProcessParams,
  };
}

export function extractFrame(
  world: World,
  assets?: AssetRegistry | null,
  pipelineState?: ExtractPipelineSurface | null,
  gpuStore?: import('./gpu-resource-store').GpuResourceStore,
  /**
   * feat-20260708-composited-multi-world-rendering M2 / D-2 / D-4:
   * optional per-call overrides.
   *
   * - `cull` (default `'self'`): when `'none'`, skip frustum-plane
   *   construction and keep all renderables (used by extractFrames for
   *   non-owner worlds whose cameras are discarded post-merge).
   *
   * This parameter is add-only (non-breaking): existing 4-arg callers
   * keep the default `'self'` behavior.
   */
  opts?: { cull?: 'self' | 'none' },
): ExtractedFrame {
  // feat-20260708-composited-multi-world-rendering M2 / D-2: resetForFrame
  // has been lifted to extractFrames (the frame-level entry point).
  // extractFrame is now a pure world->snapshot function with no frame-level
  // side effects. See plan-decisions PD2 for the reviewer ruling.
  const skinPaletteAllocator = pipelineState?.skinPaletteAllocator ?? null;
  const cullMode = opts?.cull ?? 'self';

  const directionalLightQuery = createQueryState({ with: [DirectionalLight, Entity] });

  // feat-20260601 D-3: camera / point / spot light world transforms are read
  // through the single resolved `Transform.world` mat4 (written by
  // propagateTransforms), not the retired GlobalTransform-column-switch.
  //
  // tweak-20260611 M1: each segment routes through `createQueryState +
  // queryRun` with `with: [PrimaryComp, Transform, Entity]` (or with Transform
  // in `optional` for the point/spot variants whose archetype may lack
  // Transform). The packed entity handle for `readWorldMat4Copy` /
  // `_getArrayView` reads is recovered via `bundle.Entity.self[i]` -- the
  // archetype-graph back-door (`graph.archetypes` / `arch.components.some`) is gone.
  // Plan-decisions K-2 sniffing scheme B (archetype-edge sniff once via
  // `bundle.X !== undefined`); K-3 invariant preserved (`_getArrayView`
  // calls survive untouched, only the entity source changes).
  const worldInternal = world as WorldInternalView;

  const cameras: CameraSnapshot[] = [];
  // feat-20260630-viewport M2 / w12 / plan-strategy D-2: track the entity id of
  // each surfaced camera in query order, parallel to `cameras[]`, so the
  // ActiveCamera resource (if any) can pick which one renders by entity id.
  const cameraEntities: number[] = [];
  const cameraQuery = createQueryState({ with: [Camera, Transform, Entity] });
  queryRun(cameraQuery, world, (bundle) => {
    const cam = bundle.Camera;
    const entitySelf = bundle.Entity.self;
    for (let i = 0; i < bundle.Entity.self.length; i++) {
      const entity = (entitySelf[i] ?? 0) as EntityHandle;
      const view = worldInternal._getArrayView(entity, Transform, 'world');
      if (view === undefined) continue;
      const worldMat = new Float32Array(view);
      // feat-20260519-tonemap-reinhard-mvp / M3 / T-M3.1: surface the
      // closed `Tonemap` literal union via the `tonemapFromF32` narrowing
      // helper. Defensive fallback to `'none'` for any unrecognised numeric.
      const tonemap = tonemapFromF32(cam.tonemap[i] ?? 0);
      const antialias = antialiasFromF32(cam.antialias[i] ?? 0);
      // feat-20260531-bloom-first-declarative-render-graph-pass / w4:
      // surface the closed `BloomEnabled` literal union via the
      // `bloomEnabledFromF32` narrowing helper (fail-fast throw, charter P3).
      const bloom = bloomEnabledFromF32(cam.bloom[i] ?? 0);
      cameras.push({
        position: mat4.getTranslation(vec3.create(), worldMat as unknown as mat4.Mat4Like),
        world: worldMat,
        fov: cam.fov[i] ?? Math.PI / 4,
        aspect: cam.aspect[i] ?? 1,
        near: cam.near[i] ?? 0.1,
        far: cam.far[i] ?? 100,
        // feat-20260613 M6 / w20: surface the projection variant + ortho
        // frustum quartet so render-system-extract's CSM frustum builder
        // can pick perspective vs orthographic. Without this discrimination
        // an ortho camera (fov=0) feeds a degenerate perspective matrix
        // into the AABB-fit and the shadow atlas stays empty (root cause
        // for shadow-m2 / shadow-m3 / shadow-opt-out dawn red).
        projection: cameraProjectionFromF32(cam.projection?.[i] ?? 0),
        orthoLeft: cam.left?.[i] ?? -1,
        orthoRight: cam.right?.[i] ?? 1,
        orthoBottom: cam.bottom?.[i] ?? -1,
        orthoTop: cam.top?.[i] ?? 1,
        tonemap,
        exposure: cam.exposure[i] ?? 1.0,
        whitePoint: cam.whitePoint[i] ?? 4.0,
        antialias,
        bloom,
        bloomThreshold: cam.bloomThreshold[i] ?? 1.0,
        bloomIntensity: cam.bloomIntensity[i] ?? 1.0,
        bloomBlurRadius: cam.bloomBlurRadius[i] ?? 4.0,
        // feat-20260608 / M1 / D-1 / D-8: clear-color quartet defaults to
        // opaque black `[0, 0, 0, 1]` when the column is absent (e.g. an
        // archetype migrated from a pre-feat snapshot).
        clearR: cam.clearR[i] ?? 0,
        clearG: cam.clearG[i] ?? 0,
        clearB: cam.clearB[i] ?? 0,
        clearA: cam.clearA[i] ?? 1,
      });
      cameraEntities.push(entity as number);
    }
  });

  // feat-20260630-viewport M2 / w12 / plan-strategy D-2: by-entity-id active
  // camera selection. When an `ActiveCamera` resource names one of the surfaced
  // cameras, prune `cameras[]` to that single snapshot so the record stage
  // renders through it (and does NOT fire `render-system-multi-camera`). When
  // the resource is absent, or names an entity that is not a surfaced camera,
  // `selectActiveCameraIndex` returns -1 and `cameras[]` is left intact —
  // preserving the existing first-hit (and multi-camera diagnostic) behavior
  // unchanged (backward compatible). The engine reads only the entity id; it
  // has no notion of which camera is editor vs game (OOS-4 — engine neutral).
  const activeCameraIndex = selectActiveCameraIndex(cameraEntities, getActiveCamera(world)?.entity);
  if (activeCameraIndex >= 0) {
    const selected = cameras[activeCameraIndex];
    if (selected !== undefined) {
      cameras.length = 0;
      cameras.push(selected);
    }
  }

  // Three-query union (M2 / w16 / AC-03): directional has no Transform
  // dependency (sun-like infinite-source semantics); point + spot pull
  // position from the companion Transform via the joined queries.
  // Host-side pre-multiplication: color *= intensity (charter P4); cone
  // deg -> cos (D-S2); range -> 1/range^2 (D-S5).
  let directional: DirectionalLightSnapshot | undefined;
  let directionalCount = 0;
  // feat-20260621 M2: capture shadow fields from the first-hit DirectionalLight.
  // castShadow defaults to true; the CSM path is gated on firstHitCastShadow !== false.
  let firstHitCastShadow: boolean | undefined;
  let firstHitShadowFields:
    | {
        cascadeCount: number;
        splitLambda: number;
        cascadeBlend: number;
        mapSize: number;
        depthBias: number;
        normalBias: number;
        shadowDistance: number;
        pcfKernelSize: number;
      }
    | undefined;
  queryRun(directionalLightQuery, world, (bundle) => {
    const l = bundle.DirectionalLight;
    for (let i = 0; i < bundle.Entity.self.length; i++) {
      directionalCount += 1;
      const intensity = l.intensity[i] ?? 1;
      const snapshot: DirectionalLightSnapshot = {
        kind: 'directional',
        direction: vec3.create(l.directionX[i] ?? 0, l.directionY[i] ?? -1, l.directionZ[i] ?? 0),
        color: vec3.create(
          (l.colorR[i] ?? 1) * intensity,
          (l.colorG[i] ?? 1) * intensity,
          (l.colorB[i] ?? 1) * intensity,
        ),
        intensity,
      };
      if (directional === undefined) {
        // First hit wins; record-stage N>1 fail-fast (M3 / w19) flags duplicates.
        directional = snapshot;
        firstHitCastShadow = (l.castShadow[i] ?? 1) !== 0;
        firstHitShadowFields = {
          cascadeCount: l.cascadeCount[i] ?? 4,
          splitLambda: l.splitLambda[i] ?? 0.75,
          cascadeBlend: l.cascadeBlend[i] ?? 0.2,
          mapSize: l.mapSize[i] ?? 2048,
          depthBias: l.depthBias[i] ?? 0.005,
          normalBias: l.normalBias[i] ?? 0.05,
          shadowDistance: l.shadowDistance[i] ?? 200,
          pcfKernelSize: l.pcfKernelSize[i] ?? 3,
        };
      }
    }
  });

  const pointSnapshots: PointLightSnapshot[] = [];
  // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4: track entity per
  // pointSnapshots index so the post-extract pointShadow join can stamp
  // `shadowAtlasLayer + shadowNear + shadowFar` onto the matching PointLight.
  const pointSnapshotEntities: number[] = [];
  const pointLightQuery = createQueryState({
    with: [PointLight, Entity],
    optional: [Transform],
  });
  queryRun(pointLightQuery, world, (bundle) => {
    const p = bundle.PointLight;
    const entitySelf = bundle.Entity.self;
    // K-2 scheme B: archetype-edge sniff -- `bundle.Transform` key is absent
    // when the archetype does not carry the Transform column.
    const hasTransform = bundle.Transform !== undefined;
    for (let i = 0; i < bundle.Entity.self.length; i++) {
      const intensity = p.intensity[i] ?? 1;
      const range = p.range[i] ?? Number.POSITIVE_INFINITY;
      const entityId = entitySelf[i] ?? 0;
      // Position = world-space translation extracted from Transform.world.
      // A point light archetype without a Transform column sits at the origin.
      let worldMat: Float32Array | undefined;
      if (hasTransform) {
        const entity = entityId as EntityHandle;
        const view = worldInternal._getArrayView(entity, Transform, 'world');
        if (view !== undefined) worldMat = new Float32Array(view);
      }
      const position =
        worldMat !== undefined
          ? mat4.getTranslation(vec3.create(), worldMat as unknown as mat4.Mat4Like)
          : vec3.create(0, 0, 0);
      pointSnapshots.push({
        kind: 'point',
        position,
        color: vec3.create(
          (p.colorR[i] ?? 1) * intensity,
          (p.colorG[i] ?? 1) * intensity,
          (p.colorB[i] ?? 1) * intensity,
        ),
        intensity,
        invRangeSquared: computeInvRangeSquared(range),
      });
      pointSnapshotEntities.push(entityId);
    }
  });

  const spotSnapshots: SpotLightSnapshot[] = [];
  const spotLightQuery = createQueryState({
    with: [SpotLight, Entity],
    optional: [Transform],
  });
  // feat-20260625-spot-light-shadow-mapping M1 w5: tile allocation for castShadow spots.
  // Cap = 4 (OOS-5), sentinel -1 = unassigned (plan-strategy D-4).
  // Direction degeneration (near-zero) also skips shadow (requirements $112).
  let spotTileNext = 0;
  queryRun(spotLightQuery, world, (bundle) => {
    const s = bundle.SpotLight;
    const entitySelf = bundle.Entity.self;
    const hasTransform = bundle.Transform !== undefined;
    for (let i = 0; i < bundle.Entity.self.length; i++) {
      const intensity = s.intensity[i] ?? 1;
      const range = s.range[i] ?? Number.POSITIVE_INFINITY;
      const innerConeDeg = s.innerConeDeg[i] ?? 0;
      const outerConeDeg = s.outerConeDeg[i] ?? 45;
      let worldMat: Float32Array | undefined;
      if (hasTransform) {
        const entity = (entitySelf[i] ?? 0) as EntityHandle;
        const view = worldInternal._getArrayView(entity, Transform, 'world');
        if (view !== undefined) worldMat = new Float32Array(view);
      }
      const position =
        worldMat !== undefined
          ? mat4.getTranslation(vec3.create(), worldMat as unknown as mat4.Mat4Like)
          : vec3.create(0, 0, 0);
      const dir = vec3.create(s.directionX[i] ?? 0, s.directionY[i] ?? -1, s.directionZ[i] ?? 0);

      // ── shadow fields (feat-20260625-spot-light-shadow-mapping M1) ──
      const castShadow = (s.castShadow[i] ?? 1) !== 0;
      const sMapSize = s.mapSize[i] ?? 2048;
      const sNearPlane = s.nearPlane[i] ?? 0.1;
      const sFarPlane = s.farPlane[i] ?? 50;

      let lightViewProj: Float32Array | undefined;
      let shadowAtlasTile = -1;

      if (castShadow) {
        // D-4 / requirements $112: normalize direction; skip shadow if degenerate.
        const dirLen = Math.sqrt(
          (dir[0] ?? 0) * (dir[0] ?? 0) +
            (dir[1] ?? 0) * (dir[1] ?? 0) +
            (dir[2] ?? 0) * (dir[2] ?? 0),
        );
        const EPSILON = 1e-6;
        if (dirLen > EPSILON) {
          const dirN = vec3.create(
            (dir[0] ?? 0) / dirLen,
            (dir[1] ?? 0) / dirLen,
            (dir[2] ?? 0) / dirLen,
          );
          const target = vec3.create(
            (position[0] ?? 0) + (dirN[0] ?? 0),
            (position[1] ?? 0) + (dirN[1] ?? 0),
            (position[2] ?? 0) + (dirN[2] ?? 0),
          );
          // D-1: perspective(outerConeDeg*2, aspect=1, near, far) x lookAt(pos, pos+dir).
          // FOV = outerConeDeg * 2 in degrees; mat4.perspective takes fov in radians.
          const fov = outerConeDeg * 2 * (Math.PI / 180);
          const proj = mat4.create();
          mat4.perspective(proj, fov, 1, sNearPlane, sFarPlane);
          const view = mat4.create();
          mat4.lookAt(view, position, target, vec3.create(0, 1, 0));
          lightViewProj = new Float32Array(16);
          // Reinterpret the Float32Array surface field as a Mat4 out-param; a
          // factory would force a needless alloc+copy. brand-cast-ok
          mat4.multiply(lightViewProj as Mat4, proj, view);

          // D-4: allocate tile 0..3; 5th+ = -1 sentinel.
          if (spotTileNext < 4) {
            shadowAtlasTile = spotTileNext;
            spotTileNext += 1;
          }
        }
      }

      spotSnapshots.push({
        kind: 'spot',
        // D-6: position reflects world transform; direction stays sourced
        // from SpotLight.directionX/Y/Z (NOT rotated by the parent).
        position,
        direction: dir,
        color: vec3.create(
          (s.colorR[i] ?? 1) * intensity,
          (s.colorG[i] ?? 1) * intensity,
          (s.colorB[i] ?? 1) * intensity,
        ),
        intensity,
        invRangeSquared: computeInvRangeSquared(range),
        cosInner: degToCos(innerConeDeg),
        cosOuter: degToCos(outerConeDeg),
        // ── shadow fields ──
        castShadow,
        lightViewProj,
        mapSize: sMapSize,
        nearPlane: sNearPlane,
        farPlane: sFarPlane,
        shadowAtlasTile,
      });
    }
  });

  // feat-20260613-csm-cascaded-shadow-maps M2 / w9:
  // Per-cascade CSM computation: PSSM splits + frustum-slice AABB fitting +
  // orthographic projection + atlas tile UV inset baked into lightViewProj.
  // Replaces the old single-cascade lightSpaceMatrix path (D-1 fixed-extent
  // bound deleted; D-3 atlas tile 1px inset; D-8 nearPlane/farPlane from
  // component).
  //
  // The old `lightSpaceMatrix` singleton is replaced by:
  //   - lightViewProj: Float32Array[4] — one mat4 per cascade
  //   - splitPlanes: Float32Array[4] — PSSM split depths (view-space z)
  //   - cascadeCount: number — effective cascade count (1..4)
  //   - cascadeBlend: number — blend width (0..0.5)
  let lightViewProj: Float32Array[] | undefined;
  let splitPlanes: Float32Array | undefined;
  let cascadeCount: number | undefined;
  let cascadeBlend: number | undefined;
  let shadowMapSize: number | undefined;

  // Camera data needed for frustum corner computation (first camera only;
  // multi-camera CSM is OOS-1).
  // feat-20260613 M6 / w20: carry the projection variant + ortho extents
  // so the matrix builder below picks perspective vs orthographic. The
  // prior shape only carried fov/aspect/near/far and silently corrupted
  // ortho cameras (fov=0 -> degenerate perspective matrix -> empty atlas).
  let cameraData:
    | {
        world: Float32Array;
        fov: number;
        aspect: number;
        near: number;
        far: number;
        projection: 'perspective' | 'orthographic';
        orthoLeft: number;
        orthoRight: number;
        orthoBottom: number;
        orthoTop: number;
      }
    | undefined;
  const cam0 = cameras[0];
  if (cam0 !== undefined) {
    const cam = cam0;
    cameraData = {
      world: cam.world,
      fov: cam.fov,
      aspect: cam.aspect,
      near: cam.near,
      far: cam.far,
      projection: cam.projection,
      orthoLeft: cam.orthoLeft,
      orthoRight: cam.orthoRight,
      orthoBottom: cam.orthoBottom,
      orthoTop: cam.orthoTop,
    };
  }

  // feat-20260621 M2: CSM computation gated on castShadow from the
  // merged DirectionalLight. castShadow defaults to true (first-hit-wins
  // semantics, D-6 no cardinality cap). The independent shadowQuery and
  // orphanShadowQuery are removed; shadow fields live on DirectionalLight.
  if (directional !== undefined && firstHitCastShadow !== false) {
    const dirSnapshot = directional;
    const sf = firstHitShadowFields;
    if (sf !== undefined) {
      const mapSize = sf.mapSize;
      const cc = sf.cascadeCount;
      const sl = sf.splitLambda;
      const cb = sf.cascadeBlend;
      // Coverage range: near derives from the active camera near (no separate
      // near knob — any value other than camera near drops near shadows or
      // wastes cascade-0 resolution); far is the component's shadowDistance.
      // Fallback camera near (0.1) only when no camera exists this frame; the
      // CSM matrices below are gated on cameraData anyway.
      const sNear = cameraData?.near ?? 0.1;
      const sFar = sf.shadowDistance;
      shadowMapSize = mapSize;
      cascadeCount = Math.round(cc);
      cascadeBlend = cb;

      // PSSM split planes: [camera near, shadowDistance], not the camera far.
      const splits = pssmSplit(sNear, sFar, cascadeCount, sl);
      splitPlanes = splits;

      // Light view matrix: camera positioned at origin, looking along light dir.
      const lightDir = dirSnapshot.direction;
      const lightDirN = vec3.normalize(vec3.create(), lightDir);
      const lightTarget = vec3.create(lightDirN[0] ?? 0, lightDirN[1] ?? 0, lightDirN[2] ?? 0);
      const lightPos = vec3.create(0, 0, 0);
      const lightView = mat4.create();
      mat4.lookAt(lightView, lightPos, lightTarget, vec3.create(0, 1, 0));

      // Camera view-projection matrix for frustum corner computation.
      // feat-20260613 M6 / w20: branch on projection variant so an
      // orthographic camera (fov=0) is not silently corrupted by
      // mat4.perspective. The frustum-corner unprojection downstream
      // is variant-agnostic (it only inverts cameraVP), so swapping
      // the projection matrix is the entire fix.
      const camProj = mat4.create();
      const camView = mat4.create();
      let cameraVP: Mat4 | undefined;
      if (cameraData !== undefined) {
        if (cameraData.projection === 'orthographic') {
          mat4.orthographic(
            camProj,
            cameraData.orthoLeft,
            cameraData.orthoRight,
            cameraData.orthoBottom,
            cameraData.orthoTop,
            cameraData.near,
            cameraData.far,
          );
        } else {
          mat4.perspective(
            camProj,
            cameraData.fov,
            cameraData.aspect,
            cameraData.near,
            cameraData.far,
          );
        }
        mat4.invert(camView, cameraData.world as unknown as mat4.Mat4Like);
        cameraVP = mat4.create();
        mat4.multiply(cameraVP, camProj, camView);
      }

      const resultLightViewProjs: Float32Array[] = [];

      // bug-20260619 RC-2 (AC-05): toward-light Z reach. A per-cascade ortho
      // whose near/far is fit to ONLY that cascade's visible slice corners
      // clips out any caster sitting BETWEEN the light and the slice (it lands
      // in front of the ortho near plane -> z < 0 -> never written to the
      // depth tile -> the ground it should shadow reads "unoccluded"). The N=4
      // case is worse than N=1 because thinner near slices give a tighter Z.
      // Fix: extend the near (toward-light) bound of EVERY cascade to the
      // toward-light extreme of the WHOLE shadow frustum (sNear..sFar), so any
      // caster within the shadowed depth range is admitted; X/Y stays per
      // cascade tight (no resolution loss) and the PSSM split is untouched.
      // In this RH light view, larger light-space z == closer to the light (see
      // lookAt forward = eye-target), so the full-frustum max-z is the toward-
      // light reach used as -maxZ (the ortho near plane) for each cascade.
      let lightSpaceMaxZFull = -Infinity;
      if (cameraVP !== undefined && cameraData !== undefined) {
        const fullCorners = computeFrustumCorners(
          cameraVP,
          cameraData.near,
          cameraData.far,
          sNear,
          sFar,
          cameraData.projection,
        );
        for (const ws of fullCorners) {
          const ls = vec3.create();
          mat4.transformVec3(ls, lightView, ws);
          if ((ls[2] ?? 0) > lightSpaceMaxZFull) lightSpaceMaxZFull = ls[2] ?? 0;
        }
      }

      // Pre-allocate 4-cascade array; fill in the effective cascades.
      for (let cIdx = 0; cIdx < 4; cIdx++) {
        if (cIdx >= cascadeCount || cameraVP === undefined || cameraData === undefined) {
          // Unused cascade slot → zero matrix.
          resultLightViewProjs.push(new Float32Array(16));
          continue;
        }

        // Cascade depth range: near of first cascade = sNear, far of last = sFar.
        const cascadeNear = cIdx === 0 ? sNear : (splits[cIdx - 1] ?? sFar);
        const cascadeFar = splits[cIdx] ?? sFar;

        // Frustum slice 8 corner points in world space. Pass projection
        // variant so the NDC-z mapping uses the right formula (perspective
        // is non-linear in viewZ; ortho is linear).
        const corners = computeFrustumCorners(
          cameraVP,
          cameraData.near,
          cameraData.far,
          cascadeNear,
          cascadeFar,
          cameraData.projection,
        );

        // Transform corners to light space and compute AABB.
        const lightMVP = mat4.clone(lightView);
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const ws of corners) {
          const ls = vec3.create();
          mat4.transformVec3(ls, lightMVP, ws);
          if ((ls[0] ?? 0) < minX) minX = ls[0] ?? 0;
          if ((ls[0] ?? 0) > maxX) maxX = ls[0] ?? 0;
          if ((ls[1] ?? 0) < minY) minY = ls[1] ?? 0;
          if ((ls[1] ?? 0) > maxY) maxY = ls[1] ?? 0;
          if ((ls[2] ?? 0) < minZ) minZ = ls[2] ?? 0;
          if ((ls[2] ?? 0) > maxZ) maxZ = ls[2] ?? 0;
        }

        // Orthographic projection from light-space AABB. RC-2 (AC-05): use the
        // whole-frustum toward-light extreme for the near (toward-light) bound
        // so casters between the light and this slice are captured; keep the
        // per-cascade far (minZ) and X/Y for tight depth precision/resolution.
        const nearZ = Math.max(maxZ, lightSpaceMaxZFull);
        const orthoProj = mat4.create();
        mat4.orthographic(orthoProj, minX, maxX, minY, maxY, -nearZ, -minZ);

        // lightViewProj = orthoProj * lightView -- pure clip-space [-1,1]
        // matrix. The atlas tile placement is handled by the per-cascade
        // viewport (urp-pipeline.ts addShadowPass viewport: { col*mapSize,
        // row*mapSize, mapSize, mapSize }) so shadow_caster.gl_Position
        // gets clip-space coords that rasterize into the right tile.
        // evalDirectional applies a tile transform in fragment-space when
        // sampling the atlas: uv_atlas = (ndc.xy * 0.5 + 0.5) / tilesPerSide
        // + tileOrigin. Splitting the role (matrix = clip-space / shader =
        // tile placement) keeps shadow_caster valid as a vertex transform
        // and keeps evalDirectional's UV math closed-form readable.
        // M5 / w28: removed texMat post-multiply that previously baked
        // atlas-UV space into the matrix; that breaks shadow_caster's
        // gl_Position contract (it expects clip-space).
        // The cIdx / cascadeCount loop variable is retained for future
        // per-cascade adjustments (e.g. depth-bias scaling per cascade).
        void cIdx;
        resultLightViewProjs.push(
          new Float32Array(mat4.multiply(mat4.create(), orthoProj, lightView)),
        );
      }

      lightViewProj = resultLightViewProjs;
    }
  }

  // feat-20260613-csm M3 / w14 (plan-strategy §D-7): pad the up-to-4
  // splitPlanes into a fixed length-4 Float32Array (unused slots = 0) so
  // the View UBO tail keeps a stable layout regardless of the runtime
  // cascadeCount. Host-side correctness invariant: only the first
  // cascadeCount slots are ever read by the WGSL kernel.
  const paddedSplitPlanes = new Float32Array(4);
  if (splitPlanes !== undefined) {
    for (let i = 0; i < splitPlanes.length; i++) {
      paddedSplitPlanes[i] = splitPlanes[i] ?? 0;
    }
  }

  // feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-7 (plan-strategy §D-3,
  // requirements §5.3): query (PointLight + PointLightShadow + Transform)
  // archetype join. For each shadow caster, build 6 face VP matrices and pack
  // into Float32Array(96). Atlas layer assigned in spawn order (0..3); the
  // sentinel -1 is shader-side and applies to non-shadow PointLights only.
  // Cap of 4 is enforced by ECS cardinality on PointLightShadow.
  const pointShadowSnapshots: PointShadowSnapshot[] = [];
  {
    const pointShadowQuery = createQueryState({
      with: [Transform, PointLight, PointLightShadow, Entity],
    });
    queryRun(pointShadowQuery, world, (bundle) => {
      const t = bundle.Transform;
      const ps = bundle.PointLightShadow;
      const ent = bundle.Entity.self;
      const len = ent.length;
      for (let i = 0; i < len; i++) {
        // Read world-space position from Transform.world (mat4 column-major;
        // translation lives at indices 12..14, mirroring CameraSnapshot.world
        // semantics in this file).
        // feat-20260614 M4 / w13: TypedArrayFor for `array<f32, 16>` now
        // resolves to a concrete `Float32Array` (was `never` pre-w11), which
        // surfaces the row-window slicing -- `t.world` is the stride-16 flat
        // column view; row i lives at `[i*16, (i+1)*16)`. The prior
        // `t.world?.[i]` form silently returned a single element under the
        // `never`-typed bundle path and `wRow[12]` widened to `undefined ?? 0`
        // so light positions clamped to the origin.
        const wRow = t.world?.subarray(i * 16, i * 16 + 16);
        if (wRow === undefined) continue;
        const px = wRow[12] ?? 0;
        const py = wRow[13] ?? 0;
        const pz = wRow[14] ?? 0;
        const lightPos = vec3.create(px, py, pz);
        const mapSize = ps.mapSize?.[i] ?? 512;
        const nearPlane = ps.nearPlane?.[i] ?? 0.1;
        const farPlane = ps.farPlane?.[i] ?? 25;
        const layer = pointShadowSnapshots.length; // 0, 1, 2, 3 in spawn order

        const matrices = buildPointShadowMatrices(lightPos, nearPlane, farPlane);
        const packed = new Float32Array(96);
        for (let f = 0; f < 6; f++) {
          const m = matrices[f];
          if (m === undefined) continue;
          for (let k = 0; k < 16; k++) {
            packed[f * 16 + k] = m[k] ?? 0;
          }
        }
        pointShadowSnapshots.push({
          // biome-ignore lint/style/noNonNullAssertion: i within ent.length by loop bound
          entity: ent[i]!,
          position: lightPos,
          mapSize,
          nearPlane,
          farPlane,
          shadowAtlasLayer: layer,
          shadowMatrices: packed,
        });
      }
    });
  }

  // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4 (plan-strategy §D-8):
  // join pointShadow snapshots into the matching PointLightSnapshot so the
  // record stage threads `shadowAtlasLayer + shadowNear + shadowFar` through
  // `packLightSlot` for the HDRP std430 LightSlot pad lanes (byte 52..64).
  // Mutates the freshly-built PointLightSnapshot in place; the snapshot is
  // not exposed elsewhere this frame yet (consumed only by lights.point[]).
  if (pointShadowSnapshots.length > 0) {
    const shadowByEntity = new Map<number, PointShadowSnapshot>();
    for (const ps of pointShadowSnapshots) shadowByEntity.set(ps.entity, ps);
    for (let i = 0; i < pointSnapshots.length; i++) {
      const entityId = pointSnapshotEntities[i] ?? 0;
      const ps = shadowByEntity.get(entityId);
      if (ps !== undefined) {
        pointSnapshots[i] = {
          ...(pointSnapshots[i] as PointLightSnapshot),
          shadowAtlasLayer: ps.shadowAtlasLayer,
          shadowNear: ps.nearPlane,
          shadowFar: ps.farPlane,
        };
      }
    }
  }

  const lights: ExtractedLights = {
    directional,
    directionalCount,
    point: pointSnapshots,
    spot: spotSnapshots,
    lightViewProj,
    splitPlanes: splitPlanes !== undefined ? paddedSplitPlanes : undefined,
    cascadeCount,
    cascadeBlend,
    shadowMapSize,
    depthBias: firstHitCastShadow !== false ? firstHitShadowFields?.depthBias : undefined,
    normalBias: firstHitCastShadow !== false ? firstHitShadowFields?.normalBias : undefined,
    pcfKernelSize: firstHitCastShadow !== false ? firstHitShadowFields?.pcfKernelSize : undefined,
    pointShadow: pointShadowSnapshots,
  };

  // feat-20260520-skylight-ibl-cubemap M4 / t26+t27: query Skylight entities.
  // First archetype hit wins (mirrors DirectionalLight pattern); multi-Skylight
  // warn in record stage (t27) uses skylightCount.
  const skylightQuery = createQueryState({ with: [Skylight, Entity] });
  let skylight: SkylightSnapshot | undefined;
  let skylightCount = 0;
  queryRun(skylightQuery, world, (bundle) => {
    const s = bundle.Skylight;
    for (let i = 0; i < bundle.Entity.self.length; i++) {
      // equirect is OPTIONAL: an omitted field zero-inits to handle 0, which
      // record treats as "no equirect" -> solid-color ambient via the white
      // fallback cube. A Skylight WITHOUT an equirect is still a valid snapshot
      // (the prior `equirectRaw !== undefined` gate dropped color-only
      // skylights, leaving the scene black -- the downstream gap #4).
      const equirectRaw = s.equirect?.get(i);
      const intensity = s.intensity?.[i] ?? 1.0;
      const colorR = s.colorR?.[i] ?? 1.0;
      const colorG = s.colorG?.[i] ?? 1.0;
      const colorB = s.colorB?.[i] ?? 1.0;
      skylightCount += 1;
      if (skylight === undefined) {
        skylight = {
          equirectHandle: equirectRaw !== undefined ? Math.round(equirectRaw) : 0,
          color: [colorR, colorG, colorB],
          intensity,
          // w19: winning entity handle for the multi-Skylight once-warn (F-8).
          entityHandle: bundle.Entity.self[i] ?? 0,
        };
      }
    }
  });

  // feat-20260531-skybox-env-background M2 / w5: query SkyboxBackground entities.
  // First archetype hit wins (mirrors Skylight pattern); multi-entity
  // once-warn in record stage uses skyboxCount.
  const skyboxQuery = createQueryState({ with: [SkyboxBackground, Entity] });
  let skybox: SkyboxSnapshot | undefined;
  let skyboxCount = 0;
  queryRun(skyboxQuery, world, (bundle) => {
    const s = bundle.SkyboxBackground;
    for (let i = 0; i < bundle.Entity.self.length; i++) {
      const equirectRaw = s.equirect?.get(i);
      const modeRaw = s.mode?.[i] ?? 0;
      skyboxCount += 1;
      if (skybox === undefined && equirectRaw !== undefined) {
        skybox = {
          equirectHandle: Math.round(equirectRaw),
          mode: modeRaw,
          // w19: winning entity handle for the multi-SkyboxBackground warn (F-8).
          entityHandle: bundle.Entity.self[i] ?? 0,
        };
      }
    }
  });

  // feat-20260528-frustum-culling M3 / w10: precompute per-camera frustum
  // planes so entities can be tested against all cameras in the inner loop.
  // Cameras with degenerate projection parameters (e.g. zero fov, zero aspect)
  // are skipped — entities are always-visible for those. Frustum plane cache
  // stored as Float32Array[] parallel to the cameras[] array.
  //
  // feat-20260708-composited-multi-world-rendering M2 / D-4: when cullMode
  // is 'none' (non-owner world in extractFrames), skip frustum construction
  // entirely — all renderables are kept. This avoids the non-owner world's
  // own cameras silently culling geometry that the owner camera would see.
  const frustumPlanes: Float32Array[] = [];
  if (cullMode !== 'none') {
    for (const cam of cameras) {
      // feat-20260613 M6 / w20: orthographic cameras have fov=0 by design;
      // the previous degeneracy guard (`fov <= 0`) was rejecting valid ortho
      // cameras and returning the always-visible escape hatch. Only the
      // perspective path needs the fov check.
      if (cam.projection === 'perspective' && (cam.fov <= 0 || cam.aspect <= 0)) {
        frustumPlanes.push(new Float32Array(0)); // degenerate → always-visible
        continue;
      }
      if (cam.near >= cam.far) {
        frustumPlanes.push(new Float32Array(0));
        continue;
      }
      const proj = mat4.create();
      if (cam.projection === 'orthographic') {
        mat4.orthographic(
          proj,
          cam.orthoLeft,
          cam.orthoRight,
          cam.orthoBottom,
          cam.orthoTop,
          cam.near,
          cam.far,
        );
      } else {
        mat4.perspective(proj, cam.fov, cam.aspect, cam.near, cam.far);
      }
      // feat-20260601 D-3: view = invert(camera world mat4). The camera scale is
      // carried in the world basis columns; the cull frustum uses the same view
      // the record stage derives, so cull stays same-source with render (AC-05).
      const view = mat4.create();
      mat4.invert(view, cam.world as unknown as mat4.Mat4Like);
      const vp = mat4.create();
      mat4.multiply(vp, proj, view);
      const f = frustum.create();
      frustum.fromViewProjection(f, vp);
      frustumPlanes.push(f);
    }
  }

  const renderables: RenderableSnapshot[] = [];
  // feat-20260528-frustum-culling M3 / w11: frustum culling counters.
  let frustumCulled = 0;
  let frustumTotal = 0;
  // feat-20260520-2d-sprite-layer-mvp M-3 / w22 (@new-surface): three-
  // bucket dispatch arrays. The legacy `materialDispatch` field stays as
  // a back-compat union (opaque + transparent + overlay back-compat
  // entries) so the pre-w25 RenderSystem.draw consumer loop keeps
  // working until M-3 / w25 lands the bucket-aware record. Plan-strategy
  // §6.1 (back-compat field stays until M-4 acceptance round green).
  // M3 / w26: single dispatch list replaces old three-bucket model
  // (plan-strategy D-3). Entries built per-entity per-pass inside the
  // archetype walk, then sorted by queue at the end.
  let dispatch: DispatchEntry[] = [];

  // tweak-20260611 M1: MeshRenderer renderable archetype walk routes
  // through `createQueryState + queryRun`. K-2 sniffing scheme B
  // (`bundle.X !== undefined` archetype-edge sniff) replaces the prior
  // `arch.components.some` row-internal back-door. K-3 invariant: the
  // variable-length array reads (`MeshRenderer.materials`,
  // `Instances.transforms`) still flow through `_getArrayView` /
  // `world.get(e, Instances)` -- only the `entity` source switches to
  // `bundle.Entity.self[i]`.
  //
  // archVersion plumbing exception: the `RenderableSnapshot.instances
  // .archVersion` cache key is keyed off the live archetype's mutation
  // counter (record stage `instanceBuffers` cache invalidation). The
  // queryRun bundle does not surface this number, so a single archetype
  // graph access is retained inside the callback (one read per matched
  // archetype, not per row) -- match the archetype by its first-entity
  // packed handle. AC-01 grep ≤ current - 1 still holds: the stale
  // archetype-graph traversal commentary at the prior call site is gone.
  // feat-20260521-sprite-atlas-animation M3 / T-16: SpriteRegionOverride
  // column id for the sprite-bucket per-entity region override read
  void SpriteRegionOverride;

  const meshRendererQuery = createQueryState({
    with: [MeshRenderer, Entity],
    optional: [
      Transform,
      MeshFilter,
      Instances,
      Skin,
      Layer,
      SortKey,
      SpriteRegionOverride,
      SpriteInstances,
    ],
  });
  const graph = worldInternal._getGraph();
  queryRun(meshRendererQuery, world, (bundle) => {
    if (bundle.Entity.self.length === 0) return;
    const mr = bundle.MeshRenderer;
    const entitySelf = bundle.Entity.self;
    // feat-20260608 M2 / w11: `materials` is the slot-id u32 column; the
    // actual handle list is resolved per-entity via `_getArrayView` below.
    // feat-20260614 M4 / D-4: bundle exposes ManagedColumnReader for the
    // variable `array<shared<MaterialAsset>>` column -- read slot ids via
    // .get(i); mutation flows through world.set / world.push.
    const mMaterials = mr.materials;
    const mFrustumCulled = mr.frustumCulled;
    if (mMaterials === undefined) return;

    // K-2 archetype-edge sniff (scheme B): a missing optional component
    // surfaces as an absent bundle key, not a row-internal optional chain.
    const hasTransform = bundle.Transform !== undefined;
    const hasMeshFilter = bundle.MeshFilter !== undefined;
    const hasInstances = bundle.Instances !== undefined;
    const hasSkin = bundle.Skin !== undefined;
    // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w10:
    // SpriteInstances optional component archetype-edge sniff. Three structured
    // EcsError codes fire at the row-loop entry (D-6 fail-fast at extract):
    //   - 'sprite-instances-mutually-exclusive-with-instances'
    //       (hasInstances && hasSpriteInstances) — Instances + SpriteInstances peers.
    //   - 'sprite-instances-requires-sprite-shading-model'
    //       (materialSnap.materialShaderId !== 'forgeax::sprite') — non-sprite material.
    //   - 'sprite-instances-count-mismatch'
    //       (transforms.length / 16 !== regions.length / 4) — stride pair desync.
    const hasSpriteInstances = bundle.SpriteInstances !== undefined;
    const isRenderable = hasTransform && hasMeshFilter;

    // feat-20260601 D-3: the resolved world transform is read per-entity from
    // the single `Transform.world` mat4 (propagateTransforms output) inside the
    // row loop below. The retired GlobalTransform-column-switch + the
    // ChildOf-without-GlobalTransform misconfig signal are gone: the world
    // column always exists on a Transform-bearing entity, so the
    // "ChildOf but forgot GlobalTransform" misconfiguration cannot occur.
    const fAssetHandle = bundle.MeshFilter?.assetHandle;
    // feat-20260520-2d-sprite-layer-mvp M-3 / w22: Layer column read here;
    // value folded into each DispatchEntry so the render-system sort can use
    // it as the primary transparent-sort key without a second ECS round-trip.
    // SortKey acknowledged; per-entity override path is deferred.
    const fLayerValue = bundle.Layer?.value as Int32Array | undefined;
    void bundle.SortKey;
    // feat-20260608-tilemap-object-layer-rendering M3 / m3-t5: tilemap-spawned
    // per-cell render entities (the ones `tilemap-chunk-extract-system`
    // pushes via `spawnDerivedRenderEntities`) reach this loop via the same
    // archetype edge that carries any sprite entity -- they all wear
    // `MeshFilter.assetHandle === HANDLE_QUAD` + a `forgeax::sprite`-shaded
    // material asset + the sprite-bucket `paramValues.region` rectangle.
    // For the per-entity Y-sort path (requirements §AC-12 / §AC-13):
    //
    //   sortKey = -(Transform.posY - effectivePivotY * |Transform.scaleY|)
    //
    // with `effectivePivotY = effectivePivotYForTilemapFlip(pivotY, pivotX,
    // flipV, flipDiagonal)` from `tilemap-chunk-extract-system` (the SAME
    // helper drives `spawnDerivedRenderEntities`, so the value the sort
    // uses matches the value baked into `Transform.posY` -- charter P4
    // single SSOT for the post-flip pivot). Sprite entities reuse the same
    // formula but skip the flip composition (their pivot stays raw); both
    // bucket types therefore feed one `transparentSortEntries` argsort
    // step + share the `argsortInPlace` radix LSD primitive (plan-strategy
    // §D-1 / §D-3). The detection lives on the material side -- detect a
    // tilemap-spawned entity by `MeshFilter.assetHandle === HANDLE_QUAD`
    // plus the `forgeax::sprite` shader id on `MeshRenderer.material`'s
    // first pass + non-empty `paramValues.region`; no new public ECS
    // marker component lands (charter F1 minimum surface).
    //
    // Layer.value is now folded into each DispatchEntry.layer (fLayerValue
    // column, read once per archetype pass above). render-system.ts
    // `sortTransparentDispatch` applies (layer ASC, sortValue ASC) for all
    // transparent-sort modes (0/1/2) using posY/pivotY/sizeY from the
    // parallel renderables[] snapshot -- no second ECS round-trip needed.
    // feat-20260527-sprite-nineslice M4 / w17 (AC-14): SpriteRegionOverride
    // per-entity UV sub-rectangle. When the entity carries this component the
    // 4-float `[uMin, vMin, uW, vH]` override displaces the asset-side
    // `paramValues.region` for this entity only — downstream 9-slice logic
    // measures slices against this effective region.zw, so a half-width sub-
    // sprite reduces the anchor budget to 0.5 rather than the asset's 1.0.
    //
    // bug-20260612: `buildColumnBundle` is now arity-aware, so
    // `bundle.SpriteRegionOverride?.region` is a full stride-4 flat
    // `Float32Array` of length `entityCount * 4` (row i at `[i*4, i*4+4)`).
    // Per-row reads still route through `_getArrayView` for the cleaner
    // row-window slice (consistent with the variable-length array column
    // reads -- K-3 carve-out keeps `_getArrayView` as the row-accessor of
    // record for any non-scalar column).
    const hasSpriteRegionOverride = bundle.SpriteRegionOverride !== undefined;
    // feat-20260523-skin-skeleton-animation M2 / T-21: Skin component
    // column views for coexistence check + joint despawn fail-fast.
    // `skeleton` holds the packed Handle<SkeletonAsset>; `joints` holds
    // the packed Entity u32 array (N x one u32 each).
    const skinSkeletonView = bundle.Skin?.skeleton;
    // m2-6: per-entity Skin.joints[] is read via `world.get(entity, Skin)`
    // inside the row loop (D-6); the column-bundled view is no longer needed.

    // archVersion lookup: locate this archetype by its first entity's
    // packed handle (all rows in this callback share one archetype).
    const firstEntity = entitySelf[0] ?? 0;
    let archVersion = 0;
    for (const arch of graph.archetypes) {
      if (!arch || arch.size === 0) continue;
      const selfCol = arch.columns.get(Entity.id)?.get('self')?.view as Uint32Array | undefined;
      if (selfCol && selfCol[0] === firstEntity) {
        archVersion = arch.version;
        break;
      }
    }

    for (let i = 0; i < bundle.Entity.self.length; i++) {
      // feat-20260608 M2 / w11: read materials array via _getArrayView
      const entity = (entitySelf[i] ?? 0) as EntityHandle;
      const layerVal = (fLayerValue?.[i] ?? 0) as number;
      const materialsView = worldInternal._getArrayView(
        entity,
        MeshRenderer as unknown as typeof Transform,
        'materials',
      ) as Uint32Array | undefined;
      const materialCount = materialsView?.length ?? 0;

      // count-mismatch validation: materials.length must equal submeshes.length
      // (plan-strategy §2 D-3 read-side interception)
      const fAssetHandleVal = fAssetHandle?.get(i);
      if (
        fAssetHandleVal !== undefined &&
        fAssetHandleVal !== 0 &&
        assets !== undefined &&
        assets !== null
      ) {
        const meshHandle = toShared<'MeshAsset'>(fAssetHandleVal);
        const meshRes = resolveAssetHandle<Asset>(world, meshHandle);
        if (meshRes.ok && meshRes.value.kind === 'mesh') {
          const meshAsset = meshRes.value as { submeshes: { length: number } };
          const submeshCount = meshAsset.submeshes?.length ?? 0;
          // case B fallback: an empty materials array routes through the
          // mid-grey defaultMaterialSnapshot path; skip count-mismatch so a
          // legacy `data: {}` spawn still renders against any mesh.
          if (materialCount > 0 && materialCount !== submeshCount) {
            const guid = (meshRes.value as { guid?: string }).guid ?? '<no-guid>';
            worldInternal._routeError(
              new AssetError({
                code: 'mesh-renderer-material-count-mismatch',
                expected: `materials.length must equal submeshes.length; submeshes=${submeshCount}, materials=${materialCount}`,
                hint: ASSET_ERROR_HINTS['mesh-renderer-material-count-mismatch'],
                detail: {
                  expectedCount: submeshCount,
                  actualCount: materialCount,
                  meshAssetGuid: guid,
                },
              }) as unknown as Error,
              {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (material-count-mismatch)',
              },
            );
            continue;
          }
        }
      }

      // Use the first material handle for the entity-level snapshot
      // (shading-model dispatch routing + multi-pass DispatchEntry. Per-
      // submesh materials[i>=1] are resolved by `resolveMaterialSnapshot`
      // below into the `materials[]` array, used by the record stage to
      // upload N material UBO slots and bind the i-th slot before the
      // i-th submesh draw.) -- feat-20260608 M5 amend / w11-a.
      const handleRaw = materialCount > 0 ? (materialsView?.[0] ?? 0) : 0;

      let materialSnap: MaterialSnapshot;

      if (handleRaw === 0 || assets === undefined || assets === null) {
        // case B: missing-spec sentinel -> mid-grey defaultMaterialSnapshot.
        materialSnap = defaultMaterialSnapshot();
      } else {
        const tagged = toShared<'MaterialAsset'>(handleRaw);
        const res = resolveAssetHandle(world, tagged);
        if (!res.ok) {
          if (isRenderable) {
            const rhiErr = new RhiError({
              code: 'asset-not-registered',
              expected: 'MeshRenderer.material in AssetRegistry',
              hint: 'catalog the material via assetRegistry.catalog(guid, asset) + world.allocSharedRef before spawn, or remove the material field to fall back to default',
              detail: { assetHandle: handleRaw },
            });
            worldInternal._routeError(rhiErr as unknown as Error, {
              severity: Severity.Error,
              systemName: 'RenderSystem.extract (material asset-not-registered)',
            });
          }
          continue;
        }
        const asset = res.value;
        if (asset.kind !== 'material') {
          materialSnap = defaultMaterialSnapshot();
        } else {
          // feat-20260529 M3 / w11: material parent chain inheritance via
          // read-through _materialWalk accessor (plan-strategy D-6).
          // The old direct asset.passes / asset.paramValues read never
          // walked the parent chain, causing broken-inheritance (root cause).
          const resolvedResult = walkMaterialPassesOverSharedRefs(world, tagged, assets);
          if (!resolvedResult.ok) {
            // AC-09 / S-7 / q8=A: passes-empty or cycle must fire structured
            // error through _routeError (same routing as asset-not-registered
            // branch above). Silent continue is forbidden because it produces
            // a black screen indistinguishable from a content bug.
            const err = resolvedResult.error;
            switch (err.code) {
              case 'material-resolved-empty-passes':
                worldInternal._routeError(
                  err instanceof MaterialResolvedEmptyPassesError ? err : (err as unknown as Error),
                  {
                    severity: Severity.Error,
                    systemName: 'RenderSystem.extract (material-resolved-empty-passes)',
                  },
                );
                break;
              case 'material-circular-inheritance':
                worldInternal._routeError(err as unknown as Error, {
                  severity: Severity.Error,
                  systemName: 'RenderSystem.extract (material-circular-inheritance)',
                });
                break;
              default:
                // Exhaustive guard: unhandled error codes from _materialWalk
                // surface an internal assertion to avoid silent continuation.
                worldInternal._routeError(err as unknown as Error, {
                  severity: Severity.Error,
                  systemName: `RenderSystem.extract (_materialWalk: ${err.code})`,
                });
            }
            continue;
          }
          const resolved = resolvedResult.value;
          const pv = resolved.paramValues as Readonly<
            Record<string, number | number[] | string | undefined>
          >;

          const baseColorPv = pv.baseColor as readonly number[] | undefined;
          const baseColor = vec3.create(
            baseColorPv?.[0] ?? 1,
            baseColorPv?.[1] ?? 1,
            baseColorPv?.[2] ?? 1,
          );
          const metallicPv = typeof pv.metallic === 'number' ? pv.metallic : 0;
          const roughnessPv = typeof pv.roughness === 'number' ? pv.roughness : 0.5;

          const paramSnap: Record<string, number | number[] | string> = {};
          for (const [k, v] of Object.entries(pv)) {
            if (typeof v === 'number') paramSnap[k] = v;
            else if (typeof v === 'string') paramSnap[k] = v;
            else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
              paramSnap[k] = v as number[];
            }
          }

          const allPasses = resolved.passes;
          const firstPassShader = allPasses.length > 0 ? allPasses[0]?.shader : undefined;
          // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w17 (D-5):
          // bidirectional Skin <-> pbr-skin material fail-fast at extract.
          // Skin component without a forgeax::pbr-skin first-pass material
          // would draw with a non-skin shader against the 18-float vertex
          // buffer (joints/weights bytes interpreted as garbage). Conversely
          // a forgeax::pbr-skin material against a 12-float (unskinned) mesh
          // would have @location(4)/@location(5) read uninitialized memory.
          // Both cases route through `_routeError` + `continue` so a single
          // misconfigured entity does NOT abort the whole frame's draw list
          // (charter P3 explicit failure + plan-decisions D-5 over `return err`).
          {
            const hasSkinSkel =
              hasSkin &&
              skinSkeletonView !== undefined &&
              skinSkeletonView.get(i) !== undefined &&
              skinSkeletonView.get(i) !== 0;
            const isPbrSkinMaterial = firstPassShader === 'forgeax::pbr-skin';
            if (hasSkinSkel && !isPbrSkinMaterial) {
              worldInternal._routeError(
                new SkinMaterialMismatchError(
                  entity as unknown as number,
                  firstPassShader,
                ) as unknown as Error,
                {
                  severity: Severity.Error,
                  systemName: 'RenderSystem.extract (skin-material-mismatch)',
                },
              );
              continue;
            }
            if (isPbrSkinMaterial && fAssetHandleVal !== undefined && fAssetHandleVal !== 0) {
              const meshHandleForSkinCheck = toShared<'MeshAsset'>(fAssetHandleVal);
              const meshResForSkinCheck = resolveAssetHandle<MeshAsset>(
                world,
                meshHandleForSkinCheck,
              );
              if (meshResForSkinCheck.ok) {
                const meshAttrs = meshResForSkinCheck.value.attributes;
                const hasSkinIdx = meshAttrs.skinIndex !== undefined;
                const hasSkinWt = meshAttrs.skinWeight !== undefined;
                if (!hasSkinIdx || !hasSkinWt) {
                  const missing: 'skinIndex' | 'skinWeight' | 'both' =
                    !hasSkinIdx && !hasSkinWt ? 'both' : !hasSkinIdx ? 'skinIndex' : 'skinWeight';
                  worldInternal._routeError(
                    new MaterialSkinAttrMissingError(
                      entity as unknown as number,
                      missing,
                    ) as unknown as Error,
                    {
                      severity: Severity.Error,
                      systemName: 'RenderSystem.extract (material-skin-attr-missing)',
                    },
                  );
                  continue;
                }
              }
            }
          }
          // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w12 (D-3):
          // sprite materials now flow through the same generic paramSchema-
          // driven extract path PBR / unlit use. The narrow `forgeax::sprite`
          // exception block below covers exactly 2 plan-authorised cases:
          //   1. SpriteRegionOverride per-entity region displacement (Q4=a)
          //   2. flipX / flipY -> region fold (plan-strategy D-8)
          // No legacy paramValues field-name shim; demos and SpriteParamValues
          // are UBO-aligned (no `texture` / `baseColor` / `pivot` / `slices`
          // / `sliceMode` keys reaching this code path). AGENTS.md §Change
          // stance: "no shim layer, no v1/v2 dual-path".
          //
          // feat-20260624 M1' / t6: `'forgeax::sprite-lit'` walks the same
          // sprite-family vertex path (VsOut byte-identical, paramSchema
          // mirror) so the SAME 2 folds apply — extending `isSprite` to
          // cover both shader ids keeps the narrowing-point count at 1
          // (plan-strategy §1.6 + D-1: mirror sprite, no new branch).
          const isSprite =
            firstPassShader === 'forgeax::sprite' || firstPassShader === 'forgeax::sprite-lit';

          // feat-20260613-material-paramschema-driven-binding M4 / w23
          // (D-5 graceful): paramSchema-driven texture-field validation.
          // For each handle-shaped paramValue (typeof === 'number'),
          // verify it actually points at a registered texture asset
          // when the field is declared as a texture in the shader's
          // paramSchema; mis-typed handles (e.g. a scalar f32 stored as
          // int 0 the M4 / w22 graceful fallback resolved to a wrong
          // sub-asset) are dropped here so the record stage falls back
          // to MISSING_TEXTURE_HANDLE (default white) without raising.
          const validateTextureHandle = (
            fieldName: string,
            raw: unknown,
          ): Handle<'TextureAsset', 'shared'> | undefined => {
            // feat-20260614 M8 (D-19): a string value is an embedded texture
            // GUID; resolve it to a column handle via catalog + allocSharedRef
            // before validation. A number is an already-minted column handle.
            let handle: Handle<'TextureAsset', 'shared'>;
            if (typeof raw === 'string') {
              if (assets === null || assets === undefined) return undefined;
              // M4: intern so the GUID mints one stable handle per World
              // instead of a fresh slot every frame (GPU residency relies on
              // a stable handleSlot). onLastRelease -> gpuStore.evictTexture.
              const interned = internSharedRefFromGuid(world, assets, raw, 'TextureAsset', (h) => {
                if (gpuStore) gpuStore.evictTexture(h);
              });
              if (interned === undefined) return undefined;
              handle = interned;
            } else if (typeof raw === 'number') {
              handle = raw as unknown as Handle<'TextureAsset', 'shared'>;
            } else {
              return undefined;
            }
            if (assets === null || assets === undefined) return handle;
            const declaredFields =
              firstPassShader !== undefined
                ? assets.materialShaderTextureFieldNames(firstPassShader)
                : undefined;
            // Shader not registered (R-4 cross-worktree path) -> trust the
            // raw handle and let the record stage / GPU layer surface any
            // mismatch via MISSING_TEXTURE_HANDLE.
            if (declaredFields === undefined) return handle;
            // Field is not declared as a texture by the shader -> the
            // loader's "try every int" fallback misclassified a scalar;
            // drop the slot so the record stage uses the default white.
            if (!declaredFields.has(fieldName)) return undefined;
            // Field declared as texture: verify the handle's asset kind.
            const assetRes = resolveAssetHandle(world, handle);
            if (!assetRes.ok) return undefined;
            const kind = (assetRes.value as { kind?: string }).kind;
            if (kind !== 'texture') return undefined;
            return handle;
          };
          // feat-20260614 M8 (D-19): resolve a sampler / texture paramValue
          // that may be an embedded GUID string (catalog + allocSharedRef) or
          // an already-minted column handle (number passthrough).
          const resolveParamHandle = <B extends string>(
            raw: unknown,
            brand: B,
          ): Handle<B, 'shared'> | undefined => {
            if (typeof raw === 'number') return raw as unknown as Handle<B, 'shared'>;
            if (typeof raw === 'string') {
              if (assets === null || assets === undefined) return undefined;
              // M4: intern the GUID -> column-handle resolution (one stable
              // handle per (world, guid, brand), reused across frames).
              if (gpuStore !== undefined && brand === 'TextureAsset') {
                return internSharedRefFromGuid(world, assets, raw, brand, (handle) => {
                  gpuStore.evictTexture(handle as Handle<'TextureAsset', 'shared'>);
                });
              }
              return internSharedRefFromGuid(world, assets, raw, brand);
            }
            return undefined;
          };
          // feat-20260621-learn-render-5-5-parallax M2 / w7 (D-3): iterate the
          // shader's derive(paramSchema).textureFieldNames SSOT so the Nth
          // user-region texture (e.g. parallax heightTexture) is validated +
          // carried, replacing the hardcoded 3-field list. validateTextureHandle
          // already drops fields a shader doesn't declare as a texture.
          const userRegionFields =
            (firstPassShader !== undefined && assets !== null && assets !== undefined
              ? assets.materialShaderTextureFieldNames(firstPassShader)
              : undefined) ?? BUILTIN_USER_REGION_TEXTURE_FIELDS;
          const textureHandles = new Map<string, Handle<'TextureAsset', 'shared'>>();
          const videoTextureFields = new Map<string, Handle<'VideoAsset', 'shared'>>();
          for (const field of userRegionFields) {
            // D-5: a video-kind paramValue routes to the transient path
            // (videoTextureFields), NOT validateTextureHandle (which drops
            // kind!=='texture', the R-7 silent-fail path). Static fields fall
            // through to validateTextureHandle unchanged.
            const videoHandle =
              assets !== null && assets !== undefined
                ? resolveVideoFieldHandle(pv[field], world, assets)
                : undefined;
            if (videoHandle !== undefined) {
              videoTextureFields.set(field, videoHandle);
              continue;
            }
            const handle = validateTextureHandle(field, pv[field]);
            if (handle !== undefined) textureHandles.set(field, handle);
          }
          const baseColorTextureHandle = textureHandles.get('baseColorTexture');
          const metallicRoughnessTextureHandle = textureHandles.get('metallicRoughnessTexture');
          const normalTextureHandle = textureHandles.get('normalTexture');
          const samplerHandle = resolveParamHandle(pv.sampler, 'SamplerAsset');
          const emissiveTextureHandle = validateTextureHandle(
            'emissiveTexture',
            pv.emissiveTexture,
          );
          const occlusionTextureHandle = validateTextureHandle(
            'occlusionTexture',
            pv.occlusionTexture,
          );
          const emissivePv = pv.emissive as readonly number[] | undefined;

          // feat-20260625 M2 / w6: first-pass transparency flag folds into
          // MaterialSnapshot.transparent so the record stage can drive the
          // LDR split + premultiplied-alpha blend decision without
          // re-reading passes[]. feat-20260626-collapse M2: derive from
          // `passes[0].renderState.blend !== undefined` (blend presence is
          // the SSOT after MaterialPassDescriptor.transparent was dropped).
          // Result is plain boolean (always defined here) — written as-is
          // into the snapshot (`boolean | undefined` field, see L759).
          const firstPassTransparent: boolean = allPasses[0]?.renderState?.blend !== undefined;

          // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w12 (D-8):
          // narrow `forgeax::sprite` extract block --- folds the legacy user
          // paramValues format (flipX / flipY / slices / sliceMode + free
          // region / pivot) into the UBO-aligned paramSnapshot vec4 fields
          // (region / pivotAndSize / slicesAndMode + colorTint). Also folds
          // per-entity SpriteRegionOverride (Q4=a). After this block the
          // generic else branch picks up the snapshot via the same writer
          // path PBR / unlit use; no more shadingModel='sprite' arm, no
          // spriteFields POD (AC-02 / AC-07: extract has exactly 2 hard
          // `forgeax::sprite` checks --- this fold + the slices mesh swap on
          // the record side).
          if (isSprite) {
            // SpriteRegionOverride: per-entity per-frame region displacement.
            let overrideRegion: readonly [number, number, number, number] | undefined;
            if (hasSpriteRegionOverride) {
              const overrideView = worldInternal._getArrayView(
                entity,
                SpriteRegionOverride as unknown as typeof Transform,
                'region',
              ) as Float32Array | undefined;
              if (overrideView !== undefined && overrideView.length >= 4) {
                overrideRegion = [
                  overrideView[0] ?? 0,
                  overrideView[1] ?? 0,
                  overrideView[2] ?? 1,
                  overrideView[3] ?? 1,
                ];
              }
            }
            // Region resolution priority: SpriteRegionOverride > paramSnapshot.
            // region (UBO-aligned user input) > [0,0,1,1] identity.
            const regionPv = paramSnap.region as readonly number[] | undefined;
            let regionX = overrideRegion?.[0] ?? regionPv?.[0] ?? 0;
            let regionY = overrideRegion?.[1] ?? regionPv?.[1] ?? 0;
            let regionZ = overrideRegion?.[2] ?? regionPv?.[2] ?? 1;
            let regionW = overrideRegion?.[3] ?? regionPv?.[3] ?? 1;
            // flipX / flipY fold into region (D-8): the shader does
            // `uv * region.zw + region.xy`, so flipping along U is a sign
            // negation of region.z plus an origin offset.
            const flipXPv = typeof pv.flipX === 'number' ? pv.flipX : 0;
            const flipYPv = typeof pv.flipY === 'number' ? pv.flipY : 0;
            if (flipXPv !== 0) {
              regionX += regionZ;
              regionZ = -regionZ;
            }
            if (flipYPv !== 0) {
              regionY += regionW;
              regionW = -regionW;
            }
            paramSnap.region = [regionX, regionY, regionZ, regionW] as unknown as number[];
            // Guard: slicesAndMode must be present and zero for non-9-slice
            // sprites so the record-stage UBO writer (applyParamSnapshotToUbo)
            // writes [0,0,0,0] at offset 48 instead of leaving the
            // buildPbrMaterialUboPayload PBR baseline (e.g. occlusionStrength=1
            // at that slot). A non-zero slicesAndMode trips `useSlices=true`
            // in sprite.wgsl, which degenerates HANDLE_QUAD geometry → invisible.
            if (!('slicesAndMode' in paramSnap)) {
              (paramSnap as Record<string, unknown>).slicesAndMode = [0, 0, 0, 0];
            }
          }

          // Generic materialShaderId snapshot --- sprite included now flows
          // through this single branch (plan-strategy D-3 / AC-01 / AC-02 /
          // AC-07). The sprite block above only writes paramSnap.region (D-8
          // SpriteRegionOverride + flip fold); the rest of the UBO is filled
          // by the same paramSchema-driven path PBR / unlit use.
          materialSnap = {
            baseColor,
            metallic: metallicPv,
            roughness: roughnessPv,
            materialShaderId: firstPassShader,
            paramSnapshot: paramSnap,
            ...(textureHandles.size > 0 && { textureHandles }),
            ...(videoTextureFields.size > 0 && { videoTextureFields }),
            ...(baseColorTextureHandle !== undefined && {
              baseColorTexture: baseColorTextureHandle,
            }),
            ...(metallicRoughnessTextureHandle !== undefined && {
              metallicRoughnessTexture: metallicRoughnessTextureHandle,
            }),
            ...(normalTextureHandle !== undefined && { normalTexture: normalTextureHandle }),
            ...(samplerHandle !== undefined && { sampler: samplerHandle }),
            ...(emissivePv !== undefined && {
              emissive: [emissivePv[0] ?? 0, emissivePv[1] ?? 0, emissivePv[2] ?? 0] as readonly [
                number,
                number,
                number,
              ],
            }),
            ...(typeof pv.emissiveIntensity === 'number' && {
              emissiveIntensity: pv.emissiveIntensity,
            }),
            ...(emissiveTextureHandle !== undefined && {
              emissiveTexture: emissiveTextureHandle,
            }),
            ...(occlusionTextureHandle !== undefined && {
              occlusionTexture: occlusionTextureHandle,
            }),
            ...(typeof pv.occlusionStrength === 'number' && {
              occlusionStrength: pv.occlusionStrength,
            }),
            transparent: firstPassTransparent,
          };

          // Build dispatch entries from resolved passes.
          if (isRenderable) {
            const matchedPasses = selectPasses(allPasses, {});
            for (let pIdx = 0; pIdx < matchedPasses.length; pIdx++) {
              const pass = matchedPasses[pIdx];
              if (!pass) continue;
              dispatch.push({
                entityIndex: i,
                materialHandle: handleRaw,
                renderableIndex: renderables.length,
                passIndex: pIdx,
                queue: pass.queue ?? 2000,
                layer: layerVal,
                tags: pass.tags ?? {},
                renderState: pass.renderState,
                defines: pass.defines,
                vertexEntry: pass.vertexEntry,
                fragmentEntry: pass.fragmentEntry,
                materialShaderId: pass.shader,
                paramSnapshot: paramSnap,
                ...(pass.stencilReference !== undefined && {
                  stencilReference: pass.stencilReference,
                }),
              });
            }
          }
        }
      }

      // feat-20260609 M2/M5 corrective fixup: default-material entities
      // (handleRaw===0 / case-B MeshRenderer{data:{}}) must produce
      // ShadowCaster dispatch entries so the shadow pass includes them.
      // The pre-existing logic only builds dispatch entries from
      // resolved material assets; defaultMaterialSnapshot() (mid-grey unlit)
      // left dispatch empty, causing shadow-m2/m3 test failures.
      // Requirements §10.5: shadow-casting is default behaviour, opt-out
      // via castShadow:false.  The default material has no opt-out, so
      // it casts shadows.
      //
      // CHARTER NOTE (feat-20260609 T-005-a): the URP literals
      // `LightMode: 'ShadowCaster'` / `LightMode: 'Forward'` below are a
      // local URP-bridge — they mirror what `Materials.unlit({ castShadow:
      // true })` produces at the asset layer.  The default-material
      // handle=0 path bypasses asset registration, so we synthesize the
      // same dispatch shape inline.  Follow-up cleanup (F-1 from
      // implement-review R1): thread default materials through the
      // Materials factory so this block can call into the shared
      // passes[] producer.
      // tweak-20260701 M1: `materialSnap.shadingModel === 'unlit'` removed —
      // for handleRaw===0, defaultMaterialSnapshot() was always unlit
      // (the shadingModel check was a tautology); the isRenderable &&
      // handleRaw===0 guard alone preserves the exact same dispatch shape.
      if (isRenderable && handleRaw === 0) {
        const shadowCasterTags: Record<string, string> = { LightMode: 'ShadowCaster' };
        const nextRenderableIndex = renderables.length;
        dispatch.push({
          entityIndex: i,
          materialHandle: 0,
          renderableIndex: nextRenderableIndex,
          passIndex: 0,
          queue: 2000,
          layer: layerVal,
          tags: shadowCasterTags,
          renderState: undefined,
          defines: undefined,
          vertexEntry: 'vs_main',
          fragmentEntry: undefined,
          materialShaderId: 'forgeax::default-shadow-caster',
          paramSnapshot: {},
        });
        // Also add a Forward pass entry so the entity renders in the
        // main scene pass (mirrors Materials.unlit default).
        const forwardTags: Record<string, string> = { LightMode: 'Forward' };
        dispatch.push({
          entityIndex: i,
          materialHandle: 0,
          renderableIndex: nextRenderableIndex,
          passIndex: 1,
          queue: 2000,
          layer: layerVal,
          tags: forwardTags,
          renderState: undefined,
          defines: undefined,
          vertexEntry: 'vs_main',
          fragmentEntry: 'fs_main',
          materialShaderId: 'forgeax::default-unlit',
          paramSnapshot: {},
        });
      }

      if (isRenderable) {
        // feat-20260612 M2 / m2-6: Skin + Instances coexistence + per-joint
        // dangling fail-fast + real palette slice allocation. Replaces the
        // T-21 placeholder ({0,0} discriminator-only sentinel) with full
        // resolve / validate / write chain (D-9 reset already fired at
        // extractFrame entry; per-entity allocate + writeJointPalette here).
        let skinSlice: SkinPaletteSlice | undefined;
        if (hasSkin) {
          const skeletonHandleRaw = skinSkeletonView?.get(i);
          if (
            skeletonHandleRaw !== undefined &&
            skeletonHandleRaw !== 0 &&
            assets !== undefined &&
            assets !== null
          ) {
            // Skin + Instances coexistence is forbidden (D-10).
            if (hasInstances) {
              worldInternal._routeError(
                new SkinInstancesCoexistForbiddenError(
                  entity as unknown as number,
                ) as unknown as Error,
                {
                  severity: Severity.Error,
                  systemName: 'RenderSystem.extract (skin-instances-coexist)',
                },
              );

              continue;
            }
            // (a) Resolve skeleton asset; on failure -> skeleton-resolve-failed.
            const skeletonHandle = toShared<'SkeletonAsset'>(skeletonHandleRaw);
            const skeletonRes = resolveAssetHandle<SkeletonAsset>(world, skeletonHandle);
            if (!skeletonRes.ok || skeletonRes.value.kind !== 'skeleton') {
              worldInternal._routeError(
                new SkeletonResolveFailedError(
                  entity as unknown as number,
                  skeletonHandleRaw,
                ) as unknown as Error,
                {
                  severity: Severity.Error,
                  systemName: 'RenderSystem.extract (skeleton-resolve-failed)',
                },
              );
              continue;
            }
            const skeleton = skeletonRes.value;
            // (b) Validate joint-count agreement; D-6: world.get public API.
            const skinRes = world.get(entity, Skin);
            if (!skinRes.ok) continue;
            const skinJoints = skinRes.value.joints as unknown as Uint32Array | readonly number[];
            const jointsLength = (skinJoints as { length: number } | undefined)?.length ?? 0;
            if (jointsLength !== skeleton.jointCount) {
              worldInternal._routeError(
                new JointCountMismatchError(
                  entity as unknown as number,
                  skeleton.jointCount,
                  jointsLength,
                ) as unknown as Error,
                {
                  severity: Severity.Error,
                  systemName: 'RenderSystem.extract (joint-count-mismatch)',
                },
              );
              continue;
            }
            // (c) Per-joint Transform.world resolve via public world.get (D-2
            // retire _getArrayView for joint reads; Result.err codes
            // 'stale-entity' / 'component-not-present' are dangling-equivalent).
            // Build mat4 list eagerly so write happens once per entity (no
            // half-written slice on dangling).
            const jointWorlds = new Array<Mat4>(skeleton.jointCount);
            let jointDangling = -1;
            for (let jIdx = 0; jIdx < skeleton.jointCount; jIdx++) {
              const jointEntityRaw = (skinJoints as Uint32Array | readonly number[])[jIdx] ?? 0;
              const jointEntity = jointEntityRaw as unknown as EntityHandle;
              const r = world.get(jointEntity, Transform);
              if (!r.ok) {
                jointDangling = jIdx;
                break;
              }
              // The view aliases the column-stored 16-float mat4 (column-major).
              // Allocator's writeJointPalette expects a Mat4-shaped Float32Array.
              // brand-cast-ok: reinterpret an existing storage view, no alloc.
              jointWorlds[jIdx] = r.value.world as unknown as Mat4;
            }
            if (jointDangling >= 0) {
              worldInternal._routeError(
                new JointEntityDanglingError(
                  entity as unknown as number,
                  jointDangling,
                ) as unknown as Error,
                {
                  severity: Severity.Error,
                  systemName: 'RenderSystem.extract (joint-entity-dangling)',
                },
              );
              continue;
            }
            // (d) Slice the IBM flat Float32Array into per-joint Float32Arrays.
            //     skeleton.inverseBindMatrices length === jointCount * 16.
            const ibmFlat = skeleton.inverseBindMatrices;
            const ibms: Float32Array[] = new Array<Float32Array>(skeleton.jointCount);
            for (let jIdx = 0; jIdx < skeleton.jointCount; jIdx++) {
              ibms[jIdx] = ibmFlat.subarray(jIdx * 16, jIdx * 16 + 16);
            }
            // (e) Allocate slice + write palette via the allocator (D-9 reset
            // already fired at extractFrame entry). When the pipelineState
            // surface is absent (test fixtures that pass undefined) the
            // hasSkin segment is skipped silently — bind-pose equivalent.
            if (skinPaletteAllocator !== null) {
              const slice = skinPaletteAllocator.allocateSlice(skeleton.jointCount);
              skinPaletteAllocator.writeJointPalette(slice, ibms, jointWorlds);
              skinSlice = {
                jointCount: slice.jointCount,
                byteOffset: slice.byteOffset,
                buffer: slice.buffer,
              };
            }
          }
        }

        // feat-20260601 D-3: read the resolved world mat4 (propagateTransforms
        // output) straight from the Transform.world column array view. The
        // record stage copies these 16 floats into the mesh SSBO with zero
        // per-snapshot `mat4.compose` (AC-07). A stale slot (generation gone)
        // skips the renderable, mirroring the Instances dangling-row sweep.
        // tweak-20260611 M1 / K-3: `_getArrayView` call survives untouched;
        // only the `entity` source switched to `bundle.Entity.self[i]`.
        const worldView = worldInternal._getArrayView(entity, Transform, 'world');
        if (worldView === undefined) continue;
        const worldMat = new Float32Array(worldView);
        const transformSnap: TransformSnapshot = { world: worldMat };
        // feat-20260608 M5 amend / w11-a: per-submesh `materials[]` array
        // aligned 1-1 with `MeshAsset.submeshes[]`. materials[0] === the
        // representative entity-level snapshot already built; materials[i>=1]
        // are resolved via `resolveMaterialSnapshot` (a non-sprite, single-
        // pass-equivalent resolver — sprite per-submesh is OOS-1). When the
        // entity has no materialsView (case-B sentinel) the array is a single
        // mid-grey default mirroring the legacy single-material path so the
        // record stage's per-submesh UBO upload loop trivially writes one
        // slot, no special branch.
        const materialsArr: MaterialSnapshot[] = [materialSnap];
        if (assets !== undefined && assets !== null && materialsView !== undefined) {
          for (let mi = 1; mi < materialsView.length; mi++) {
            const subHandle = materialsView[mi] ?? 0;
            materialsArr.push(resolveMaterialSnapshot(subHandle, world, assets, gpuStore));
          }
        }

        // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 /
        // w10: SpriteInstances validation + snapshot materialisation.
        // Three structured EcsError fires at this single point (plan-strategy
        // D-6 "fail-fast at the render domain entry, not at ECS spawn-time"):
        let spriteInstancesSnap: SpriteInstancesSnapshot | undefined;
        if (hasSpriteInstances) {
          // (1) mutually exclusive with Instances (peers — pick one).
          if (hasInstances) {
            worldInternal._routeError(
              new SpriteInstancesMutuallyExclusiveWithInstancesError(
                entity as unknown as number,
              ) as unknown as Error,
              {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (sprite-instances-mutually-exclusive)',
              },
            );
            continue;
          }
          // (2) requires sprite shader — the per-instance UV region is
          // consumed by the sprite vertex shader path only (plan-strategy D-4
          // axis on sprite.wgsl). Post-collapse (PR #520): sprite is no longer
          // a `shadingModel` enum member; identification is via the first-pass
          // `materialShaderId === 'forgeax::sprite'` (OOS-1 path retained).
          //
          // feat-20260624 M1' / t6: `'forgeax::sprite-lit'` also walks the same
          // per-instance UV region vertex path (VsOut byte-identical, paramSchema
          // mirror); accept either shader id.
          if (
            materialSnap.materialShaderId !== 'forgeax::sprite' &&
            materialSnap.materialShaderId !== 'forgeax::sprite-lit'
          ) {
            worldInternal._routeError(
              new SpriteInstancesRequiresSpriteShaderError(
                entity as unknown as number,
                materialSnap.materialShaderId ?? 'undefined',
              ) as unknown as Error,
              {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (sprite-instances-requires-sprite-shader)',
              },
            );
            continue;
          }
          // (3) count mismatch — transforms.length / 16 === regions.length / 4
          // (transforms.length=0 + regions.length=0 is the zero-instance lawful
          // boundary; both derivations are 0 and equality holds, so no fire).
          const spriteRes = world.get(entity, SpriteInstances);
          if (spriteRes.ok) {
            const transforms = spriteRes.value.transforms;
            const regions = spriteRes.value.regions;
            const transformsLength = transforms.length;
            const regionsLength = regions.length;
            // Stride sanity: transforms must be mod 16, regions must be mod 4.
            // A stride violation expresses as a count mismatch under the
            // canonical derivation transforms/16 vs regions/4 — fire the
            // count-mismatch code (the same code carries detail.expectedStride).
            const tCount = transformsLength / 16;
            const rCount = regionsLength / 4;
            if (transformsLength % 16 !== 0 || regionsLength % 4 !== 0 || tCount !== rCount) {
              worldInternal._routeError(
                new SpriteInstancesCountMismatchError(
                  transformsLength,
                  regionsLength,
                ) as unknown as Error,
                {
                  severity: Severity.Error,
                  systemName: 'RenderSystem.extract (sprite-instances-count-mismatch)',
                },
              );
              continue;
            }
            // Validation passes — build the snapshot. transforms.length === 0
            // is lawful (zero-instance) and produces instanceCount=0; the
            // record stage skips drawIndexed when instanceCount===0.
            const transformsCopy = new Float32Array(transforms);
            const regionsCopy = new Float32Array(regions);
            spriteInstancesSnap = {
              transforms: transformsCopy,
              regions: regionsCopy,
              instanceCount: tCount,
              cacheKey: entity as unknown as number,
              archVersion,
            };
          }
        }

        const baseRenderable: RenderableSnapshot = {
          assetHandle: Math.round(fAssetHandle?.get(i) ?? 0),
          transform: transformSnap,
          material: materialSnap,
          materials: materialsArr,
          worldId: 0,
          entityKey: 0,
          ...(skinSlice !== undefined ? { skin: skinSlice } : {}),
          ...(spriteInstancesSnap !== undefined ? { spriteInstances: spriteInstancesSnap } : {}),
        };

        // feat-20260528-frustum-culling M3 / w10: frustum culling check.
        // Skip the entity if frustumCulled is enabled (default: 1) AND
        // a valid AABB exists AND ALL cameras' frusta reject the world-space
        // AABB. Entities with frustumCulled=0, no AABB, or inverted-infinity
        // AABB are always visible.
        const frustumCulledVal = mFrustumCulled?.[i] ?? 1;
        if (frustumCulledVal !== 0) {
          const assetHandleRaw = Math.round(fAssetHandle?.get(i) ?? 0);
          // feat-20260614 M8 (D-15/D-19): the mesh AABB resolves entirely
          // through `resolveAssetHandle(world, ...)` (builtin slots + world
          // sharedRefs); it no longer touches AssetRegistry, so the cull gate
          // must not require `assets` to be present.
          if (assetHandleRaw !== 0) {
            const taggedMesh = toShared<'MeshAsset'>(assetHandleRaw);
            const meshRes = resolveAssetHandle(world, taggedMesh);
            if (meshRes.ok) {
              const localAabb = (meshRes.value as MeshAsset).aabb;
              if (localAabb !== undefined) {
                const minX = localAabb[0] as number;
                const maxX = localAabb[3] as number;
                // Inverted-infinity empty box means always visible; skip culling.
                if (minX <= maxX) {
                  // feat-20260601 D-3: cull AABB uses the resolved world mat4
                  // directly (no compose) -- same source the record stage feeds
                  // the mesh SSBO, so cull stays same-source with render (AC-05).
                  const worldAabb = box3.create();
                  box3.transformBox3(
                    worldAabb,
                    localAabb,
                    transformSnap.world as unknown as Parameters<typeof box3.transformBox3>[2],
                  );

                  // Test against all cameras. Entity is visible if any camera
                  // frustum intersects the world-space AABB (or planes are empty
                  // from degenerate projection).
                  frustumTotal += 1;
                  let visible = frustumPlanes.length === 0;
                  for (let ci = 0; ci < frustumPlanes.length; ci++) {
                    const planes = frustumPlanes[ci] as Float32Array;
                    if (planes.length === 0) {
                      visible = true;
                      break;
                    }
                    if (
                      frustum.intersectsBox(planes as frustum.Frustum, worldAabb as box3.Box3Like)
                    ) {
                      visible = true;
                      break;
                    }
                  }
                  if (!visible) {
                    frustumCulled += 1;
                    continue;
                  }
                }
              }
            }
          }
        }

        if (hasInstances) {
          const entityKey = entity as unknown as number;
          const instRes = world.get(entity, Instances);
          if (!instRes.ok) {
            renderables.push({ ...baseRenderable, entityKey });
          } else {
            const transforms = instRes.value.transforms;
            const actualLength = transforms.length;
            if (actualLength % 16 !== 0) {
              worldInternal._routeError(new InstanceTransformsStrideMismatchError(actualLength), {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (Instances stride)',
              });

              continue;
            }
            const snapshotCopy = new Float32Array(transforms);
            const instanceCount = Math.max(1, Math.floor(actualLength / 16));
            renderables.push({
              ...baseRenderable,
              entityKey,
              instances: {
                transforms: snapshotCopy,
                instanceCount,
                cacheKey: entity as unknown as number,
                archVersion,
              },
            });
          }
        } else {
          const entityKey = entity as unknown as number;
          renderables.push({ ...baseRenderable, entityKey });
        }
      }

      // feat-20260520-2d-sprite-layer-mvp M-3 / w22 + w25: finalise the
      // pending TransparentEntry with the renderableIndex pointing at the
      // RenderableSnapshot we just pushed (when isRenderable === true).
      // The check below also covers a sprite entity that survives the
      // dangling-Instances branch (silent skip with `dispatchEntry !==
      // null` early-continue) — in that case renderableIndex is still set
      // to the just-pushed slot which is correct because materialDispatch
      // already captures the dispatch position.
    }
  });

  // M3 / w26: sort dispatch entries by queue (ascending, stable sort)
  // per plan-strategy D-3.
  dispatch = sortDispatchByQueue(dispatch);

  // D-1: collect PostProcessParams entities into Map<shaderId, Uint8Array>.
  // Last-one-wins when multiple entities bear the same shader id (mirrors
  // Camera.exposure -> CameraSnapshot pattern; extract stage only reads).
  const postProcessParams: Map<string, Uint8Array> = new Map();
  const postProcessParamsQuery = createQueryState({ with: [PostProcessParams, Entity] });
  queryRun(postProcessParamsQuery, world, (bundle) => {
    for (let i = 0; i < bundle.Entity.self.length; i++) {
      const entity = bundle.Entity.self[i] as EntityHandle;
      const read = world.get(entity, PostProcessParams);
      if (!read.ok) continue;
      postProcessParams.set(read.value.shader, read.value.data);
    }
  });

  // feat-20260621 M-A3 / w13 (D-5): engine built-in tonemap data-driven
  // provider. The engine bridges the active camera's `Camera.exposure /
  // whitePoint / tonemap` onto the SAME unified params channel custom
  // post-processes use — `Camera.exposure` stays the AI-user-facing SSOT (D-5),
  // the engine itself acts as the provider for the `'forgeax::tonemap'` shader
  // id. The 16B layout is byte-identical to the prior recordTonemapPass packing
  // (render-system-record.ts pre-w14): Float32 [exposure, whitePoint, _, pad]
  // with the mode u32 occupying the third 4-byte slot via tonemapToU32 (SSOT in
  // camera.ts). Run AFTER the user-entity collection above so the engine's
  // built-in provider is authoritative for its own reserved key (a user entity
  // can never shadow `'forgeax::tonemap'`). The single active camera mirrors
  // recordFrame's `activeCameras[0]` selection.
  const tonemapCamera = cameras[0];
  if (tonemapCamera !== undefined) {
    const tonemapBytes = new ArrayBuffer(16);
    const tonemapF32 = new Float32Array(tonemapBytes);
    const tonemapU32 = new Uint32Array(tonemapBytes);
    tonemapF32[0] = tonemapCamera.exposure;
    tonemapF32[1] = tonemapCamera.whitePoint;
    tonemapU32[2] = tonemapToU32(tonemapCamera.tonemap);
    tonemapF32[3] = 0;
    postProcessParams.set('forgeax::tonemap', new Uint8Array(tonemapBytes));
  }

  return {
    cameras,
    lights,
    renderables,
    dispatch,
    skylight,
    skylightCount,
    skybox,
    skyboxCount,
    frustumStats: { culled: frustumCulled, total: frustumTotal },
    postProcessParams,
  };
}

export function defaultTransformSnapshot(): TransformSnapshot {
  // Identity world mat4 (column-major 16 floats).
  return {
    world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  };
}

export function defaultMaterialSnapshot(): MaterialSnapshot {
  // Mid-grey unlit fallback (D-Q7 case B + extract-stage missing-spec),
  // matching the pre-w6 visual outcome where the record stage's force-cast
  // read of `firstMaterial.baseColorTexture` returned undefined and the
  // unlit fallback shader was selected.
  return {
    baseColor: vec3.create(0.5, 0.5, 0.5),
    metallic: 0,
    roughness: 1,
  };
}
