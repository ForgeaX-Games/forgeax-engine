// @forgeax/engine-runtime - glyphTextLayoutSystem
// (feat-20260531-world-space-msdf-text-rendering M4 / w18).
//
// The named ECS system that turns `GlyphText` authoring data into a rendered
// world-space label (plan-strategy D-2). The renderer invokes it at the top of
// `draw(world)`, BEFORE the render record (equivalent to a PreRender stage), so
// a freshly-spawned `GlyphText` entity gains its `MeshFilter` + `MeshRenderer`
// before the same frame's render walk reaches it. Per `GlyphText` entity:
//
//   1. First observation (entity has no `MeshFilter`): resolve the FontAsset,
//      run `layoutGlyphText` (w15) + `bakeGlyphMesh` (w17), then attach
//      `MeshFilter` + `MeshRenderer` (AC-07). The attach uses the same
//      immediate `world.addComponent` path as `spriteAnimationTickSystem`'s
//      auto-add (the system runs ahead of the render walk in the same frame).
//   2. Dirty (text / fontSize / color changed since last bake): re-layout and
//      `updateMesh` IN PLACE (plan-strategy D-1) -- never re-`register`, never
//      re-attach. The AssetRegistry size stays constant (AC-08; avoids the
//      unbounded growth R-1 would otherwise cause).
//
// D-8 concurrency: at most 8 distinct FontAsset handles may be active in one
// frame. The system resets the per-frame tracker (resetFontConcurrency) at the
// top and tracks each distinct font; the 9th distinct font surfaces a
// structured `TextError('font-concurrency-exceeded')` (it does NOT silently
// evict the oldest font).
//
// The system does NOT modify `pick.ts` (D-5): the baked mesh carries a local
// AABB and the entity carries MeshFilter + MeshRenderer + Transform, so the
// existing `pick()` raycast walk catches it for free.

import {
  decodeEntity,
  Entity,
  type EntityHandle,
  err,
  ok,
  type Result,
  type World,
} from '@forgeax/engine-ecs';
import type { FontAsset, Handle } from '@forgeax/engine-types';
import { TextError } from '@forgeax/engine-types';

import type { AssetRegistry } from './asset-registry';
import { GlyphText } from './components/glyph-text';
import { MeshFilter } from './components/mesh-filter';
import { MeshRenderer } from './components/mesh-renderer';
import { layoutGlyphText, resetFontConcurrency, trackFontConcurrency } from './glyph-layout';
import { bakeGlyphMesh } from './glyph-mesh-bake';
import type { GpuResourceStore } from './gpu-resource-store';
import { worldEntityKey } from './record/frame-snapshot';
import { resolveAssetHandle } from './resolve-asset-handle';

// Per-entity bake bookkeeping: the baked mesh handle id + the authoring
// signature it was baked from. Keyed by the entity index slot (stable across
// archetype migrations). A signature change triggers an in-place updateMesh;
// an entity with no entry is a first-observation bake. Module-level because the
// system is a free function invoked once per frame (mirrors the
// font-concurrency tracker in glyph-layout.ts).
interface BakeRecord {
  readonly meshHandleId: number;
  signature: string;
  /** The MeshRenderer.material handle assigned on first observation. */
  readonly materialHandleId: number;
}
const bakeCache = new Map<number, BakeRecord>();

// Per-(font, tintColor) MSDF MaterialAsset cache (F-1 / plan D-7). The layout
// system builds ONE MaterialAsset per distinct (font, color) and reuses its
// handle across every GlyphText entity sharing that font + tint, so the atlas
// texture + sampler + tintColor + distanceRange are bound to the
// `forgeax::msdf-text` shader without re-registering a material per frame or
// per entity (avoids the unbounded-growth hazard mirrored by the mesh
// bakeCache). Keyed by `${fontHandle}|${r},${g},${b},${a}` because tintColor
// is a per-text uniform value folded into the material UBO.
const fontMaterialCache = new Map<string, number>();

/** Clear the per-entity bake + per-font material caches (test isolation). */
export function resetGlyphBakeCache(): void {
  bakeCache.clear();
  fontMaterialCache.clear();
}

// Premultiplied-alpha blend (mirrors the sprite path, plan D-7). The
// `forgeax::msdf-text` fragment emits premultiplied RGB so the over-composite
// math (`dst' = src + dst * (1 - src.a)`) is direct. The pass rides the
// Transparent queue (3000) so text composites after opaque geometry while
// honoring depth occlusion (depthCompare less-equal, depthWrite off via the
// material-shader pipeline render state).
const MSDF_TEXT_BLEND = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;

interface GlyphTextData {
  readonly fontHandle: number;
  readonly text: string;
  readonly fontSize: number;
  readonly colorR: number;
  readonly colorG: number;
  readonly colorB: number;
  readonly colorA: number;
}

/** @internal archetype-walk view (same shape reached for in render-system-extract). */
interface WorldInternalView {
  /** @internal */
  _getGraph(): {
    readonly archetypes: ReadonlyArray<
      | {
          readonly size: number;
          readonly components: ReadonlyArray<{ readonly id: number }>;
          readonly columns: ReadonlyMap<
            number,
            ReadonlyMap<string, { readonly view: ArrayLike<number> }>
          >;
        }
      | undefined
    >;
  };
}

/**
 * Lay out + bake every `GlyphText` entity, attaching MeshFilter + MeshRenderer
 * on first observation and re-baking in place on a text / size / color change.
 *
 * @param world The ECS world holding the GlyphText entities.
 * @param assets The AssetRegistry that owns the baked mesh lifecycle.
 * @returns `ok(void)` on a clean pass, or `err(TextError)` carrying the FIRST
 *   structured failure (currently only `font-concurrency-exceeded`). Healthy
 *   entities observed before the failing one are still baked.
 */
export function glyphTextLayoutSystem(
  world: World,
  assets: AssetRegistry,
  gpuStore: GpuResourceStore,
  worldId: number,
): Result<void, TextError> {
  resetFontConcurrency();

  const worldInternal = world as unknown as WorldInternalView;
  // No GlyphText entity in this World -> empty collection -> no-op pass. The
  // former per-World `_getComponentByName(GlyphText.name)` registration probe
  // is gone (feat-20260602 dropped the registered concept); column presence is
  // read directly from the archetype graph by `collectGlyphEntities`.
  const entities = collectGlyphEntities(worldInternal, GlyphText.id);

  let firstError: TextError | null = null;
  for (const entity of entities) {
    const error = processEntity(world, assets, gpuStore, entity, worldId);
    if (error !== null && firstError === null) firstError = error;
  }

  if (firstError !== null) return err(firstError);
  return ok(undefined);
}

/** Collect every Entity handle carrying GlyphText (single archetype walk). */
function collectGlyphEntities(worldInternal: WorldInternalView, gtId: number): EntityHandle[] {
  const graph = worldInternal._getGraph();
  const entities: EntityHandle[] = [];
  for (const arch of graph.archetypes) {
    if (!arch || arch.size === 0) continue;
    if (!arch.components.some((c) => c.id === gtId)) continue;
    const selfCol = arch.columns.get(Entity.id)?.get('self')?.view;
    if (selfCol === undefined) continue;
    for (let i = 0; i < arch.size; i++) {
      entities.push((selfCol[i] ?? 0) as EntityHandle);
    }
  }
  return entities;
}

/**
 * Process one GlyphText entity. Returns a TextError when the concurrency limit
 * is exceeded (the entity is skipped); returns null otherwise.
 */
function processEntity(
  world: World,
  assets: AssetRegistry,
  gpuStore: GpuResourceStore,
  entity: EntityHandle,
  worldId: number,
): TextError | null {
  const gtRes = world.get(entity, GlyphText);
  if (!gtRes.ok) return null;
  const gt = gtRes.value as unknown as GlyphTextData;

  // Unresolved font handle (zero sentinel) -> skip (entity not yet wired).
  if (gt.fontHandle === 0) return null;

  // D-8 concurrency: track this distinct font; the 9th throws a TextError.
  try {
    trackFontConcurrency(gt.fontHandle);
  } catch (e) {
    if (e instanceof TextError) return e;
    throw e;
  }

  const fontRes = resolveAssetHandle<FontAsset>(world, asFontHandle(gt.fontHandle));
  if (!fontRes.ok) return null; // font not registered yet -> skip silently
  const font = fontRes.value;

  const signature = signatureOf(gt);
  const indexSlot = decodeEntity(entity).index;
  // D-1a #6: bakeCache key = worldEntityKey(worldId, index) for cross-world isolation.
  const cacheKey = worldEntityKey(worldId, indexSlot);
  const cached = bakeCache.get(cacheKey);

  // Dirty path: same entity already baked, but the authoring signature changed.
  if (cached !== undefined) {
    if (cached.signature === signature) return null; // clean -> nothing to do
    const layout = layoutGlyphText(font, gt.text, gt.fontSize);
    // feat-20260601-gpu-resource-store-extraction M1: in-place GPU mesh update
    // moved to the store. The mesh became GPU-resident on the first render
    // frame's `ensureResident` pull; the dirty re-layout overwrites those
    // buffers in place (a no-op if not yet resident -- the next render's
    // ensureResident then uploads the latest registered POD).
    gpuStore.updateMesh(asMeshHandle(cached.meshHandleId), layout.vertices, layout.indices);
    // A color change re-keys the per-(font, tint) material; re-resolve and
    // re-bind it in place so the tint follows the authoring edit (the mesh
    // handle stays stable, only MeshRenderer.material is overwritten).
    const materialId = resolveTextMaterial(world, assets, gt, font, gpuStore);
    if (materialId !== cached.materialHandleId) {
      world.set(entity, MeshRenderer, {
        materials: [materialId] as unknown as never,
      });
    }
    bakeCache.set(cacheKey, {
      meshHandleId: cached.meshHandleId,
      signature,
      materialHandleId: materialId,
    });
    return null;
  }

  // First-observation path. If this entity already carries a MeshFilter (e.g.
  // the bake cache was reset between frames), skip without re-baking. `world.get`
  // returns err(component-not-present) (never throws) when the column is absent,
  // so the column probe needs no registration guard (feat-20260602).
  if (world.get(entity, MeshFilter).ok) return null;

  const layout = layoutGlyphText(font, gt.text, gt.fontSize);
  const bake = bakeGlyphMesh(world, layout);
  if (!bake.ok) return null; // register fail-fast (should not happen for w15 output)

  // F-1: resolve (build + cache) the per-(font, tint) MSDF MaterialAsset so the
  // `forgeax::msdf-text` shader + atlas texture + sampler are bound to this
  // text entity (plan D-7). Without this the MeshRenderer would carry material
  // handle 0 -> default mid-grey unlit, and the atlas would never be sampled.
  const materialId = resolveTextMaterial(world, assets, gt, font, gpuStore);

  world.addComponent(entity, { component: MeshFilter, data: { assetHandle: bake.value.handle } });
  world.addComponent(entity, {
    component: MeshRenderer,
    data: { materials: [materialId] as unknown as never },
  });
  bakeCache.set(cacheKey, {
    meshHandleId: handleId(bake.value.handle),
    signature,
    materialHandleId: materialId,
  });
  return null;
}

/**
 * Build (or reuse) the MSDF text MaterialAsset for `(font, tintColor)` and
 * return its raw unmanaged handle id. The material carries a single
 * Transparent-queue pass on the `forgeax::msdf-text` shader with premultiplied
 * blend, and paramValues binding the tint color, the atlas distance range, and
 * the atlas texture + sampler (plan D-7). HDR tint components (>1) flow through
 * unchanged so bloom-enabled cameras pick up bright text (AC-12).
 */
function resolveTextMaterial(
  world: World,
  assets: AssetRegistry,
  gt: GlyphTextData,
  font: FontAsset,
  gpuStore: GpuResourceStore,
): number {
  const key = `${gt.fontHandle}|${gt.colorR},${gt.colorG},${gt.colorB},${gt.colorA}`;
  const cached = fontMaterialCache.get(key);
  if (cached !== undefined) return cached;

  // feat-20260614 M8 (D-19): font.atlas / font.sampler are embedded GUIDs.
  // Resolve each to a user-tier column handle by looking up the catalogued
  // payload and minting via world.allocSharedRef; the material paramValues
  // carry the column handle ids the render path reads.
  const atlasPayload = assets.lookup(font.atlas);
  const samplerPayload = assets.lookup(font.sampler);
  let atlasHandle: Handle<'TextureAsset', 'shared'> | undefined;
  if (atlasPayload !== undefined) {
    atlasHandle = world.allocSharedRef('TextureAsset', atlasPayload, () => {
      // atlasHandle is always assigned at this point (alloc just returned it)
      const h = atlasHandle;
      if (h !== undefined) gpuStore.evictTexture(h);
    });
  }
  const samplerHandle =
    samplerPayload !== undefined ? world.allocSharedRef('SamplerAsset', samplerPayload) : undefined;

  const reg = assets.catalog(assets.parseGuid(deriveTextMaterialGuid(key)), {
    kind: 'material',
    passes: [
      {
        name: 'text',
        shader: 'forgeax::msdf-text',
        tags: { LightMode: 'Forward' },
        queue: 3000,
        // cullMode none: the billboard reconstructs a camera-facing right/up
        // basis whose triangle winding flips with the view direction, so a
        // fixed back-face cull would drop the text whenever the quad winds CW
        // relative to the camera. Text is conceptually double-sided. depthWrite
        // off keeps transparent text from occluding later transparent draws
        // while depthCompare less-equal still respects opaque-geometry depth
        // (AC-11 occlusion).
        renderState: {
          blend: MSDF_TEXT_BLEND as never,
          cullMode: 'none',
          depthWriteEnabled: false,
          depthCompare: 'less-equal',
        },
      },
    ],
    paramValues: {
      tintColor: [gt.colorR, gt.colorG, gt.colorB, gt.colorA],
      distanceRange: font.common.distanceRange,
      ...(atlasHandle !== undefined ? { baseColorTexture: atlasHandle as unknown as number } : {}),
      ...(samplerHandle !== undefined ? { sampler: samplerHandle as unknown as number } : {}),
    },
  });
  // catalog can only fail on schema validation; the literal passes/paramValues
  // above are schema-valid for forgeax::msdf-text, so a failure here is an
  // engine-internal invariant break. The material then needs a column handle
  // for the MeshRenderer; mint it from the catalogued payload.
  const id = reg.ok ? (world.allocSharedRef('MaterialAsset', reg.value) as unknown as number) : 0;
  fontMaterialCache.set(key, id);
  return id;
}

// Deterministic per-(font, tint) material GUID derived from the cache key so
// repeat resolves catalogue the same row (idempotent). The 32-hex-char digest
// is the key's char codes folded into a UUIDv4-shaped string -- it never
// collides with a real asset GUID (the registry catalogues by lowercased GUID
// string; this synthetic key lives only in the runtime text-material space).
function deriveTextMaterialGuid(key: string): string {
  let h = 0x811c9dc5;
  const hex: string[] = [];
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
    hex.push((h & 0xff).toString(16).padStart(2, '0'));
  }
  while (hex.length < 16) hex.push('00');
  const h32 = hex.slice(0, 16).join('');
  return `${h32.slice(0, 8)}-${h32.slice(8, 12)}-4${h32.slice(13, 16)}-8${h32.slice(17, 20)}-${h32.slice(20, 32).padEnd(12, '0')}`;
}

function signatureOf(gt: GlyphTextData): string {
  return `${gt.fontHandle}|${gt.fontSize}|${gt.text}|${gt.colorR},${gt.colorG},${gt.colorB},${gt.colorA}`;
}

// Handle bridges: GlyphText.fontHandle / cached mesh ids are packed u32 values;
// AssetRegistry expects branded Handles. The brand is a compile-time phantom
// (runtime value is the raw number), so a cast is the canonical bridge
// (mirrors pick.ts toShared).
function asFontHandle(raw: number): Handle<'FontAsset', 'shared'> {
  return raw as unknown as Handle<'FontAsset', 'shared'>;
}
function asMeshHandle(id: number): Handle<'MeshAsset', 'shared'> {
  return id as unknown as Handle<'MeshAsset', 'shared'>;
}
function handleId(handle: Handle<'MeshAsset', 'shared'>): number {
  return handle as unknown as number;
}
