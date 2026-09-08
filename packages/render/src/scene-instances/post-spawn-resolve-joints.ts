// @forgeax/engine-runtime — postSpawnResolveJoints hook (M1 / T-14).
//
// Invoked after sceneInstances.instantiate to auto-wire Skin.joints: Entity[]
// from the SkinAsset.jointPaths via Name-component lookup on the
// spawned entity subtree. This is the v1 missing item #2: instantiate auto-calls
// postSpawnResolveJoints so AI users never manually populate Skin.joints.
//
// Resolution protocol (plan-strategy D-6a + tweak-20260611 D-7 subtree-scope):
//   - From the spawnRoot, walk ChildOf relations BFS to collect the spawned
//     subtree's entities. nameIndex is built only over those entities.
//   - For each Skin-bearing entity in the subtree, resolve the skeleton handle
//     to jointPaths via the resolver.
//   - For each jointPath leaf name, match against the subtree-local Name index.
//   - Same-name sibling within the subtree: first-match with console.warn (D-6a).
//   - Missing entity: fail-fast 'skin-joint-path-unresolved' error.
//   - Empty jointPaths: no-op (no crash).
//
// Why subtree-scope (tweak-20260611 D-7):
//   Without scope, multiple instantiate() calls on the same SceneAsset (e.g. 3
//   Fox foxes side-by-side) all wire to the FIRST instance's joint entities
//   because Name leaf strings collide globally — Skin.joints[] points to
//   instance-0's bones for every spawn, three foxes share one skeleton, poses
//   cannot differ. Scoping to ChildOf descendants of spawnRoot eliminates the
//   collision: each spawn has its own copy of the subtree, names collide only
//   among siblings within the same spawn, where D-6a's first-match-with-warn
//   remains the correct policy.
//
// Decision anchors:
//   - requirements AC-14 (post-spawn auto-wire)
//   - plan-strategy D-6a (first-match strategy within subtree)
//   - tweak-20260611 plan-strategy D-7 (subtree-scope)
//   - charter P3 (explicit failure: path-unresolved fail-fast)

import type { SkinJointResolver } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { collectSubtree, Name } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';

// feat-20260705-runtime-tier2-decomposition M1 / w6 (D-1): SkinJointResolver
// relocated to registry/instantiate.ts so the hook contract travels with the
// instantiate cluster into @forgeax/engine-assets-runtime. Imported back here as
// a forward (runtime -> assets-runtime-bound module) type-only reference and
// re-exported for existing consumers of this module's SkinJointResolver export.
export type { SkinJointResolver } from '@forgeax/engine-assets-runtime';

interface JointPathUnresolvedError {
  code: 'skin-joint-path-unresolved';
  expected: string;
  hint: string;
  detail: {
    skinEntity: number;
    path: readonly string[];
    failedAtIndex: number;
  };
}

interface SkinAssetUnresolvedError {
  code: 'skin-asset-unresolved';
  expected: string;
  hint: string;
  detail: {
    skinEntity: number;
    skeletonHandle: number;
  };
}

type ResolveError = JointPathUnresolvedError | SkinAssetUnresolvedError;

export function postSpawnResolveJoints(
  world: World,
  resolver: SkinJointResolver,
  spawnRoot: EntityHandle,
): { ok: true } | { ok: false; error: ResolveError } {
  // tweak-20260611 D-7: scope nameIndex to the spawnRoot's ChildOf-descendant
  // subtree (incl. spawnRoot itself). Multiple instantiate() calls on the same
  // SceneAsset each get an independent subtree, so leaf-name collisions across
  // instances no longer wire all spawns to the first instance's joints.
  const subtree = collectSubtree(world, spawnRoot);
  const nameIndex = new Map<string, number[]>();
  const nameQuery = world.query({ read: [Name] });
  if (nameQuery.ok) {
    for (const row of nameQuery.value) {
      if (!subtree.has(row.entity as number)) continue;
      const nameVal = row.get(Name).value;
      const list = nameIndex.get(nameVal) ?? [];
      list.push(row.entity);
      nameIndex.set(nameVal, list);
    }
  }

  // Walk Skin-bearing entities IN THE SUBTREE and resolve joints. Skin is
  // matched through the owner identity projection, and entities outside the subtree
  // are filtered after readEntityAt (cheaper than per-archetype filtering).
  const skinQuery = world.query({ read: [Skin] });
  if (!skinQuery.ok) return { ok: true };
  for (const queryRow of skinQuery.value) {
    const entity = queryRow.entity;
    if (!subtree.has(entity as number)) continue;
    const skeletonHandle = queryRow.get(Skin).skeleton as number;

    const skinAsset = resolver.resolveSkinAsset(skeletonHandle);
    if (skinAsset === undefined) {
      // feat-20260612 M2 fixup: was a silent `continue` that left
      // `Skin.joints` empty -- the M2-introduced
      // JointCountMismatchError fail-fast in render-system-extract then
      // triggered every frame on the browser-async-pack-fetch path.
      // The cure is to load SkinAssets through the SceneAsset.skinGuids
      // cross-edge (gltfImporter scene branch emits the SkinAsset GUIDs into
      // the scene envelope's refs[], the runtime recursion source) so this
      // resolver should always succeed; if it does not, fail-fast here
      // with a precise errorCode rather than silently producing an
      // unresolvable Skin.joints state.
      return {
        ok: false,
        error: {
          code: 'skin-asset-unresolved',
          expected: `SkinAsset registered for skeleton handle ${skeletonHandle} when instantiate triggers postSpawnResolveJoints`,
          hint: `SkinAsset matching skeletonGuid for handle ${skeletonHandle} was not found in AssetRegistry; verify the SceneAsset.skinGuids[] cross-edge is populated by the importer (gltfImporter scene branch) and that loadByGuid<SceneAsset> recursively loaded each SkinAsset before instantiate (browser-async-pack-fetch path)`,
          detail: { skinEntity: entity, skeletonHandle },
        },
      };
    }

    const jointEntityList: number[] = [];
    for (const jointPath of skinAsset.jointPaths) {
      const pathSegments = jointPath.split('/').filter(Boolean);
      if (pathSegments.length === 0) continue;

      const leafName = pathSegments[pathSegments.length - 1];
      if (leafName === undefined) continue;

      const nameMatches = nameIndex.get(leafName);
      if (nameMatches === undefined || nameMatches.length === 0) {
        return {
          ok: false,
          error: {
            code: 'skin-joint-path-unresolved',
            expected: `joint entity with Name="${leafName}" exists in the spawned subtree (root entity ${spawnRoot})`,
            hint: `joint path "${jointPath}" for skin entity ${entity} could not be resolved within spawnRoot ${spawnRoot}'s ChildOf-subtree; verify glTF node names are preserved and instantiateScene seeded a Children mirror`,
            detail: {
              skinEntity: entity,
              path: pathSegments,
              failedAtIndex: pathSegments.length - 1,
            },
          },
        };
      }

      if (nameMatches.length > 1) {
        console.warn(
          `[Skin] same-name sibling: "${leafName}" matches ${nameMatches.length} entities ` +
            `within spawn subtree of root ${spawnRoot}; using first-match (entity ${nameMatches[0]}) per D-6a`,
        );
      }

      jointEntityList.push(nameMatches[0] as number);
    }

    world.set(entity, Skin, {
      joints: new Uint32Array(jointEntityList),
    } as never);
  }

  return { ok: true };
}
