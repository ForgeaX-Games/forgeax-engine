// @forgeax/engine-runtime - glyphTextLayoutSystem
// (feat-20260531-world-space-msdf-text-rendering M4 / w18).
//
// The named ECS system that turns `GlyphText` authoring data into a rendered
// world-space label (plan-strategy D-2). A Renderer attaches it to World's
// internal render-derived phase,
// so a freshly-spawned `GlyphText` entity gains its `MeshFilter` +
// `MeshRenderer` before final publication resolves transforms and the same frame's
// read-only render walk reaches it. Per `GlyphText` entity:
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

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { Entity, type EntityHandle, err, ok, type Result, type World } from '@forgeax/engine-ecs';
import { PROCEDURAL_FLOATS_PER_VERTEX } from '@forgeax/engine-geometry';
import {
  bakeGlyphMesh,
  conservativeCubeAabb,
  layoutGlyphText,
  resetFontConcurrency,
  trackFontConcurrency,
} from '@forgeax/engine-graphics-extras';
import type { FontAsset, Handle, MaterialAsset, MeshAsset, Submesh } from '@forgeax/engine-types';
import { TextError, unpackSlot } from '@forgeax/engine-types';
import { MeshFilter, MeshRenderer } from './components';
import { GlyphText } from './components/glyph-text';
import type { GpuResourceStore } from './gpu-resource-store';

// Per-entity bake bookkeeping: the baked mesh handle id + the authoring
// signature it was baked from. A WeakMap owns one cache per World and each
// entry is bounded by entity slot while retaining the full generation-bearing
// EntityHandle, so slot reuse replaces stale state instead of aliasing it or
// growing one historical entry per generation.
interface BakeRecord {
  readonly meshHandleId: number;
  signature: string;
  /** The MeshRenderer.material handle assigned on first observation. */
  readonly materialHandleId: number;
}
interface BakeCacheEntry {
  readonly handle: EntityHandle;
  readonly record: BakeRecord;
}
let bakeCache = new WeakMap<World, Map<number, BakeCacheEntry>>();

// One current material producer handle per GlyphText entity slot. Continuous
// tint edits replace and release the previous producer instead of growing a
// historical color-key cache.
let materialCache = new WeakMap<World, Map<number, number>>();
let liveGlyphHandles = new WeakMap<World, Set<number>>();

/** Clear the per-entity bake + per-font material caches (test isolation). */
export function resetGlyphBakeCache(): void {
  bakeCache = new WeakMap();
  materialCache = new WeakMap();
  liveGlyphHandles = new WeakMap();
}

function worldBakeCache(world: World): Map<number, BakeCacheEntry> {
  let cache = bakeCache.get(world);
  if (cache === undefined) {
    cache = new Map();
    bakeCache.set(world, cache);
  }
  return cache;
}

function worldMaterialCache(world: World): Map<number, number> {
  let cache = materialCache.get(world);
  if (cache === undefined) {
    cache = new Map();
    materialCache.set(world, cache);
  }
  return cache;
}

/** Release renderer-derived producer refs at GlyphText removal time. */
function releaseGlyphProducers(world: World, entity: EntityHandle): void {
  const slot = unpackSlot(entity as unknown as number);
  const bake = bakeCache.get(world)?.get(slot);
  if (bake?.handle === entity) {
    world.sharedRefs.release(asMeshHandle(bake.record.meshHandleId));
    bakeCache.get(world)?.delete(slot);
  }
  const material = materialCache.get(world)?.get(slot);
  if (material !== undefined) {
    world.sharedRefs.release(asMaterialHandle(material));
    materialCache.get(world)?.delete(slot);
  }
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
  // feat-20260709 M3: color collapsed into one inline array<f32,4>; the
  // world.get read path materialises it as a Float32Array (color[0..3] = rgba).
  readonly color: ArrayLike<number>;
}

/** @internal archetype-walk view (same shape reached for in render-system-extract). */
interface WorldInternalView {
  /** @internal */
  _getGraph(): {
    readonly tables: ReadonlyArray<
      | {
          readonly size: number;
          readonly components: ReadonlyArray<{ readonly id: number }>;
          readonly storage: ReadonlyMap<
            number,
            { readonly fields: ReadonlyMap<string, { readonly view: ArrayLike<number> }> }
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
 * @returns `ok(void)` on a clean pass, or `err(TextError)` carrying the FIRST
 *   structured failure (currently only `font-concurrency-exceeded`). Healthy
 *   entities observed before the failing one are still baked.
 */
export function glyphTextLayoutSystem(
  world: World,
  gpuStore: GpuResourceStore,
): Result<void, TextError> {
  resetFontConcurrency();

  const worldInternal = world as unknown as WorldInternalView;
  // No GlyphText entity in this World -> empty collection -> no-op pass. The
  // former per-World `_getComponentByName(GlyphText.name)` registration probe
  // is gone (feat-20260602 dropped the registered concept); column presence is
  // read directly from the archetype graph by `collectGlyphEntities`.
  const entities = collectGlyphEntities(worldInternal, GlyphText.id);
  const live = liveGlyphHandles.get(world) ?? new Set<number>();
  live.clear();
  for (const entity of entities) live.add(entity as unknown as number);
  liveGlyphHandles.set(world, live);
  for (const entry of worldBakeCache(world).values()) {
    if (!live.has(entry.handle as unknown as number)) releaseGlyphProducers(world, entry.handle);
  }

  let firstError: TextError | null = null;
  for (const entity of entities) {
    const error = processEntity(world, gpuStore, entity);
    if (error !== null && firstError === null) firstError = error;
  }

  if (firstError !== null) return err(firstError);
  return ok(undefined);
}

/** Collect every Entity handle carrying GlyphText (single archetype walk). */
function collectGlyphEntities(worldInternal: WorldInternalView, gtId: number): EntityHandle[] {
  const graph = worldInternal._getGraph();
  const entities: EntityHandle[] = [];
  for (const table of graph.tables) {
    if (!table || table.size === 0) continue;
    if (!table.components.some((c) => c.id === gtId)) continue;
    const selfCol = table.storage.get(Entity.id)?.fields.get('self')?.view;
    if (selfCol === undefined) continue;
    for (let i = 0; i < table.size; i++) {
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
  gpuStore: GpuResourceStore,
  entity: EntityHandle,
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
  const entityCache = worldBakeCache(world);
  const slot = unpackSlot(entity as unknown as number);
  const cachedEntry = entityCache.get(slot);
  if (cachedEntry !== undefined && cachedEntry.handle !== entity) {
    world.sharedRefs.release(asMeshHandle(cachedEntry.record.meshHandleId));
    const staleMaterial = worldMaterialCache(world).get(slot);
    if (staleMaterial !== undefined) {
      world.sharedRefs.release(asMaterialHandle(staleMaterial));
      worldMaterialCache(world).delete(slot);
    }
    entityCache.delete(slot);
  }
  const cached = cachedEntry?.handle === entity ? cachedEntry.record : undefined;

  // Dirty path: same entity already baked, but the authoring signature changed.
  if (cached !== undefined) {
    if (cached.signature === signature) return null; // clean -> nothing to do
    const layout = layoutGlyphText(font, gt.text, gt.fontSize);
    // feat-20260601-gpu-resource-store-extraction M1: in-place GPU mesh update
    // moved to the store. The mesh became GPU-resident on the first render
    // frame's `ensureResident` pull; the dirty re-layout overwrites those
    // buffers in place (a no-op if not yet resident -- the next render's
    // ensureResident then uploads the latest registered POD).
    const meshHandle = asMeshHandle(cached.meshHandleId);
    const submeshes = [
      {
        indexOffset: 0,
        indexCount: layout.indices.length,
        vertexCount: layout.vertices.length / PROCEDURAL_FLOATS_PER_VERTEX,
        topology: 'triangle-list',
      },
    ] satisfies readonly Submesh[];
    // A dynamic label can begin empty, so its first bake has a degenerate AABB.
    // Keep the shared MeshAsset's culling/picking bounds in lockstep with the
    // dirty layout; otherwise the GPU buffers update but the render walk still
    // rejects the label as an empty mesh.
    const mesh = world.sharedRefs.resolve<'MeshAsset', MeshAsset>(meshHandle);
    if (mesh.ok) {
      const aabb = conservativeCubeAabb(layout.radius);
      // Keep both sides of the pull boundary coherent. A zero-glyph first
      // bake may have no resident GPU buffers yet, so updating only the GPU
      // store would lose the new text on the next ensureResident pull.
      Object.assign(mesh.value, {
        vertices: layout.vertices,
        indices: layout.indices,
        submeshes,
        aabb,
      });
    }
    gpuStore.updateMesh(meshHandle, layout.vertices, layout.indices, 0, submeshes);
    // A color change replaces the material payload at this entity's stable
    // derived slot and re-binds the new producer handle in place.
    const materialId = resolveTextMaterial(world, gt, font, slot);
    if (materialId !== cached.materialHandleId) {
      world.set(entity, MeshRenderer, {
        materials: [materialId] as unknown as never,
      });
    }
    entityCache.set(slot, {
      handle: entity,
      record: {
        meshHandleId: cached.meshHandleId,
        signature,
        materialHandleId: materialId,
      },
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

  // F-1: resolve the entity-owned MSDF MaterialAsset so the
  // `forgeax::msdf-text` shader + atlas texture + sampler are bound to this
  // text entity (plan D-7). Without this the MeshRenderer would carry material
  // handle 0 -> default mid-grey unlit, and the atlas would never be sampled.
  const materialId = resolveTextMaterial(world, gt, font, slot);

  world.addComponent(entity, { component: MeshFilter, data: { assetHandle: bake.value.handle } });
  world.addComponent(entity, {
    component: MeshRenderer,
    data: { materials: [materialId] as unknown as never },
  });
  entityCache.set(slot, {
    handle: entity,
    record: {
      meshHandleId: handleId(bake.value.handle),
      signature,
      materialHandleId: materialId,
    },
  });
  return null;
}

/**
 * Build the MSDF text MaterialAsset for one World/entity slot and
 * return its raw unmanaged handle id. The material carries a single
 * Transparent-queue pass on the `forgeax::msdf-text` shader with premultiplied
 * blend, and values binding the tint color, packed atlas distance data, and an
 * embedded atlas texture reference (the record stage supplies the sampler).
 * HDR tint components (>1) flow through unchanged so bloom-enabled cameras
 * pick up bright text (AC-12).
 */
function resolveTextMaterial(
  world: World,
  gt: GlyphTextData,
  font: FontAsset,
  slot: number,
): number {
  const cache = worldMaterialCache(world);
  const material = {
    kind: 'material',
    passes: [
      {
        name: 'text',
        program: { module: 'forgeax::msdf-text' },
        renderState: {
          ...{
            blend: MSDF_TEXT_BLEND as never,
            cullMode: 'none',
            depthWriteEnabled: false,
            depthCompare: 'less-equal',
          },
          tags: { LightMode: 'Forward' },
          queue: 3000,
        },
      },
    ],
    values: {
      tintColor: [gt.color[0] ?? 1, gt.color[1] ?? 1, gt.color[2] ?? 1, gt.color[3] ?? 1],
      distanceRange: [
        font.common.distanceRange,
        font.common.atlasWidth,
        font.common.atlasHeight,
        0,
      ],
      baseColorTexture: { texture: font.atlas },
    },
    parameters: [
      { name: 'tintColor', type: 'color', default: [1, 1, 1, 1] },
      { name: 'distanceRange', type: 'vec4', default: [4, 512, 512, 0] },
      { name: 'baseColorTexture', type: 'texture' },
      { name: 'metallicRoughnessTexture', type: 'texture', optional: true },
      { name: 'normalTexture', type: 'texture', optional: true },
    ],
  } satisfies MaterialAsset;
  const id = world.allocSharedRef('MaterialAsset', material) as unknown as number;
  const previous = cache.get(slot);
  cache.set(slot, id);
  if (previous !== undefined && previous !== id) {
    world.sharedRefs.release(asMaterialHandle(previous));
  }
  return id;
}

function signatureOf(gt: GlyphTextData): string {
  return `${gt.fontHandle}|${gt.fontSize}|${gt.text}|${gt.color[0]},${gt.color[1]},${gt.color[2]},${gt.color[3]}`;
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
function asMaterialHandle(id: number): Handle<'MaterialAsset', 'shared'> {
  return id as unknown as Handle<'MaterialAsset', 'shared'>;
}
function handleId(handle: Handle<'MeshAsset', 'shared'>): number {
  return handle as unknown as number;
}
