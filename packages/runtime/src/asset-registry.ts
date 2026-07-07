// @forgeax/engine-runtime - AssetRegistry v2 (feat-20260513-guid-asset-package-system).
//
// Entrypoints (feat-20260614 M8 de-handle cut, D-15/D-17/D-19): the registry
// is a GUID->payload catalogue. It no longer mints or maps handles -- column
// handles are minted on the World via `world.allocSharedRef('Kind', payload)`,
// and resolved through the two-tier `resolveAssetHandle` (BuiltinAssetRegistry
// process-static slots [1,1024) + per-World `world.sharedRefs` slots >=1024).
//
//   - catalog<T extends Asset>(guid, asset): Result<T, AssetError>
//       stores the GUID->payload entry loadByGuid resolves (dev/inline path)
//   - parseGuid(guidStr): AssetGuid
//   - lookup(guid): Asset | undefined          (catalogued payload, no fetch)
//   - loadByGuid<T extends Asset>(guid): Promise<Result<T, AssetError | ImageError | RhiError>>
//       returns the PAYLOAD T (never a handle, D-17)
//       dev/fallback: synchronous catalogue lookup wrapped in Promise
//       prod: fetch(packIndexUrl) -> parse catalog -> fetch entry -> parse Asset
//   - instantiate<T extends SceneAsset>(handle, world, parent?): Result<EntityHandle, ...>
//       handle is a `world.allocSharedRef('SceneAsset', payload)` column handle
//   - inspect(): InspectSnapshot
//
// v1 load(url) removed in feat-20260513-guid-asset-package-system (w12).
// loadByGuid is the replacement; M4/w23 adds real fetch-from-pack-index.
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15: the
// `createInstancedBuffer` / `updateInstancedBuffer` / `getInstancedGpuBuffer`
// triplet is removed alongside the `InstancedBufferAsset` POD; per-entity
// instance transforms are now stored inside the ECS via the `Instances {
// transforms: 'array<f32>' }` component (the RenderSystem record stage owns
// the GPU storage buffer + dirty-version upload). Asset closed-union narrows
// 5 -> 4; the registry surface loses the optional `RhiDevice` constructor
// argument (no remaining device consumer).
//
// Dual-backend audited: the registry is engine-agnostic (no @webgpu/types
// imports + no rhi-webgpu / rhi-wgpu references); the same instance drives
// both dual-impl shim backends through the @forgeax/engine-rhi interface
// SSOT at the consumer site.

import type { EcsError, EntityHandle, World } from '@forgeax/engine-ecs';
import { meshFromInterleaved } from '@forgeax/engine-geometry';
import type { PackError } from '@forgeax/engine-pack/errors';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { deriveAssetName } from '@forgeax/engine-pack/name';
import { err, ok, type Result, type RhiError } from '@forgeax/engine-rhi';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import {
  type AnimationChannel,
  ASSET_ERROR_HINTS,
  type Asset,
  type AssetCompression,
  type AssetEnvelope,
  AssetError,
  type AssetErrorCode,
  type AssetErrorDetail,
  type AssetRef,
  countExtraUvSets,
  derive,
  type EquirectAsset,
  type FontAsset,
  type Handle,
  handleSlot,
  IMAGE_ERROR_HINTS,
  type ImageError,
  type ImageErrorDetail,
  type ImageMetadata,
  type ImportTransport,
  type InspectEntry,
  type InspectSnapshot,
  type LoadContext,
  type Loader,
  type LoaderAsyncResult,
  type LocalEntityId,
  type MaterialAsset,
  type MaterialPassDescriptor,
  PACK_ERROR_HINTS,
  type Package,
  type ParamSchemaEntry,
  type ParseErrorDetail,
  type SceneAsset,
  type SceneEntity,
  type SceneInstanceMount,
  type SkeletonAsset,
  type TagOf,
  type TextureAsset,
  type TilesetAsset,
  type MeshAsset as TypesMeshAsset,
  toShared,
  unwrapHandle,
} from '@forgeax/engine-types';
import {
  BUILTIN_CUBE,
  BUILTIN_CYLINDER,
  BUILTIN_FLOATS_PER_VERTEX,
  BUILTIN_NINESLICE_QUAD,
  BUILTIN_QUAD,
  BUILTIN_SPHERE,
  BUILTIN_TRIANGLE,
} from './builtin-asset-registry';
import {
  ChildOf as runtimeChildOf,
  TileLayer as runtimeTileLayer,
  Tilemap as runtimeTilemap,
} from './components';
import type { LoaderRegistry } from './loader-registry';
import { resolveAssetHandle } from './resolve-asset-handle';
import { postSpawnResolveJoints } from './scene-instances/post-spawn-resolve-joints';
import { createDefaultLoaderRegistry } from './wire-default-loaders';

/**
 * Strip readonly from all fields of T. Used to mutate the MeshAsset.aabb slot
 * after mesh validation passes (the interface is readonly but register-time
 * computation writes the real AABB into the caller's placeholder).
 */

import type { EngineMetrics } from './engine-metrics';
import { unpackMeshBin } from './mesh-bin';
// feat-20260601-gpu-resource-store-extraction M1: the GPU texture / cubemap /
// mesh upload paths moved to GpuResourceStore; the registry retains only
// `numMipLevels` for the POD `mipLevelCount` mirror at load time (CPU
// metadata, no GPU resource).
import { numMipLevels } from './mipmap-generator';
import { extractSceneEntityHandleGuids } from './scene-handle-fields';

// Local minimal `ImageError` constructor (charter P5 producer / consumer
// split: the runtime AssetRegistry should not import @forgeax/engine-image
// errors module because the image package is the disk-side decoder; the
// runtime is the GPU consumer. Both packages share the `ImageError`
// interface SSOT in @forgeax/engine-types so runtime constructs the
// 4-field surface (.code / .expected / .hint / .detail) directly without
// duplicating the @forgeax/engine-image errors.ts class).
const IMAGE_ERROR_EXPECTED_LOCAL: Readonly<Record<string, string>> = {
  'image-decode-failed': 'PNG / JPG byte stream decodes successfully',
  'image-format-unsupported':
    "mime is one of ['image/png', 'image/jpeg']; texture format <-> colorSpace family agrees",
  'image-dimension-out-of-bounds':
    'width and height fall under device caps maxTextureDimension2D (or 16384 hard cap)',
  'image-meta-missing':
    "<source>.meta.json sidecar (assetType: 'image') exists in the same directory",
};

class RuntimeImageError extends Error implements ImageError {
  readonly code: ImageError['code'];
  readonly expected: string;
  readonly hint: string;
  readonly detail: ImageErrorDetail;
  constructor(detail: ImageErrorDetail) {
    const code = detail.code;
    const expected = IMAGE_ERROR_EXPECTED_LOCAL[code] ?? '';
    const hint = IMAGE_ERROR_HINTS[code];
    super(`[ImageError ${code}] expected: ${expected}; hint: ${hint}`);
    this.name = 'ImageError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

function makeImageError(detail: ImageErrorDetail): ImageError {
  return new RuntimeImageError(detail);
}

// ─── Re-exports for engine-runtime-local consumers ──────────────────────────
//
// Legacy re-exports: `Asset` widens to the 4-variant engine-types union;
// `MeshAsset` keeps the engine-types shape (with `attributes`). Consumers
// that previously imported from `./asset-registry` keep working through
// the type alias re-exports below.

export type { Asset, TypesMeshAsset as MeshAsset };

// ─── Builtin handles (D-S9 / backward compat with hello-triangle + hello-cube) ─

/**
 * Builtin unit-cube mesh handle (8 vertices + 36 indices, pos+normal
 * interleaved). Pair with `MeshFilter` to spawn a cube entity.
 *
 * @remarks Typed as `Handle<'MeshAsset', 'shared'>` — feat-20260517
 * unifies the engine-types and engine-ecs Handle brand SSOT into a single
 * `Handle<T extends string, M extends 'unique'|'shared'>` declaration
 * (research Finding 4 import-path-decoupled identity), and constructs the
 * value via the brand-creation factory `toShared<'MeshAsset'>(N)` so
 * the caller-side `as unknown as` cast is eliminated (AC-05). The
 * `'shared'` mode signals the AssetRegistry owns the lifecycle — the
 * ECS does not release the slot on despawn / removeComponent / set.
 * Runtime value is a small u32 (1).
 */
export const HANDLE_CUBE: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(1);

/**
 * Builtin triangle mesh handle (3 vertices). Pair with `MeshFilter`.
 *
 * @remarks Typed as `Handle<'MeshAsset', 'shared'>` (same narrow brand
 * as HANDLE_CUBE; constructed via the `toShared<'MeshAsset'>(N)`
 * factory per AC-05).
 */
export const HANDLE_TRIANGLE: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(2);

/**
 * Builtin unit-quad mesh handle — 4 vertices, 6 indices, 2 triangles on
 * the XY plane facing +Z. Pair with `MeshFilter` to spawn a sprite quad
 * (feat-20260520-2d-sprite-layer-mvp / M-1 / w06).
 *
 * @derives Same-shape sibling of {@link HANDLE_CUBE} / {@link HANDLE_TRIANGLE}
 *   per requirements §2.1.C: built via the `toShared<'MeshAsset'>(N)`
 *   brand-creation factory; reserved-id 3 fills the namespace hole between
 *   HANDLE_TRIANGLE=2 and FIRST_USER_HANDLE=1024 (no `BUILTIN_HANDLE_`
 *   prefix per Q2 naming decision — discoverable next to existing
 *   builtins in IDE autocomplete; charter F1 single-entry indexability).
 *
 * @reuses {@link createPlaneGeometry}(1, 1) — the procedural plane factory
 *   already produces 8-floats-per-vertex interleaved (position + normal +
 *   uv) and is then expanded to the runtime 12-floats layout (adds
 *   tangent vec4) by {@link meshFromInterleaved}. This funnels HANDLE_QUAD
 *   onto the exact same vertex pipeline branch as BUILTIN_CUBE /
 *   BUILTIN_TRIANGLE and the procedural geometry factories — zero new
 *   layout discriminator (plan-strategy §3 RT4 + D-9 + charter P4
 *   consistent abstraction).
 *
 * @reuses {@link BUILTIN_FLOATS_PER_VERTEX} = 12 (the single layout SSOT;
 *   the procedural `createPlaneGeometry` factory already returns 12F via
 *   {@link meshFromInterleaved}). Reviewer can grep `BUILTIN_FLOATS_PER_VERTEX`
 *   to enumerate every consumer of this constant.
 */
export const HANDLE_QUAD: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(3);

/**
 * Id=4 reserved builtin; occupies the next available slot under
 * FIRST_USER_HANDLE=1024. BUILTIN_SPHERE is synthesised from
 * `createSphereGeometry(1, 16, 12)` through the same
 * `meshFromInterleaved` path as BUILTIN_QUAD, so the runtime
 * 12-float stride is byte-identical to procedural output — zero
 * new layout discriminator (charter P4 consistent abstraction).
 */
export const HANDLE_SPHERE: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(4);

/**
 * Builtin cylinder mesh handle — procedural open cylinder (unit-height,
 * radius=0.5, 16 radial segments, no caps). Pair with `MeshFilter`.
 *
 * @derives Same-shape sibling of {@link HANDLE_SPHERE}: synthesised from
 *   `createCylinderGeometry(0.5, 0.5, 1, 16, 1)` through the same
 *   `meshFromInterleaved` path as BUILTIN_SPHERE, so the runtime
 *   12-float stride is byte-identical to all other built-in meshes —
 *   zero new layout discriminator (charter P4 consistent abstraction).
 *
 * @remarks Id=6 follows {@link HANDLE_NINESLICE_QUAD}=5 in the builtin slot
 *   sequence (FIRST_USER_HANDLE=1024 untouched).
 *   feat-20260701-editor-world-container-doc-ecs-collapse M0 / AC-16:
 *   GUID = deriveBuiltin('HANDLE_CYLINDER') UUIDv5
 *   (plan-strategy §2 D-6 + §5.6 builtin-guid-ssot gate)
 */
export const HANDLE_CYLINDER: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(6);

/**
 * Builtin 9-slice quad mesh handle — 4×4 grid (16 vertices, 9 sub-quads,
 * 54 indices) on the XY plane facing +Z. Pair with `MeshFilter` and a
 * `MaterialAsset` whose first pass shader is `'forgeax::sprite'` and whose
 * `paramValues.slices` is non-zero to render a 9-sliced UI panel
 * (feat-20260527-sprite-nineslice / M2 / w9).
 *
 * @derives Same-shape sibling of {@link HANDLE_QUAD}: synthesised from
 *   `createPlaneGeometry(1, 1, 3, 3)` which subdivides the unit quad into
 *   3×3 sub-quads (9 cells). The 16 grid points and 54 indices feed
 *   {@link meshFromInterleaved} so the runtime 12-float vertex stride is
 *   byte-identical to all other built-in / procedural meshes — zero new
 *   layout discriminator (charter P4 consistent abstraction).
 *
 * @remarks Id=5 follows {@link HANDLE_SPHERE}=4 in the builtin slot
 *   sequence (FIRST_USER_HANDLE=1024 untouched). The vertex shader uses
 *   `vertex_index % 4` / `vertex_index / 4` to recover (i, j) grid
 *   coordinates and four anchor vec4s to map each grid cell to the right
 *   region of the source texture; only required when the sprite material
 *   declares non-zero `slices`. For the legacy zero-slice sprite path use
 *   {@link HANDLE_QUAD}.
 *
 * @reuses {@link BUILTIN_FLOATS_PER_VERTEX} = 12 (sprite-pipeline binding
 *   table / vertex layout untouched). plan-strategy §D-2 NOTE clarifies
 *   the id=5 vs original-plan id=4 drift: HANDLE_SPHERE took id=4 in
 *   feat-20260529-fxaa-sphere-builtin before this feat landed.
 */
export const HANDLE_NINESLICE_QUAD: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(5);

/**
 * Stable GUIDs for the builtin meshes — the dash-form of
 * `deriveBuiltin('HANDLE_<NAME>')` (UUIDv5, ForgeaX namespace) in
 * `@forgeax/engine-pack`. They are inlined here (not imported) because the
 * pack derivation runs under top-level `await` (async SubtleCrypto) and
 * dragging that into the AssetRegistry constructor — a synchronous hot path
 * consumed engine-wide — would make the whole runtime module graph async.
 *
 * The single source of truth remains `deriveBuiltin`: a cross-package
 * guard test (`builtin-guid-ssot.test.ts`) asserts each literal equals the
 * derived value, so any drift in the derivation reds the suite. This pairs
 * the previously-disconnected dual truths (the u32 `HANDLE_*` constants and
 * the pack GUID strings) into one bidirectionally-resolvable table, so
 * `guidOf(HANDLE_CUBE)` no longer returns `undefined`
 * (docs/feedbacks/2026-06-03 §6.2 Tier 0).
 */
const BUILTIN_MESH_GUIDS: ReadonlyArray<readonly [Handle<'MeshAsset', 'shared'>, string]> = [
  [HANDLE_CUBE, 'cbe42beb-8975-5096-b3a1-3dda4cb4c077'],
  [HANDLE_TRIANGLE, '22592f07-d967-5116-b29c-fa9781929ba8'],
  [HANDLE_QUAD, '339338aa-a338-581c-9fc5-744267ef8a51'],
  [HANDLE_SPHERE, '95730fd2-9846-5f84-8658-0b3c971eb263'],
  [HANDLE_NINESLICE_QUAD, '692d38b4-8cac-5fb2-9dcf-f389e076d6bf'],
  // feat-20260701-editor-world-container-doc-ecs-collapse M0 / AC-16:
  // cylinder builtin handle=6, GUID = deriveBuiltin('HANDLE_CYLINDER') UUIDv5
  // (plan-strategy §5.6 builtin-guid-ssot gate)
  [HANDLE_CYLINDER, 'ab20af21-0764-55be-a7f2-b80ab3d46a0a'],
];

// D-15: the five BUILTIN_* mesh payloads + BUILTIN_FLOATS_PER_VERTEX moved to
// builtin-asset-registry.ts (the process-static vertex-layout + payload SSOT);
// imported at the top of this file. The constructor still pre-populates the
// handle->payload map from those imports (the map itself retires in w49).

// feat-20260618-asset-and-pack-name-fields M3 (D-1 / D-3): the mutable runtime
// package object every GUID of the same import path shares. `assetGuids` grows
// as `registerPackage` adds GUIDs; `assetCount` (the engine-types `Package`
// view) is derived from `assetGuids.size`, never stored (#2 Derive). The public
// `packageOf(guid)` projects this to the readonly `Package` interface.
interface MutablePackage {
  path: string;
  readonly assetGuids: Set<string>;
}

// ─── Runtime brand helper ──────────────────────────────────────────────────
//
// AC-11 inspect() `.brand` is a 4-member string literal union mirroring the
// engine-types Asset discriminated union. Map a stored Asset value to its
// brand via the `.kind` discriminator (+ `.shadingModel` refinement for
// `MaterialAsset`, preserved for forward compatibility though the runtime
// brand stays at the asset-kind level per AC-11 spec).
//
// feat-20260514 M3 / w15: the `'InstancedBufferAsset'` brand is retired
// alongside the deleted POD + 3 registry methods; the runtime brand union
// shrinks 5 -> 4 to mirror the Asset closed-union shape.
// feat-20260514 w3: re-extends to 5 with the addition of the `'SceneAsset'`
// brand mirroring the new `'scene'` kind in the Asset discriminated union.
// feat-20260618-asset-and-pack-name-fields M1 / w3: AssetBrand moved to
// @forgeax/engine-types (public, single-entry discoverability per charter F1).
// feat-20260608-tilemap-object-layer-rendering M0: AssetBrand union grows
// 13 -> 14 with `'TilesetAsset'` in @forgeax/engine-types.

// feat-20260622 D-4/D-8: the 14-arm assetBrand switch and ASSET_BRAND Record
// table are both retired (PR #496 eliminated the brand concept entirely).
// New Asset union members no longer need a brand mapping; the closed union
// exhaustive switch in test-d files is the sole type-level guard.

// ─── Schema-driven material parse result (feat-20260523 M4-T01) ──────────
// ─── AssetRegistry class ────────────────────────────────────────────────────

/**
 * Field names known to carry handle<> schema-vocab references (plan-strategy
 * D-4).  parseScenePayload uses this allowlist to replace integer values
 * with GUID strings from refs[] only for handle fields — Transform.posX=0,
 * ChildOf.parent=0 and similar non-handle integers are left untouched.
 *
 * When a new handle<> field is added to a runtime component, its field name
 * MUST be added here so parseScenePayload correctly resolves it.
 */
const HANDLE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'assetHandle',
  'material',
  'skeleton',
  'clip',
  // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w27:
  // Skylight.equirect + SkyboxBackground.equirect (shared<EquirectAsset>). The
  // generic extractSceneEntityHandleGuids path already covers shared< fields by
  // schema; this allowlist is the second scene-parse path (parseScenePayload),
  // so the new handle field name is registered here too (R-1).
  'equirect',
]);

/**
 * Field names known to carry `array<handle<X>>` schema-vocab references
 * (feat-20260608 M2 / w7: MeshRenderer.materials). Each element is a refs
 * index that resolves to a GUID string. Coexists with HANDLE_FIELD_NAMES;
 * a field name lives in exactly one set.
 */
const HANDLE_ARRAY_FIELD_NAMES: ReadonlySet<string> = new Set(['materials']);

/**
 * Structured error returned by parseScenePayload when a refs index is
 * out of bounds (F-2 / AC-02).
 */
interface ParseSceneError {
  readonly localId: number;
  readonly component: string;
  readonly field: string;
  readonly index: number;
  readonly refsLength: number;
}

// Reconstruct a SceneAsset POD from a serialised pack payload (feat-20260514
// w3 / parseAssetPayload 'scene' dispatch). The payload arrives as the
// outer pack file's `assets[i].payload` object after ajv structural
// validation; this helper re-stamps the LocalEntityId brand on each
// SceneEntity.localId field and freezes the resulting POD shape so consumer
// code sees the same readonly surface as a hand-authored SceneAsset (AC-01
// + plan-strategy §3.1 rt_pkg sub-graph).
//
// feat-20260528-scene-asset-guid-refs-and-post-instantiate M1-fixup F-1:
// refs parameter — when provided, integer values in handle-type component
// fields (identified via HANDLE_FIELD_NAMES allowlist, plan-strategy D-4)
// are replaced with refs[N] (GUID string). Non-handle integer fields
// (Transform posX/posY/posZ/quatW/scalex/y/z, ChildOf.parent Entity, etc.)
// are kept as-is.
//
// feat-20260528-scene-asset-guid-refs-and-post-instantiate M1-fixup F-2:
// out-of-bounds (N < 0 or N >= refs.length) returns a structured
// ParseSceneError with localId + component + field + index + refs.length
// so the caller can construct a precise AssetError (AC-02).
// The M1 stop-on-first-error (AC-08) behaviour is preserved.
function parseScenePayload(
  payload: Record<string, unknown>,
  refs?: string[],
): SceneAsset | ParseSceneError | undefined {
  const rawEntities = payload.entities;
  if (!Array.isArray(rawEntities)) return undefined;
  const nodes: SceneEntity[] = [];
  for (const rn of rawEntities as Array<{ localId?: unknown; components?: unknown }>) {
    if (typeof rn.localId !== 'number') return undefined;
    const rawComponents = (rn.components ?? {}) as Record<string, Record<string, unknown>>;

    // Resolve refs indices to GUID strings only for handle-type fields
    // (plan-strategy D-4 / F-1 fix: non-handle integers preserved as-is).
    if (refs) {
      const resolvedComponents: Record<string, Record<string, unknown>> = {};
      for (const compName of Object.keys(rawComponents)) {
        const rawFields = rawComponents[compName];
        if (!rawFields) continue;
        const resolvedFields: Record<string, unknown> = {};
        for (const fieldName of Object.keys(rawFields)) {
          const value = rawFields[fieldName];
          if (
            HANDLE_FIELD_NAMES.has(fieldName) &&
            typeof value === 'number' &&
            Number.isInteger(value)
          ) {
            const idx = value;
            if (idx < 0 || idx >= refs.length) {
              return {
                localId: rn.localId as number,
                component: compName,
                field: fieldName,
                index: idx,
                refsLength: refs.length,
              };
            }
            resolvedFields[fieldName] = refs[idx];
          } else if (HANDLE_ARRAY_FIELD_NAMES.has(fieldName) && Array.isArray(value)) {
            // feat-20260608 M2 / w7: array<handle<X>> field — each element is a
            // refs index resolved to a GUID string. Out-of-bounds in any element
            // surfaces the same ParseSceneError as the scalar handle path.
            const resolvedArr: string[] = [];
            for (let elemIdx = 0; elemIdx < value.length; elemIdx++) {
              const elem = value[elemIdx];
              if (typeof elem !== 'number' || !Number.isInteger(elem)) {
                resolvedFields[fieldName] = value;
                resolvedArr.length = 0;
                break;
              }
              if (elem < 0 || elem >= refs.length) {
                return {
                  localId: rn.localId as number,
                  component: compName,
                  field: `${fieldName}[${elemIdx}]`,
                  index: elem,
                  refsLength: refs.length,
                };
              }
              const ref = refs[elem];
              if (ref !== undefined) resolvedArr.push(ref);
            }
            if (resolvedArr.length === value.length) {
              resolvedFields[fieldName] = resolvedArr;
            } else if (resolvedFields[fieldName] === undefined) {
              resolvedFields[fieldName] = value;
            }
          } else {
            resolvedFields[fieldName] = value;
          }
        }
        resolvedComponents[compName] = resolvedFields as Record<string, unknown>;
      }
      nodes.push({
        localId: rn.localId as LocalEntityId,
        components: resolvedComponents,
      });
    } else {
      nodes.push({
        localId: rn.localId as LocalEntityId,
        components: rawComponents,
      });
    }
  }
  const resolvedMounts = resolveMounts(payload, refs);
  if (resolvedMounts === undefined && Array.isArray(payload.mounts)) {
    // mounts resolution failed (e.g. out-of-bounds source index)
    return undefined;
  }
  // feat-20260612 M2 fixup: resolve `skinGuids` field (refs[] indices on disk
  // -> GUID strings post-parse). The SkinAsset chain has no entity-component
  // hook so the scene must carry an explicit cross-edge list; without it,
  // browser-async-pack-fetch never loads SkinAssets and postSpawnResolveJoints
  // silently skips, leaving Skin.joints.length=0 for every frame.
  const resolvedSkinGuids = resolveSkinGuids(payload, refs);
  if (resolvedSkinGuids === undefined && Array.isArray(payload.skinGuids)) {
    return undefined;
  }
  return {
    kind: 'scene',
    entities: nodes,
    mounts: resolvedMounts as unknown as readonly SceneInstanceMount[],
    ...(resolvedSkinGuids !== undefined ? { skinGuids: resolvedSkinGuids } : {}),
  } as SceneAsset;
}

/**
 * feat-20260612 M2 fixup: resolve `SceneAsset.skinGuids` -- on-disk refs[]
 * indices into post-parse GUID strings. Mirror of {@link resolveMounts}.
 * Returns undefined when no `skinGuids` field is present (back-compat:
 * pre-M2 SceneAssets carry no skin cross-edges).
 */
function resolveSkinGuids(
  payload: Record<string, unknown>,
  refs: readonly string[] | undefined,
): readonly string[] | undefined {
  const raw = payload.skinGuids;
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw as ReadonlyArray<unknown>) {
    if (typeof item === 'string') {
      // Pre-resolved GUID string (in-memory dawn smoke / direct register path).
      out.push(item);
    } else if (typeof item === 'number' && Number.isInteger(item)) {
      // refs[] index path (browser pack-fetch JSON-roundtrip shape).
      if (refs === undefined) return undefined;
      if (item < 0 || item >= refs.length) return undefined;
      const guid = refs[item];
      if (typeof guid !== 'string') return undefined;
      out.push(guid);
    } else {
      return undefined;
    }
  }
  return out;
}

/**
 * Resolve mounts[].source integer indices through refs[] to GUID strings.
 * Mount.source is resolved positionally (not through HANDLE_FIELD_NAMES),
 * per AC-11. Returns undefined when no mounts field is present (back-compat).
 */
function resolveMounts(
  payload: Record<string, unknown>,
  refs: readonly string[] | undefined,
): ReadonlyArray<Record<string, unknown>> | undefined {
  const rawMounts = payload.mounts;
  if (!Array.isArray(rawMounts)) return undefined;
  if (refs === undefined) return rawMounts as ReadonlyArray<Record<string, unknown>>;
  const resolved: Record<string, unknown>[] = [];
  for (const rm of rawMounts as ReadonlyArray<Record<string, unknown>>) {
    const mount = { ...rm };
    const source = rm.source;
    if (typeof source === 'number' && Number.isInteger(source)) {
      const idx = source;
      if (idx < 0 || idx >= refs.length) {
        return undefined;
      }
      mount.source = refs[idx];
    }
    resolved.push(mount);
  }
  return resolved;
}

// === Inline pack-payload loader bodies (feat-20260603-asset-import-loader-injection
// M1 / w4) ===
//
// The seven `if (kind === ...)` arms that lived inside
// `AssetRegistry.parseAssetPayload` (research Finding 1) are extracted here as
// module-level `{ kind, load }` objects so they register into a
// `LoaderRegistry` (D-1) and can be imported by `wireDefaultLoaders` (w5). The
// body logic is copied verbatim — M1 is a pure refactor (AC-03), no behavioural
// change. Each parses an inline `.pack.json` payload synchronously and returns
// the `Asset` POD or `undefined` (parse rejected). The `scene` arm routes its
// structured out-of-bounds-ref error back through the LoaderOutput return
// value instead of the old shared instance slot (D-8 channel replaced by F21).

/** mesh loader — Float32Array / Uint16Array | Uint32Array normalisation -> MeshAsset.
 *
 * feat-20260611: skinIndex (Uint16Array) and skinWeight (Float32Array) accept
 * both their native typed-array shape (in-memory: dawn smoke / direct
 * `register` test) AND `number[]` (post-`JSON.stringify` shape produced by the
 * dev-server / build-mode pack-body round-trip — `JSON.stringify(pack) -> fetch
 * -> JSON.parse` flattens every typed array to a plain Array). Same dual
 * contract `skeletonLoader` / `animationClipLoader` already honour (PR #350);
 * without the array arm, every Fox.glb / Khronos skinned glTF surfaces as
 * `asset-parse-failed` on the browser path while dawn smoke stays green.
 */
export const meshLoader: Loader = {
  kind: 'mesh',
  load(payload) {
    const vertexData = payload.vertices;
    const indexData = payload.indices;
    const rawAttributes = (payload.attributes as Record<string, unknown> | undefined) ?? {};
    const attributes: Record<string, unknown> = { ...rawAttributes };

    const skinIndexRaw = rawAttributes.skinIndex;
    if (skinIndexRaw instanceof Uint16Array) {
      attributes.skinIndex = skinIndexRaw;
    } else if (Array.isArray(skinIndexRaw)) {
      attributes.skinIndex = new Uint16Array(skinIndexRaw as number[]);
    } else if (skinIndexRaw !== undefined) {
      return undefined;
    }

    const skinWeightRaw = rawAttributes.skinWeight;
    if (skinWeightRaw instanceof Float32Array) {
      attributes.skinWeight = skinWeightRaw;
    } else if (Array.isArray(skinWeightRaw)) {
      attributes.skinWeight = new Float32Array(skinWeightRaw as number[]);
    } else if (skinWeightRaw !== undefined) {
      return undefined;
    }

    let vertices: Float32Array;
    let indices: Uint16Array | Uint32Array | undefined;

    if (vertexData instanceof Float32Array) {
      vertices = vertexData;
    } else if (Array.isArray(vertexData)) {
      vertices = new Float32Array(vertexData as number[]);
    } else {
      return undefined;
    }

    // bug-20260610: index width must follow vertex count, not a hard-coded
    // Uint16Array. A glTF mesh (e.g. Sponza, ~192k merged verts) overflows
    // Uint16; round-tripping through Uint16Array silently wraps and
    // `mesh-vertex-stride-mismatch` then fires because `maxIndex + 1` no
    // longer equals `vertexCount`. Mirrors `meshIrToMeshAsset` in
    // packages/gltf/src/bridge.ts which picks Uint32 above 0xffff.
    //
    // feat-20260612 M2 fixup: when the input carries an empty index array
    // (Fox.glb-style non-indexed primitives flattened through the mesh-bin
    // sidecar with `ilen=0`), drop the indices field rather than emit a
    // 0-byte typed array. The downstream `gpu-resource-store` chooses the
    // indexed-vs-vertex-only path on `mesh.indices !== undefined`; a 0-byte
    // typed array still satisfies !== undefined and triggers a 0-size IBO
    // allocation, whose `setIndexBuffer(buffer.slice(0..0), ...)` panics
    // wgpu's `BufferSlice` "buffer slices can not be empty" assertion.
    if (indexData instanceof Uint16Array || indexData instanceof Uint32Array) {
      indices = indexData.length > 0 ? indexData : undefined;
    } else if (Array.isArray(indexData)) {
      const arr = indexData as number[];
      if (arr.length === 0) {
        indices = undefined;
      } else {
        const vertexCount = vertices.length / BUILTIN_FLOATS_PER_VERTEX;
        const useUint32 = vertexCount > 0xffff;
        indices = useUint32 ? new Uint32Array(arr) : new Uint16Array(arr);
      }
    } else if (indexData === undefined) {
      indices = undefined;
    } else {
      return undefined;
    }

    // feat-20260608 M5 / w27: pack-payload mesh assets default to a single
    // triangle-list submesh covering the full index/vertex range. Inline
    // .pack.json mesh payloads do not carry submesh tables (single-prim
    // legacy shape); render code unconditionally reads `submeshes[0]`.
    // vertexCount stored as full vertices.length (downstream computes per-
    // attribute strides; submesh keeps the buffer-element-count for now).
    //
    // bug-20260610: when the payload carries an explicit `submeshes` table
    // (gltf importer emits one per primitive), respect it. The
    // `triangle-list 0..indices.length` default fits only single-prim packs.
    const payloadSubmeshes = payload.submeshes;
    const submeshes =
      Array.isArray(payloadSubmeshes) && payloadSubmeshes.length > 0
        ? (payloadSubmeshes as unknown as TypesMeshAsset['submeshes'])
        : [
            {
              indexOffset: 0,
              indexCount: indices?.length ?? 0,
              vertexCount: vertices.length,
              topology: 'triangle-list' as const,
            },
          ];

    return {
      kind: 'mesh',
      vertices,
      ...(indices !== undefined ? { indices } : {}),
      attributes: attributes as TypesMeshAsset['attributes'],
      aabb: new Float32Array(6),
      submeshes,
    };
  },
};

/** scene loader — delegates to parseScenePayload; routes structured ref error via ctx. */
export const sceneLoader: Loader = {
  kind: 'scene',
  load(payload, refs, _ctx: LoadContext) {
    const result = parseScenePayload(payload, refs === undefined ? undefined : [...refs]);
    if (result === undefined) return undefined;
    // Structured ParseSceneError (has an `index` field absent on SceneAsset):
    // return it inline through LoaderOutput so the caller (parseAndReturnAsset)
    // can build a precise AssetError without a shared instance slot (F21).
    if ('index' in result) {
      return { ok: false, error: result as ParseErrorDetail };
    }
    return result as Asset;
  },
};

/**
 * feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
 * the legacy hardcoded texture-field allowlist Set has been removed
 * (AC-03). The materialLoader now consults `ctx.getMaterialShaderTextureFieldNames`
 * (paramSchema-derived via derive()) to know which paramValues fields carry
 * refs[] indices. When the shader is not yet registered (cross-worktree
 * shader-late-register path, plan R-4), the loader falls back to attempting
 * resolution on every int-typed paramValue in [0, refs.length) — M4 / w23's
 * extract-layer paramSchema validation catches misclassifications and routes
 * unresolved texture slots through `MISSING_TEXTURE_HANDLE`.
 */
function collectShaderTextureFieldNames(
  passesFromPayload: unknown,
  ctx: LoadContext,
): ReadonlySet<string> | undefined {
  if (!Array.isArray(passesFromPayload) || passesFromPayload.length === 0) return undefined;
  const lookup = ctx.getMaterialShaderTextureFieldNames;
  if (lookup === undefined) return undefined;
  const collected = new Set<string>();
  let anyResolved = false;
  for (const pass of passesFromPayload) {
    const shaderId = (pass as { shader?: unknown }).shader;
    if (typeof shaderId !== 'string' || shaderId.length === 0) continue;
    const fields = lookup(shaderId);
    if (fields === undefined) continue;
    anyResolved = true;
    for (const name of fields) collected.add(name);
  }
  return anyResolved ? collected : undefined;
}

/** material loader — passes + paramValues + parent ref-index -> parentGuid string. */
export const materialLoader: Loader = {
  kind: 'material',
  load(payload, refs, ctx: LoadContext) {
    const matPayload = payload;
    const passesFromPayload = matPayload.passes;
    const rawParamValues = (matPayload.paramValues as Record<string, unknown>) ?? {};

    let parentGuid: string | undefined;
    if (typeof matPayload.parent === 'number') {
      const idx = matPayload.parent;
      const refsArr = refs ?? [];
      if (idx >= 0 && idx < refsArr.length) {
        const refGuid = refsArr[idx];
        if (typeof refGuid === 'string') {
          parentGuid = refGuid;
        }
      }
      if (parentGuid === undefined) {
        return undefined;
      }
    }

    // bug-20260610: paramValues fields that are typed `handle<TextureAsset>`
    // arrive on disk as a refs[] index (small int 0..refs.length-1). The
    // build-time gltfImporter writes these as refs indices, mirroring the
    // scene's HANDLE_FIELD_NAMES treatment.
    //
    // feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
    // texture-field discovery now derives from the registered shader's
    // paramSchema via `ctx.getMaterialShaderTextureFieldNames`. When the
    // shader is registered (the common case), only declared texture fields
    // are resolved — identical to the old hardcoded-Set behaviour without the
    // SSOT duplication. When the shader is not yet registered (cross-worktree
    // shader-late-register, plan R-4), every int-typed paramValue in
    // [0, refs.length) is attempted; the M4 / w23 extract layer's paramSchema
    // validation catches misclassified scalars and falls back to
    // MISSING_TEXTURE_HANDLE.
    const paramValues: Record<string, unknown> = { ...rawParamValues };
    if (refs && refs.length > 0) {
      const shaderTextureFields = collectShaderTextureFieldNames(passesFromPayload, ctx);
      const candidateFields =
        shaderTextureFields !== undefined ? shaderTextureFields : Object.keys(paramValues);
      for (const fieldName of candidateFields) {
        const value = paramValues[fieldName];
        if (typeof value !== 'number' || !Number.isInteger(value)) continue;
        if (value < 0 || value >= refs.length) {
          // Only emit a parse-error breadcrumb when the field is declared as
          // a texture by the shader paramSchema (the OOB is unambiguous).
          // For the graceful "try every int" fallback, OOB simply means
          // "this scalar was not a refs index" — don't spam parse errors.
          if (shaderTextureFields !== undefined) {
            delete paramValues[fieldName];
          }
          continue;
        }
        const refGuid = refs[value];
        if (typeof refGuid !== 'string') {
          if (shaderTextureFields !== undefined) {
            delete paramValues[fieldName];
          }
          continue;
        }
        // feat-20260614 M8 (D-19): store the embedded sub-asset ref as its GUID
        // string (dash-form). The ECS/render side resolves GUID -> column handle
        // at use time via `world.allocSharedRef` -- the registry never mints.
        paramValues[fieldName] = refGuid;
      }
    }

    if (Array.isArray(passesFromPayload) && passesFromPayload.length > 0) {
      return {
        kind: 'material',
        passes: passesFromPayload as readonly MaterialPassDescriptor[],
        paramValues,
        parentGuid,
      } as MaterialAsset & { parentGuid?: string };
    }

    if (parentGuid !== undefined) {
      return {
        kind: 'material',
        paramValues,
        parentGuid,
      } as unknown as MaterialAsset & { parentGuid?: string };
    }

    return undefined;
  },
};

/** skeleton loader — inverseBindMatrices stride validation.
 *
 * bug-20260611: accept both `Float32Array` (in-memory: dawn smoke / direct
 * `register` test) AND `number[]` (post-`JSON.stringify` shape: `normaliseForPack`
 * in @forgeax/engine-import flattens every typed array to a plain Array so
 * `JSON.stringify(pack)` survives the dev-server / build-mode round-trip --
 * the same dual contract `meshLoader` already honours). Without the array arm
 * the .pack.json -> fetch -> JSON.parse path lands a plain object whose
 * `instanceof Float32Array` check fails, surfacing as `asset-parse-failed`
 * for any glTF carrying a Skin (e.g. Khronos Fox.glb).
 */
export const skeletonLoader: Loader = {
  kind: 'skeleton',
  load(payload) {
    const ibmRaw = payload.inverseBindMatrices;
    const jointCount = typeof payload.jointCount === 'number' ? payload.jointCount : 0;
    let ibm: Float32Array;
    if (ibmRaw instanceof Float32Array) {
      ibm = ibmRaw;
    } else if (Array.isArray(ibmRaw)) {
      ibm = new Float32Array(ibmRaw as number[]);
    } else {
      return undefined;
    }
    if (ibm.byteLength !== jointCount * 64) return undefined;
    return {
      kind: 'skeleton',
      inverseBindMatrices: ibm,
      jointCount,
    };
  },
};

/** skin loader — skeletonGuid + jointPaths validation. */
export const skinLoader: Loader = {
  kind: 'skin',
  load(payload) {
    const skeletonGuid = payload.skeletonGuid;
    const jointPathsRaw = payload.jointPaths;
    if (typeof skeletonGuid !== 'string') return undefined;
    if (!Array.isArray(jointPathsRaw)) return undefined;
    const jointPaths: string[] = [];
    for (const item of jointPathsRaw) {
      if (typeof item !== 'string') return undefined;
      jointPaths.push(item);
    }
    return { kind: 'skin', skeletonGuid, jointPaths };
  },
};

/** animation-clip loader — channels / sampler validation.
 *
 * bug-20260611: sampler.input / sampler.output accept both `Float32Array`
 * (in-memory) and `number[]` (post-`JSON.stringify` shape produced by
 * `normaliseForPack`). Same dual contract as `skeletonLoader` /
 * `meshLoader`; without it the dev `.pack.json` round-trip surfaces every
 * skinned-with-animation glTF as `asset-parse-failed`.
 */
export const animationClipLoader: Loader = {
  kind: 'animation-clip',
  load(payload) {
    const duration = typeof payload.duration === 'number' ? payload.duration : 0;
    const channelsRaw = payload.channels;
    if (!Array.isArray(channelsRaw)) return undefined;
    const channels: AnimationChannel[] = [];
    for (const ch of channelsRaw) {
      if (typeof ch !== 'object' || ch === null) return undefined;
      const chObj = ch as Record<string, unknown>;
      const targetPath = chObj.targetPath;
      const property = chObj.property;
      const samplerObj = chObj.sampler as Record<string, unknown> | undefined;
      if (!Array.isArray(targetPath)) return undefined;
      if (property !== 'translation' && property !== 'rotation' && property !== 'scale')
        return undefined;
      if (samplerObj === undefined) return undefined;
      const inputRaw = samplerObj.input;
      const outputRaw = samplerObj.output;
      const interpolation = samplerObj.interpolation;
      let input: Float32Array;
      if (inputRaw instanceof Float32Array) {
        input = inputRaw;
      } else if (Array.isArray(inputRaw)) {
        input = new Float32Array(inputRaw as number[]);
      } else {
        return undefined;
      }
      let output: Float32Array;
      if (outputRaw instanceof Float32Array) {
        output = outputRaw;
      } else if (Array.isArray(outputRaw)) {
        output = new Float32Array(outputRaw as number[]);
      } else {
        return undefined;
      }
      if (interpolation !== 'LINEAR' && interpolation !== 'STEP') return undefined;
      channels.push({
        targetPath: targetPath as readonly string[],
        property: property as 'translation' | 'rotation' | 'scale',
        sampler: { input, output, interpolation },
      });
    }
    return { kind: 'animation-clip', duration, channels };
  },
};

/**
 * The six inline pack-payload loaders, in the historical `if`-chain order.
 * `wireDefaultLoaders` (w5) registers these plus the texture / font / equirect
 * loaders (w6) and the audio placeholder (w8).
 */
export const INLINE_PACK_LOADERS: readonly Loader[] = [
  meshLoader,
  sceneLoader,
  materialLoader,
  skeletonLoader,
  skinLoader,
  animationClipLoader,
];

// === Upstream-branch loader bodies (feat-20260603-asset-import-loader-injection
// M1 / w6) ===
//
// texture / font are the two kinds that, pre-refactor, were dispatched on
// `entry.kind` in `loadByGuidProd` (above `parseAssetPayload`) through bespoke
// `loadTextureFromEntry` / `loadFontFromEntry` methods (research Finding 2).
// w6 extracts those bodies here as async loaders. They receive the catalog
// `entry` (relativeUrl + optional metadata) as the `payload` argument and use
// the injected `LoadContext` (`fetchBinary` / `resolveRef`) instead of reaching
// into `AssetRegistry` internals. They produce the `Asset` POD only;
// `registerWithGuid` stays in `loadByGuidProd` (D-2).
//
// M3 (feat-20260603-asset-import-loader-injection / w26, AC-15): the image
// decoder left the runtime. The static `@forgeax/engine-image` imports
// (`decodeImageInBrowser` / `decodeHdr`) and the dynamic node `parseImage`
// branch are gone -- the texture loader now reads ONLY a build-time-imported
// RGBA `.bin` produced by the `imageImporter` (engine-image), and a raw image
// source (`.jpg` / `.png` / `.hdr`) reaching the runtime loader is a misconfig
// that fails fast (charter P3) rather than triggering a runtime decode. The
// decode lives behind the build-time import pipeline (the runtime is the GPU
// consumer; the disk decoder is build-time only).

/** Catalog entry shape the texture / font loaders read from the `payload` slot. */
interface LoaderEntry {
  readonly guidKey: string;
  readonly relativeUrl: string;
  readonly kind: string;
  readonly metadata?: ImageMetadata | undefined;
  /** Build-time compression strategy for this artefact. `undefined` = legacy uncompressed. */
  readonly compression?: AssetCompression;
}

/** texture loader — fetch bytes -> hdr / import / dev decode -> TextureAsset POD. */
export const textureLoader: Loader = {
  kind: 'texture',
  load(payload, _refs, ctx): Promise<LoaderAsyncResult> {
    const entry = payload as unknown as LoaderEntry;
    return loadTextureAsset(entry, ctx);
  },
};

async function loadTextureAsset(entry: LoaderEntry, ctx: LoadContext): Promise<LoaderAsyncResult> {
  // feat-20260604-hdr-equirect-cube-importer-loader M2 / D-1 (import-state signal
  // converged 2026-06-06): the runtime reads only a build-time-imported RGBA
  // `.bin`. The `.bin` suffix is the SINGLE import-state judgement and it is
  // checked FIRST -- before the metadata check -- so an unimported texture row
  // always surfaces the dedicated `texture-source-not-imported` sentinel
  // (transport-eligible) regardless of whether its `metadata` is fully folded.
  // (Previously the metadata check ran first; a raw row missing width/height
  // returned the non-transport-eligible `image-meta-missing` ImageError and the
  // import-on-demand route was never reached.) `image-decode-failed` stays
  // reserved for a genuinely corrupt imported `.bin` and is never
  // transport-eligible, so a real decode failure is never silently lazy-imported.
  // `.ktx2` is also an import-state suffix (KTX2 container dispatched by magic
  // byte check downstream, D-5).
  if (!entry.relativeUrl.endsWith('.bin') && !entry.relativeUrl.endsWith('.ktx2')) {
    return {
      ok: false,
      error: new AssetError({
        code: 'texture-source-not-imported',
        expected: `a build-time-imported RGBA .bin or KTX2 .ktx2 for texture ${entry.relativeUrl}`,
        hint: ASSET_ERROR_HINTS['texture-source-not-imported'],
        detail: { sourcePath: entry.relativeUrl },
      }),
    };
  }

  const meta = entry.metadata;
  if (meta === undefined || meta.kind !== 'texture') {
    return {
      ok: false,
      error: makeImageError({
        code: 'image-meta-missing',
        sourcePath: entry.relativeUrl,
        expectedSidecarPath: `${entry.relativeUrl}.meta.json`,
      }),
    };
  }

  const fetched = await ctx.fetchBinary(
    entry.relativeUrl,
    entry.compression ? { compression: entry.compression } : undefined,
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const bytes = fetched.value;

  // KTX2 magic dispatch (D-5): cheap first-byte sniff (0xAB) keeps non-KTX2
  // texture loads from importing the codec, then verify the full 12-byte
  // identifier against the codec's SSOT constant so runtime and codec cannot
  // drift on the magic bytes.
  if (bytes.length >= 12 && bytes[0] === 0xab) {
    const { KTX2_IDENTIFIER, ktx2LevelsToRGBA, parseKtx2 } = await import('@forgeax/engine-codec');
    if (KTX2_IDENTIFIER.every((m, i) => bytes[i] === m)) {
      try {
        const parsed = await parseKtx2(bytes);
        if (!parsed.ok) {
          return {
            ok: false,
            error: new AssetError({
              code: 'asset-fetch-failed',
              expected: 'valid KTX2 texture container',
              hint: `KTX2 parse failed (${parsed.error.code}): ${(parsed.error.detail as { reason: string }).reason}. ${parsed.error.hint}`,
              detail: { sourcePath: entry.relativeUrl },
            }),
          };
        }

        const rgba = await ktx2LevelsToRGBA(parsed.value, 0);
        if (!rgba.ok) {
          return {
            ok: false,
            error: new AssetError({
              code: 'asset-fetch-failed',
              expected: 'decompressable KTX2 level data',
              hint: `KTX2 level decode failed (${rgba.error.code}): ${JSON.stringify(rgba.error.detail)}. ${rgba.error.hint}`,
              detail: { sourcePath: entry.relativeUrl },
            }),
          };
        }

        const texAsset: TextureAsset = {
          kind: 'texture',
          width: parsed.value.header.pixelWidth,
          height: parsed.value.header.pixelHeight,
          format: 'rgba8unorm',
          data: rgba.value,
          colorSpace: meta.colorSpace,
          mipmap: meta.mipmap,
          mipLevelCount: Math.max(1, parsed.value.header.levelCount),
        };
        return { ok: true, value: texAsset };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: new AssetError({
            code: 'asset-fetch-failed',
            expected: 'loadable KTX2 texture',
            hint: `KTX2 codec dynamic import or parse failed: ${message}. Check that @forgeax/engine-codec is installed.`,
            detail: { sourcePath: entry.relativeUrl },
          }),
        };
      }
    }
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const levels = meta.mipmap === true ? numMipLevels({ width, height }) : 1;
  const texAsset: TextureAsset = {
    kind: 'texture',
    width,
    height,
    format: meta.format,
    data: bytes,
    colorSpace: meta.colorSpace,
    mipmap: meta.mipmap,
    mipLevelCount: levels,
  };
  return { ok: true, value: texAsset };
}

/**
 * equirect loader (feat-20260630 M1 / w4) -- fetch the build-time-imported
 * rgba16float `.bin` and assemble an EquirectAsset POD. An equirect `.hdr`
 * folds to a single 2D image with a disk identity (unlike the retired
 * cube-texture), so it rides the same upstream-entry `.bin` path as
 * textureLoader. D-2: independent async body, no shared `.bin` parser helper
 * (the inline assembly is the whole body; abstraction would add a concept).
 */
export const equirectLoader: Loader = {
  kind: 'equirect',
  load(payload, _refs, ctx): Promise<LoaderAsyncResult> {
    const entry = payload as unknown as LoaderEntry;
    return loadEquirectAsset(entry, ctx);
  },
};

async function loadEquirectAsset(entry: LoaderEntry, ctx: LoadContext): Promise<LoaderAsyncResult> {
  // The `.bin` suffix is the single import-state judgement (mirrors
  // loadTextureAsset): an unimported equirect row fails fast with the
  // dedicated sentinel rather than reaching fetchBinary on a raw `.hdr`.
  if (!entry.relativeUrl.endsWith('.bin')) {
    return {
      ok: false,
      error: new AssetError({
        code: 'texture-source-not-imported',
        expected: `a build-time-imported rgba16float .bin for equirect ${entry.relativeUrl}`,
        hint: ASSET_ERROR_HINTS['texture-source-not-imported'],
        detail: { sourcePath: entry.relativeUrl },
      }),
    };
  }

  const meta = entry.metadata;
  if (meta === undefined || meta.kind !== 'texture') {
    return {
      ok: false,
      error: makeImageError({
        code: 'image-meta-missing',
        sourcePath: entry.relativeUrl,
        expectedSidecarPath: `${entry.relativeUrl}.meta.json`,
      }),
    };
  }

  const fetched = await ctx.fetchBinary(
    entry.relativeUrl,
    entry.compression ? { compression: entry.compression } : undefined,
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const equirectAsset: EquirectAsset = {
    kind: 'equirect',
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    format: meta.format,
    data: fetched.value,
    colorSpace: meta.colorSpace,
  };
  return { ok: true, value: equirectAsset };
}

/** font loader — fetch pack JSON -> resolve atlas/sampler refs -> FontAsset POD. */
export const fontLoader: Loader = {
  kind: 'font',
  load(payload, _refs, ctx): Promise<LoaderAsyncResult> {
    const entry = payload as unknown as LoaderEntry;
    return loadFontAsset(entry, ctx);
  },
};

async function loadFontAsset(entry: LoaderEntry, ctx: LoadContext): Promise<LoaderAsyncResult> {
  const fetched = await ctx.fetchBinary(
    entry.relativeUrl,
    entry.compression ? { compression: entry.compression } : undefined,
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(fetched.value)) as unknown;
  } catch {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-fetch-failed',
        expected: `font pack file ${entry.relativeUrl} to parse as JSON`,
        hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
      }),
    };
  }

  const packFile = raw as {
    assets?: Array<{ guid: string; kind: string; payload: Record<string, unknown> }>;
  };
  const fontEntry = (packFile.assets ?? []).find(
    (a) => a.guid.toLowerCase() === entry.guidKey.toLowerCase(),
  );
  if (fontEntry === undefined) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-not-found',
        expected: `GUID ${entry.guidKey} present in pack file ${entry.relativeUrl}`,
        hint: ASSET_ERROR_HINTS['asset-not-found'],
      }),
    };
  }
  const payloadObj = fontEntry.payload;

  const atlasGuidStr = payloadObj.atlasGuid;
  const samplerGuidStr = payloadObj.samplerGuid;
  if (typeof atlasGuidStr !== 'string' || typeof samplerGuidStr !== 'string') {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'font pack payload to contain atlasGuid and samplerGuid string fields',
        hint: 'atlas texture and sampler GUIDs must be present in the font pack payload',
      }),
    };
  }

  // feat-20260614 M8 (D-19): ensure the atlas + sampler sub-assets are
  // catalogued (recursive load), then store their GUIDs (AssetGuid) on the
  // FontAsset -- the registry never mints; the glyph layout / render side
  // resolves GUID -> column handle at use time.
  const atlasGuidParsed = AssetGuid.parse(atlasGuidStr);
  if (!atlasGuidParsed.ok) return { ok: false, error: atlasGuidParsed.error };
  const samplerGuidParsed = AssetGuid.parse(samplerGuidStr);
  if (!samplerGuidParsed.ok) return { ok: false, error: samplerGuidParsed.error };
  const atlasResolved = await ctx.resolveRef(atlasGuidStr);
  if (!atlasResolved.ok) return { ok: false, error: atlasResolved.error };
  const samplerResolved = await ctx.resolveRef(samplerGuidStr);
  if (!samplerResolved.ok) return { ok: false, error: samplerResolved.error };

  const glyphsParsed = parseFontGlyphs(payloadObj.glyphs);
  if (!glyphsParsed.ok) return { ok: false, error: glyphsParsed.error };
  const commonParsed = parseFontCommon(payloadObj.common);
  if (!commonParsed.ok) return { ok: false, error: commonParsed.error };
  const notdef = parseFontNotdef(payloadObj.notdef);

  const fontAsset: FontAsset = {
    kind: 'font',
    atlas: atlasGuidParsed.value,
    sampler: samplerGuidParsed.value,
    glyphs: glyphsParsed.value,
    common: commonParsed.value,
    ...(notdef !== undefined ? { notdef } : {}),
  };
  return { ok: true, value: fontAsset };
}

/** Parse the font payload `glyphs` Record into typed GlyphMetric entries. */
function parseFontGlyphs(
  glyphsRaw: unknown,
): { ok: true; value: FontAsset['glyphs'] } | { ok: false; error: AssetError } {
  if (typeof glyphsRaw !== 'object' || glyphsRaw === null) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'glyphs field to be a Record<number, GlyphMetric>',
        hint: `got ${typeof glyphsRaw}`,
      }),
    };
  }
  const glyphs: FontAsset['glyphs'] = {};
  for (const [codepointStr, g] of Object.entries(glyphsRaw as Record<string, unknown>)) {
    const codepoint = Number(codepointStr);
    if (Number.isNaN(codepoint)) continue;
    if (typeof g !== 'object' || g === null) continue;
    const m = g as Record<string, unknown>;
    const size = m.size as Record<string, unknown> | undefined;
    const region = m.region as Record<string, unknown> | undefined;
    if (
      typeof m.advance !== 'number' ||
      typeof m.bearingX !== 'number' ||
      typeof m.bearingY !== 'number' ||
      typeof size !== 'object' ||
      size === null ||
      typeof size.w !== 'number' ||
      typeof size.h !== 'number' ||
      typeof region !== 'object' ||
      region === null ||
      typeof region.x !== 'number' ||
      typeof region.y !== 'number' ||
      typeof region.w !== 'number' ||
      typeof region.h !== 'number'
    ) {
      continue;
    }
    glyphs[codepoint] = {
      advance: m.advance,
      bearingX: m.bearingX,
      bearingY: m.bearingY,
      size: { w: size.w, h: size.h },
      region: { x: region.x, y: region.y, w: region.w, h: region.h },
    };
  }
  return { ok: true, value: glyphs };
}

/** Parse the font payload `common` block. */
function parseFontCommon(
  commonRaw: unknown,
): { ok: true; value: FontAsset['common'] } | { ok: false; error: AssetError } {
  if (typeof commonRaw !== 'object' || commonRaw === null) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'common field to be present',
        hint: `got ${typeof commonRaw}`,
      }),
    };
  }
  const cm = commonRaw as Record<string, unknown>;
  if (
    typeof cm.lineHeight !== 'number' ||
    typeof cm.base !== 'number' ||
    typeof cm.distanceRange !== 'number' ||
    typeof cm.pxRange !== 'number' ||
    typeof cm.atlasWidth !== 'number' ||
    typeof cm.atlasHeight !== 'number'
  ) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'common block to contain all required number fields',
        hint: 'common block must have lineHeight, base, distanceRange, pxRange, atlasWidth, atlasHeight',
      }),
    };
  }
  return {
    ok: true,
    value: {
      lineHeight: cm.lineHeight,
      base: cm.base,
      distanceRange: cm.distanceRange,
      pxRange: cm.pxRange,
      atlasWidth: cm.atlasWidth,
      atlasHeight: cm.atlasHeight,
    },
  };
}

/** Parse the optional font payload `notdef` glyph. */
function parseFontNotdef(notdefRaw: unknown): FontAsset['notdef'] | undefined {
  if (typeof notdefRaw !== 'object' || notdefRaw === null) return undefined;
  const nd = notdefRaw as Record<string, unknown>;
  if (
    typeof nd.advance !== 'number' ||
    typeof nd.bearingX !== 'number' ||
    typeof nd.bearingY !== 'number'
  ) {
    return undefined;
  }
  const size = nd.size as Record<string, unknown> | undefined;
  const region = nd.region as Record<string, unknown> | undefined;
  return {
    advance: nd.advance,
    bearingX: nd.bearingX,
    bearingY: nd.bearingY,
    size: {
      w: typeof size?.w === 'number' ? size.w : 0,
      h: typeof size?.h === 'number' ? size.h : 0,
    },
    region: {
      x: typeof region?.x === 'number' ? region.x : 0,
      y: typeof region?.y === 'number' ? region.y : 0,
      w: typeof region?.w === 'number' ? region.w : 0,
      h: typeof region?.h === 'number' ? region.h : 0,
    },
  };
}

/**
 * The two upstream-branch loaders that consume a catalog entry directly
 * (research Finding 2): they are dispatched from `loadByGuidProd` off the entry
 * (not via the `.pack.json` -> parseAssetPayload path). `UPSTREAM_ENTRY_KINDS`
 * lets `loadByGuidProd` route to them without a hardcoded `if (entry.kind ===
 * ...)` chain (AC-01); it is derived from the loader objects so the kind
 * strings have one source.
 */
export const UPSTREAM_ENTRY_LOADERS: readonly Loader[] = [
  textureLoader,
  fontLoader,
  equirectLoader,
];
const UPSTREAM_ENTRY_KINDS: ReadonlySet<string> = new Set(
  UPSTREAM_ENTRY_LOADERS.map((l) => l.kind),
);

// perf-20260706: raw source-container extensions. A pack-index row whose
// relativeUrl still ends in one of these has NOT been import-cooked yet -- the
// vite-plugin-pack gltf/fbx catalog arm emits thin mesh/material/scene rows
// pointing at the source container, and only the ImportTransport (dev
// `POST /__import/:guid`) rewrites each to an importer artifact (`.<guid>.bin`).
// ddcLoad fails such rows fast (asset-not-imported) so they route to the
// transport instead of fetch+parse-failing the whole (possibly 62 MB) binary
// container once per sub-asset. Extension check only -- the importer's output
// suffix is always `.bin` / `.pack.json`, never these.
const RAW_ASSET_CONTAINER_EXTS: readonly string[] = ['.glb', '.gltf', '.fbx'];

function isRawAssetContainerUrl(relativeUrl: string): boolean {
  const q = relativeUrl.indexOf('?');
  const path = (q === -1 ? relativeUrl : relativeUrl.slice(0, q)).toLowerCase();
  return RAW_ASSET_CONTAINER_EXTS.some((ext) => path.endsWith(ext));
}

/**
 * Asset registry (instance-per-engine; `engine.assets: AssetRegistry | null`).
 *
 * The builtin meshes (`HANDLE_CUBE` / `HANDLE_TRIANGLE` / ...) are served by
 * the process-static `BuiltinAssetRegistry`, so AI users see usable handles in
 * the very first frame without registration ceremony (charter proposition 1).
 *
 * @example Catalogue a texture by GUID, load its payload, and bind a material:
 * ```ts
 * const guid = engine.assets.parseGuid('00000000-0000-7000-8000-000000000001');
 * engine.assets.catalog(guid, myTexture);                       // GUID -> payload
 * const res = await engine.assets.loadByGuid(guid);             // payload (D-17)
 * if (!res.ok) {
 *   switch (res.error.code) {
 *     case 'asset-not-found':  // guid not catalogued
 *   }
 *   return;
 * }
 * const material = world.allocSharedRef('MaterialAsset', {       // mint column handle
 *   kind: 'material',
 *   passes: [{ name: 'Forward', shader: 'forgeax::default-standard-pbr', tags: { LightMode: 'Forward' }, queue: 2000 }],
 *   paramValues: { baseColorTexture: res.value },
 * });
 * world.spawn({ component: MeshRenderer, data: { materials: [material] } });
 * ```
 */

/**
 * Register-stage fail-fast for `kind: 'mesh'` payloads whose vertices buffer
 * is not the canonical 12-floats-per-vertex layout.
 *
 * Validation spec (plan-strategy D-3):
 *   (a) asset.kind !== 'mesh' -> return null immediately
 *   (b) vertices.length === 0 && indices.length === 0 -> return null (empty mesh legal)
 *   (c) vertices.length % 12 !== 0 -> `AssetError` with code='mesh-vertex-stride-mismatch',
 *       detail = { vertexCount: 0, floatsPerVertex: vertices.length / 12 } (non-integer)
 *   (d) otherwise compute vertexCount = vertices.length / 12; scan indices for maxIndex;
 *       if maxIndex + 1 !== vertexCount -> same AssetError shape with
 *       detail = { vertexCount: maxIndex + 1, floatsPerVertex: vertices.length / (maxIndex + 1) }
 *
 * Isomorphic with `validateMaterialPayload` — both are private module-level helpers,
 * both return `AssetError | null`, and both are called from `register()` at entry.
 *
 * Anchors: charter P3 (structured failure); plan-strategy D-2 (gate at register stage);
 *          plan-strategy D-3 (three-branch validation: empty / non-divisible-12 / maxIndex mismatch);
 *          plan-strategy D-5 (physical location co-located with validateMaterialPayload).
 */
function validateMeshPayload(asset: Asset): AssetError | null {
  if (asset.kind !== 'mesh') return null;

  // feat-20260604-mesh-topology-debug-draw M5 / w13: semantic topology gate
  // (plan-strategy D-A2).
  //
  // feat-20260608 M2 / w9: topology is now per-submesh (MeshAsset.submeshes[]).
  // All topology + submesh-empty + index-OOB validation runs here.
  const submeshes = (asset as TypesMeshAsset).submeshes;
  if (submeshes.length === 0) {
    // TypesMeshAsset POD does not carry an inline GUID; the registry assigns
    // one on register, but at validation time we only have the payload. Emit
    // a stable sentinel so the closed AssetErrorDetail union still narrows.
    const guid = '<no-guid>';
    return new AssetError({
      code: 'mesh-asset-submeshes-empty',
      expected: 'submeshes array has at least one Submesh entry',
      hint: ASSET_ERROR_HINTS['mesh-asset-submeshes-empty'],
      detail: { meshAssetGuid: guid },
    });
  }

  const hasIndices = (asset.indices?.length ?? 0) > 0;
  const indexBufferLength = asset.indices?.length ?? 0;
  for (let i = 0; i < submeshes.length; i++) {
    const sm = submeshes[i];
    if (sm === undefined) continue;
    const topology = sm.topology;
    if ((topology === 'line-strip' || topology === 'triangle-strip') && !hasIndices) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: `submesh[${i}] strip topology carries an index buffer`,
        hint: 'line-strip / triangle-strip meshes must provide indices; add MeshAsset.indices or use line-list / triangle-list',
        detail: {
          field: `submeshes[${i}].topology`,
          value: topology,
          reason: 'strip-topology-without-indices',
        },
      });
    }
    if (asset.vertices.length === 0 && topology !== 'triangle-list') {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: `submesh[${i}]: empty geometry uses 'triangle-list'`,
        hint: 'a zero-vertex mesh has nothing to draw; change submesh topology to triangle-list or provide vertices',
        detail: {
          field: `submeshes[${i}].topology`,
          value: topology,
          reason: 'empty-geometry-non-default-topology',
        },
      });
    }
    // feat-20260608 M2 / w9: index-range-out-of-bounds per submesh
    if (sm.indexOffset + sm.indexCount > indexBufferLength) {
      // TypesMeshAsset POD does not carry an inline GUID; the registry assigns
      // one on register, but at validation time we only have the payload. Emit
      // a stable sentinel so the closed AssetErrorDetail union still narrows.
      const guid = '<no-guid>';
      return new AssetError({
        code: 'mesh-submesh-index-range-out-of-bounds',
        expected: `submesh[${i}].indexOffset + indexCount <= index buffer length (${indexBufferLength})`,
        hint: ASSET_ERROR_HINTS['mesh-submesh-index-range-out-of-bounds'],
        detail: {
          submeshIndex: i,
          indexOffset: sm.indexOffset,
          indexCount: sm.indexCount,
          indexBufferLength,
          meshAssetGuid: guid,
        },
      });
    }
  }

  // indices is optional (vertex-only meshes omit it); read defensively. The
  // stride invariant below stays null-safe for vertex-only meshes (D-A4).
  if (asset.vertices.length === 0 && (asset.indices?.length ?? 0) === 0) return null;

  // Skin-aware stride: when MeshAsset.attributes carries skinIndex + skinWeight,
  // the bridge promotes the interleaved buffer to 18 floats/vertex (12 base +
  // 4 uint16x4 packed via aliased Uint16 view at slots 12-13 + 4 float weights
  // at slots 14-17).
  // feat-20260629 multi-uv: extra UV sets (uv1..uv7) add 2 floats each to the
  // interleaved stride, pushed after skin data (canonical order).
  const attrs = (asset as TypesMeshAsset).attributes;
  const isSkinned =
    attrs !== undefined && attrs.skinIndex !== undefined && attrs.skinWeight !== undefined;
  const extraUvSets = countExtraUvSets(attrs);
  const floatsPerVertex = (isSkinned ? 18 : 12) + extraUvSets * 2;

  if (asset.vertices.length % floatsPerVertex !== 0) {
    return new AssetError({
      code: 'mesh-vertex-stride-mismatch',
      expected: isSkinned
        ? '18 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4 + skinIndex u16x4 + skinWeight vec4)'
        : '12 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4)',
      hint: ASSET_ERROR_HINTS['mesh-vertex-stride-mismatch'],
      detail: {
        vertexCount: 0,
        floatsPerVertex: asset.vertices.length / floatsPerVertex,
      },
    });
  }

  const vertexCount = asset.vertices.length / floatsPerVertex;
  // Vertex-only meshes (no indices) skip the maxIndex-vs-vertexCount invariant:
  // there is no index buffer to bound-check against the vertex array (D-A4).
  const indices = asset.indices;
  if (indices === undefined || indices.length === 0) return null;
  let maxIndex = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx !== undefined && idx > maxIndex) maxIndex = idx;
  }

  if (maxIndex + 1 !== vertexCount) {
    return new AssetError({
      code: 'mesh-vertex-stride-mismatch',
      expected: isSkinned
        ? '18 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4 + skinIndex u16x4 + skinWeight vec4)'
        : '12 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4)',
      hint: ASSET_ERROR_HINTS['mesh-vertex-stride-mismatch'],
      detail: {
        vertexCount: maxIndex + 1,
        floatsPerVertex: vertexCount > 0 ? asset.vertices.length / (maxIndex + 1) : 0,
      },
    });
  }

  return null;
}

// === Tileset / Tilemap / TileLayer validators (feat-20260608 M0 baseline rebuild) ===
//
// R-6 first-error path (plan-strategy §R-6 ordering, M1 extended):
//   (1) `atlases.length >= 1`                -> 'tileset-tile-entry-malformed'
//                                                .field='atlases' .scope='tileset-asset' (M1)
//   (2) region rectangle stays in atlas      -> 'tileset-region-index-out-of-range' (M0)
//   (3) `region.atlasIndex` in atlases range -> 'tileset-tile-entry-malformed'
//                                                .field='atlasIndex' .scope='tileset-asset' (M1)
//   (4) `tiles[i].regionIndex` in regions    -> 'tileset-region-index-out-of-range' (M0)
//   (5) tile entry widthCells / heightCells  -> 'tileset-tile-entry-malformed'
//        / pivotX / pivotY / collider           .field=<field> .scope='tile-entry'
//                                                .tileEntryIndex=i (M1)
//
// Tilemap / TileLayer register-time invariants use `AssetError
// 'asset-invalid-value'` with `.detail = { field, value, reason }` so the
// closed AssetErrorDetail discriminated union narrows uniformly (charter
// P4 consistent abstraction with `validateMeshPayload`).

/**
 * Optional atlas extent for `validateTilesetPayload`. When omitted, the
 * region-rectangle bounds-check is skipped — only the
 * `tiles[].regionIndex` in `[0, regions.length)` invariant runs.
 */
export interface TilesetValidateOptions {
  readonly atlasWidth?: number;
  readonly atlasHeight?: number;
}

/**
 * Construct an `AssetError` for the M1 `tileset-tile-entry-malformed`
 * code with structured `.detail` (closed 7-variant `.field` enum +
 * 2-variant `.scope` + optional `.tileEntryIndex`). The helper centralises
 * the boilerplate so each call site stays a one-liner (charter F1 single
 * affordance) and the `.detail` shape stays SSOT-aligned with
 * `AssetTilesetTileEntryMalformedDetail`.
 */
function tileEntryMalformed(args: {
  tilesetGuid: string;
  field: 'widthCells' | 'heightCells' | 'pivotX' | 'pivotY' | 'collider' | 'atlases' | 'atlasIndex';
  scope: 'tileset-asset' | 'tile-entry';
  tileEntryIndex?: number;
  expected: string;
}): AssetError {
  const detail: AssetErrorDetail = {
    code: 'tileset-tile-entry-malformed',
    field: args.field,
    scope: args.scope,
    tilesetGuid: args.tilesetGuid,
    ...(args.tileEntryIndex !== undefined ? { tileEntryIndex: args.tileEntryIndex } : {}),
    expected: args.expected,
    hint: ASSET_ERROR_HINTS['tileset-tile-entry-malformed'],
  };
  return new AssetError({
    code: 'tileset-tile-entry-malformed',
    expected: args.expected,
    hint: ASSET_ERROR_HINTS['tileset-tile-entry-malformed'],
    detail,
  });
}

/**
 * Validate the shape of a `TilesetTileCollider` value (R-6 step 5d).
 * Returns `null` when the collider is well-formed, otherwise an
 * `AssetError` with code `'tileset-tile-entry-malformed'` and
 * `.detail.field = 'collider'` (charter P3 closed schema).
 *
 * Rules per variant:
 *   - `'none'` -- always accepted.
 *   - `'rect'` -- `rect.length === 4`; each component in `[0, 1]`;
 *     `w > 0`, `h > 0`; `x + w <= 1`, `y + h <= 1`.
 *   - `'polygon'` -- `points.length >= 3`; each point's `x` and `y` in
 *     `[0, 1]`.
 *   - any other `type` discriminator surfaces the same `.field='collider'`
 *     fail-fast (unreachable through the typed surface but defends
 *     against unchecked JSON loaders, charter P4 fail-fast in depth).
 */
function validateColliderShape(
  collider: NonNullable<TilesetTileEntryColliderField>,
  tilesetGuid: string,
  tileEntryIndex: number,
): AssetError | null {
  if (collider.type === 'none') return null;
  if (collider.type === 'rect') {
    const rect = collider.rect;
    if (!Array.isArray(rect) || rect.length !== 4) {
      return tileEntryMalformed({
        tilesetGuid,
        field: 'collider',
        scope: 'tile-entry',
        tileEntryIndex,
        expected: `tiles[${tileEntryIndex}].collider.rect length === 4`,
      });
    }
    const [rx, ry, rw, rh] = rect;
    const valid =
      typeof rx === 'number' &&
      typeof ry === 'number' &&
      typeof rw === 'number' &&
      typeof rh === 'number' &&
      rx >= 0 &&
      ry >= 0 &&
      rw > 0 &&
      rh > 0 &&
      rx + rw <= 1 &&
      ry + rh <= 1;
    if (!valid) {
      return tileEntryMalformed({
        tilesetGuid,
        field: 'collider',
        scope: 'tile-entry',
        tileEntryIndex,
        expected: `tiles[${tileEntryIndex}].collider.rect in [0, 1]^2 with w > 0, h > 0, x + w <= 1, y + h <= 1`,
      });
    }
    return null;
  }
  if (collider.type === 'polygon') {
    const points = collider.points;
    if (!Array.isArray(points) || points.length < 3) {
      return tileEntryMalformed({
        tilesetGuid,
        field: 'collider',
        scope: 'tile-entry',
        tileEntryIndex,
        expected: `tiles[${tileEntryIndex}].collider.points length >= 3`,
      });
    }
    for (let j = 0; j < points.length; j++) {
      const p = points[j];
      if (
        !Array.isArray(p) ||
        p.length !== 2 ||
        typeof p[0] !== 'number' ||
        typeof p[1] !== 'number' ||
        p[0] < 0 ||
        p[0] > 1 ||
        p[1] < 0 ||
        p[1] > 1
      ) {
        return tileEntryMalformed({
          tilesetGuid,
          field: 'collider',
          scope: 'tile-entry',
          tileEntryIndex,
          expected: `tiles[${tileEntryIndex}].collider.points[${j}] in [0, 1]^2`,
        });
      }
    }
    return null;
  }
  // Unknown discriminator (only reachable via unchecked JSON loaders bypassing
  // the typed surface). Closed enum -> fail-fast (charter P3).
  return tileEntryMalformed({
    tilesetGuid,
    field: 'collider',
    scope: 'tile-entry',
    tileEntryIndex,
    expected: `tiles[${tileEntryIndex}].collider.type in {'none', 'rect', 'polygon'}`,
  });
}

/**
 * Internal alias for the optional `collider` field on `TilesetTileEntry`.
 * Localised to keep the validator helper signature math-free.
 */
type TilesetTileEntryColliderField = TilesetAsset['tiles'][number]['collider'];

/**
 * Validate a `TilesetAsset` payload at register time (M0 baseline rebuild
 * + M1 schema extension). Returns `null` on success or an `AssetError`
 * carrying the first-error details (charter P3 fail-fast). R-6 ordering:
 *
 *   1. `atlases.length >= 1` -- 'tileset-tile-entry-malformed' .field='atlases'.
 *   2. Region rectangle escapes atlas extent (when extent is supplied) --
 *      M0 code 'tileset-region-index-out-of-range'.
 *   3. `regions[i].atlasIndex` in `[0, atlases.length)` -- 'tileset-tile-entry-malformed'
 *      .field='atlasIndex'.
 *   4. `tiles[i].regionIndex` in `[0, regions.length)` -- M0 code.
 *   5. Per-tile-entry boundaries -- 'tileset-tile-entry-malformed'
 *      .field=widthCells | heightCells | pivotX | pivotY | collider,
 *      in that order, .scope='tile-entry' .tileEntryIndex=i.
 */
export function validateTilesetPayload(
  asset: TilesetAsset,
  opts: TilesetValidateOptions = {},
): AssetError | null {
  // (1) atlases empty fail-fast (M1 R-6 top-level invariant).
  if (asset.atlases.length < 1) {
    return tileEntryMalformed({
      tilesetGuid: asset.guid,
      field: 'atlases',
      scope: 'tileset-asset',
      expected: 'atlases.length >= 1',
    });
  }

  const regionCount = asset.regions.length;
  const atlasesLength = asset.atlases.length;
  // (2) region rectangle bounds-check. Negative coords / non-positive size are
  // rejected regardless of whether an atlas extent is supplied; the optional
  // atlasWidth / atlasHeight tightens the upper bound when present.
  const atlasWidth = opts.atlasWidth;
  const atlasHeight = opts.atlasHeight;
  for (let i = 0; i < regionCount; i++) {
    const region = asset.regions[i];
    if (region === undefined) continue;
    const negativeOrZero = region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0;
    const exceedsAtlas =
      typeof atlasWidth === 'number' &&
      typeof atlasHeight === 'number' &&
      (region.x + region.width > atlasWidth || region.y + region.height > atlasHeight);
    if (negativeOrZero || exceedsAtlas) {
      return new AssetError({
        code: 'tileset-region-index-out-of-range',
        expected: `regions[${i}] rectangle (x/y >= 0, width/height > 0${
          typeof atlasWidth === 'number' && typeof atlasHeight === 'number'
            ? `, x + width <= ${atlasWidth}, y + height <= ${atlasHeight}`
            : ''
        })`,
        hint: ASSET_ERROR_HINTS['tileset-region-index-out-of-range'],
        detail: {
          code: 'tileset-region-index-out-of-range',
          tilesetGuid: asset.guid,
          tileId: 0,
          regionIndex: i,
          regionCount,
        },
      });
    }
    // (3) per-region atlasIndex bounds-check (M1; optional field defaults 0).
    if (region.atlasIndex !== undefined) {
      const ai = region.atlasIndex;
      if (!Number.isInteger(ai) || ai < 0 || ai >= atlasesLength) {
        return tileEntryMalformed({
          tilesetGuid: asset.guid,
          field: 'atlasIndex',
          scope: 'tileset-asset',
          expected: `regions[${i}].atlasIndex in [0, ${atlasesLength})`,
        });
      }
    }
  }
  // (4) tile entry regionIndex in [0, regions.length) (M0 code).
  for (let i = 0; i < asset.tiles.length; i++) {
    const entry = asset.tiles[i];
    if (entry === undefined) continue;
    const ri = entry.regionIndex;
    if (!Number.isInteger(ri) || ri < 0 || ri >= regionCount) {
      return new AssetError({
        code: 'tileset-region-index-out-of-range',
        expected: `tiles[${i}].regionIndex in [0, ${regionCount})`,
        hint: ASSET_ERROR_HINTS['tileset-region-index-out-of-range'],
        detail: {
          code: 'tileset-region-index-out-of-range',
          tilesetGuid: asset.guid,
          tileId: i + 1,
          regionIndex: ri,
          regionCount,
        },
      });
    }
  }
  // (5) per-tile-entry M1 boundaries -- widthCells > heightCells > pivotX >
  // pivotY > collider, per plan-strategy §R-6 first-error order. Each loop
  // iteration runs the full sub-order on entry i before advancing to i+1 so
  // the deterministic global order is (i=0 widthCells, i=0 heightCells, ...,
  // i=0 collider, i=1 widthCells, ...). Tests in tileset-asset-validate.test.ts
  // R-6 block exercise the sub-order on a single entry.
  for (let i = 0; i < asset.tiles.length; i++) {
    const entry = asset.tiles[i];
    if (entry === undefined) continue;
    if (entry.widthCells !== undefined) {
      const w = entry.widthCells;
      if (!Number.isFinite(w) || w <= 0 || w > 64) {
        return tileEntryMalformed({
          tilesetGuid: asset.guid,
          field: 'widthCells',
          scope: 'tile-entry',
          tileEntryIndex: i,
          expected: `tiles[${i}].widthCells in (0, 64]`,
        });
      }
    }
    if (entry.heightCells !== undefined) {
      const h = entry.heightCells;
      if (!Number.isFinite(h) || h <= 0 || h > 64) {
        return tileEntryMalformed({
          tilesetGuid: asset.guid,
          field: 'heightCells',
          scope: 'tile-entry',
          tileEntryIndex: i,
          expected: `tiles[${i}].heightCells in (0, 64]`,
        });
      }
    }
    if (entry.pivotX !== undefined) {
      const px = entry.pivotX;
      if (!Number.isFinite(px) || px < 0 || px > 1) {
        return tileEntryMalformed({
          tilesetGuid: asset.guid,
          field: 'pivotX',
          scope: 'tile-entry',
          tileEntryIndex: i,
          expected: `tiles[${i}].pivotX in [0, 1]`,
        });
      }
    }
    if (entry.pivotY !== undefined) {
      const py = entry.pivotY;
      if (!Number.isFinite(py) || py < 0 || py > 1) {
        return tileEntryMalformed({
          tilesetGuid: asset.guid,
          field: 'pivotY',
          scope: 'tile-entry',
          tileEntryIndex: i,
          expected: `tiles[${i}].pivotY in [0, 1]`,
        });
      }
    }
    if (entry.collider !== undefined) {
      const colliderErr = validateColliderShape(entry.collider, asset.guid, i);
      if (colliderErr !== null) return colliderErr;
    }
  }
  return null;
}

function invalidValue(field: string, value: unknown, reason: string): AssetError {
  return new AssetError({
    code: 'asset-invalid-value',
    expected: `register-time invariant for ${field}`,
    hint: `${ASSET_ERROR_HINTS['asset-invalid-value']} (${reason})`,
    detail: { field, value, reason },
  });
}

/**
 * Validate Tilemap component invariants on the spawned entity (M0 baseline).
 *
 * Checks: `cols / rows >= 1`, `chunkSize >= 1`, `tileset` handle != 0.
 * Returns `Result.ok(undefined)` when every invariant holds, otherwise
 * `Result.err(AssetError 'asset-invalid-value')` with field-specific
 * detail (charter P3 fail-fast + P4 consistent with `validateMeshPayload`).
 */
export function validateTilemapAtRegister(
  world: World,
  tilemapEntity: EntityHandle,
): Result<void, AssetError> {
  const r = world.get(tilemapEntity, runtimeTilemap);
  if (!r.ok) {
    return err(invalidValue('Tilemap', tilemapEntity, 'tilemap-entity-missing-component'));
  }
  const cols = r.value.cols;
  const rows = r.value.rows;
  const chunkSize = r.value.chunkSize;
  const tileset = r.value.tileset;
  if (!(cols >= 1)) return err(invalidValue('Tilemap.cols', cols, 'cols-below-one'));
  if (!(rows >= 1)) return err(invalidValue('Tilemap.rows', rows, 'rows-below-one'));
  if (!(chunkSize >= 1)) {
    return err(invalidValue('Tilemap.chunkSize', chunkSize, 'chunkSize-below-one'));
  }
  if (handleSlot(tileset) === 0) {
    return err(invalidValue('Tilemap.tileset', tileset, 'tileset-handle-zero'));
  }
  return ok(undefined);
}

/**
 * Validate TileLayer component invariants on the spawned entity (M0 baseline).
 *
 * Checks: parent `ChildOf` points at a Tilemap-carrying entity AND
 * `tiles.length === parent.cols * parent.rows` (M0 second-stage mutation
 * recheck; the invariant must hold after every spawn-time mutation).
 */
export function validateTileLayerAtRegister(
  world: World,
  layerEntity: EntityHandle,
): Result<void, AssetError> {
  const layer = world.get(layerEntity, runtimeTileLayer);
  if (!layer.ok) {
    return err(invalidValue('TileLayer', layerEntity, 'tilelayer-entity-missing-component'));
  }
  const child = world.get(layerEntity, runtimeChildOf);
  if (!child.ok) {
    return err(invalidValue('TileLayer.ChildOf', layerEntity, 'tilelayer-missing-childof'));
  }
  const parentEntity = child.value.parent as EntityHandle;
  const parentTilemap = world.get(parentEntity, runtimeTilemap);
  if (!parentTilemap.ok) {
    return err(
      invalidValue('TileLayer.ChildOf.parent', parentEntity, 'tilelayer-parent-not-tilemap'),
    );
  }
  const expectedLen = parentTilemap.value.cols * parentTilemap.value.rows;
  const actualLen = layer.value.tiles.length;
  if (actualLen !== expectedLen) {
    return err(
      invalidValue(
        'TileLayer.tiles.length',
        actualLen,
        `tilelayer-tiles-length-mismatch (expected ${expectedLen}, got ${actualLen})`,
      ),
    );
  }
  return ok(undefined);
}

/**
 * Compute the implicit atlas extent of a `TilesetAsset` from its grid metadata
 * (`columns * tileWidth` x `rows * tileHeight`). Used by the register-time
 * region-bounds check when the caller does not supply explicit extents.
 */
function inferAtlasExtent(asset: TilesetAsset): { atlasWidth: number; atlasHeight: number } {
  return {
    atlasWidth: asset.columns * asset.tileWidth,
    atlasHeight: asset.rows * asset.tileHeight,
  };
}

/**
 * Compute the local-space AABB of a mesh from its position attribute.
 *
 * Reads every third float from the position buffer as (x, y, z) and computes
 * [minX, minY, minZ, maxX, maxY, maxZ]. When position is absent, empty, or
 * less than 3 floats, returns an inverted-infinity empty box ([+Inf,+Inf,+Inf,
 * -Inf,-Inf,-Inf]) — consumers interpret this as "always-visible" (no culling).
 *
 * The position attribute can be Float32Array, ArrayBuffer (re-wrapped as
 * Float32Array), or Uint16Array (unlikely for position data; treated as
 * absent). Empty vertices (0 x 12 = 0) also produce empty box.
 *
 * Anchors: plan-strategy D-7 (register-time computation); D-1 (Float32Array
 * bare type); requirements AC-02 (empty -> inverted-infinity).
 */
function computeAABB(asset: TypesMeshAsset): Float32Array {
  const pos = asset.attributes.position;
  // Convert to Float32Array if possible; bail to empty-box otherwise.
  let floatPos: Float32Array;
  if (pos instanceof Float32Array) {
    floatPos = pos;
  } else if (pos instanceof ArrayBuffer) {
    floatPos = new Float32Array(pos);
  } else {
    return emptyBox();
  }
  if (floatPos.length < 3) return emptyBox();

  let minX = floatPos[0] ?? 0;
  let minY = floatPos[1] ?? 0;
  let minZ = floatPos[2] ?? 0;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (let i = 3; i < floatPos.length; i += 3) {
    const x = floatPos[i] ?? 0;
    const y = floatPos[i + 1] ?? 0;
    const z = floatPos[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Float32Array.of(minX, minY, minZ, maxX, maxY, maxZ);
}

function emptyBox(): Float32Array {
  return Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
}

// Assigns the computed AABB to the mesh in place when the object is
// extensible; falls back to a shallow copy when frozen / sealed (e.g.
// BUILTIN_CUBE / BUILTIN_TRIANGLE / BUILTIN_QUAD reused via registerWithGuid).
function withMeshAabb(asset: TypesMeshAsset): TypesMeshAsset {
  const aabb = computeAABB(asset);
  if (Object.isExtensible(asset)) {
    (asset as { aabb: Float32Array }).aabb = aabb;
    return asset;
  }
  return { ...asset, aabb };
}

// bug-20260610 Fix B: parsed pack-file body stored in the fetchPackFile
// in-memory cache + in-flight dedup maps (D-4). Only the raw JSON shape is
// cached -- parseAssetPayload still runs per-call to look up the per-GUID
// entry (CON-2 register-before-recurse cycle safety).
interface ParsedPackFile {
  assets: Array<{
    guid: string;
    kind: string;
    payload: Record<string, unknown>;
    refs?: string[];
  }>;
}

export class AssetRegistry {
  // feat-20260614 M8 (D-15 / D-17 / D-19): the registry is a GUID -> payload
  // catalogue. It holds NO handle concept -- it cannot mint a column handle
  // (it has no World). `loadByGuid` returns the PAYLOAD; column minting
  // (`world.allocSharedRef`) is the caller's job on the ECS/render side.
  // Sub-asset refs embedded in a payload stay as GUID strings (AssetGuid /
  // dash-form), never minted at load time. Keyed by lowercased GUID string.
  private readonly assetCatalog: Map<string, AssetEnvelope<Asset>> = new Map();

  // feat-20260618-asset-and-pack-name-fields M3 (D-1): the package index that
  // backs the two-segment asset identity `<packagePath>.<name>`. `packages`
  // maps a lowercased GUID key to its `MutablePackage` (a shared object every
  // GUID of the same import path points at), or `null` for assets with no
  // package (catalog() inline + builtin, D-5). All three registration entry
  // points (catalog / loadByGuid / builtin) funnel through the single
  // `registerPackage` primitive so the XOR name invariant lands once (#1 SSOT).
  private readonly packages: Map<string, MutablePackage | null> = new Map();

  // Secondary index path -> shared MutablePackage so every GUID of the same
  // import path points at one object (the 1->N promotion + assetCount derive
  // depend on this sharing). Not a duplicate of `packages` (#2): `packages` is
  // the per-GUID lookup; this is the per-path dedup used only inside
  // registerPackage to find-or-create the shared object.
  private readonly packageByPath: Map<string, MutablePackage> = new Map();

  // Per-GUID stored display names now live on the asset envelope's `name` field
  // (the single home, replacing the retired storedNameOf side table; D-6).
  // resolveName reads `assetCatalog.get(key)?.name` as the `storedName` argument
  // of deriveAssetName. `pendingNames` bridges the one ordering where a name is
  // known before its envelope exists: the prod disk path registers the package
  // (entry names) during resolveCatalogEntry, then catalogues the body later --
  // catalog() drains the pending name into the new envelope, so nothing persists
  // here once the envelope is in place.
  private readonly pendingNames: Map<string, string> = new Map();

  // ─── Prod pack-index fetch state (M4/w23) ──────────────────────────────
  // When packIndexUrl is configured, loadByGuid fetches pack-index.json on
  // first call, caches the parsed catalog in packIndexCache, then fetches
  // the individual resource file and registers the asset.
  private packIndexUrl: string | undefined = undefined;
  private packIndexCache:
    | Map<
        string,
        {
          relativeUrl: string;
          kind: string;
          name?: string;
          metadata?: ImageMetadata | undefined;
          refs?: readonly string[];
          compression?: AssetCompression;
        }
      >
    | undefined = undefined;

  // tweak-20260609 M1: in-flight Map for recursive loadByGuid dedup + cycle
  // prevention (D-5 / B-10). Maps guidKey → Promise<Result<Handle, ...>> so
  // concurrent calls for the same GUID share the same fetch + register chain,
  // and cycles (A→B→A) terminate when the second visit hits the in-flight
  // entry for A instead of re-entering fetch.
  private readonly inFlight: Map<
    string,
    Promise<Result<unknown, AssetError | ImageError | RhiError>>
  > = new Map();

  // bug-20260610 Fix B (M3 / D-4): per-instance pack-file cache keyed by
  // relativeUrl (the .pack.json URL). `packFileInFlight` de-duplicates
  // concurrent fetches; `packFileCache` stores resolved bodies so the
  // same URL is fetched at most once per AssetRegistry lifetime (CON-6).
  private readonly packFileCache: Map<string, ParsedPackFile> = new Map();
  private readonly packFileInFlight: Map<string, Promise<ParsedPackFile>> = new Map();

  // feat-20260621-asset-registry-robustness-invalidate-inflight-cach F17c:
  // per-GUID generation counter incremented on each invalidate(guid) call.
  // loadByGuid captures this value at Promise creation and discards the
  // result (returning asset-invalidated) if the generation has changed by
  // the time the fetch completes.
  // F22: invalidateAll increments a single globalGeneration counter instead,
  // which invalidates every in-flight Promise regardless of GUID.
  private readonly generations: Map<string, number> = new Map();
  private globalGeneration: number = 0;

  // F20: per-cache Promise queue to serialise packIndexCache write operations
  // in transportOrFail. The "check -> new Map() -> set" three-step block is
  // not atomic across concurrent transportOrFail calls; chaining through a
  // single queue Promise ensures each patch completes before the next starts.
  private packIndexCachePatchQueue: Promise<void> = Promise.resolve();

  // feat-20260527-sprite-nineslice M4 / w16 + w18 (D-5 + D-9): per-Renderer
  // EngineMetrics shared with the runtime so register-time soft-warns
  // (`nineslice.tile-needs-repeat-sampler` for sliceMode=1 + sampler not
  // 'repeat') and runtime soft-warns (`nineslice.scale-too-small`) increment
  // the SAME counter map. `createRenderer.ts` calls `assets.setMetrics(metrics)`
  // immediately after constructing the registry; standalone test fixtures
  // that do not go through `createRenderer` may leave this null and the
  // soft-warn paths simply no-op (charter P9 graceful degradation: the
  // structured fail-fast branches still fire; only the metric is dropped).
  private metrics: EngineMetrics | null = null;

  // feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip M1 (D-1):
  // origin reverse-index: resolved SceneAsset copy -> original catalog GUID.
  // WeakMap so entries auto-GC when the world despawns and the copy is
  // no longer held by sharedRefs. Only the instantiate path writes here;
  // _guidForAsset consults it after the catalog identity scan MISSes.
  // SSOT for the copy provenance fact (architecture-principles #1).
  /** @internal */
  _originIndex: WeakMap<SceneAsset, string> = new WeakMap();

  /**
   * Construct a fresh registry pre-populated with the builtin cube + triangle
   * mesh handles (`HANDLE_CUBE` / `HANDLE_TRIANGLE`).
   *
   * feat-20260514 M3 / w15: the previous optional `RhiDevice` constructor
   * argument (consumed by the now-deleted `createInstancedBuffer` triplet)
   * is removed; the registry surface is engine-agnostic again. Per-entity
   * instance transforms now live inside the ECS `Instances { transforms:
   * 'array<f32>' }` component; the RenderSystem record stage owns GPU
   * storage buffer allocation + cap-gate.
   */
  // feat-20260603-asset-import-loader-injection M1 / w5 (D-7): the registry
  // dispatches `parseAssetPayload` / the texture+font upstream branches through
  // this `LoaderRegistry`. feat-20260623 M3 / w9: the loader registry is now
  // internally built by `createDefaultLoaderRegistry()` (public readonly field)
  // so host apps can reach `engine.assets.loaders.register(...)` without a
  // constructor-injection slot or a phantom passthrough wrapper.
  readonly loaders: LoaderRegistry = createDefaultLoaderRegistry();

  // feat-20260603-asset-import-loader-injection M4 / w31 (AC-19 / AC-22):
  // the optional `ImportTransport` is the *only* difference between the studio
  // form (transport injected, dev DDC miss triggers lazy import) and the shipped
  // form (transport absent, DDC miss fails fast with `asset-not-imported`).
  // The load path AFTER a successful DDC fetch is identical in both forms --
  // zero branching on transport (AC-23 key invariant). Set at construction (no
  // setter, no illegal intermediate state), same D-7 stance as LoaderRegistry.
  private readonly importTransport: ImportTransport | undefined;

  /** @internal Stored for M2 validation; TS suppressor reference */
  constructor(
    private readonly shaderRegistry: ShaderRegistry,
    importTransport?: ImportTransport | undefined,
  ) {
    void this.shaderRegistry;
    this.importTransport = importTransport;
    // feat-20260614 M8 (D-15): builtins are GUID-addressable catalogue rows.
    // The builtin payloads also live process-static in BuiltinAssetRegistry
    // (slot < BUILTIN_BASE) for handle-tier resolution; here they are
    // catalogued by GUID so loadByGuid(builtinGuid) returns the payload and
    // scene refs[] pointing at a builtin GUID resolve without a hand-
    // maintained table (docs/feedbacks/2026-06-03 §6.2 Tier 0).
    const builtinByHandle = new Map<number, Asset>([
      [handleSlot(HANDLE_CUBE), BUILTIN_CUBE],
      [handleSlot(HANDLE_TRIANGLE), BUILTIN_TRIANGLE],
      [handleSlot(HANDLE_QUAD), BUILTIN_QUAD],
      [handleSlot(HANDLE_SPHERE), BUILTIN_SPHERE],
      [handleSlot(HANDLE_NINESLICE_QUAD), BUILTIN_NINESLICE_QUAD],
      [handleSlot(HANDLE_CYLINDER), BUILTIN_CYLINDER],
    ]);
    for (const [handle, guidStr] of BUILTIN_MESH_GUIDS) {
      const parsed = AssetGuid.parse(guidStr);
      if (!parsed.ok) {
        throw new Error(`[asset-registry] builtin GUID ${guidStr} is not a valid UUID`);
      }
      const payload = builtinByHandle.get(handleSlot(handle));
      if (payload !== undefined)
        this.assetCatalog.set(guidStr.toLowerCase(), {
          guid: guidStr,
          kind: payload.kind,
          payload,
          refs: [],
        });
    }
    // D-5: builtin meshes have no import path and no source name -- register
    // them with a null package so resolveName returns '' (the detectable
    // "genuinely no name" signal). They are deliberately NOT given a synthetic
    // package + derived name (memory builtin-guid-preregister-collides).
    this._registerPackage(
      null,
      BUILTIN_MESH_GUIDS.map(([, guidStr]) => guidStr),
    );
  }

  /**
   * feat-20260527-sprite-nineslice M4 / w16 prep + w18 (D-5 + D-9): inject the
   * per-Renderer `EngineMetrics` so register-time soft-warns can bump the same
   * counter map the runtime reads through `renderer.metrics.snapshot()`. Called
   * by `createRenderer` after constructing both the registry and the metrics
   * instance; safe to skip in standalone tests (the soft-warn arms simply do
   * not record).
   */
  setMetrics(metrics: EngineMetrics): void {
    this.metrics = metrics;
  }

  /**
   * @internal — read the metrics handle for register-time soft-warn paths.
   * Returns `null` when no `createRenderer` wired the registry to a renderer
   * (the standalone-test path; the structured fail-fast branches still fire).
   */
  _getMetrics(): EngineMetrics | null {
    return this.metrics;
  }

  /**
   * @internal — reverse-lookup: find the GUID key for a catalogued asset
   * payload by identity comparison (===). Returns the GUID string if found,
   * `undefined` otherwise. This is the SSOT for the inline identity scan
   * idiom that previously existed in two places (instantiate sceneGuidKey
   * lookup and resolveSkinAsset skeleton match).
   *
   * Linear scan of the assetCatalog (Map<string, AssetEnvelope>). The O(n)
   * cost is acceptable for save-path frequencies (OOS-2).
   */
  _guidForAsset(asset: Asset): string | undefined {
    for (const [key, envelope] of this.assetCatalog) {
      if (envelope.payload === asset) {
        return key;
      }
    }
    // feat-20260703 M1 (D-1): fallback to the origin reverse-index.
    // _resolveSceneGuids produces a deep copy — identity (===) will never
    // match the catalogued original — so after the catalog scan MISSes
    // we check the WeakMap that the instantiate path populates.
    return this._originIndex.get(asset as SceneAsset);
  }

  /**
   * Configure the production pack-index URL for `loadByGuid`.
   *
   * Call this once during engine initialization with the URL where
   * `pack-index.json` is served (emitted by `@forgeax/engine-vite-plugin-pack`
   * during `vite build`). After configuration, `loadByGuid` will fetch
   * the catalog on its first invocation and cache it for subsequent calls.
   *
   * @example
   * ```ts
   * engine.assets.configurePackIndex('/pack-index.json');
   * const payloadRes = await engine.assets.loadByGuid(guid); // payload, not a handle (D-17)
   * ```
   */
  configurePackIndex(url: string): void {
    this.packIndexUrl = url;
    this.packIndexCache = undefined; // reset cache if URL changes
  }

  /**
   * feat-20260621 F17c: invalidate a single cached asset by GUID so the next
   * `loadByGuid` performs a genuinely fresh fetch. Clears, for this GUID only:
   * the catalogue entry, the in-flight dedup entry, the cached pack-file body
   * (keyed by the index entry's relativeUrl), and the pack-index entry. Then
   * increments the per-GUID generation counter so any still in-flight Promise
   * for this GUID discards its result (returns `asset-invalidated`). The body +
   * index clears are targeted (other GUIDs' cached bodies and index entries
   * survive); deleting the index entry forces `resolveCatalogEntry` to re-fetch
   * the pack-index on the next load, re-resolving the relativeUrl whose body
   * cache was just dropped. No-op when the GUID is not catalogued.
   *
   * Does NOT touch `packages` (a re-load's registerPackage overwrites them; D-8)
   * and does NOT trigger GPU resource release (OOS-1,
   * q1 boundary: the asset is CPU-only; GPU resources follow the ECS).
   *
   * @param guid - Case-insensitive GUID string or AssetGuid.
   */
  invalidate(guid: string): void {
    const guidKey = guid.toLowerCase();
    // D-6: the stored name lives on the envelope; preserve it across the delete
    // (the `packages` mapping survives, so resolveName must still see the name
    // until a re-load's registerPackage overwrites it) by parking it on
    // pendingNames -- the next catalog() of this GUID drains it back.
    const survivingName = this.assetCatalog.get(guidKey)?.name;
    if (survivingName !== undefined) this.pendingNames.set(guidKey, survivingName);
    this.assetCatalog.delete(guidKey);
    // R-1 hard fix (research-decisions.md): delete inFlight entry so the
    // next loadByGuid does not hit the old Promise whose generation no
    // longer matches (AC-04 requires a fresh fetch, not asset-invalidated).
    this.inFlight.delete(guidKey);
    // Round-2 M-A: widen the clear so a COMPLETED reload re-fetches fresh
    // bytes instead of serving the stale cached body. Ordering is load-bearing:
    // read relativeUrl from the index entry FIRST, then delete the body, then
    // delete the index entry. Targeted delete (not wholesale undefined) keeps
    // other GUIDs' cached bodies/index entries intact (per-GUID precision).
    const entry = this.packIndexCache?.get(guidKey);
    if (entry !== undefined) this.packFileCache.delete(entry.relativeUrl);
    this.packIndexCache?.delete(guidKey);
    this.generations.set(guidKey, (this.generations.get(guidKey) ?? 0) + 1);
  }

  /**
   * feat-20260621 F17c: invalidate ALL cached assets so the next `loadByGuid`
   * re-fetches both the pack-index and the asset body. Clears assetCatalog,
   * inFlight, and packFileCache (wholesale), and resets packIndexCache to
   * `undefined` (NOT `.clear()` -- an empty Map would short-circuit
   * `resolveCatalogEntry`'s `=== undefined` re-fetch guard and serve
   * asset-not-imported for every later load; undefined forces a fresh
   * fetchPackIndex). Then increments a single globalGeneration counter so every
   * in-flight Promise (regardless of GUID) discards its result. Returns the
   * number of assets that were catalogued before the call.
   *
   * Idempotent: second call on an already-empty catalogue returns clearedCount 0
   * (AC-06). Does NOT trigger GPU resource release (OOS-1).
   */
  invalidateAll(): { clearedCount: number } {
    const count = this.assetCatalog.size;
    this.assetCatalog.clear();
    this.inFlight.clear();
    this.globalGeneration++;
    // Round-2 M-A: wholesale clear of the shared body cache, and reset the
    // index cache to UNDEFINED (R2-1) -- NOT .clear(). packFileCache uses
    // .clear() because fetchPackFile checks `.get(relativeUrl)` per URL, so an
    // empty Map correctly misses and re-fetches. packIndexCache uses =undefined
    // because resolveCatalogEntry's re-fetch guard tests `=== undefined`; an
    // empty Map would short-circuit it and serve asset-not-imported for every
    // later load -- the exact F17b pollution this feat fixes. The asymmetry is
    // intentional; do not normalise the two operations.
    this.packFileCache.clear();
    this.packIndexCache = undefined;
    return { clearedCount: count };
  }

  /**
   * Force a re-fetch of the configured pack-index NOW and repopulate the cache,
   * so a synchronous `listCatalog()` immediately reflects assets added on disk
   * since boot (a freshly imported GLB's sub-assets). `loadByGuid`'s lazy
   * re-fetch only fires on a per-GUID miss and `invalidateAll()` merely clears
   * the cache (leaving `listCatalog()` empty until the next load), so neither
   * makes a Content Browser or `loadByGuid`-driven "Add to Scene" see a new
   * asset without a page reload. This does.
   *
   * No-op (returns false) when no pack-index URL is configured (dev inline
   * catalogue path) or the fetch fails — callers keep the stale cache rather
   * than blanking it. Returns true when the cache was repopulated.
   */
  async refreshCatalog(): Promise<boolean> {
    if (this.packIndexUrl === undefined) return false;
    const result = await this.fetchPackIndex();
    if (!result.ok) return false;
    this.packIndexCache = result.value;
    this.registerPackagesFromIndex(this.packIndexCache);
    return true;
  }

  /**
   * Materialise a `SceneAsset` into an existing `World` and return the
   * synthetic root `Entity` (feat-20260514 w31 sugar wrapper; AC-03 +
   * requirements §IN-3; M3: returns Entity not SceneInstanceId).
   *
   * Before spawning, handle-type component fields (e.g. `assetHandle`,
   * `material`, `skeleton`) containing GUID strings are resolved to fresh
   * user-tier `Handle` numbers via `world.allocSharedRef` (feat-20260614 M8
   * D-19 instantiate-time GUID->handle mint; supersedes the pre-D-17
   * `resolveGuid` map). GUIDs that fail to parse or are not catalogued return
   * `AssetError(code='asset-not-found')` with a hint containing the GUID,
   * node localId, and field name.
   *
   * Errors propagate verbatim through the closed
   * `AssetError | PackError | EcsError` union so AI users that already
   * narrow `loadByGuid<SceneAsset>` results reuse the same `switch
   * (err.code)` exhaustively (charter proposition 3 machine-readable
   * union; plan-strategy §3.3 closed-union transparency).
   *
   * @example
   * ```ts
   * const sceneRes = await engine.assets.loadByGuid<SceneAsset>(roomGuid); // payload (D-17)
   * if (!sceneRes.ok) return;
   * const handle = world.allocSharedRef('SceneAsset', sceneRes.value);     // mint column handle
   * const r = engine.assets.instantiate(handle, world);
   * if (!r.ok) {
   *   switch (r.error.code) {
   *     case 'asset-not-found':
   *     case 'pack-cyclic-reference':
   *     // ... AssetErrorCode | PackErrorCode | EcsErrorCode exhaustive
   *   }
   * }
   * ```
   */
  instantiate<T extends SceneAsset>(
    handle: Handle<TagOf<T>, 'shared'>,
    world: World,
    parent?: EntityHandle,
  ): Result<EntityHandle, AssetError | PackError | EcsError> {
    // feat-20260614 M8 (D-15 / D-17): resolve the SceneAsset payload from the
    // handle through the two-tier `resolveAssetHandle` (builtin / user-tier
    // world.sharedRefs) -- the registry holds no handle->payload map. Scene
    // GUID-type component fields are then resolved to fresh user-tier handles
    // via `world.allocSharedRef` (instantiate-time GUID->handle mint). When the
    // handle does not resolve to a scene payload, fall through to the ecs-only
    // path (an externally-resolved SceneAssetResolver handle).
    let instantiateResult: Result<EntityHandle, AssetError | PackError | EcsError>;
    const sceneRes0 = resolveAssetHandle<SceneAsset>(
      world,
      handle as unknown as Handle<string, 'shared'>,
    );
    const sceneAsset = sceneRes0.ok ? sceneRes0.value : undefined;
    if (sceneAsset !== undefined && sceneAsset.kind === 'scene') {
      // feat-20260622 M3 / w8: find the scene's GUID key in the catalog
      // so _resolveSceneGuids can reverse-decode from envelope.refs edges.
      const sceneGuidKey = this._guidForAsset(sceneAsset);
      const sceneRes = this._resolveSceneGuids(sceneAsset, world, sceneGuidKey);
      if (!sceneRes.ok) return sceneRes;

      // feat-20260703 M1 (D-1): register the resolved copy -> original
      // catalog GUID in the origin reverse-index so _guidForAsset can
      // find it even after the local sceneGuidKey variable is discarded.
      if (sceneGuidKey !== undefined) {
        this._originIndex.set(sceneRes.value, sceneGuidKey);
      }

      // Register the GUID-resolved SceneAsset as a shared ref so
      // world._resolveSceneAsset can resolve it transparently. The shared
      // ref alloc-grant rc=1 stays held by the alloc; the SceneInstance spawn
      // retains to rc=2 and the despawn path releases back to rc=1.
      const sharedHandle = world.allocSharedRef('SceneAsset', sceneRes.value);

      // m3-i3: wire identity resolver so mount.source already resolved
      // to a live handle number by _resolveMountsRec passes through.
      // world._resolveMountSource will call this resolver during
      // _instantiateSceneRec; when source is a number (live handle),
      // return it as-is; when source is a string (unresolved GUID),
      // fail (should not happen after resolution, but fail-safe).
      world._setSceneAssetResolver((source, _parentHandle) => {
        if (typeof source === 'number') {
          return ok(source as unknown as Handle<'SceneAsset', 'shared'>);
        }
        return err({
          code: 'asset-not-found' as const,
          expected: `mount source GUID ${source} resolved before instantiate`,
          hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
        });
      });

      // C-R2 (feat-20260622-s5 M6): instantiateScene now returns
      // `{ root, diagnostics }` on success. This runtime API keeps its
      // `Result<EntityHandle>` contract; unwrap to `root`. (Surfacing scene
      // unknown-field diagnostics through `assets.instantiate` is M7 README
      // scope — the ECS boundary `world.instantiateScene` is the SSOT today.)
      const sceneInst = world.instantiateScene(sharedHandle, parent);
      if (!sceneInst.ok) {
        return sceneInst as unknown as Result<EntityHandle, AssetError | PackError | EcsError>;
      }
      instantiateResult = ok(sceneInst.value.root);
    } else {
      // Non-resolvable handle: original ecs direct path (backward compat).
      const sceneInst = world.instantiateScene(handle as Handle<'SceneAsset', 'shared'>, parent);
      if (!sceneInst.ok) {
        return sceneInst as unknown as Result<EntityHandle, AssetError | PackError | EcsError>;
      }
      instantiateResult = ok(sceneInst.value.root);
    }

    // Post-spawn hook: auto-wire Skin.joints from jointPaths. feat-20260614 M8
    // (D-15): the Skin column holds a user-tier SkeletonAsset handle; resolve
    // it to the payload via the two-tier `resolveAssetHandle`, then match the
    // catalogued SkinAsset whose resolved skeleton payload is the same object
    // (the registry holds no handle->guid index).
    const self = this;
    const jointResolveResult = postSpawnResolveJoints(
      world,
      {
        resolveSkinAsset(skeletonHandleRaw: number) {
          const skelRes = resolveAssetHandle<SkeletonAsset>(
            world,
            skeletonHandleRaw as unknown as Handle<string, 'shared'>,
          );
          if (!skelRes.ok) return undefined;
          const skeletonPayload = skelRes.value as Asset;
          const skeletonGuid = self._guidForAsset(skeletonPayload);
          if (skeletonGuid === undefined) return undefined;
          for (const [, envelope] of self.assetCatalog) {
            const asset = envelope.payload;
            if (asset.kind !== 'skin') continue;
            const skinSkeletonGuid = asset.skeletonGuid;
            if (skinSkeletonGuid === undefined) continue;
            if (skinSkeletonGuid.toLowerCase() === skeletonGuid) {
              return asset;
            }
          }
          return undefined;
        },
      },
      instantiateResult.value,
    );
    if (!jointResolveResult.ok) {
      return { ok: false, error: jointResolveResult.error } as unknown as Result<
        EntityHandle,
        AssetError | PackError | EcsError
      >;
    }

    return instantiateResult;
  }

  /**
   * @internal
   * Transform a SceneAsset whose handle-type component fields hold GUID
   * strings (post-parseScenePayload intermediate state) into a copy whose
   * handle fields hold resolved Handle numbers.
   *
   * Schema-driven field detection (plan-strategy D-4): for each component
   * field whose Component.schema fieldType starts with `shared\<`, the
   * value is treated as a GUID string and resolved via `AssetGuid.parse` +
   * catalogue lookup + `world.allocSharedRef` (feat-20260614 M8 D-15/D-17;
   * the registry mints nothing). Unknown component names are silently passed
   * through (the ecs layer's additionalProperties check will catch unknowns at
   * spawn if appropriate).
   *
   * Stop-on-first-error (AC-08): the first unresolvable GUID aborts
   * iteration and returns `AssetError(code='asset-not-found')` with a hint
   * containing the GUID string, node localId, and field name for AI-user
   * debuggability (P3).
   */
  _resolveSceneGuids(
    scene: SceneAsset,
    world: World,
    sceneGuidKey?: string,
    _visitedMountGuids?: Set<string>,
  ): Result<SceneAsset, AssetError> {
    // feat-20260622 M3 / w8: reverse-decode from envelope.refs edges when
    // sceneGuidKey is provided and the catalog holds an envelope for this
    // scene. Each edge with sceneEntityId+sourceField.componentName carries
    // the (entityLocalId, componentName, fieldName, arrayIndex) triple —
    // no need to walk entities with resolveComponent reflection.
    // D-15/D-17 dedup contract: the same catalogued GUID referenced from
    // multiple nodes must resolve to ONE user-tier handle (one allocSharedRef
    // per unique payload), so cross-node references share a single ref-counted
    // slot. Mint once per GUID, reuse for every later occurrence.
    const resolvedMap = new Map<string, number>();
    const guidToHandle = new Map<string, number>();
    const sceneEnvelope =
      sceneGuidKey !== undefined ? this.assetCatalog.get(sceneGuidKey) : undefined;
    // Did the structured-edge branch actually resolve anything? Prod-loaded
    // packs catalogue refs[] as GUID-only edges (sourceField / sceneEntityId
    // stripped at the w7 D-10 serialization boundary), so the rich-edge loop
    // below `continue`-skips every ref and resolves nothing. When that happens
    // we MUST fall through to the entity-walk fallback — otherwise the handle
    // fields keep their GUID strings and `spawn` writes the sentinel 0 while
    // `retainSharedScalarHandle(GUID)` routes `shared-ref-released` (the on-disk
    // game-scene instantiate crash: enemy MeshFilter.assetHandle).
    let resolvedFromEdges = false;
    if (
      sceneEnvelope !== undefined &&
      sceneEnvelope.refs !== undefined &&
      sceneEnvelope.refs.length > 0
    ) {
      for (const ref of sceneEnvelope.refs) {
        const { sceneEntityId, sourceField } = ref;
        if (sceneEntityId === undefined || sourceField === undefined) continue;
        const { componentName, fieldName, arrayIndex } = sourceField;
        if (componentName === undefined || fieldName === undefined) continue;

        const fieldPath = `${componentName}.${fieldName}${arrayIndex !== undefined ? `[${arrayIndex}]` : ''}`;

        const envelope = this.assetCatalog.get(ref.guid.toLowerCase());
        if (envelope === undefined) {
          return err(
            new AssetError({
              code: 'asset-not-found',
              expected: `GUID ${ref.guid} catalogued in AssetRegistry`,
              hint:
                `GUID ${ref.guid} not catalogued; ` +
                `call loadByGuid('${ref.guid}') before instantiate; ` +
                `at node localId=${sceneEntityId}, field=${fieldPath}`,
            }),
          );
        }
        const payload = envelope.payload;
        const guidKey = ref.guid.toLowerCase();
        let resolvedSlot = guidToHandle.get(guidKey);
        if (resolvedSlot === undefined) {
          resolvedSlot = unwrapHandle(world.allocSharedRef(payload.kind, payload));
          guidToHandle.set(guidKey, resolvedSlot);
        }

        const key =
          `${sceneEntityId}|${componentName}|${fieldName}` +
          (arrayIndex !== undefined ? `|${arrayIndex}` : '|');
        resolvedMap.set(key, resolvedSlot);
        resolvedFromEdges = true;
      }
    }
    if (!resolvedFromEdges) {
      // Fallback: positive extraction via extractSceneEntityHandleGuids when
      // the structured edges resolved nothing — either the scene envelope is
      // absent (unit tests that build a SceneAsset without cataloguing it) OR
      // the catalogued refs[] are GUID-only with no per-entity metadata (the
      // prod on-disk pack path). The entity-component walk recovers the
      // (localId, componentName, fieldName, arrayIndex) triple the bare edge
      // dropped, so GUID strings resolve to live handles before spawn.
      const entries = extractSceneEntityHandleGuids(
        scene.entities as unknown as ReadonlyArray<{
          readonly localId: number;
          readonly components: Record<string, Record<string, unknown>>;
        }>,
      );

      for (const entry of entries) {
        const fieldPath =
          `${entry.componentName}.${entry.fieldName}` +
          (entry.arrayIndex !== undefined ? `[${entry.arrayIndex}]` : '');

        const guidRes = AssetGuid.parse(entry.guidString);
        if (!guidRes.ok) {
          return err(
            new AssetError({
              code: 'asset-not-found',
              expected: `valid GUID string for field ${fieldPath}`,
              hint:
                `GUID "${entry.guidString}" could not be parsed; ` +
                `at node localId=${entry.entityLocalId}, field=${fieldPath}`,
            }),
          );
        }
        const envelope = this.assetCatalog.get(entry.guidString.toLowerCase());
        if (envelope === undefined) {
          return err(
            new AssetError({
              code: 'asset-not-found',
              expected: `GUID ${entry.guidString} catalogued in AssetRegistry`,
              hint:
                `GUID ${entry.guidString} not catalogued; ` +
                `call loadByGuid('${entry.guidString}') before instantiate; ` +
                `at node localId=${entry.entityLocalId}, field=${fieldPath}`,
            }),
          );
        }
        const payload = envelope.payload;
        const guidKey = entry.guidString.toLowerCase();
        let resolvedSlot = guidToHandle.get(guidKey);
        if (resolvedSlot === undefined) {
          resolvedSlot = unwrapHandle(world.allocSharedRef(payload.kind, payload));
          guidToHandle.set(guidKey, resolvedSlot);
        }

        const key =
          `${entry.entityLocalId}|${entry.componentName}|${entry.fieldName}` +
          (entry.arrayIndex !== undefined ? `|${entry.arrayIndex}` : '|');
        resolvedMap.set(key, resolvedSlot);
      }
    }

    // Build the resolved copy. Handle-type fields (detected above) are
    // reconstructed from the resolvedMap; all other fields pass through as-is.
    const resolvedNodes: SceneEntity[] = [];
    for (const node of scene.entities) {
      const rawComponents = node.components as Record<string, Record<string, unknown>>;
      const resolvedComponents: Record<string, Record<string, unknown>> = {};

      for (const compName of Object.keys(rawComponents)) {
        const rawFields = rawComponents[compName];
        if (!rawFields) {
          resolvedComponents[compName] = {};
          continue;
        }
        const resolvedFields: Record<string, unknown> = {};
        for (const fieldName of Object.keys(rawFields)) {
          const value = rawFields[fieldName];
          const plainKey = `${node.localId}|${compName}|${fieldName}|`;
          const plainResolved = resolvedMap.get(plainKey);
          if (plainResolved !== undefined) {
            resolvedFields[fieldName] = plainResolved;
          } else if (Array.isArray(value)) {
            const resolvedArr: number[] = [];
            let hasAnyResolved = false;
            for (let i = 0; i < value.length; i++) {
              const arrKey = `${node.localId}|${compName}|${fieldName}|${i}`;
              const arrResolved = resolvedMap.get(arrKey);
              if (arrResolved !== undefined) {
                resolvedArr.push(arrResolved);
                hasAnyResolved = true;
              } else if (typeof value[i] === 'number') {
                resolvedArr.push(value[i]);
              }
            }
            resolvedFields[fieldName] = hasAnyResolved ? resolvedArr : value;
          } else {
            resolvedFields[fieldName] = value;
          }
        }
        resolvedComponents[compName] = resolvedFields;
      }
      resolvedNodes.push({
        localId: node.localId,
        components: resolvedComponents,
      });
    }

    // ── m3-i2 / m3-i3: Resolve mounts recursively (breakpoint B fix) ──
    // For each mount.source (GUID string), look up the child scene in
    // assetCatalog, recursively resolve its GUIDs, allocSharedRef the
    // resolved child copy, register it in originIndex (D-7), and produce
    // a resolved mount with source as the live handle number.
    // Cycle detection via visited GUID set (R-9): re-entry =>
    // pack-cyclic-reference / mount-asset, cast through the return type
    // as world.ts does for its PackError exits.
    const mountVisited = _visitedMountGuids ?? new Set<string>();
    if (sceneGuidKey !== undefined) mountVisited.add(sceneGuidKey.toLowerCase());
    if (scene.mounts !== undefined && scene.mounts.length > 0) {
      const resolvedMounts = this.resolveMountsRec(scene.mounts, world, mountVisited);
      if (sceneGuidKey !== undefined) mountVisited.delete(sceneGuidKey.toLowerCase());
      if (!resolvedMounts.ok) {
        // Cycle or child-resolution error: cast through as AssetError
        // (same pattern as world.ts PackError-as-EcsError casts).
        return resolvedMounts as unknown as Result<SceneAsset, AssetError>;
      }
      return ok({
        kind: 'scene',
        entities: resolvedNodes,
        mounts: resolvedMounts.value,
      } as SceneAsset);
    }
    if (sceneGuidKey !== undefined) mountVisited.delete(sceneGuidKey.toLowerCase());
    return ok({ kind: 'scene', entities: resolvedNodes });
  }

  /**
   * m3-i2: Recursively resolve mounts[].source GUID strings.
   * Returns a PackError-shaped object on cycle (R-9) or AssetError
   * on child resolution failure.
   */
  private resolveMountsRec(
    mounts: readonly SceneInstanceMount[],
    world: World,
    visited: Set<string>,
  ): Result<
    SceneInstanceMount[],
    | AssetError
    | {
        readonly code: 'pack-cyclic-reference';
        readonly expected: string;
        readonly hint: string;
        readonly detail: {
          readonly code: 'pack-cyclic-reference';
          readonly kind: 'mount-asset';
          readonly cycle: readonly string[];
        };
      }
  > {
    const out: SceneInstanceMount[] = [];
    for (const m of mounts) {
      const src = m.source;
      // m3-i3: if source is already a number (live handle from a prior
      // resolution pass), pass through unchanged.
      if (typeof src === 'number') {
        out.push({ ...m });
        continue;
      }

      // source is a GUID string — resolve it.
      const guidKey = src.toLowerCase();

      // Cycle detection.
      if (visited.has(guidKey)) {
        return err({
          code: 'pack-cyclic-reference' as const,
          expected: 'no circular mount.source GUID references',
          hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
          detail: {
            code: 'pack-cyclic-reference' as const,
            kind: 'mount-asset' as const,
            cycle: [...visited, guidKey],
          },
        });
      }

      // Look up child scene.
      const childEnv = this.assetCatalog.get(guidKey);
      if (childEnv === undefined) {
        // Not catalogued — pass through as-is.
        out.push({ ...m });
        continue;
      }
      const childPayload = childEnv.payload;
      if (
        typeof childPayload !== 'object' ||
        childPayload === null ||
        (childPayload as Asset).kind !== 'scene'
      ) {
        out.push({ ...m });
        continue;
      }

      // Resolve mounts recursively.
      const childVisited = new Set(visited);
      // Don't add guidKey to visited here — _resolveSceneGuids will do it
      // via its own _visitedMountGuids parameter.
      const childRes = this._resolveSceneGuids(
        childPayload as SceneAsset,
        world,
        guidKey,
        childVisited,
      );

      if (!childRes.ok) {
        // Propagate child resolution error.
        return childRes as unknown as Result<SceneInstanceMount[], AssetError>;
      }

      // Build resolved child with its own mounts.
      const resolvedChild: SceneAsset = {
        kind: 'scene',
        entities: childRes.value.entities,
        ...(childRes.value.mounts !== undefined && childRes.value.mounts.length > 0
          ? { mounts: childRes.value.mounts }
          : {}),
      } as SceneAsset;

      // allocSharedRef + register in originIndex (D-7).
      const chRaw = unwrapHandle(world.allocSharedRef('SceneAsset', resolvedChild));
      this._originIndex.set(resolvedChild, guidKey);

      // Replace source with live handle number (D-5: source is number|string).
      out.push({
        ...m,
        source: chRaw,
      } as SceneInstanceMount);
    }
    return ok(out);
  }

  /**
   * Validate a MaterialAsset's passes[] against the ShaderRegistry's
   * paramSchema (union semantics: all declared params across all passes
   * must be satisfiable from paramValues).
   *
   * - Empty / undefined passes[] → error
   * - Each pass's shader must exist in ShaderRegistry
   * - Union of all pass paramSchemas: params without `default` must
   *   appear in paramValues with matching type
   * - Extra keys in paramValues are silently ignored (D-5)
   *
   * @returns AssetError on failure, null on success
   */
  private validateMaterialPasses(asset: MaterialAsset): AssetError | null {
    const passes = asset.passes;
    // undefined passes is valid (material inherits from parent at resolve time);
    // only explicit empty passes[] is an error.
    if (passes === undefined || passes.length === 0) {
      if (passes !== undefined && passes.length === 0) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected: 'MaterialAsset with at least one pass',
          hint: 'add at least one pass descriptor to passes[] before register',
          detail: { passCount: 0 },
        });
      }
      // passes undefined: skip validation (inherits from parent later)
      return null;
    }

    const allSchemas: ParamSchemaEntry[] = [];
    for (let passIndex = 0; passIndex < passes.length; passIndex++) {
      const pass = passes[passIndex];
      if (pass === undefined) continue;
      const lookup = this.shaderRegistry.lookupMaterialShader(pass.shader);
      if (!lookup.ok) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected: `shader '${pass.shader}' registered in ShaderRegistry`,
          hint: `pass[${passIndex}] references shader '${pass.shader}' which is not registered; register it via ShaderRegistry.registerMaterialShader('${pass.shader}', ...) at engine boot`,
          detail: { passIndex, shaderKey: pass.shader, cause: 'shader-not-found' },
        });
      }
      for (const entry of lookup.value.paramSchema) {
        allSchemas.push(entry);
      }
    }

    // Deduplicate by name (first occurrence wins)
    const seen = new Set<string>();
    const unionSchema: ParamSchemaEntry[] = [];
    for (const entry of allSchemas) {
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        unionSchema.push(entry);
      }
    }

    const paramValues: Record<string, unknown> =
      (asset.paramValues as Record<string, unknown>) ?? {};

    // feat-20260613-material-paramschema-driven-binding M3 / w16 (D-2):
    // derive(schema) is the SSOT for which schema fields are textures vs
    // samplers vs numeric. The register-time three-layer validation (extra-
    // key / type-mismatch / missing-required) categorizes fields via
    // derive output instead of a hardcoded literal type list. Texture
    // and sampler fields are always optional at register time (the
    // resource handles may not be available yet — D-5 graceful path),
    // so derive-derived membership decides the skip set without keeping
    // a parallel literal table.
    const derived = derive(unionSchema);
    const textureFields = derived.textureFieldNames;
    const samplerFields = new Set<string>();
    for (const e of unionSchema) {
      if (e.type === 'sampler' || e.type === 'sampler_comparison') {
        samplerFields.add(e.name);
      }
    }

    const missingParams: string[] = [];
    for (const entry of unionSchema) {
      // Param with default: skip if missing in paramValues
      if (entry.default !== undefined) {
        continue;
      }
      // Texture / sampler params are always optional at register time
      // (asset handles may not be available yet); derive output is the
      // SSOT for category membership.
      if (textureFields.has(entry.name) || samplerFields.has(entry.name)) {
        continue;
      }
      const value = paramValues[entry.name];
      if (value === undefined) {
        missingParams.push(entry.name);
        continue;
      }
      // Type-check supplied values
      const typeOk = this.validateParamType(entry.name, entry.type, value);
      if (!typeOk) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected: `paramValues.${entry.name} to be of type ${entry.type}`,
          hint: `paramValues['${entry.name}'] has type ${typeof value} but paramSchema declares ${entry.type}`,
          detail: { paramName: entry.name, expectedType: entry.type, got: typeof value },
        });
      }
    }

    if (missingParams.length > 0) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: `paramValues to contain keys: ${missingParams.join(', ')}`,
        hint: `missing required params: ${missingParams.join(', ')}`,
        detail: { missingParams },
      });
    }

    return null;
  }

  /**
   * Sprite 9-slice paramValues fail-fast validation
   * (feat-20260527-sprite-nineslice M2 / w8, plan-strategy §D-1 + AC-08).
   *
   * Fires when:
   *  - asset.kind === 'material'
   *  - first pass shader === 'forgeax::sprite'
   *  - paramValues.slices is present
   *
   * Six fail-fast branches (1:1 with w4 test):
   *   (1) any component is negative
   *   (2) slices.x + slices.z >= region.zw[0]   (X-axis overlap)
   *   (3) slices.y + slices.w >= region.zw[1]   (Y-axis overlap)
   *   (4) any component is NaN
   *   (5) any component is Infinity
   *   (6) length !== 4
   *
   * Reuses the existing 'asset-invalid-value' member of the closed
   * `AssetErrorCode` 13-member union (no new code added per
   * AGENTS.md §Error model). The `.expected` literal mirrors the AI-User
   * Charter §3 string; `.hint` inlines the offending sum + the relevant
   * `region.zw` numeral so AI users can copy-paste the prompt straight
   * back into the IDE for self-recovery (plan-strategy §R-4).
   *
   * @returns AssetError on failure, null on success.
   */
  private validateSpriteSlices(asset: MaterialAsset): AssetError | null {
    const passes = asset.passes;
    if (passes === undefined || passes.length === 0) return null;
    const firstPass = passes[0];
    if (firstPass === undefined || firstPass.shader !== 'forgeax::sprite') return null;
    const pv = (asset.paramValues ?? {}) as Record<string, unknown>;
    const slicesRaw = pv.slices;
    // Field absent — caller relies on paramSchema default [0, 0, 0, 0]; nothing to check.
    if (slicesRaw === undefined) return null;
    const expected =
      'paramValues.slices: [number, number, number, number] with 0 ≤ left + right < region.zw[0] and 0 ≤ top + bottom < region.zw[1]';
    if (!Array.isArray(slicesRaw)) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `paramValues.slices is not an array (got ${typeof slicesRaw}); must be a 4-tuple [left, top, right, bottom]`,
        detail: { paramName: 'slices', got: typeof slicesRaw },
      });
    }
    // (6) length check
    if (slicesRaw.length !== 4) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `paramValues.slices length is ${slicesRaw.length}; must be 4 ([left, top, right, bottom])`,
        detail: { paramName: 'slices', got: slicesRaw.length },
      });
    }
    const slices = slicesRaw as readonly unknown[];
    // Type check each component first.
    for (let i = 0; i < 4; i++) {
      if (typeof slices[i] !== 'number') {
        return new AssetError({
          code: 'asset-invalid-value',
          expected,
          hint: `paramValues.slices[${i}] is not a number (got ${typeof slices[i]})`,
          detail: { paramName: 'slices', got: typeof slices[i] },
        });
      }
    }
    const left = slices[0] as number;
    const top = slices[1] as number;
    const right = slices[2] as number;
    const bottom = slices[3] as number;
    // (4) NaN
    for (let i = 0; i < 4; i++) {
      if (Number.isNaN(slices[i] as number)) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected,
          hint: `paramValues.slices[${i}] is NaN; all four components must be finite non-negative numbers`,
          detail: { paramName: 'slices', got: 'NaN' },
        });
      }
    }
    // (5) Infinity
    for (let i = 0; i < 4; i++) {
      if (!Number.isFinite(slices[i] as number)) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected,
          hint: `paramValues.slices[${i}] is Infinity; all four components must be finite non-negative numbers`,
          detail: { paramName: 'slices', got: 'Infinity' },
        });
      }
    }
    // (1) negative — D-3 sentinel uses negative .w for tile mode but only
    // after extract; at register-time the user-supplied tuple must be all
    // non-negative (the engine encodes the sign downstream).
    for (let i = 0; i < 4; i++) {
      if ((slices[i] as number) < 0) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected,
          hint: `paramValues.slices[${i}] = ${slices[i]}; all four components must be non-negative`,
          detail: { paramName: 'slices', got: slices[i] as number },
        });
      }
    }
    // (2)/(3) overlap with region. region default is [0, 0, 1, 1];
    // user override comes via paramValues.region (vec4).
    const regionRaw = pv.region;
    let regionZ = 1;
    let regionW = 1;
    if (Array.isArray(regionRaw) && regionRaw.length >= 4) {
      const rz = regionRaw[2];
      const rw = regionRaw[3];
      if (typeof rz === 'number') regionZ = rz;
      if (typeof rw === 'number') regionW = rw;
    }
    const sumX = left + right;
    if (sumX >= regionZ) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `received slices=[${left}, ${top}, ${right}, ${bottom}]; left + right = ${sumX} ≥ ${regionZ} (region.z)`,
        detail: { paramName: 'slices', got: sumX },
      });
    }
    const sumY = top + bottom;
    if (sumY >= regionW) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: `received slices=[${left}, ${top}, ${right}, ${bottom}]; top + bottom = ${sumY} ≥ ${regionW} (region.w)`,
        detail: { paramName: 'slices', got: sumY },
      });
    }
    return null;
  }

  private validateParamType(_name: string, type: string, value: unknown): boolean {
    switch (type) {
      case 'f32':
      case 'i32':
      case 'u32':
        return typeof value === 'number';
      case 'vec2':
        return (
          Array.isArray(value) && value.length >= 2 && value.every((v) => typeof v === 'number')
        );
      case 'vec3':
        return (
          Array.isArray(value) && value.length >= 3 && value.every((v) => typeof v === 'number')
        );
      case 'vec4':
        return (
          Array.isArray(value) && value.length >= 4 && value.every((v) => typeof v === 'number')
        );
      case 'color':
        return (
          Array.isArray(value) &&
          (value.length === 3 || value.length === 4) &&
          value.every((v) => typeof v === 'number')
        );
      case 'texture2d':
      case 'sampler':
        // Texture/sampler params carry string GUIDs at registration time
        return typeof value === 'string';
      default:
        return false;
    }
  }

  /**
   * Register an asset and return a fresh
   * `Result<Handle<TagOf<T>, 'shared'>, AssetError>`. The brand `target`
   * tag is derived from the Asset's `kind` discriminator via `AssetTagMap`
   * (charter F1 single-entry indexability). The runtime representation is
   * an auto-incrementing u32 starting at 1024 (builtins reserve 1-2).
   *
   * feat-20260526 M4: `shadingModel` field is retired in favour of
   * pass-based MaterialAsset. This generic surface covers the full
   * `Asset` closed union (mesh / texture / sampler / scene / equirect
   * / material).
   */
  /**
   * feat-20260614 M8 (D-15 / D-17): catalogue a payload under its GUID.
   * Replaces the old `register` / `registerWithGuid` mint pair -- the registry
   * stores the PAYLOAD and never produces a handle (it owns no World).
   * Column minting is the caller's job via `world.allocSharedRef`.
   *
   * Validates mesh stride + material passes / sprite slices at catalogue entry
   * (same fail-fast surface as the old register path). Returns
   * `Result.err(AssetError)` on validation failure; `Result.ok(payload)` with
   * the stored payload (mesh payloads gain an `aabb`) on success.
   */
  catalog<T = Asset>(
    guid: AssetGuid | string,
    asset: T,
    refs?: readonly AssetRef[],
  ): Result<T, AssetError> {
    // D-5: narrow T to Asset for kind-discriminate branches. The runtime
    // catalog only accepts Asset-kind payloads (host custom kinds enter
    // through loadByGuid + registerParsedAsset, not catalog directly).
    const a: Asset = asset as unknown as Asset;
    const meshValidation = validateMeshPayload(a);
    if (meshValidation !== null) return err(meshValidation);

    // feat-20260608 M0 baseline rebuild: tileset payload fail-fast gate at
    // register entry — region rectangle bounds-check uses the implicit atlas
    // extent (columns * tileWidth x rows * tileHeight) when the caller did
    // not supply an explicit one (charter P3 explicit failure).
    if (a.kind === 'tileset') {
      const tilesetAsset = a as TilesetAsset;
      const tilesetValidation = validateTilesetPayload(
        tilesetAsset,
        inferAtlasExtent(tilesetAsset),
      );
      if (tilesetValidation !== null) return err(tilesetValidation);
    }

    // feat-20260527 M2 / w6: material validation with union paramSchema
    // semantics across all passes (plan-strategy D-2, D-5).
    if (a.kind === 'material') {
      const matValidation = this.validateMaterialPasses(a as MaterialAsset);
      if (matValidation !== null) return err(matValidation);
      const sliceValidation = this.validateSpriteSlices(a as MaterialAsset);
      if (sliceValidation !== null) return err(sliceValidation);
      this.detectTileNeedsRepeatSampler(a as MaterialAsset);
    }

    let stored: Asset = a;
    if (a.kind === 'mesh') {
      stored = withMeshAabb(a as TypesMeshAsset);
    }
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const kind = a.kind;
    // Drain any name recorded by an earlier _registerPackage call whose body had
    // not yet been catalogued (prod disk path; D-6). Preserve a name already on
    // a prior envelope for this key (re-catalog of the same GUID).
    const pendingName = this.pendingNames.get(key);
    const priorName = this.assetCatalog.get(key)?.name;
    const name = pendingName ?? priorName;
    this.pendingNames.delete(key);
    this.assetCatalog.set(key, {
      guid: key,
      kind,
      ...(name !== undefined ? { name } : {}),
      payload: stored,
      refs: refs ?? [],
    });
    // D-1: catalog() inline path defaults every GUID to the no-package state
    // (null). loadByGuid + builtin override via their own registerPackage calls
    // before / after this so the package mapping is populated for all assets
    // through the single primitive (#1 SSOT). Do not clobber a package mapping
    // a prior registerPackage already established for this GUID.
    if (!this.packages.has(key)) this.packages.set(key, null);
    return ok(stored as T);
  }

  /**
   * @internal feat-20260618-asset-and-pack-name-fields M3 (D-1): the single
   * package-mapping write primitive. All three registration entry points funnel
   * here so the XOR name invariant is implemented once (#1 SSOT):
   *   - catalog() inline path -> registerPackage(null, [guid])          (no package)
   *   - loadByGuid disk path  -> registerPackage(relativeUrl, [g1,g2,...], names)
   *   - constructor builtin    -> registerPackage(null, [...guids])      (D-5 null)
   *
   * `path === null` registers the GUIDs with no package (resolveName reads their
   * storedName or returns ''). A non-null `path` finds-or-creates the shared
   * MutablePackage for that path and adds the GUIDs to it; per-GUID entry names
   * (D-2: name flows entry -> Package, never the payload) are taken from
   * `names`. The 1->N promotion branch (D-3) is added by w11. Never throws --
   * it only writes maps; resolution + validation happen in resolveName / rename.
   */
  _registerPackage(
    path: string | null,
    guids: readonly string[],
    names?: Map<string, string>,
  ): void {
    if (path === null) {
      for (const g of guids) {
        const key = g.toLowerCase();
        this.packages.set(key, null);
        const n = names?.get(g) ?? names?.get(key);
        if (n !== undefined) this.setStoredName(key, n);
      }
      return;
    }

    const pkg = this.packageByPath.get(path) ?? { path, assetGuids: new Set<string>() };
    this.packageByPath.set(path, pkg);

    // D-3: 1->N promotion. When this path already holds exactly one asset and a
    // new member is arriving, freeze the original asset's derived basename as its
    // stored name so it joins the multi-asset branch with a stable name. The
    // freeze is idempotent: an original that already carries a stored name (the
    // abnormal single-asset-with-name state, D-4) is left untouched and the
    // soft-violation counter records it (charter P3 machine-readable signal).
    const addsNewMember = guids.some((g) => !pkg.assetGuids.has(g.toLowerCase()));
    if (pkg.assetGuids.size === 1 && addsNewMember) {
      const [originalKey] = pkg.assetGuids;
      if (originalKey !== undefined) {
        if (this.hasStoredName(originalKey)) {
          this.metrics?.increment('package.xor-invariant-violated');
        } else {
          this.setStoredName(originalKey, deriveAssetName(pkg.path, 1));
        }
      }
    }

    for (const g of guids) {
      const key = g.toLowerCase();
      pkg.assetGuids.add(key);
      this.packages.set(key, pkg);
      const n = names?.get(g) ?? names?.get(key);
      if (n !== undefined) this.setStoredName(key, n);
    }
  }

  /**
   * Read the per-GUID stored display name (D-6 home: the envelope's `name`
   * field, with `pendingNames` covering the prod-disk ordering where the name is
   * known before the body is catalogued). Single read point for resolveName /
   * the 1->N promotion XOR check.
   */
  private storedNameFor(key: string): string | undefined {
    return this.assetCatalog.get(key)?.name ?? this.pendingNames.get(key);
  }

  private hasStoredName(key: string): boolean {
    return this.storedNameFor(key) !== undefined;
  }

  /**
   * Write the per-GUID stored display name. When the envelope exists, replace it
   * with one carrying the new `name` (the envelope is immutable; D-6 keeps the
   * payload free of the name). Before the envelope is catalogued (prod disk
   * path), stash on `pendingNames` so catalog() can drain it into the new
   * envelope. `name === undefined` clears the name in both homes.
   */
  private setStoredName(key: string, name: string | undefined): void {
    const envelope = this.assetCatalog.get(key);
    if (envelope !== undefined) {
      const { name: _drop, ...rest } = envelope;
      this.assetCatalog.set(key, name === undefined ? rest : { ...rest, name });
      this.pendingNames.delete(key);
      return;
    }
    if (name === undefined) this.pendingNames.delete(key);
    else this.pendingNames.set(key, name);
  }

  /**
   * Return the `Package` this GUID belongs to, or `null` when the asset has no
   * package (catalog() inline + builtin, D-5), or `undefined` when the GUID was
   * never registered. The returned `Package` is a readonly snapshot whose
   * `assetCount` is derived from the live member set (#2 Derive).
   */
  packageOf(guid: AssetGuid | string): Package | null | undefined {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const pkg = this.packages.get(key);
    if (pkg === undefined) return undefined;
    if (pkg === null) return null;
    return { path: pkg.path, assetGuids: pkg.assetGuids, assetCount: pkg.assetGuids.size };
  }

  /**
   * Resolve an asset's human-readable display name -- the single source of truth
   * for the two-segment identity's `name` segment (D-6). Every name consumer
   * (inspect / catalog builder / CLI) reads this or the same `deriveAssetName`
   * pure function it delegates to (AC-04); no consumer re-implements the XOR
   * rule. Returns a deterministic fallback rather than throwing on a missing
   * name (AC-15): `basename(path)` for a multi-asset entry that lacks a stored
   * name, or `''` for a no-package asset with no self name (the detectable
   * "genuinely no name" signal, charter P3). An unregistered GUID is treated as
   * the no-package branch.
   */
  resolveName(guid: AssetGuid | string): string {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const pkg = this.packages.get(key);
    const storedName = this.storedNameFor(key);
    const path = pkg == null ? null : pkg.path;
    const assetCount = pkg == null ? 0 : pkg.assetGuids.size;
    return deriveAssetName(path, assetCount, storedName);
  }

  /**
   * Rename an asset's display name in memory (D-4). Three classes by package
   * shape:
   *   - no-package asset      -> set the stored self name
   *   - multi-asset package   -> set the entry stored name
   *   - single-asset package  -> rewrite the package path's leaf segment so the
   *                              derived basename becomes `newName` (the package
   *                              stays single-asset; the leaf IS the name)
   *
   * In-memory only (OOS-1: no disk write-back). Returns structured failures via
   * the closed `AssetErrorCode` union with no new members (D-4): a name that
   * collides with another member of the same package -> `asset-invalid-value`;
   * an unregistered GUID -> `asset-not-found`. AI users consume `.code` through
   * a `switch`, not by parsing `.message` (charter P3).
   */
  rename(guid: AssetGuid | string, newName: string): Result<void, AssetError> {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    if (!this.packages.has(key)) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `a registered asset for GUID ${key}`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }

    const pkg = this.packages.get(key) ?? null;

    const collision = pkg !== null ? this.nameCollisionIn(pkg, key, newName) : null;
    if (collision !== null) return err(collision);

    if (pkg !== null && pkg.assetGuids.size === 1) {
      // Single-asset package: the leaf segment IS the derived name; rewrite it so
      // basename(path) === newName. Keep the directory prefix intact.
      const slash = pkg.path.lastIndexOf('/');
      const oldPath = pkg.path;
      pkg.path = slash >= 0 ? `${pkg.path.slice(0, slash + 1)}${newName}` : newName;
      this.packageByPath.delete(oldPath);
      this.packageByPath.set(pkg.path, pkg);
      this.setStoredName(key, undefined);
      return ok(undefined);
    }

    this.setStoredName(key, newName);
    return ok(undefined);
  }

  /**
   * Return an `asset-invalid-value` AssetError if another member of `pkg`
   * already resolves to `newName`, else null. Extracted from `rename` to keep
   * the collision-detection control flow flat (D-4 reuses the closed error code;
   * the detail narrows via the `{ field, value, reason }` union variant).
   */
  private nameCollisionIn(
    pkg: MutablePackage,
    selfKey: string,
    newName: string,
  ): AssetError | null {
    for (const memberKey of pkg.assetGuids) {
      if (memberKey !== selfKey && this.resolveName(memberKey) === newName) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected: `a name unique within package "${pkg.path}"`,
          hint: `another asset in "${pkg.path}" is already named "${newName}"; choose a distinct name`,
          detail: {
            field: 'name',
            value: newName,
            reason: `duplicate name within package ${pkg.path}`,
          },
        });
      }
    }
    return null;
  }

  /**
   * Parse a dash-form GUID string into an `AssetGuid`. Thin convenience over
   * `AssetGuid.parse` for the `loadByGuid` / `catalog` call sites; throws
   * `AssetError` on a malformed GUID (caller-error, mirrors `parseInt`-style
   * eager validation -- the GUID literal is author-supplied, not user data).
   */
  parseGuid(guidStr: string): AssetGuid {
    const parsed = AssetGuid.parse(guidStr);
    if (!parsed.ok) {
      throw new AssetError({
        code: 'asset-parse-failed',
        expected: `valid dash-form GUID, got "${guidStr}"`,
        hint: ASSET_ERROR_HINTS['asset-parse-failed'],
      });
    }
    return parsed.value;
  }

  /**
   * Look up a catalogued payload by GUID, or `undefined` on miss. Used by the
   * ECS/render side (e.g. `walkMaterialParents` in `resolve-asset-handle.ts`)
   * to resolve a payload's embedded sub-asset GUIDs (D-19) without minting.
   */
  lookup<T = Asset>(guid: AssetGuid | string): T | undefined {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    return this.assetCatalog.get(key)?.payload as T | undefined;
  }

  /**
   * feat-20260527-sprite-nineslice M4 / w18 (D-9): register-time soft-warn
   * for sliceMode=1 (tile) bound to a sampler whose addressMode is not
   * 'repeat'. Bumps `nineslice.tile-needs-repeat-sampler` once per offending
   * catalogue call. Never throws -- the counter is the sole AI-user-facing
   * signal (charter P3 machine-readable; AC-08 closed, never extends
   * AssetErrorCode).
   *
   * feat-20260614 M8 (D-19): `paramValues.sampler` is now an embedded GUID
   * string (dash-form), resolved against the catalogue rather than a handle.
   */
  private detectTileNeedsRepeatSampler(asset: MaterialAsset): void {
    if (this.metrics === null) return;
    const passes = asset.passes;
    if (passes === undefined || passes.length === 0) return;
    const firstPass = passes[0];
    if (firstPass === undefined || firstPass.shader !== 'forgeax::sprite') return;
    const pv = (asset.paramValues ?? {}) as Record<string, unknown>;
    const sliceMode = typeof pv.sliceMode === 'number' ? pv.sliceMode : 0;
    if (sliceMode !== 1) return;
    const samplerGuid = typeof pv.sampler === 'string' ? pv.sampler : undefined;
    if (samplerGuid === undefined) return;
    const samplerEnvelope = this.assetCatalog.get(samplerGuid.toLowerCase());
    if (samplerEnvelope === undefined || samplerEnvelope.kind !== 'sampler') return;
    const samplerAsset = samplerEnvelope.payload;
    if (samplerAsset.kind !== 'sampler') return;
    const u = samplerAsset.addressModeU;
    const v = samplerAsset.addressModeV;
    if (u !== 'repeat' || v !== 'repeat') {
      this.metrics.increment('nineslice.tile-needs-repeat-sampler');
    }
  }

  /**
   * feat-20260613-material-paramschema-driven-binding M4 / w23 (D-5 graceful):
   * Return the texture-field name set for the given material-shader id,
   * derived from the registered shader's paramSchema via `derive(paramSchema)
   * .textureFieldNames`. Returns `undefined` when the shader is not yet
   * registered (cross-worktree shader-late-register, plan R-4).
   *
   * Used by `extractFrame` to know which paramValues fields the shader
   * declares as texture handles; the extract layer validates handle-vs-
   * scalar typing and drops misclassified slots so the record stage's
   * MISSING_TEXTURE_HANDLE fallback can take over (white default texture)
   * rather than letting a stray handle reach `device.createBindGroup`.
   */
  materialShaderTextureFieldNames(shaderId: string): ReadonlySet<string> | undefined {
    const lookup = this.shaderRegistry.lookupMaterialShader(shaderId);
    if (!lookup.ok) return undefined;
    return derive(lookup.value.paramSchema).textureFieldNames;
  }

  /**
   * Load an asset and all its transitively referenced sub-assets by GUID;
   * returns `ok(handle)` only when the asset and every sub-asset are in the
   * registry.
   *
   * **Post-condition:** `ok(payload)` is returned ONLY when the asset AND every
   * transitively referenced sub-asset (per the asset envelope's `refs[]`) are
   * present in this registry. The implementation walks `envelope.refs` and
   * recursively calls `loadByGuid` on each ref before cataloguing the top-level
   * asset. The resolved value is the PAYLOAD `T`
   * (D-17), never a handle -- mint a column handle with
   * `world.allocSharedRef('Kind', payload)` when one is needed (e.g. before
   * `instantiate`).
   *
   * Two paths:
   * - **Dev / fallback** (no `configurePackIndex` call): synchronous catalogue
   *   lookup wrapped in `Promise.resolve`. Returns `Err(asset-not-found)` if not
   *   catalogued.
   * - **Prod** (after `configurePackIndex(url)`): fetches `pack-index.json`
   *   on the first call (cached as a `Map<guid, {relativeUrl, kind}>`), then
   *   fetches the individual resource URL and parses the asset payload, then
   *   catalogues it (GUID -> payload) and returns the payload.
   *
   * Error union: `AssetError | PackError | ImageError | RhiError` (closed -- no
   * new codes were introduced by the recursive walk; every code is pre-existing).
   *
   * An in-flight `Map` (D-5) deduplicates concurrent calls for the same GUID and
   * prevents stack overflow on cycles (A->B->A).
   *
   * **Breaking-change classification:** this is a semantic strengthening, not a
   * shape change. Sub-assets catalogued by a prior `catalog(guid, payload)` /
   * `loadByGuid` call are protected by the catalogue fast-path: the recursive
   * walk hits cache on every node and incurs zero additional fetch.
   *
   * @example
   * ```ts
   * const res = await engine.assets.loadByGuid<SceneAsset>(sceneGuid);
   * if (!res.ok) {
   *   switch (res.error.code) {
   *     case 'asset-not-found':
   *       // top GUID or any sub-asset GUID is missing from the catalog
   *       break;
   *     case 'asset-fetch-failed':
   *       // network / CORS
   *       break;
   *     case 'asset-parse-failed':
   *       // payload malformed
   *       break;
   *     // ... AssetErrorCode | PackErrorCode | ImageErrorCode | RhiErrorCode exhaustive
   *   }
   *   return;
   * }
   * ```
   */
  async loadByGuid<T = Asset>(
    guid: AssetGuid,
    parentContext?: {
      sceneEntityId?: number;
      componentField?: string;
    },
  ): Promise<Result<T, AssetError | ImageError | RhiError>> {
    const guidKey = AssetGuid.format(guid).toLowerCase();

    // feat-20260614 M8 (D-17): the registry catalogues GUID -> payload and
    // returns the PAYLOAD (never a handle). Fast path: already catalogued
    // (covers dev catalog() + prod cached repeat calls).
    const existing = this.assetCatalog.get(guidKey);
    if (existing !== undefined) {
      return ok(existing.payload as T);
    }

    // In-flight dedup (D-5 / B-10): if another call is already loading this
    // GUID, return that same Promise — covers (a) concurrent same-GUID calls
    // and (b) cycle A→B→A termination (B reaches A's in-flight entry).
    const inFlightPromise = this.inFlight.get(guidKey);
    if (inFlightPromise !== undefined) {
      return inFlightPromise as Promise<Result<T, AssetError | ImageError | RhiError>>;
    }

    // Prod fetch path: only enabled when packIndexUrl is configured.
    if (this.packIndexUrl !== undefined && typeof globalThis.fetch === 'function') {
      // F22: capture generation snapshot at Promise creation time so the
      // resolve path can detect whether invalidate/invalidateAll was called
      // while the fetch was in flight.
      const genAtStart = this.generations.get(guidKey) ?? 0;
      const globalGenAtStart = this.globalGeneration;

      const promise = this.loadByGuidProd<T>(guid, guidKey, parentContext);
      this.inFlight.set(guidKey, promise);
      try {
        const result = await promise;
        // F22: if the generation counters changed since the Promise was
        // created, discard the result -- the asset was invalidated. The
        // inFlight.delete in the finally block still runs (correctly).
        if (
          genAtStart !== (this.generations.get(guidKey) ?? 0) ||
          globalGenAtStart !== this.globalGeneration
        ) {
          // Clean up catalog -- loadByGuidProd may have already written
          // the payload via catalog() before the generation check runs.
          this.assetCatalog.delete(guidKey);
          return err(
            new AssetError({
              code: 'asset-invalidated',
              expected: `GUID ${guidKey} was invalidated during load`,
              hint: ASSET_ERROR_HINTS['asset-invalidated'],
            }),
          );
        }
        return result;
      } finally {
        this.inFlight.delete(guidKey);
      }
    }

    // Dev / fallback: synchronous catalogue miss (no network).
    return Promise.resolve(
      err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${guidKey} catalogued in AssetRegistry`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      ),
    );
  }

  /**
   * feat-20260603-asset-import-loader-injection M1 / w6: load an
   * upstream-branch kind (texture / font) straight from its catalog entry
   * through the injected async loader, then register the produced POD. Replaces
   * the bespoke `loadTextureFromEntry` / `loadFontFromEntry` methods; the decode
   * / glyph-parse logic moved verbatim into the loader bodies (D-2 — loader is
   * pure of `registerWithGuid`, which stays here).
   */
  private async loadFromUpstreamEntry<T = Asset>(
    guidKey: string,
    entry: {
      relativeUrl: string;
      kind: string;
      name?: string;
      metadata?: ImageMetadata | undefined;
    },
  ): Promise<Result<T, AssetError | ImageError | RhiError>> {
    const loader = this.loaders.get(entry.kind);
    if (loader === undefined) {
      return err(
        new AssetError({
          code: 'loader-not-registered',
          expected: `a loader registered for kind '${entry.kind}'`,
          hint: ASSET_ERROR_HINTS['loader-not-registered'],
          detail: { kind: entry.kind, registeredKinds: this.loaders.registeredKinds() },
        }),
      );
    }
    const out = loader.load({ ...entry, guidKey }, undefined, this.makeLoadContext());
    // Upstream-branch loaders are async (Promise<LoaderAsyncResult>).
    const result = (await out) as LoaderAsyncResult;
    if (!result.ok) {
      return err(result.error as AssetError | ImageError | RhiError);
    }
    const guid = AssetGuid.parse(guidKey);
    if (!guid.ok) {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `valid GUID ${guidKey}`,
          hint: ASSET_ERROR_HINTS['asset-parse-failed'],
        }),
      );
    }
    return this.catalog(guid.value, result.value) as Result<T, AssetError | ImageError | RhiError>;
  }

  /**
   * Internal: prod fetch path for `loadByGuid`.
   * Fetches pack-index.json (cached), then fetches the pack file, parses the
   * asset payload, and registers it.
   */
  private async loadByGuidProd<T = Asset>(
    guid: AssetGuid,
    guidKey: string,
    parentContext?: {
      sceneEntityId?: number;
      componentField?: string;
    },
  ): Promise<Result<T, AssetError | ImageError | RhiError>> {
    // feat-20260603-asset-import-loader-injection M4 / w31 (AC-19 lazy iron law):
    // wrap the DDC fetch + load path so a DDC miss can be routed through the
    // injected ImportTransport (studio form) or fail-fast with
    // `asset-not-imported` (shipped form, AC-22). The load path after a
    // successful DDC resolve is identical in both forms -- zero branches on
    // `this.importTransport` (AC-23 key invariant).
    //
    // A DDC miss is: (a) the GUID is absent from the catalog, OR (b) the
    // `.pack.json` fetch returns `asset-not-found` / `asset-fetch-failed`.
    // In case (a) the transport is probed first (the pack-index may have been
    // built before the asset was imported); in case (b) the transport is the
    // only fallback (the pack file is genuinely missing).

    const entry = await this.resolveCatalogEntry(guidKey);
    if (entry !== undefined) {
      // Catalog hit: try the DDC load path.
      const result = await this.ddcLoad<T>(guid, guidKey, entry, parentContext);
      if (result.ok) return result;
      // DDC miss: only route through transport when the error indicates a
      // missing pack file (not a parse / validation failure inside the pack) or
      // an unimported texture source (feat-20260604 M2 / D-1: import-on-demand).
      // `texture-source-not-imported` is an AssetError, so it passes the
      // `instanceof AssetError` guard naturally. `image-decode-failed` is an
      // ImageError (a genuinely corrupt imported .bin) -- it fails the guard and
      // is therefore never transport-eligible (Risk-1), so a real decode
      // failure is never silently lazy-imported.
      const ddcError = result.error;
      const transportEligible =
        ddcError instanceof AssetError &&
        (ddcError.code === 'asset-not-found' ||
          ddcError.code === 'asset-fetch-failed' ||
          ddcError.code === 'texture-source-not-imported' ||
          // perf-20260706: the raw-container fail-fast (mesh/material/scene whose
          // relativeUrl is still a .glb/.gltf/.fbx) surfaces source-not-imported;
          // it is transport-eligible so the import runs once and rewrites the row
          // to .bin/.pack.json (the shipped form, with no transport, fails fast).
          // Distinct from the generic asset-not-imported, which must stay
          // NON-eligible so the parent-missing breadcrumb is never masked.
          ddcError.code === 'source-not-imported');
      if (transportEligible) {
        return this.transportOrFail<T>(guid, guidKey, ddcError.code);
      }
      return result;
    }

    // Catalog miss: the GUID is not in the pack-index. In the studio form the
    // import transport can lazily create the missing DDC.
    return this.transportOrFail<T>(guid, guidKey, 'asset-not-found');
  }

  /**
   * Resolve the catalog entry for a GUID, lazily fetching the pack-index on
   * first call. Returns `undefined` when the GUID is absent from the catalog.
   */
  private async resolveCatalogEntry(guidKey: string): Promise<
    | {
        relativeUrl: string;
        kind: string;
        name?: string;
        metadata?: ImageMetadata | undefined;
        compression?: AssetCompression;
      }
    | undefined
  > {
    const key = guidKey.toLowerCase();
    // Re-fetch the pack-index when it has never been fetched (=== undefined) OR
    // when the cached Map lacks this GUID. The miss case covers invalidate(guid)
    // round-2 M-A, which deletes the per-GUID index entry (targeted, bystanders
    // survive) without nuking the whole Map to undefined: the next loadByGuid
    // must re-consult the source so the GUID re-resolves and its freshly-cleared
    // body cache re-fetches. A genuinely absent GUID re-fetches once then still
    // misses, falling through to the transport / asset-not-found path as before.
    if (this.packIndexCache === undefined || !this.packIndexCache.has(key)) {
      const catalogResult = await this.fetchPackIndex();
      if (!catalogResult.ok) {
        // Keep packIndexCache === undefined so next resolveCatalogEntry re-enters
        // the fetch path instead of short-circuiting on an empty (polluted) cache.
        if (this.packIndexCache === undefined) return undefined;
      } else {
        this.packIndexCache = catalogResult.value;
        this.registerPackagesFromIndex(this.packIndexCache);
      }
    }
    return this.packIndexCache?.get(key);
  }

  /**
   * feat-20260618 M3 (D-2): once the pack-index is parsed, group every row by
   * its `relativeUrl` and register each package fully -- all of its GUIDs and
   * their entry display names in one `registerPackage` call. Registering the
   * whole package at once (rather than one GUID per load) means the package
   * cardinality is known up front, so `resolveName` returns the basename for a
   * genuinely single-asset package and the entry name for a multi-asset one,
   * with no incremental 1->N promotion needed on the prod path. The name travels
   * entry -> Package, never through the payload (Risk-3 JSON-roundtrip safety),
   * and covers both the sync (parseAssetPayload) and async (texture/font) loads.
   */
  private registerPackagesFromIndex(
    catalog: Map<string, { relativeUrl: string; name?: string }>,
  ): void {
    const byPath = new Map<string, { guids: string[]; names: Map<string, string> }>();
    for (const [guidKey, entry] of catalog) {
      let group = byPath.get(entry.relativeUrl);
      if (group === undefined) {
        group = { guids: [], names: new Map() };
        byPath.set(entry.relativeUrl, group);
      }
      group.guids.push(guidKey);
      if (entry.name !== undefined) group.names.set(guidKey, entry.name);
    }
    for (const [path, group] of byPath) {
      this._registerPackage(path, group.guids, group.names);
    }
  }

  /**
   * Load an asset through the DDC (catalog entry -> fetch pack -> loader.load
   * -> register). Returns `Err(asset-not-found)` or `Err(asset-fetch-failed)`
   * on DDC miss (the caller then decides whether to route through the
   * import transport).
   *
   * This path is IDENTICAL in studio and shipped forms -- the only difference
   * between the two is whether `this.importTransport` exists when the caller
   * falls back to `transportOrFail` (AC-23 key invariant).
   */
  private async ddcLoad<T = Asset>(
    guid: AssetGuid,
    guidKey: string,
    entry: {
      relativeUrl: string;
      kind: string;
      name?: string;
      metadata?: ImageMetadata | undefined;
      compression?: AssetCompression;
    },
    parentContext?: {
      sceneEntityId?: number;
      componentField?: string;
    },
  ): Promise<Result<T, AssetError | ImageError | RhiError>> {
    // feat-20260603-asset-import-loader-injection M1 / w6: the texture / font
    // "upstream-branch" kinds (research Finding 2) are loaded straight from the
    // catalog entry (no `.pack.json` payload detour) through their injected
    // async loaders. Routing is data-driven off the loader set
    // (`UPSTREAM_ENTRY_KINDS`), not a hardcoded `if (entry.kind === 'texture')`
    // chain (AC-01). The loader produces the POD; `registerWithGuid` stays here
    // (D-2).
    if (UPSTREAM_ENTRY_KINDS.has(entry.kind)) {
      return this.loadFromUpstreamEntry<T>(guidKey, entry);
    }

    // perf-20260706: fail-fast for a DDC sub-asset whose relativeUrl still
    // points at a RAW container (`.glb` / `.gltf` / `.fbx`) rather than an
    // importer-produced artifact (`.bin` / `.pack.json`). The gltf/fbx catalog
    // arm (vite-plugin-pack build-catalog) emits thin rows for mesh / material /
    // scene / skeleton / skin / animation-clip whose relativeUrl is the source
    // container; the per-sub-asset body only exists AFTER the ImportTransport
    // (dev `POST /__import/:guid`) parses the container once and rewrites each
    // row to `.<guid>.bin`. Without this guard, every such sub-asset first
    // fetch+parse-FAILS the whole container (e.g. `res.json()` on a 62 MB binary
    // GLB) before falling through to the transport -- so a 1028-sub-asset GLB
    // re-downloaded the 62 MB file ~707x (once per mesh/material/scene) at
    // ~5 min add-to-scene. Returning `asset-not-imported` here routes straight
    // to `transportOrFail` (loadByGuidProd), which imports the container ONCE
    // and patches the rows to `.bin`; the re-entry then no longer trips this
    // guard (no loop). This mirrors the texture path, which already fails fast
    // on its `!relativeUrl.endsWith('.bin')` check in loadTextureAsset.
    if (isRawAssetContainerUrl(entry.relativeUrl)) {
      return err(
        new AssetError({
          code: 'source-not-imported',
          expected:
            `an imported artifact URL (.bin / .pack.json) for ${entry.kind} ` +
            `GUID ${guidKey}; got the raw container ${entry.relativeUrl}`,
          hint: ASSET_ERROR_HINTS['source-not-imported'],
        }),
      );
    }

    // bug-20260610 / feat-20260614 M8 (D-19): when the asset is a material, its
    // paramValues handle fields (e.g. baseColorTexture) are stored on disk as
    // refs[] indices. The materialLoader rewrites each to its refs[] GUID
    // string verbatim (D-19: no handle minting at load time -- the ECS/render
    // side resolves GUID -> column handle at use time).
    // feat-20260622 M4 / w12 + w13: each branch yields the parsed asset AND its
    // pack-entry refs[] (GUID-string projection). The refs ride onto the
    // catalogued envelope (D-9), and the recursive core reads envelope.refs as
    // the single recursion source (D-5) — no per-kind ref re-derivation,
    // and no more per-kind texture preload (the former material Path A is folded
    // into the unified for-loop, R1). loadByGuid stays idempotent on cache hit,
    // so the unified for-loop loading texture sub-assets after the material is
    // registered preserves the cycle-safety register-before-recurse invariant.
    let packResult: Result<{ asset: Asset; refs: readonly string[] }, AssetError>;
    if (entry.kind === 'mesh' && entry.relativeUrl.endsWith('.bin')) {
      // bug-20260610 Fix A: mesh sub-assets carry their vertices / indices in
      // a sibling `<guid>.bin` produced by `packMeshBin` (build-time, in
      // @forgeax/engine-import), not as inline JSON arrays. The catalog row's
      // relativeUrl points straight at the .bin (D-3); we read it via
      // `LoadContext.fetchBinary`, decode through `unpackMeshBin`, and feed a
      // hydrated synthetic payload through the meshLoader (no .pack.json
      // round-trip for mesh -- saves the 80 MB JSON parse on Sponza). The
      // legacy inline-array path (CON-7) still flows through the regular
      // `fetchPackFile` -> meshLoader branch below when the catalog row
      // points at a `.pack.json` carrying number-array vertices (older
      // fixtures and direct-register tests).
      const ctx = this.makeLoadContext();
      const binFetch = await ctx.fetchBinary(
        entry.relativeUrl,
        entry.compression ? { compression: entry.compression } : undefined,
      );
      if (!binFetch.ok) {
        return err(binFetch.error) as Result<T, AssetError>;
      }
      const unpacked = unpackMeshBin(binFetch.value);
      if (unpacked === undefined) {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `decodable mesh-bin payload for GUID ${guidKey}`,
            hint: ASSET_ERROR_HINTS['asset-parse-failed'],
          }),
        );
      }
      // feat-20260612 M2 fixup: pass `indices` through verbatim (including the
      // undefined case for mesh-bins with `ilen=0`, e.g. Fox.glb non-indexed
      // primitives). The previous `?? new Uint16Array(0)` synthesised an
      // empty typed array; meshLoader accepted it but downstream
      // gpu-resource-store treated `indices !== undefined` as "has indices",
      // allocated a 0-byte IBO, and the first frame's
      // `setIndexBuffer(buffer.slice(0..0), ...)` panicked wgpu's
      // `BufferSlice` "buffer slices can not be empty" assertion. meshLoader
      // now accepts undefined and returns a MeshAsset whose `indices` field
      // is omitted, taking the non-indexed `pass.draw` path in record stage.
      const synthIndices: Uint16Array | Uint32Array | undefined = unpacked.indices;
      // bug-20260610: per-stream typed arrays for position / normal / uv /
      // tangent are intentionally absent from the .bin payload (they
      // duplicate the interleaved bytes already in `vertices`); the
      // meshLoader's `payload.attributes ?? {}` fallback handles that.
      // feat-20260611 (w17-b): skinIndex / skinWeight are an exception --
      // they ride alongside the interleaved buffer because the runtime
      // pbr-skin VBO layout reads `attributes.skinIndex` directly via
      // `deriveVertexBufferLayout`. When present in the .bin, hydrate them
      // back into `attributes`; absent (legacy / unskinned) -> empty object.
      const synthAttributes: Record<string, unknown> = {};
      if (unpacked.skinIndex !== undefined) synthAttributes.skinIndex = unpacked.skinIndex;
      if (unpacked.skinWeight !== undefined) synthAttributes.skinWeight = unpacked.skinWeight;
      // feat-20260629 multi-uv regression fix: the extra UV sets (uv1..uvK)
      // ride inside the interleaved `vertices` buffer, but the .bin format
      // stores only the header's `uvSetCount` / `floatsPerVertex` -- not the
      // per-set standalone arrays. Downstream (register stride validator +
      // gpu-resource-store stride + deriveVertexBufferLayout) derives the UV
      // set count from `attributes` via countUvSets, so a decode that omits
      // uv1..uvK makes the wide interleaved buffer disagree with attributes
      // (14-float stride vs. attributes-implied 12) -> every multi-UV mesh
      // fails register with `mesh-vertex-stride-mismatch`. Reconstruct the
      // standalone uv1..uvK Float32Arrays from the interleaved buffer so the
      // attribute set faithfully reflects the packed geometry. UV values are
      // still uploaded from `vertices` (interleaved) -- these arrays only
      // carry the count + let writeback / custom shaders read per-set UVs.
      const uvSetCount = unpacked.uvSetCount ?? 1;
      const floatsPerVertex = unpacked.floatsPerVertex ?? 0;
      if (uvSetCount > 1 && floatsPerVertex > 0 && unpacked.vertices.length > 0) {
        const extraUvSets = uvSetCount - 1;
        // UV1 starts right after the base region (canonical interleaved order:
        // position/normal/uv/tangent[/skinIndex/skinWeight]/uv1..uvK), so the
        // base width is the total stride minus the extra-UV floats.
        const uv1Offset = floatsPerVertex - extraUvSets * 2;
        const vertexCount = unpacked.vertices.length / floatsPerVertex;
        for (let k = 1; k <= extraUvSets; k++) {
          const cat = new Float32Array(vertexCount * 2);
          const interleavedOffset = uv1Offset + (k - 1) * 2;
          for (let v = 0; v < vertexCount; v++) {
            const src = v * floatsPerVertex + interleavedOffset;
            cat[v * 2 + 0] = unpacked.vertices[src + 0] as number;
            cat[v * 2 + 1] = unpacked.vertices[src + 1] as number;
          }
          synthAttributes[`uv${k}`] = cat;
        }
      }
      const synthPayload: Record<string, unknown> = {
        vertices: unpacked.vertices,
        ...(synthIndices !== undefined ? { indices: synthIndices } : {}),
        attributes: synthAttributes,
        ...(unpacked.submeshes !== undefined ? { submeshes: unpacked.submeshes } : {}),
        ...(unpacked.aabb !== undefined ? { aabb: unpacked.aabb } : {}),
      };
      const parsed = this.parseAssetPayload('mesh', synthPayload);
      if (parsed === undefined || (typeof parsed === 'object' && 'ok' in parsed)) {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `parseable mesh payload for GUID ${guidKey}`,
            hint: ASSET_ERROR_HINTS['asset-parse-failed'],
          }),
        );
      }
      // mesh is a leaf asset (no sub-asset refs).
      packResult = ok({ asset: parsed as Asset, refs: [] });
    } else if (entry.kind === 'material') {
      // feat-20260622 M4 / w13 (R1): fold the former Path A (material texture
      // preload) into the unified envelope.refs for-loop. The material parse
      // (materialLoader.load) resolves each paramValues texture field by
      // index -> refs[] GUID string verbatim — it never reads the texture
      // sub-asset from the catalog, only the refs[] string projection. So the
      // texture sub-assets do NOT need pre-loading before parse; the unified
      // for-loop (w12) iterates the catalogued material envelope.refs (which
      // include the texture edges produced by gltf-importer, w5) and loads
      // them, idempotent on cache hit. We fetch the raw entry, parse, and let
      // the unified for-loop handle every refs[] edge.
      const rawResult = await this.fetchPackEntry(entry.relativeUrl, guidKey);
      if (!rawResult.ok) {
        return rawResult as unknown as Result<T, AssetError>;
      }
      const refsRaw = rawResult.value.refs ?? [];
      const parsed = this.parseAssetPayload(
        rawResult.value.kind,
        rawResult.value.payload,
        rawResult.value.refs,
      );
      if (parsed === undefined || (typeof parsed === 'object' && 'ok' in parsed)) {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `parseable material payload for GUID ${guidKey}`,
            hint: ASSET_ERROR_HINTS['asset-parse-failed'],
          }),
        );
      }
      packResult = ok({ asset: parsed as Asset, refs: refsRaw });
    } else {
      packResult = await this.fetchPackFile(entry.relativeUrl, guidKey, entry.kind);
    }
    if (!packResult.ok) {
      return packResult as Result<T, AssetError>;
    }

    const asset = packResult.value.asset;
    // feat-20260622 M4 / w12: project the pack-entry refs[] (GUID strings) into
    // AssetRef[] for the envelope. The on-disk pack.json refs[] carries only
    // GUID strings (sourceField / sceneEntityId are stripped at the
    // serialization boundary, w7 D-10), so prod-loaded edges have no per-entity
    // metadata — the scene breadcrumb fallback (buildSceneChildContext) still
    // walks the payload for entity/field detail. Dev-server register paths that
    // carry rich AssetRef[] keep their edge metadata end-to-end.
    const packRefs: readonly AssetRef[] = packResult.value.refs.map((g) => ({ guid: g }));

    // feat-20260622 M5 / w17 (D-8, R5): the former material parent preload
    // "Path B" (an independent early-return that loaded the parent BEFORE the
    // unified for-loop and carried the precise breadcrumb hint `loading parent
    // material X for child Y`) is folded into the unified envelope.refs
    // for-loop. The parent GUID already rides on the material envelope.refs
    // (gltf-importer w5 writes it; the on-disk pack refs[] carries it as a
    // GUID string -> packRefs above projects it), so the unified for-loop
    // recurses on it like any other edge. Here we only resolve the parent
    // GUID -> AssetGuid and stamp `parent` onto the asset payload (the
    // renderer-facing field read by walkMaterialPassesOverSharedRefs); the
    // parent EDGE load + the `loading parent material X for child Y` breadcrumb
    // + the not-a-material guard all move into the for-loop's
    // sourceField.fieldName==='parent' / parent-edge branch below. No early
    // return: the material registers (register-before-recurse) and its parent
    // edge loads through the same unified path as texture / scene edges.
    let assetToRegister: Asset = asset;
    let parentGuidKey: string | undefined;
    if (
      asset.kind === 'material' &&
      'parentGuid' in (asset as unknown as Record<string, unknown>) &&
      typeof (asset as unknown as Record<string, unknown>).parentGuid === 'string'
    ) {
      const parentGuidStr = (asset as unknown as MaterialAsset & { parentGuid: string }).parentGuid;
      const parentGuid = AssetGuid.parse(parentGuidStr);
      if (!parentGuid.ok) {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `valid parent GUID for child ${guidKey}`,
            hint: `parent GUID '${parentGuidStr}' is not a valid UUID format`,
          }),
        );
      }
      parentGuidKey = parentGuidStr.toLowerCase();
      const matAsset = asset as unknown as MaterialAsset & { parentGuid?: string };
      const passes = matAsset.passes;
      const paramValues = matAsset.paramValues;
      assetToRegister = {
        kind: 'material',
        ...(passes !== undefined ? { passes } : {}),
        ...(paramValues !== undefined ? { paramValues } : {}),
        parent: parentGuid.value,
      };
    }

    // tweak-20260609 M1: catalogue the asset BEFORE recursing into its
    // sub-assets. This way, when a cycle (A→B→A) reaches back to A during
    // B's recursion, A is already catalogued (fast-path hit) and the inFlight
    // Promise for A can be fulfilled. The inFlight entry in `loadByGuid` is
    // the second line of defense — it catches concurrent same-GUID calls
    // before the asset is catalogued.
    const registerResult = this.registerParsedAsset<T>(guid, assetToRegister, guidKey, packRefs);
    if (!registerResult.ok) return registerResult;
    const registeredPayload = registerResult.value;

    // feat-20260622 M4 / w12 (D-5): the recursion source is the just-catalogued
    // envelope's refs[]. The for-loop is kind-agnostic
    // — every AssetRef carries the GUID to recurse on; scene/material/skin all
    // flow through this one loop. Each edge optionally carries sourceField /
    // sceneEntityId; when present the childContext is built straight from the
    // edge, otherwise the scene branch falls back to walking the payload
    // (buildSceneChildContext) so the prod-path breadcrumb keeps its entity /
    // field detail (on-disk refs[] are GUID-string-only, w7 D-10).
    const envelope = this.assetCatalog.get(guidKey);
    const refs: readonly AssetRef[] = envelope?.refs ?? [];
    if (refs.length > 0) {
      const subResults = await Promise.all(
        refs.map((ref) => {
          const refGuidKey = ref.guid.toLowerCase();
          const parsedRef = AssetGuid.parse(ref.guid);
          if (!parsedRef.ok) {
            return Promise.resolve({
              guidKey: refGuidKey,
              result: err(
                new AssetError({
                  code: 'asset-parse-failed',
                  expected: `valid sub-asset GUID referenced by ${asset.kind} ${guidKey}`,
                  hint: `refs[] entry '${ref.guid}' is not a valid UUID format`,
                }),
              ) as Result<Asset, AssetError | ImageError | RhiError>,
              childContext: undefined as
                | {
                    sceneEntityId?: number;
                    componentField?: string;
                    sourceField?: {
                      componentName?: string;
                      fieldName: string;
                      arrayIndex?: number;
                    };
                  }
                | undefined,
              isParentEdge: false,
              edge: ref,
            });
          }
          let childContext:
            | {
                sceneEntityId?: number;
                componentField?: string;
                sourceField?: {
                  componentName?: string;
                  fieldName: string;
                  arrayIndex?: number;
                };
              }
            | undefined;
          if (ref.sceneEntityId !== undefined || ref.sourceField !== undefined) {
            childContext = {};
            if (ref.sceneEntityId !== undefined) childContext.sceneEntityId = ref.sceneEntityId;
            if (ref.sourceField?.fieldName !== undefined) {
              childContext.componentField =
                (ref.sourceField.componentName !== undefined
                  ? `${ref.sourceField.componentName}.`
                  : '') +
                ref.sourceField.fieldName +
                (ref.sourceField.arrayIndex !== undefined ? `[${ref.sourceField.arrayIndex}]` : '');
              childContext.sourceField = ref.sourceField;
            }
          } else if (asset.kind === 'scene') {
            childContext = this.buildSceneChildContext(asset, refGuidKey, guidKey);
          }
          // feat-20260622 M5 / w17 (D-8): the material parent edge. Identify it
          // by either the rich dev-path marker (sourceField.fieldName==='parent')
          // or the prod-path GUID match against the resolved parent GUID
          // (on-disk refs[] strip sourceField, w7 D-10, so the GUID is the only
          // signal). The parent edge carries the distinct `loading parent
          // material X for child Y` breadcrumb (AC-10) instead of the generic
          // buildBreadcrumbHint form, and is guarded to be a material.
          const isParentEdge =
            asset.kind === 'material' &&
            (ref.sourceField?.fieldName === 'parent' ||
              (parentGuidKey !== undefined && refGuidKey === parentGuidKey));
          return this.loadByGuid(parsedRef.value, childContext ?? parentContext).then((r) => ({
            guidKey: refGuidKey,
            result: r,
            childContext,
            isParentEdge,
            edge: ref,
          }));
        }),
      );

      // If any sub-asset load failed, propagate the first error enriched with
      // parent breadcrumb.
      for (const {
        guidKey: subGuidKey,
        result: subResult,
        childContext: subChildContext,
        isParentEdge,
        edge: subEdge,
      } of subResults) {
        // feat-20260622 M5 / w17: parent-edge breadcrumb migration (former Path
        // B). On load failure, carry the distinct `loading parent material X for
        // child Y: <subErr.hint>` form (AC-10 downstream literal assertion) and
        // propagate the parent's own error code verbatim.
        if (isParentEdge && !subResult.ok) {
          const subErr = subResult.error;
          const code: AssetErrorCode =
            subErr instanceof AssetError ? subErr.code : 'asset-parse-failed';
          return err(
            new AssetError({
              code,
              expected: subErr.expected,
              hint: `loading parent material ${subGuidKey} for child ${guidKey}: ${
                subErr.hint ?? ''
              }`,
              ...(subErr instanceof AssetError && subErr.detail !== undefined
                ? { detail: subErr.detail as Readonly<AssetErrorDetail> }
                : {}),
            }),
          );
        }
        // feat-20260622 M5 / w17: parent edge loaded but is not a material —
        // same guard the former Path B carried, with the matching breadcrumb.
        if (isParentEdge && subResult.ok && subResult.value?.kind !== 'material') {
          return err(
            new AssetError({
              code: 'asset-parse-failed',
              expected: `parent GUID ${subGuidKey} to reference a MaterialAsset`,
              hint: `loading parent material ${subGuidKey} for child ${guidKey}: referenced asset is ${subResult.value?.kind ?? 'unknown'}, not 'material'`,
            }),
          );
        }
        if (!subResult.ok) {
          const subErr = subResult.error;
          const breadcrumb = this.buildBreadcrumbHint(
            guidKey,
            asset.kind,
            subGuidKey,
            subChildContext ?? parentContext,
          );
          const code: AssetErrorCode =
            subErr instanceof AssetError ? subErr.code : 'asset-fetch-failed';
          // feat-20260622 verify r1: deliver the breadcrumb provenance in
          // structured form so AI users locate the broken edge by property
          // access (charter P3), not by parsing the hint. Preserve the sub
          // error's own detail when it carries one (more specific); otherwise
          // expose the edge provenance (entity / source field).
          // Prefer the rich dev-path edge provenance; on the prod path the
          // on-disk edge is GUID-only (sourceField stripped, w7 D-10), so fall
          // back to the entity-walk-recovered provenance carried on the
          // childContext (verify r1).
          const provEntityId = subEdge?.sceneEntityId ?? subChildContext?.sceneEntityId;
          const provSourceField = subEdge?.sourceField ?? subChildContext?.sourceField;
          const breadcrumbDetail: Readonly<AssetErrorDetail> = {
            referencedByGuid: guidKey,
            referencedByKind: asset.kind,
            subAssetGuid: subGuidKey,
            ...(provEntityId !== undefined ? { sceneEntityId: provEntityId } : {}),
            ...(provSourceField !== undefined ? { sourceField: provSourceField } : {}),
          };
          const detail: Readonly<AssetErrorDetail> =
            subErr instanceof AssetError && subErr.detail !== undefined
              ? subErr.detail
              : breadcrumbDetail;
          return err(
            new AssetError({
              code,
              expected: subErr.expected,
              hint: `${breadcrumb} / ${subErr.hint ?? ''}`,
              detail,
            }),
          );
        }
      }
    }

    return ok(registeredPayload as T);
  }

  /**
   * tweak-20260609 M1 helper: build the per-sub-ref parent context for a
   * SceneAsset child. feat-20260622 M3 / w9: re-sourced to lookup in the
   * scene envelope's ``refs[]`` edges instead of walking entity components
   * via extractSceneEntityHandleGuids (D-7). When the scene envelope is not
   * found in the catalog, falls back to the entity-walk path (backward compat
   * for call sites that lack a catalogued envelope).
   *
   * Texture edges (sourceField=undefined) produce ``componentField:
   * undefined`` — the breadcrumb will show GUID+kind only, no per-entity
   * detail (D-2: texture has no per-entity origin).
   */
  private buildSceneChildContext(
    scene: Asset & { kind: 'scene' },
    subGuidKey: string,
    sceneGuidKey?: string,
  ):
    | {
        sceneEntityId?: number;
        componentField?: string;
        sourceField?: {
          componentName?: string;
          fieldName: string;
          arrayIndex?: number;
        };
      }
    | undefined {
    // feat-20260622 M3 / w9: direct lookup in envelope.refs edges.
    // feat-20260622 review r1: address the recursing scene's OWN envelope by
    // its guidKey, not the first scene in the catalog -- under a multi-scene
    // glTF catalog the first-scene scan attributes the breadcrumb to the wrong
    // scene. Fall back to the first-scene scan only when no guidKey is given
    // (legacy call sites lacking a catalogued envelope).
    let sceneEnvelope: AssetEnvelope | undefined;
    if (sceneGuidKey !== undefined) {
      const env = this.assetCatalog.get(sceneGuidKey);
      if (env?.kind === 'scene') sceneEnvelope = env;
    }
    if (sceneEnvelope === undefined) {
      for (const [, env] of this.assetCatalog) {
        if (env.kind === 'scene' && env.refs !== undefined && env.refs.length > 0) {
          sceneEnvelope = env;
          break;
        }
      }
    }
    let edgeResult:
      | {
          sceneEntityId?: number;
          componentField?: string;
        }
      | undefined;
    if (sceneEnvelope?.refs !== undefined) {
      for (const ref of sceneEnvelope.refs) {
        if (ref.guid.toLowerCase() === subGuidKey) {
          const { sceneEntityId, sourceField } = ref;
          const result: {
            sceneEntityId?: number;
            componentField?: string;
            sourceField?: {
              componentName?: string;
              fieldName: string;
              arrayIndex?: number;
            };
          } = {};
          if (sceneEntityId !== undefined) {
            result.sceneEntityId = sceneEntityId;
          }
          if (sourceField?.componentName !== undefined && sourceField?.fieldName !== undefined) {
            result.componentField =
              `${sourceField.componentName}.${sourceField.fieldName}` +
              (sourceField.arrayIndex !== undefined ? `[${sourceField.arrayIndex}]` : '');
          }
          if (sourceField !== undefined) {
            result.sourceField = sourceField;
          }
          // A rich edge (dev register path) carries full detail — return now.
          if (result.sceneEntityId !== undefined || result.componentField !== undefined) {
            return result;
          }
          // feat-20260622 M4 / w14: a GUID-only edge (prod path: on-disk refs[]
          // strip sourceField / sceneEntityId at the serialization boundary, w7
          // D-10) carries no per-entity detail. Keep this empty-but-defined
          // result as the fallback, then try the entity walk below to recover
          // the entity localId + component.field path (D-7 / B-8). The walk
          // recovers handle-field edges (mesh / material); a texture edge (D-2:
          // no per-entity origin) is not found by the walk, so the empty
          // edgeResult is returned (w10 texture-edge contract preserved).
          edgeResult = result;
          break;
        }
      }
    }
    // Backward compat: fall back to entity walk when the envelope edge carries
    // no per-entity detail (prod path: GUID-only refs[]) or no envelope is
    // available (e.g. direct catalog() registration with scene payload, no refs).
    const entries = extractSceneEntityHandleGuids(
      scene.entities as unknown as ReadonlyArray<{
        readonly localId: number;
        readonly components: Record<string, Record<string, unknown>>;
      }>,
    );
    for (const entry of entries) {
      if (entry.guidString.toLowerCase() === subGuidKey) {
        return {
          sceneEntityId: entry.entityLocalId,
          componentField: `${entry.componentName}.${entry.fieldName}${entry.arrayIndex !== undefined ? `[${entry.arrayIndex}]` : ''}`,
          // feat-20260622 verify r1: also surface the recovered provenance in
          // structured parts so the failure `.detail` can expose them for AI
          // property access (charter P3), not only the concatenated hint string.
          sourceField: {
            componentName: entry.componentName,
            fieldName: entry.fieldName,
            ...(entry.arrayIndex !== undefined ? { arrayIndex: entry.arrayIndex } : {}),
          },
        };
      }
    }
    return edgeResult;
  }
  /**
   * tweak-20260609 M1 helper: build the error-hint breadcrumb string
   * containing the parent asset's GUID + kind, enriched with the
   * caller-provided `parentContext` (entity localId + component.field).
   *
   * Per D-7 / B-8: the breadcrumb appears before the sub-asset's own hint,
   * separated by " / ".
   */
  private buildBreadcrumbHint(
    parentGuidKey: string,
    parentKind: string,
    subGuidKey: string,
    parentContext?: {
      sceneEntityId?: number;
      componentField?: string;
    },
  ): string {
    let breadcrumb = `sub-asset ${subGuidKey} referenced by ${parentKind} ${parentGuidKey}`;
    if (parentContext?.sceneEntityId !== undefined && parentContext?.componentField !== undefined) {
      breadcrumb += ` (entity ${parentContext.sceneEntityId}, field ${parentContext.componentField})`;
    }
    return breadcrumb;
  }

  /**
   * M4 transport fallback: try the injected {@link ImportTransport} to lazily
   * import a missing DDC, then re-enter the DDC load path. When no transport
   * is wired (shipped form), fail fast with `asset-not-imported` (AC-22).
   */
  private async transportOrFail<T = Asset>(
    guid: AssetGuid,
    guidKey: string,
    _missReason: AssetErrorCode,
  ): Promise<Result<T, AssetError | ImageError | RhiError>> {
    if (this.importTransport === undefined) {
      // shipped form: no transport wired -> fail fast, never degrade to
      // runtime import (AC-22, charter P3 explicit failure).
      return err(
        new AssetError({
          code: 'asset-not-imported',
          expected: `GUID ${guidKey} to have been pre-imported at build time or to have an ImportTransport wired`,
          hint: ASSET_ERROR_HINTS['asset-not-imported'],
        }),
      );
    }

    // studio form: request the transport to import this GUID on-the-fly.
    // After a successful transport call the DDC is available; re-enter the
    // catalog + DDC load path (the transport writes the DDC but does NOT
    // register the asset — that's the Loader's job).
    const transportResult = await this.importTransport.fetchPack(guidKey);
    if (!transportResult.ok) {
      return err(
        new AssetError({
          code: 'asset-not-imported',
          expected: `import transport to fetch pack for GUID ${guidKey}`,
          hint: ASSET_ERROR_HINTS['asset-not-imported'],
        }),
      );
    }

    // Patch ONLY the freshly imported rows into the catalog cache (per-asset
    // incremental, the four-verb redesign 2026-06-06) instead of nuking the
    // cache and re-fetching the whole pack-index. The transport returns the one
    // imported entry (+ sub-asset siblings); each becomes / overwrites a cache
    // row. This keeps 122 concurrent texture imports O(N) instead of O(N^2)
    // whole-catalog re-fetches and never resets a sibling's imported row.
    const importedEntries = 'entries' in transportResult ? transportResult.entries : undefined;
    if (importedEntries !== undefined && importedEntries.length > 0) {
      // F20: serialise packIndexCache writes through a per-cache Promise queue.
      // The "check -> new Map -> set" block is not atomic across concurrent
      // transportOrFail calls; chaining through the queue ensures each patch
      // completes before the next starts, preventing new-Map overwrite races.
      this.packIndexCachePatchQueue = this.packIndexCachePatchQueue.then(() => {
        if (this.packIndexCache === undefined) this.packIndexCache = new Map();
        for (const e of importedEntries) {
          this.packIndexCache.set(e.guid.toLowerCase(), {
            relativeUrl: e.relativeUrl,
            kind: e.kind,
            // Carry the transport's derived display name into the cache row.
            // buildCatalog already resolves it (deriveAssetName: basename of the
            // source for single-/no-storedName sub-assets), so a freshly imported
            // GLB's 1000+ sub-assets show as "<file>.glb" in the Content Browser
            // instead of blank. Dropping it here made listCatalog fall back to
            // `entry.name ?? ''` — the whole-index re-read path (else branch) kept
            // names, so only the incremental patch path was blank.
            ...(e.name !== undefined ? { name: e.name } : {}),
            ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
            // Carry refs on the incremental patch path too, else an asset
            // imported via POST /__import shows missing dependency edges until
            // the next full pack-index refresh (feat: listCatalog refs).
            ...(e.refs !== undefined ? { refs: e.refs } : {}),
            ...(e.compression !== undefined ? { compression: e.compression } : {}),
          });
        }
      });
      await this.packIndexCachePatchQueue;
    } else {
      // No inline rows -- fall back to a full pack-index re-read so the freshly
      // imported DDC entry is visible (legacy / non-row-returning transports).
      this.packIndexCache = undefined;
    }
    const entry = await this.resolveCatalogEntry(guidKey);
    if (entry === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-imported',
          expected: `import transport to produce a catalog entry for GUID ${guidKey}`,
          hint: ASSET_ERROR_HINTS['asset-not-imported'],
        }),
      );
    }

    // Re-enter the DDC load path (identical to the catalog-hit path).
    return this.ddcLoad<T>(guid, guidKey, entry);
  }

  /**
   * Register a parsed asset POD (the synchronous tail of the DDC load path:
   * `registerWithGuid`). Material parent preload is handled asynchronously
   * inside `ddcLoad` before calling this method; the registered asset is
   * always fully resolved by the time it reaches here.
   *
   * Extracted from the old `loadByGuidProd` body so `ddcLoad` and
   * `transportOrFail` share an identical load path (AC-23 key invariant).
   */
  private registerParsedAsset<T = Asset>(
    guid: AssetGuid,
    asset: Asset,
    _guidKey: string,
    refs?: readonly AssetRef[],
  ): Result<T, AssetError | ImageError | RhiError> {
    // feat-20260614 M8 (D-17): catalogue the parsed payload under its GUID and
    // return the PAYLOAD. `catalog` validates mesh stride + material passes and
    // returns Result.err on failure (no throw), so the loadByGuid surface stays
    // a consistent Result (charter P4 consistent abstraction).
    //
    // feat-20260622 M4 / w12 (D-9): the pack-entry refs[] ride onto the
    // catalogued envelope here so the recursive core can read envelope.refs as
    // its single recursion source.
    return this.catalog<T>(guid, asset as T, refs) as Result<T, AssetError | ImageError | RhiError>;
  }

  /**
   * Fetch and parse pack-index.json into a Map<guidKey, {relativeUrl, kind}>.
   */
  private async fetchPackIndex(): Promise<
    Result<
      Map<
        string,
        {
          relativeUrl: string;
          kind: string;
          name?: string;
          metadata?: ImageMetadata | undefined;
          refs?: readonly string[];
          compression?: AssetCompression;
        }
      >,
      AssetError
    >
  > {
    let raw: unknown;
    try {
      const res = await globalThis.fetch(this.packIndexUrl as string);
      if (!res.ok) {
        return err(
          new AssetError({
            code: 'asset-fetch-failed',
            expected: `fetch(${this.packIndexUrl}) to return ok`,
            hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
          }),
        );
      }
      raw = (await res.json()) as unknown;
    } catch {
      return err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: `fetch(${this.packIndexUrl}) to succeed`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        }),
      );
    }

    if (!Array.isArray(raw)) {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: 'pack-index.json to be a JSON array',
          hint: ASSET_ERROR_HINTS['asset-parse-failed'],
        }),
      );
    }

    const catalog = new Map<
      string,
      {
        relativeUrl: string;
        kind: string;
        name?: string;
        metadata?: ImageMetadata | undefined;
        refs?: readonly string[];
        compression?: AssetCompression;
      }
    >();
    for (const item of raw as Array<{
      guid?: unknown;
      relativeUrl?: unknown;
      kind?: unknown;
      name?: unknown;
      metadata?: unknown;
      refs?: unknown;
      compression?: unknown;
    }>) {
      if (
        typeof item.guid === 'string' &&
        typeof item.relativeUrl === 'string' &&
        typeof item.kind === 'string'
      ) {
        // metadata is the optional 5th field introduced by feat-20260517
        // D-2 (catalog builder writes it for kind: 'texture' rows; legacy
        // 4-field rows leave it undefined). Pass-through is structural --
        // runtime narrows on `entry.metadata !== undefined` inside the
        // texture arm and routes to `image-meta-missing` otherwise.
        //
        // feat-20260618 M3 (D-2): `name` is the optional display name the
        // catalog builder writes for multi-asset entries. It flows entry ->
        // Package (registerPackage in the load path), never into the payload,
        // so loader payload parsing stays untouched (Risk-3 roundtrip safety).
        const row: {
          relativeUrl: string;
          kind: string;
          name?: string;
          metadata?: ImageMetadata | undefined;
          refs?: readonly string[];
          compression?: AssetCompression;
        } = {
          relativeUrl: item.relativeUrl,
          kind: item.kind,
          metadata: item.metadata as ImageMetadata | undefined,
        };
        if (typeof item.name === 'string') row.name = item.name;
        // refs is the optional dependency-edge field (feat: listCatalog refs);
        // narrow to a string[] so a malformed pack-index row cannot inject
        // non-string edges into the catalog.
        if (Array.isArray(item.refs) && item.refs.every((r) => typeof r === 'string')) {
          row.refs = item.refs as readonly string[];
        }
        // compression is the optional compression strategy field (Loop 1).
        // Narrow to literal union values to reject malformed rows.
        if (item.compression === 'none' || item.compression === 'zstd') {
          row.compression = item.compression;
        }
        catalog.set(item.guid.toLowerCase(), row);
      }
    }
    return ok(catalog);
  }

  /**
   * Fetch a .pack.json file, find the asset entry matching guidKey, and
   * reconstruct the Asset from its payload.
   */
  /**
   * bug-20260610: fetch one pack file and return the raw asset entry without
   * parsing. Used by `loadByGuidProd` for material kinds so the caller can
   * recursively preload `refs[]` (texture sub-assets) BEFORE the synchronous
   * materialLoader runs and rewrites paramValues handle fields to their refs[]
   * GUID strings (feat-20260614 M8 / D-19: GUID verbatim, no handle minting).
   */
  private async fetchPackEntry(
    relativeUrl: string,
    guidKey: string,
  ): Promise<
    Result<{ kind: string; payload: Record<string, unknown>; refs?: string[] }, AssetError>
  > {
    let raw: unknown;
    try {
      const res = await globalThis.fetch(relativeUrl);
      if (!res.ok) {
        return err(
          new AssetError({
            code: 'asset-fetch-failed',
            expected: `fetch(${relativeUrl}) to return ok`,
            hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
          }),
        );
      }
      raw = (await res.json()) as unknown;
    } catch {
      return err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: `fetch(${relativeUrl}) to succeed`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        }),
      );
    }
    const packFile = raw as {
      assets?: Array<{
        guid: string;
        kind: string;
        payload: Record<string, unknown>;
        refs?: string[];
      }>;
    };
    const assetEntry = (packFile.assets ?? []).find(
      (a) => a.guid.toLowerCase() === guidKey.toLowerCase(),
    );
    if (assetEntry === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }
    return ok({
      kind: assetEntry.kind,
      payload: assetEntry.payload,
      ...(assetEntry.refs !== undefined ? { refs: assetEntry.refs } : {}),
    });
  }

  /**
   * Fetch one pack file, locate the requested asset entry, and either parse it
   * inline or expose the entry to the caller (for kinds that need to preload
   * `refs[]` BEFORE running the loader — currently 'material', whose
   * paramValues handle fields are rewritten to their refs[] GUID strings
   * (feat-20260614 M8 / D-19: GUID verbatim, no handle minting at load time)).
   *
   * bug-20260610 Fix B (M3 / D-4): the fetch+parse result is cached per
   * `relativeUrl` in `packFileCache`; concurrent calls for the same URL share
   * a single in-flight promise via `packFileInFlight`. Only the raw parsed
   * body is cached — `parseAssetPayload` still runs per-call (CON-2).
   */
  private async fetchPackFile(
    relativeUrl: string,
    guidKey: string,
    _kind: string,
  ): Promise<Result<{ asset: Asset; refs: readonly string[] }, AssetError>> {
    // ── cache hit ───────────────────────────────────────────────────────
    const cached = this.packFileCache.get(relativeUrl);
    if (cached !== undefined) {
      const assetEntry = cached.assets.find((a) => a.guid.toLowerCase() === guidKey.toLowerCase());
      if (assetEntry === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
            hint: ASSET_ERROR_HINTS['asset-not-found'],
          }),
        );
      }
      return this.parseAndReturnAsset(assetEntry);
    }

    // ── in-flight dedup ─────────────────────────────────────────────────
    const inFlight = this.packFileInFlight.get(relativeUrl);
    if (inFlight !== undefined) {
      try {
        const packFile = await inFlight;
        const assetEntry = packFile.assets.find(
          (a) => a.guid.toLowerCase() === guidKey.toLowerCase(),
        );
        if (assetEntry === undefined) {
          return err(
            new AssetError({
              code: 'asset-not-found',
              expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
              hint: ASSET_ERROR_HINTS['asset-not-found'],
            }),
          );
        }
        return this.parseAndReturnAsset(assetEntry);
      } catch {
        // In-flight promise rejected (network failure) — fall through to
        // re-fetch. The in-flight entry was already cleaned by the
        // catch block in the original miss path.
      }
    }

    // ── miss: fetch + parse + cache ─────────────────────────────────────
    return this.fetchAndCachePackFile(relativeUrl, guidKey);
  }

  /**
   * Parse the asset payload from a pack-file entry and return the result.
   * Extracted so cache-hit and in-flight-dedup paths share the same
   * parseAssetPayload + error-wrapping logic.
   */
  private parseAndReturnAsset(assetEntry: {
    kind: string;
    payload: Record<string, unknown>;
    refs?: string[];
  }): Result<{ asset: Asset; refs: readonly string[] }, AssetError> {
    const parsed = this.parseAssetPayload(assetEntry.kind, assetEntry.payload, assetEntry.refs);
    // F21: the scene loader returns its structured ParseErrorDetail inline via
    // the LoaderOutput `{ ok: false, error }` arm, surfaced here through
    // parseAssetPayload's return value -- no shared instance slot.
    if (parsed !== undefined && typeof parsed === 'object' && 'ok' in parsed) {
      const e = (parsed as { readonly ok: false; readonly error: ParseErrorDetail }).error;
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `refs index ${e.index} within [0, ${e.refsLength})`,
          detail: {
            localId: e.localId,
            component: e.component,
            field: e.field,
            index: e.index,
            refsLength: e.refsLength,
          },
          hint:
            `at node localId=${e.localId}, component=${e.component}, ` +
            `field=${e.field}: index ${e.index} is out of bounds ` +
            `(refs has ${e.refsLength} entries)`,
        }),
      );
    }
    if (parsed === undefined) {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `parseable asset payload for kind ${assetEntry.kind}`,
          hint: ASSET_ERROR_HINTS['asset-parse-failed'],
        }),
      );
    }
    // feat-20260622 M4 / w12: surface the pack-entry refs[] (GUID-string
    // projection) alongside the parsed payload so ddcLoad can store them on
    // the catalogued envelope. The recursive core then reads envelope.refs
    // as the single recursion source (D-5), never re-deriving them from
    // the payload.
    return ok({ asset: parsed as Asset, refs: assetEntry.refs ?? [] });
  }

  /**
   * Fetch a pack file from the network, parse the JSON body, store the
   * result in the cache, and return the requested asset entry.
   *
   * Registers the in-flight promise in `packFileInFlight` so concurrent
   * callers share a single fetch. On success the body moves to
   * `packFileCache`; on failure the in-flight entry is removed so
   * subsequent retries re-fetch (D-7).
   */
  private async fetchAndCachePackFile(
    relativeUrl: string,
    guidKey: string,
  ): Promise<Result<{ asset: Asset; refs: readonly string[] }, AssetError>> {
    const fetchPromise = (async (): Promise<ParsedPackFile> => {
      let raw: unknown;
      try {
        const res = await globalThis.fetch(relativeUrl);
        if (!res.ok) {
          throw new AssetError({
            code: 'asset-fetch-failed',
            expected: `fetch(${relativeUrl}) to return ok`,
            hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
          });
        }
        raw = (await res.json()) as unknown;
      } catch (e) {
        if (e instanceof AssetError) throw e;
        throw new AssetError({
          code: 'asset-fetch-failed',
          expected: `fetch(${relativeUrl}) to succeed`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        });
      }
      // Shape guard: the dev-server / preview / 404 fallback can return
      // index.html or an unrelated JSON body that satisfies res.ok but lacks
      // the ParsedPackFile contract. Without this guard the downstream
      // `packFile.assets.find` raises TypeError outside any AssetError
      // branch, escapes as a process-level Unhandled Rejection, and drives
      // vitest browser-project exit=1 even when every onerror-gate test
      // assertion passes (feat-20260611 step-implement F-4).
      if (
        raw === null ||
        typeof raw !== 'object' ||
        !Array.isArray((raw as { assets?: unknown }).assets)
      ) {
        throw new AssetError({
          code: 'asset-fetch-failed',
          expected: `pack-file body at ${relativeUrl} to be { assets: [...] }`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        });
      }
      return raw as ParsedPackFile;
    })();

    this.packFileInFlight.set(relativeUrl, fetchPromise);

    try {
      const packFile = await fetchPromise;
      this.packFileCache.set(relativeUrl, packFile);
      this.packFileInFlight.delete(relativeUrl);

      const assetEntry = packFile.assets.find(
        (a) => a.guid.toLowerCase() === guidKey.toLowerCase(),
      );
      if (assetEntry === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
            hint: ASSET_ERROR_HINTS['asset-not-found'],
          }),
        );
      }
      return this.parseAndReturnAsset(assetEntry);
    } catch (e) {
      this.packFileInFlight.delete(relativeUrl);
      if (e instanceof AssetError) {
        return err(e);
      }
      throw e;
    }
  }

  /**
   * Reconstruct a typed `Asset` from a raw payload object.
   *
   * @param kind The asset kind discriminant (matches the pack entry or
   *   dev-register dispatch).
   * @param payload The serialised asset payload (keys mirror the asset
   *   interface field names).
   * @param refs Pack-file refs array for Handle fields — when a field
   *   value is `number` it resolves to `refs[N]` (glTF-style index).
   *   Optional to preserve compatibility with callers outside the pack
   *   ingestion path (e.g., direct `registerWithGuid`).
   */
  private parseAssetPayload(
    kind: string,
    payload: Record<string, unknown>,
    refs?: string[],
  ):
    | Asset
    | Record<string, unknown>
    | undefined
    | { readonly ok: false; readonly error: ParseErrorDetail } {
    // feat-20260603-asset-import-loader-injection M1 / w4: dispatch on
    // `kind` through the injected LoaderRegistry instead of a hardcoded
    // `if (kind === ...)` chain (D-1 / AC-01). The seven inline pack-payload
    // loaders parse synchronously; texture / font live on the upstream
    // loadByGuidProd branch (w6) and are never reached here.
    // feat-20260623 M2 / w5: unknown kinds pass through the raw payload so
    // host-registered loaders can parse their own kind. The engine does not
    // parse payloads it cannot match; parse responsibility is explicit on the
    // missing loader (charter P3).
    const loader = this.loaders.get(kind);
    if (loader === undefined) return { ...payload, kind };
    const out = loader.load(payload, refs, this.makeLoadContext());
    // The inline pack-payload loaders are synchronous (`Asset | undefined`);
    // the async texture / font loaders are dispatched from loadByGuidProd, not
    // here. A Promise here would mean a misregistered loader -> treat as a
    // parse miss rather than leaking a thenable into the sync return.
    if (out !== undefined && typeof (out as { then?: unknown }).then === 'function') {
      return undefined;
    }
    // F21: the scene loader returns { ok: false, error: ParseErrorDetail } for
    // structured parse errors. Pass the error arm straight through the return
    // value so the caller constructs a precise AssetError -- no instance slot.
    if (out !== undefined && out !== null && typeof out === 'object' && 'ok' in out) {
      return out as { readonly ok: false; readonly error: ParseErrorDetail };
    }
    return out as Asset | undefined;
  }

  /**
   * Build the {@link LoadContext} passed to a loader's `load`.
   * `fetchBinary` / `resolveRef` / `device` are wired for the async texture /
   * font loaders (w6).
   */
  private makeLoadContext(): LoadContext {
    return {
      /**
       * feat-20260706 M3 / w19: fetchBinary signature extended per D-2.
       * `opts?.compression` triggers the single decompression gate (AC-02).
       * 'zstd' → lazy-init codec decompressZstd · 'none' / undefined → pass-through.
       * On decompression failure, the codec error is nested in asset-fetch-failed
       * detail (D-8: runtime error union NOT extended).
       */
      fetchBinary: async (url: string, opts?: { readonly compression?: AssetCompression }) => {
        try {
          const res = await globalThis.fetch(url);
          if (!res.ok) {
            return {
              ok: false as const,
              error: new AssetError({
                code: 'asset-fetch-failed',
                expected: `fetch(${url}) to return ok`,
                hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
              }),
            };
          }
          const buf = await res.arrayBuffer();
          let bytes: Uint8Array = new Uint8Array(buf);

          // --- Decompression gate (AC-02: single gate inside fetchBinary) ---
          if (opts?.compression === 'zstd') {
            const { decompressZstd } = await import('@forgeax/engine-codec');
            const decRes = await decompressZstd(bytes);
            if (!decRes.ok) {
              return {
                ok: false as const,
                error: new AssetError({
                  code: 'asset-parse-failed',
                  expected: `zstd decompression for ${url}`,
                  hint: `[${decRes.error.code}] ${decRes.error.hint}`,
                  detail: { sourcePath: url },
                }),
              };
            }
            bytes = new Uint8Array(
              decRes.value.buffer,
              decRes.value.byteOffset,
              decRes.value.byteLength,
            );
          }
          // compression === 'none' / undefined → E1 pass-through

          return { ok: true as const, value: bytes };
        } catch {
          return {
            ok: false as const,
            error: new AssetError({
              code: 'asset-fetch-failed',
              expected: `fetch(${url}) to succeed`,
              hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
            }),
          };
        }
      },
      resolveRef: async (guid: string) => {
        const parsed = AssetGuid.parse(guid);
        if (!parsed.ok) {
          return { ok: false as const, error: parsed.error };
        }
        const r = await this.loadByGuid(parsed.value);
        if (!r.ok) return { ok: false as const, error: r.error };
        // feat-20260614 M8 (D-19): resolveRef ensures the sub-asset is
        // catalogued (recursive load). The numeric value is vestigial -- the
        // registry mints no handles; callers store the GUID, not this number.
        return { ok: true as const, value: 0 };
      },
      // feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
      // expose the registered shader's derive(paramSchema).textureFieldNames to
      // the materialLoader so it can decide which paramValues fields carry
      // refs[] indices without a hardcoded texture-field allowlist Set
      // (AC-03). Returns `undefined` when the shader is not registered (cross-
      // worktree shader-late-register, plan R-4) — the loader then falls back
      // to a graceful "try every int paramValue" walk.
      getMaterialShaderTextureFieldNames: (shaderId: string) => {
        const lookup = this.shaderRegistry.lookupMaterialShader(shaderId);
        if (!lookup.ok) return undefined;
        return derive(lookup.value.paramSchema).textureFieldNames;
      },
      device: undefined,
    };
  }

  /**
   * Return a runtime snapshot of every catalogued asset. Each entry exposes
   * `{ guid, kind, name }` where `kind` is the asset discriminant string
   * from `payload.kind`. feat-20260614 M8 (D-15): the registry holds no
   * handles -- entries are keyed by GUID (the catalogue key).
   *
   * AI-user narrowing flow (AC-11 + plan-strategy §7.4):
   * ```ts
   * for (const e of registry.inspect().assets) {
   *   if (e.kind === 'texture') {
   *     // re-query via registry.lookup(e.guid) to get the typed Asset value.
   *   }
   * }
   * ```
   */
  inspect(): InspectSnapshot {
    const assets: InspectEntry[] = [];
    for (const [guid, envelope] of this.assetCatalog) {
      assets.push({
        guid,
        kind: envelope.payload.kind,
        name: this.resolveName(guid),
      });
    }
    return { assets };
  }

  /**
   * Return a readonly snapshot of all catalogued assets (inlined + pack-index)
   * for enumeration by asset panels (AC-03 single source of truth).
   *
   * Merges entries from the private `packIndexCache` (prod path, carries
   * `relativeUrl`) and `assetCatalog` (inlined / dev path, no URL). Each
   * GUID appears exactly once. Returns a fresh array on every call — the
   * internal Maps are never exposed (charter P4 consistent abstraction).
   *
   * plan-strategy section 2 D1; requirements AC-03; research Finding 5.
   *
   * @example
   * ```ts
   * for (const e of registry.listCatalog()) {
   *   console.log(e.guid, e.kind, e.name, e.relativeUrl);
   * }
   * ```
   */
  listCatalog(): readonly {
    guid: string;
    kind: string;
    name?: string;
    relativeUrl: string;
    refs?: readonly string[];
    /** Build-time compression strategy. `undefined` for legacy / uncompressed rows. */
    compression?: AssetCompression;
  }[] {
    const seen = new Set<string>();
    const result: {
      guid: string;
      kind: string;
      name?: string;
      relativeUrl: string;
      refs?: readonly string[];
      compression?: AssetCompression;
    }[] = [];

    // Prod entries: packIndexCache carries relativeUrl + optional name + refs.
    if (this.packIndexCache) {
      for (const [guidKey, entry] of this.packIndexCache) {
        seen.add(guidKey);
        result.push({
          guid: guidKey,
          kind: entry.kind,
          name: entry.name ?? '',
          relativeUrl: entry.relativeUrl,
          ...(entry.refs !== undefined ? { refs: entry.refs } : {}),
          ...(entry.compression !== undefined ? { compression: entry.compression } : {}),
        });
      }
    }

    // Inlined / dev-path entries: assetCatalog, no pack-index URL. The envelope
    // holds the authoritative AssetRef[] graph; flatten it to plain GUID edges
    // so both catalog paths expose the same refs: readonly string[] shape.
    for (const [guidKey, envelope] of this.assetCatalog) {
      if (!seen.has(guidKey)) {
        const name = envelope.name ?? this.resolveName(guidKey);
        result.push({
          guid: guidKey,
          kind: envelope.payload.kind,
          name,
          relativeUrl: '',
          ...(envelope.refs.length > 0 ? { refs: envelope.refs.map((r) => r.guid) } : {}),
        });
      }
    }

    return result;
  }
}
