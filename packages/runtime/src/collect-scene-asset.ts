// feat-20260623 M2 w11+w12 — SceneInstance to SceneAsset POD collection + pack
// serialization (plan-strategy D-1: pure-data collector).
//
// feat-20260701-rootstosceneasset-forest-collect-schema-derived-ha:
//   rootsToSceneAsset(registry, world, roots) -> Result<SceneAsset, ...>
//   serializeSceneAssetToPack -> schema-derived refs[] index.
//
// feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip M2 + M3:
//
//   ── mount-collapse (M2) ──
//   rootsToSceneAsset detects entities carrying SceneInstance (anchors) and
//   folds each anchor's subtree into a mounts[] entry — the uplink inverse of
//   instantiateScene which expands mounts[] into live entities.  Member
//   classification filter, not subtree pruning: BFS walks the full subtree
//   (collectSubtree unchanged, D-4), then anchors' members are folded into
//   mount windows, graft entities survive as owned, and cross-window entity
//   references are remapped to window LocalEntityIds.  Two anchor forms:
//   Form 2 (root = instance) strips SceneInstance without self-mount; Form 1
//   (deep anchor) folds at the anchor site with mount.parent pointing to the
//   anchor's ChildOf parent.  Window accounting (totalSlots = entities.length
//   + mounts.length + sum(memberCount)) preserves the child instance's full
//   totalSlots, never shrinking by surviving-member count (AC-03, #495 guard).
//
//   ── serialize mounts (M3) ──
//   serializeSceneAssetToPack maps in-memory mounts[].source GUID strings to
//   refs[] indices, memberFirst/memberCount/localId/parent numeric pass-through.
//   _resolveSceneGuids (asset-registry.ts) carries mounts through the reload
//   chain: recursively resolves child scene GUIDs, registers child copies in
//   the origin reverse-index (D-7), and protects against mount-source cycles
//   (R-9).  registry.instantiate wires an identity resolver so resolved mount
//   handles flow into instantiateScene transparently.
//
//   ── round-trip closure ──
//   The round-trip instantiate -> collect (rootsToSceneAsset) -> serialize
//   (serializeSceneAssetToPack) -> reload (loadByGuid + registry.instantiate)
//   -> instantiate produces a structurally equivalent live subtree (AC-04).
//   The equivalence benchmark is a second collect (fixed-point): after the
//   first reload, the second collect output equals the first (D-9 normalization
//   converges after one cycle).
//
//   ── known limitations ──
//   OOS-1: mount.overrides[] (Layer-0 diffs) are not folded back during collect.
//   D-9: Form 1 mount entity absorption — when the anchor parent cannot be
//   proven to be a mount entity, components is left undefined (one-time
//   normalization on first reload; fixed-point from second collect onward).

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  resolveAssetHandle,
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from '@forgeax/engine-assets-runtime';
import {
  checkRelationshipMirrorsTransient,
  type Component as EcsComponent,
  type EntityHandle,
  getRegisteredComponents,
  RELATIONSHIP_COMPONENTS,
  resolveComponent,
  type World,
} from '@forgeax/engine-ecs';
import { classifyEntityField } from '@forgeax/engine-ecs/externalization';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import type {
  Asset,
  Handle,
  LocalEntityId,
  MountOverride,
  SceneAsset,
  SceneEntity,
  SceneInstanceMount,
} from '@forgeax/engine-types';
import { SceneInstance } from './components/scene-instance';
import { collectSubtree } from './scene-utils/collect-subtree';
import { foldMountOverrides } from './scene-utils/mount-override-fold';

// Shared helpers
function _isArrayLike(value: unknown): value is ArrayLike<unknown> {
  return (
    Array.isArray(value) ||
    value instanceof Uint32Array ||
    value instanceof Float32Array ||
    value instanceof Int32Array ||
    value instanceof Float64Array ||
    value instanceof Uint8Array ||
    value instanceof Int16Array ||
    value instanceof Uint16Array
  );
}
function _normalizeArray(value: ArrayLike<unknown>): unknown[] {
  return Array.from(value);
}

// Schema-derived field classifier — shared kernel now owns entity classification.
// Keep the local shared<T> classifier because the kernel only handles entity fields.
type SchemaFieldClass =
  | { kind: 'entity'; scalar: true }
  | { kind: 'entity'; scalar: false }
  | { kind: 'shared'; scalar: true }
  | { kind: 'shared'; scalar: false };

function classifyFieldSchema(fieldType: string | undefined): SchemaFieldClass | undefined {
  if (fieldType === undefined) return undefined;
  if (fieldType.startsWith('shared<')) return { kind: 'shared', scalar: true };
  if (fieldType.startsWith('array<shared<')) return { kind: 'shared', scalar: false };
  return undefined;
}

// ── M5 (w21): override-value handle→GUID serialization ──
//
// Reverse-lookup one shared-field handle to its catalogued GUID string. Returns
// `undefined` for the NULL sentinel (handle 0) so the caller applies the two
// distinct sentinel semantics: scalar -> omit the field, array -> placeholder 0.
// Any non-zero handle that fails to resolve is a fail-fast (D-2, no silent drop).
// Shared kernel: both the owned-entity serialization loop (Step 4) and the M5
// override-value serialization call this so the resolve/lookup/fail-fast idiom
// lives in exactly one place; `field` names the failing field in the error.
function _handleToGuid(
  world: World,
  registry: AssetRegistry,
  handle: number,
  field: string,
): Result<string | undefined, SceneCollectAssetGuidUnresolvedError> {
  if (handle === 0) return ok(undefined); // NULL sentinel
  const assetRes = resolveAssetHandle(world, handle as unknown as Handle<string, 'shared'>);
  if (!assetRes.ok) return err(new SceneCollectAssetGuidUnresolvedError(field, handle));
  const guid = registry._guidForAsset(assetRes.value as Asset);
  if (guid === undefined) return err(new SceneCollectAssetGuidUnresolvedError(field, handle));
  return ok(guid);
}

// Convert one shared field value (scalar handle or array<handle>) from the live
// handle domain to the serialized GUID domain, applying the two-state NULL
// sentinel: scalar handle 0 -> undefined (caller omits the field); array handle
// 0 -> numeric 0 kept in place (positional SoA alignment, #640). Non-shared
// values pass through untouched.
function _serializeSharedFieldValue(
  world: World,
  registry: AssetRegistry,
  classification: SchemaFieldClass,
  value: unknown,
  field: string,
): Result<unknown, SceneCollectAssetGuidUnresolvedError> {
  if (classification.scalar) {
    if (typeof value !== 'number') return ok(value);
    return _handleToGuid(world, registry, value, field); // undefined -> caller omits
  }
  if (!Array.isArray(value)) return ok(value);
  const mapped: Array<string | number> = [];
  for (const elem of value as ReadonlyArray<unknown>) {
    if (typeof elem !== 'number') {
      mapped.push(elem as number);
      continue;
    }
    const g = _handleToGuid(world, registry, elem, field);
    if (!g.ok) return g;
    mapped.push(g.value ?? 0); // NULL sentinel keeps positional 0
  }
  return ok(mapped);
}

// Convert an override's value from the live handle domain to the serialized GUID
// domain (w21). Field-patch form (`ov.field` present) carries a single field
// value; component-add form carries a per-field value map. Shared fields are
// reverse-looked-up per {@link _serializeSharedFieldValue}; a scalar NULL
// sentinel drops the key (component-add) or is kept as 0 (field-patch, where the
// override IS that field so it cannot be omitted). Non-shared fields pass through.
function _serializeOverrideValueHandles(
  world: World,
  registry: AssetRegistry,
  ov: MountOverride,
): Result<unknown, SceneCollectAssetGuidUnresolvedError> {
  const comp = resolveComponent(ov.comp);
  const schema = comp?.schema as Record<string, string> | undefined;
  if (ov.field !== undefined) {
    const classification = schema ? classifyFieldSchema(schema[ov.field]) : undefined;
    if (!classification || classification.kind !== 'shared') return ok(ov.value);
    const conv = _serializeSharedFieldValue(world, registry, classification, ov.value, ov.field);
    if (!conv.ok) return conv;
    // Field-patch: keep the field even at NULL sentinel (the override IS the
    // field); undefined only arises for a scalar handle 0 -> emit 0.
    return ok(conv.value ?? 0);
  }
  // component-add: value is a per-field map.
  if (typeof ov.value !== 'object' || ov.value === null || Array.isArray(ov.value)) {
    return ok(ov.value);
  }
  const src = ov.value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const fieldName of Object.keys(src)) {
    const classification = schema ? classifyFieldSchema(schema[fieldName]) : undefined;
    if (!classification || classification.kind !== 'shared') {
      out[fieldName] = src[fieldName];
      continue;
    }
    const conv = _serializeSharedFieldValue(
      world,
      registry,
      classification,
      src[fieldName],
      fieldName,
    );
    if (!conv.ok) return conv;
    if (classification.scalar && conv.value === undefined) continue; // scalar 0 -> omit
    out[fieldName] = conv.value;
  }
  return ok(out);
}

// Collect the inline GUID strings from one override's shared fields into `set`
// (M5 / w21 refs completeness). Field-patch form checks the single field;
// component-add form checks each key of the value map. Non-shared / non-string
// values are ignored.
function _collectOverrideGuids(ov: MountOverride, set: Set<string>): void {
  const comp = resolveComponent(ov.comp);
  const schema = comp?.schema as Record<string, string> | undefined;
  const addFromField = (fieldName: string, value: unknown): void => {
    const classification = schema ? classifyFieldSchema(schema[fieldName]) : undefined;
    if (!classification || classification.kind !== 'shared') return;
    if (classification.scalar) {
      if (typeof value === 'string') set.add(value);
    } else if (Array.isArray(value)) {
      for (const elem of value as ReadonlyArray<unknown>) {
        if (typeof elem === 'string') set.add(elem);
      }
    }
  };
  if (ov.field !== undefined) {
    addFromField(ov.field, ov.value);
    return;
  }
  if (typeof ov.value === 'object' && ov.value !== null && !Array.isArray(ov.value)) {
    const map = ov.value as Record<string, unknown>;
    for (const fieldName of Object.keys(map)) addFromField(fieldName, map[fieldName]);
  }
}

// serializeSceneAssetToPack — unchanged from original
export function serializeSceneAssetToPack(
  sceneAsset: SceneAsset,
  guid?: string,
): Result<Record<string, unknown>, SceneCollectAssetGuidUnresolvedError> {
  const assetGuid = guid ?? crypto.randomUUID();
  const guidSet = new Set<string>();
  for (const ent of sceneAsset.entities) {
    const comps = ent.components as Record<string, Record<string, unknown>>;
    for (const compName of Object.keys(comps)) {
      const comp = resolveComponent(compName);
      if (!comp?.schema) continue;
      const fields = comps[compName];
      if (!fields) continue;
      for (const fieldName of Object.keys(comp.schema)) {
        const classification = classifyFieldSchema(comp.schema[fieldName]);
        if (!classification || classification.kind !== 'shared') continue;
        const value = fields[fieldName];
        if (value === undefined) continue;
        if (classification.scalar) {
          if (typeof value === 'string') guidSet.add(value);
        } else {
          if (Array.isArray(value)) {
            for (const elem of value as ReadonlyArray<unknown>) {
              if (typeof elem === 'string') guidSet.add(elem);
            }
          }
        }
      }
    }
  }
  // Phase 1.5: collect mounts[].source GUID strings into guidSet (m3-i1) +
  // mounts[].overrides[] shared-field GUID strings (M5 / w21) so the scene
  // envelope's refs[] recursion source lists every asset a mount override
  // references (loadByGuid preloads them before instantiate).
  if (sceneAsset.mounts !== undefined) {
    for (const m of sceneAsset.mounts) {
      if (typeof m.source === 'string') guidSet.add(m.source);
      for (const ov of m.overrides ?? []) {
        _collectOverrideGuids(ov, guidSet);
      }
    }
  }

  const refs = [...guidSet];
  const guidToIndex = new Map<string, number>();
  for (const [i, g] of refs.entries()) guidToIndex.set(g, i);

  const serializedEntities: Array<Record<string, unknown>> = [];
  for (const ent of sceneAsset.entities) {
    const serializedComps: Record<string, Record<string, unknown>> = {};
    const comps = ent.components as Record<string, Record<string, unknown>>;
    for (const compName of Object.keys(comps)) {
      const comp = resolveComponent(compName);
      const fields = comps[compName];
      if (!fields) continue;
      const serializedFields: Record<string, unknown> = {};
      const schema = comp?.schema;
      for (const fieldName of Object.keys(fields)) {
        const value = fields[fieldName];
        if (value === undefined) continue;
        const classification = schema ? classifyFieldSchema(schema[fieldName]) : undefined;
        if (classification?.kind === 'shared') {
          if (classification.scalar) {
            if (typeof value !== 'string') {
              serializedFields[fieldName] = value;
              continue;
            }
            const idx = guidToIndex.get(value);
            if (idx === undefined)
              return err(new SceneCollectAssetGuidUnresolvedError(fieldName, value));
            serializedFields[fieldName] = idx;
          } else {
            if (!Array.isArray(value)) {
              serializedFields[fieldName] = value;
              continue;
            }
            const mapped: number[] = [];
            for (const elem of value as ReadonlyArray<unknown>) {
              if (typeof elem !== 'string') {
                mapped.push(elem as number);
                continue;
              }
              const idx = guidToIndex.get(elem);
              if (idx === undefined)
                return err(new SceneCollectAssetGuidUnresolvedError(fieldName, elem));
              mapped.push(idx);
            }
            serializedFields[fieldName] = mapped;
          }
        } else {
          serializedFields[fieldName] = value;
        }
      }
      if (Object.keys(serializedFields).length > 0) serializedComps[compName] = serializedFields;
    }
    serializedEntities.push({
      localId: ent.localId as unknown as number,
      components: serializedComps,
    });
  }
  // Phase 2.5: serialize mounts (m3-i1, breakpoint A fix).
  // source GUID string -> refs index; memberFirst/memberCount/localId/parent
  // are numeric LocalEntityId values passed through directly.
  let serializedMounts: Array<Record<string, unknown>> | undefined;
  if (sceneAsset.mounts !== undefined && sceneAsset.mounts.length > 0) {
    serializedMounts = [];
    for (const m of sceneAsset.mounts) {
      const sm: Record<string, unknown> = {
        localId: m.localId as unknown as number,
        memberFirst: m.memberFirst as unknown as number,
        memberCount: m.memberCount,
      };
      if (typeof m.source === 'string') {
        const idx = guidToIndex.get(m.source);
        if (idx === undefined)
          return err(new SceneCollectAssetGuidUnresolvedError('mount.source', m.source));
        sm.source = idx;
      } else {
        sm.source = m.source as unknown as number;
      }
      if (m.parent !== undefined) sm.parent = m.parent as unknown as number;
      // M5 / w21: pass mounts[].overrides[] through unchanged. Override shared
      // fields already carry inline GUID strings (rootsToSceneAsset did the
      // handle→GUID reverse-lookup); the deserialize + apply path reads those
      // GUID strings directly (resolveMountOverrides / forEachHandleGuid), so
      // unlike entity/source fields they are NOT rewritten to refs[] indices.
      if (m.overrides !== undefined && m.overrides.length > 0) {
        sm.overrides = m.overrides.map((ov) => ({ ...ov }));
      }
      serializedMounts.push(sm);
    }
  }

  const payload: Record<string, unknown> = { entities: serializedEntities };
  if (serializedMounts !== undefined) payload.mounts = serializedMounts;
  return ok({
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [{ guid: assetGuid, kind: 'scene', payload, refs }],
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// rootsToSceneAsset — with M2 mount-collapse
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Collect a forest of entity subtrees into a self-contained SceneAsset.
 *
 * M2 mount-collapse: entities carrying SceneInstance that are NOT roots
 * are folded into mount entries. Root anchors have their SceneInstance
 * row stripped without producing a self-mount. Member classification
 * filter (not subtree pruning): graft entities under members survive as owned.
 */
export function rootsToSceneAsset(
  registry: AssetRegistry,
  world: World,
  roots: EntityHandle[],
): Result<
  SceneAsset,
  SceneCollectEntityRefOutOfClosureError | SceneCollectAssetGuidUnresolvedError
> {
  // ── D-2 dev-gate: check that every relationship mirror target declares
  // transient: true.  Dev-only (production silently skips); the check is a
  // programmer-bug invariant, not an expected user failure — throw, don't
  // return Result.
  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
    ?.NODE_ENV;
  if (typeof nodeEnv === 'string' && nodeEnv !== 'production') {
    const violations = checkRelationshipMirrorsTransient(
      RELATIONSHIP_COMPONENTS,
      resolveComponent as (name: string) => EcsComponent<string> | undefined,
    );
    if (violations.length > 0) {
      const lines = violations.map((mirrorName) => {
        // Best-effort holder lookup for the error message.
        let holderName = '<unknown>';
        for (const h of RELATIONSHIP_COMPONENTS) {
          if (h.relationship?.mirror === mirrorName) {
            holderName = h.name;
            break;
          }
        }
        return `  holder "${holderName}" -> mirror "${mirrorName}" (add { transient: true } to the mirror component's defineComponent call)`;
      });
      throw new Error(
        `RELATIONSHIP_COMPONENTS mirror components missing transient: true:\n${lines.join('\n')}`,
      );
    }
  }

  // ── Step 1: BFS closure ──
  const visited = new Set<number>();
  for (const root of roots) collectSubtree(world, root, visited);
  if (visited.size === 0) return ok({ kind: 'scene', entities: [] });

  const rootRawSet = new Set<number>();
  for (const r of roots) rootRawSet.add(r as number);

  // ── Step 1.5: Mount-collapse — identify anchors ──
  const anchorEntities = new Set<number>();
  for (const er of visited) {
    if (world.get(er as EntityHandle, SceneInstance).ok) anchorEntities.add(er);
  }

  // D-7 (feat-20260707) ordering robustness: the first-wins loops below
  // (memberEntities claim + carrier absorption) resolve ties by iteration
  // order. Iterating the anchorEntities Set directly ties the outcome to BFS
  // insertion order — deterministic within one run but fragile to Node/VM
  // changes. Sort by raw handle so "which anchor claims a shared member / a
  // shared carrier" is a deterministic function of the SceneAsset (§3.2
  // fixed-point premise: collect output must be a pure function of the graph).
  const anchorsSorted = [...anchorEntities].sort((a, b) => a - b);

  // Classify members for non-root anchors.
  const memberEntities = new Set<number>();
  const memberOrigin = new Map<number, { anchorRaw: number; memberLocalId: number }>();
  for (const er of anchorsSorted) {
    if (rootRawSet.has(er)) continue; // root anchor: don't classify members
    const sr = world.getSceneInstanceState(er as EntityHandle);
    if (!sr.ok) continue;
    for (const [me, lid] of sr.value.entityToLocalId) {
      const mr = me as number;
      if (visited.has(mr) && !anchorEntities.has(mr) && !memberEntities.has(mr)) {
        memberEntities.add(mr);
        memberOrigin.set(mr, { anchorRaw: er, memberLocalId: lid as unknown as number });
      }
    }
  }

  // Remove inner anchors (members of outer anchors).
  for (const er of anchorEntities) {
    if (memberEntities.has(er) && !rootRawSet.has(er)) anchorEntities.delete(er);
  }

  // ── Step 1.75: Mount-carrier absorption ──
  //
  // world.instantiateScene materialises each mounts[] entry as a plain "mount
  // entity" (`_spawnMountEntity` output: mount.components + a default Transform,
  // but NO SceneInstance) whose child is the mounted scene's synthetic root (the
  // real anchor, which DOES carry SceneInstance). So a `mounts[{parent: W}]`
  // whose parent W is an OWNED entity comes back on reload as the live chain
  //     W (owned) -> carrier (plain mount entity) -> anchor (SceneInstance).
  // The carrier IS the re-materialised mount slot. If collect keeps it as an
  // owned entity (it has no SceneInstance, so Step 2 would), the next serialize→
  // reload inserts ANOTHER carrier under it, growing one nameless ghost node per
  // save→reload cycle — unbounded (the editor "Add to Scene → save → reopen →
  // #N" regression). Existing pure-mount round-trips don't hit this because they
  // use `mount.parent === undefined` (mount attaches to the synthetic root,
  // which is stripped, so no owned carrier survives).
  //
  // Fix: recognise a carrier and fold it back into its mount. A carrier is the
  // ChildOf-parent P of a non-root anchor A where P is a pure mount slot: not a
  // root, not itself an anchor/member, carries no authored identity (only the
  // structural Transform/Children/ChildOf/Entity that _spawnMountEntity leaves),
  // and its sole visited child is A. The mount for A then takes P's slot:
  // mount.parent = P's ChildOf parent, and any ref to P resolves to the mount.
  const childOfTk0 = resolveComponent('ChildOf');
  const childrenTk0 = resolveComponent('Children');
  const carrierAllowed = new Set(['Transform', 'Children', 'ChildOf', 'Entity']);
  const carrierForAnchor = new Map<number, number>(); // anchorRaw -> carrierRaw
  const carrierToAnchor = new Map<number, number>(); // carrierRaw -> anchorRaw
  const isMountCarrier = (p: number, anchorRaw: number): boolean => {
    if (rootRawSet.has(p)) return false;
    if (anchorEntities.has(p) || memberEntities.has(p)) return false;
    if (!visited.has(p)) return false;
    for (const [compName, compToken] of getRegisteredComponents()) {
      if (carrierAllowed.has(compName)) continue;
      if (world.get(p as EntityHandle, compToken as EcsComponent<string>).ok) return false;
    }
    if (childrenTk0) {
      const cr = world.get(p as EntityHandle, childrenTk0 as EcsComponent<string>);
      if (cr.ok) {
        const kids = (cr.value as { entities?: ArrayLike<number> }).entities;
        if (kids) {
          let visitedKidCount = 0;
          let sawAnchor = false;
          for (let i = 0; i < kids.length; i++) {
            const k = kids[i] as number;
            if (!visited.has(k)) continue;
            visitedKidCount += 1;
            if (k === anchorRaw) sawAnchor = true;
          }
          if (!sawAnchor || visitedKidCount !== 1) return false;
        }
      }
    }
    return true;
  };
  if (childOfTk0) {
    // Deterministic order (D-7): a carrier shared by two anchors is claimed by
    // the lowest-handle anchor regardless of Set iteration order.
    for (const anchorRaw of anchorsSorted) {
      if (!anchorEntities.has(anchorRaw)) continue; // pruned inner anchor
      if (rootRawSet.has(anchorRaw)) continue;
      const cr = world.get(anchorRaw as EntityHandle, childOfTk0 as EcsComponent<string>);
      if (!cr.ok) continue;
      const pRaw = (cr.value as Record<string, unknown>).parent as number | undefined;
      if (pRaw === undefined) continue;
      if (!carrierToAnchor.has(pRaw) && isMountCarrier(pRaw, anchorRaw)) {
        carrierForAnchor.set(anchorRaw, pRaw);
        carrierToAnchor.set(pRaw, anchorRaw);
      }
    }
  }

  // ── Step 2: Filter owned & build mounts for non-root anchors ──
  const orderedEntities = [...visited];
  const ownedEntities: number[] = [];
  for (const er of orderedEntities) {
    if (carrierToAnchor.has(er)) continue; // absorbed into its mount
    if ((!anchorEntities.has(er) || rootRawSet.has(er)) && !memberEntities.has(er)) {
      ownedEntities.push(er);
    }
  }

  const entityToLocalId = new Map<number, number>();
  for (let i = 0; i < ownedEntities.length; i++) {
    const e = ownedEntities[i];
    if (e !== undefined) entityToLocalId.set(e, i);
  }

  // Build non-root anchor info + resolve GUIDs.
  const nonRootAnchors: Array<{ entityRaw: number; sourceGuid: string; totalSlots: number }> = [];
  for (const er of anchorEntities) {
    if (rootRawSet.has(er)) continue;
    const sh = world.getSceneAssetForInstance(er as EntityHandle);
    if (!sh.ok)
      return err(
        new SceneCollectAssetGuidUnresolvedError(
          'SceneInstance.source',
          sh.error as unknown as number,
        ),
      );
    const pr = resolveAssetHandle<SceneAsset>(
      world,
      sh.value as unknown as Handle<string, 'shared'>,
    );
    if (!pr.ok)
      return err(
        new SceneCollectAssetGuidUnresolvedError(
          'SceneInstance.source',
          sh.value as unknown as number,
        ),
      );
    const g = registry._guidForAsset(pr.value as Asset);
    if (g === undefined)
      return err(
        new SceneCollectAssetGuidUnresolvedError(
          'SceneInstance.source',
          sh.value as unknown as number,
        ),
      );
    const sr = world.getSceneInstanceState(er as EntityHandle);
    if (!sr.ok)
      return err(new SceneCollectAssetGuidUnresolvedError('SceneInstance.source', 'state'));
    nonRootAnchors.push({ entityRaw: er, sourceGuid: g, totalSlots: sr.value.totalSlots });
  }

  // Sort by BFS order.
  const bfsIdx = new Map<number, number>();
  for (let i = 0; i < orderedEntities.length; i++) {
    if (orderedEntities[i] !== undefined) bfsIdx.set(orderedEntities[i] as number, i);
  }
  nonRootAnchors.sort((a, b) => (bfsIdx.get(a.entityRaw) ?? 0) - (bfsIdx.get(b.entityRaw) ?? 0));

  // ── Step 3: Allocate mount windows ──
  const ownedCount = ownedEntities.length;
  const outMounts: SceneInstanceMount[] = [];
  let nextMF = ownedCount + nonRootAnchors.length;
  const childOfTk = resolveComponent('ChildOf');

  const transformTk = resolveComponent('Transform');
  for (const a of nonRootAnchors) {
    // When a mount carrier was absorbed (Step 1.75), the mount takes the
    // carrier's slot: resolve the ChildOf parent from the CARRIER (the anchor's
    // own parent IS the carrier, which no longer exists as an owned entity), and
    // carry the carrier's Transform as mount.components so placement round-trips.
    const carrierRaw = carrierForAnchor.get(a.entityRaw);
    const parentSourceRaw = carrierRaw ?? a.entityRaw;
    let mp: number | undefined;
    if (childOfTk) {
      const cr = world.get(parentSourceRaw as EntityHandle, childOfTk as EcsComponent<string>);
      if (cr.ok) {
        const pRaw = (cr.value as Record<string, unknown>).parent as number;
        if (pRaw !== undefined) {
          const ol = entityToLocalId.get(pRaw);
          if (ol !== undefined) mp = ol;
          else {
            const mo = memberOrigin.get(pRaw);
            if (mo !== undefined) {
              const ai = nonRootAnchors.findIndex((x) => x.entityRaw === mo.anchorRaw);
              if (ai >= 0) mp = ownedCount + ai;
            }
          }
        }
      }
    }
    let mountComponents: SceneInstanceMount['components'] | undefined;
    if (carrierRaw !== undefined && transformTk) {
      const tr = world.get(carrierRaw as EntityHandle, transformTk as EcsComponent<string>);
      if (tr.ok) {
        mountComponents = {
          Transform: { ...(tr.value as Record<string, unknown>) },
        } as SceneInstanceMount['components'];
      }
    }
    // ── M5 (w20 + w21): fold runtime-authored overrides into this mount ──
    // foldMountOverrides emits child-namespace localIds in the LIVE handle
    // domain; rebase each into the parent namespace (memberFirst + childLocalId)
    // and reverse-lookup shared-field handles to GUID strings (two-state
    // NULL-sentinel). Unresolvable handle -> SceneCollectAssetGuidUnresolvedError
    // (D-2 fail-fast, no silent drop).
    const memberFirst0 = nextMF;
    let mountOverrides: MountOverride[] | undefined;
    const foldStateRes = world.getSceneInstanceState(a.entityRaw as EntityHandle);
    if (foldStateRes.ok) {
      const rawOverrides = foldMountOverrides(world, foldStateRes.value);
      if (rawOverrides.length > 0) {
        mountOverrides = [];
        for (const ov of rawOverrides) {
          const convRes = _serializeOverrideValueHandles(world, registry, ov);
          if (!convRes.ok) return convRes;
          mountOverrides.push({
            ...ov,
            localId: (memberFirst0 + (ov.localId as unknown as number)) as LocalEntityId,
            value: convRes.value,
          });
        }
      }
    }

    const mount: SceneInstanceMount = {
      localId: (ownedCount + outMounts.length) as LocalEntityId,
      source: a.sourceGuid,
      memberFirst: nextMF as LocalEntityId,
      memberCount: a.totalSlots,
      ...(mp !== undefined ? { parent: mp as LocalEntityId } : {}),
      ...(mountComponents !== undefined ? { components: mountComponents } : {}),
      ...(mountOverrides !== undefined && mountOverrides.length > 0
        ? { overrides: mountOverrides }
        : {}),
    };
    outMounts.push(mount);
    nextMF += a.totalSlots;
  }

  // Entity ref resolution helper.
  function _rlid(t: number): number | undefined {
    const ol = entityToLocalId.get(t);
    if (ol !== undefined) return ol;
    // An absorbed mount carrier resolves to its mount's localId (the mount took
    // the carrier's slot in Step 1.75), so refs to the carrier — e.g. the
    // wrapper's Children list — point at the mount rather than dangle.
    const absorbedAnchor = carrierToAnchor.get(t);
    if (absorbedAnchor !== undefined) {
      for (let i = 0; i < nonRootAnchors.length; i++) {
        if (nonRootAnchors[i]?.entityRaw === absorbedAnchor) return ownedCount + i;
      }
    }
    for (let i = 0; i < nonRootAnchors.length; i++) {
      if (nonRootAnchors[i]?.entityRaw === t) return ownedCount + i;
    }
    const mo = memberOrigin.get(t);
    if (mo !== undefined) {
      for (let i = 0; i < nonRootAnchors.length; i++) {
        if (nonRootAnchors[i]?.entityRaw === mo.anchorRaw) {
          let mf = ownedCount + nonRootAnchors.length;
          for (let j = 0; j < i; j++) mf += nonRootAnchors[j]?.totalSlots ?? 0;
          return mf + mo.memberLocalId;
        }
      }
    }
    return undefined;
  }

  // ── Step 4: Build SceneEntity rows ──
  const registeredComps = getRegisteredComponents();
  const entities: SceneEntity[] = [];

  for (let lid = 0; lid < ownedEntities.length; lid++) {
    const entityRaw = ownedEntities[lid];
    if (entityRaw === undefined) continue;
    const entity = entityRaw as EntityHandle;
    const components: Record<string, Record<string, unknown>> = {};
    const isRoot = rootRawSet.has(entityRaw);

    for (const [compName, compToken] of registeredComps) {
      if (compToken.transient) continue;
      if (isRoot && compName === 'ChildOf') continue;

      const valRes = world.get(entity, compToken as EcsComponent<string>);
      if (!valRes.ok) continue;

      const val = valRes.value as Record<string, unknown>;
      const comp = resolveComponent(compName);
      if (!comp?.schema) continue;

      const schemaKeys = Object.keys(comp.schema);
      if (schemaKeys.length === 0) continue;

      const fieldValues: Record<string, unknown> = {};

      for (const fieldName of schemaKeys) {
        const rawValue = val[fieldName];
        if (rawValue === undefined) continue;

        // Field-level transient skip (D-5): a field declared `transient: true`
        // is derived/reconstructable and excluded from serialization, just as a
        // transient component (L554) is. Generic — reads the reflection flag for
        // any component/field; no hardcoded component or field name.
        if (comp.fields[fieldName]?.transient) continue;

        const schemaFieldType = comp.schema[fieldName];
        const entityKind = classifyEntityField(comp as EcsComponent, fieldName);
        const sharedClass =
          schemaFieldType !== undefined ? classifyFieldSchema(schemaFieldType) : undefined;

        if (!entityKind && !sharedClass) {
          if (_isArrayLike(rawValue)) {
            fieldValues[fieldName] = _normalizeArray(rawValue);
          } else {
            fieldValues[fieldName] = rawValue;
          }
          continue;
        }

        if (entityKind !== null) {
          // Entity / array<entity> field — use shared kernel for remap
          if (entityKind.isArray) {
            const arr = _isArrayLike(rawValue)
              ? _normalizeArray(rawValue)
              : (rawValue as unknown[]);
            const mapped: number[] = [];
            for (const elem of arr) {
              const lid2 = _rlid(elem as number);
              if (lid2 === undefined) {
                return err(
                  new SceneCollectEntityRefOutOfClosureError(entityRaw, fieldName, elem as number),
                );
              }
              mapped.push(lid2);
            }
            fieldValues[fieldName] = mapped;
          } else {
            const lid2 = _rlid(rawValue as number);
            if (lid2 === undefined) {
              return err(
                new SceneCollectEntityRefOutOfClosureError(
                  entityRaw,
                  fieldName,
                  rawValue as number,
                ),
              );
            }
            fieldValues[fieldName] = lid2;
          }
        } else {
          // shared<T> field — reverse-lookup handle(s) to GUID(s) via the shared
          // kernel (same two-state NULL-sentinel the M5 override serializer uses).
          // scalar handle 0 -> undefined => omit the field (deserialize restores
          // the slot-0 default; emitting 0 would be misread as refs index 0 by
          // parseScenePayload HANDLE_FIELD_NAMES). array handle 0 -> positional 0
          // kept (paired SoA alignment, e.g. AnimationPlayer.clips = [h,0,0,0]).
          // AnimationPlayer.graph (shared<AnimationGraph> scalar, M4/w31) is
          // handled generically here — no special case needed.
          const normalized = _isArrayLike(rawValue) ? _normalizeArray(rawValue) : rawValue;
          if (sharedClass === undefined) {
            // Fallback: non-entity, non-shared — pass through
            fieldValues[fieldName] = normalized;
            continue;
          }
          const conv = _serializeSharedFieldValue(
            world,
            registry,
            sharedClass,
            normalized,
            fieldName,
          );
          if (!conv.ok) return conv;
          if (sharedClass.scalar && conv.value === undefined) continue; // NULL sentinel -> omit
          fieldValues[fieldName] = conv.value;
        }
      }

      if (Object.keys(fieldValues).length > 0) components[compName] = fieldValues;
    }

    entities.push({ localId: lid as LocalEntityId, components } as SceneEntity);
  }

  return ok({
    kind: 'scene',
    entities,
    ...(outMounts.length > 0 ? { mounts: outMounts } : {}),
  });
}
