// @forgeax/engine-state -- transitionStatesSystem (M3 / m3w4)
//
// 8-step per-token transition logic executed every frame by the
// 'transitionStates' system registered in registerStatesPlugin.
//
// Per token:
//   1. Read NextState Resource; if undefined -> continue (zero-cost skip)
//   2. Read State Resource; if prev===next && !force -> clear NextState, continue (same-state no-op)
//   3. Write PreviousState = prev, flip State = next
//   4. Collect exit-scoped entities -> world.despawn each
//   5. OnExit placeholder (M4)
//   6. Collect enter-scoped entities -> world.despawn each
//   7. OnEnter placeholder (M4)
//   8. Clear NextState = undefined
//
// Decision anchors:
// - plan-strategy sec 3.2: 8-step flowchart + OnEnter/OnExit dispatch between flip and despawn
// - plan-strategy D-2: unified world.despawn via linkedSpawn cascade
// - plan-strategy D-5: fn[] registry + transition body dispatch, zero ECS change
// - research F-6: queryRun + world.despawn sufficient, no new query API needed
// - requirements sec 7: despawn tolerance (entity already dead = no error)

import type { Component, EntityHandle, World } from '@forgeax/engine-ecs';
import { createQueryState, Entity, queryRun, resolveComponent } from '@forgeax/engine-ecs';
import { getRegisteredTokens } from './define-state';
import { getCallbacks, OnEnter, OnExit } from './on-enter-on-exit';
import { nextStateResourceKey, previousStateResourceKey, stateResourceKey } from './resources';

interface NextStatePayload {
  value: number;
  force: boolean;
}

/**
 * Collect entities whose ScopedTo component matches a given mode and value,
 * then despawn all of them. Single despawn fault (already-dead entity) does
 * not abort the batch — despawn tolerance per requirements sec 7.
 *
 * A scoped entity that is a SceneInstance root is torn down with `despawnScene`
 * (cascade over its instantiated members), NOT plain `world.despawn`. Plain
 * despawn does not cascade through `ChildOf` (which ships `linkedSpawn=false`),
 * so a scoped scene root would orphan every member entity it instantiated. On a
 * state replay (e.g. Title->Play->Title->Play) those orphans linger, their index
 * slots are reused at a new generation, and a surviving member's stale
 * `ChildOf -> (oldRoot, oldGen)` makes `propagateTransforms` throw
 * `hierarchy-broken` every frame. Cascading via `despawnScene` removes the whole
 * instantiated subtree so nothing is left pointing at the dead root.
 */
function scopeDespawn(world: World, scopedComponent: Component, mode: number, value: number): void {
  const state = createQueryState({ with: [scopedComponent, Entity] });
  const despawns: EntityHandle[] = [];
  queryRun(state, world, (bundle) => {
    const raw = bundle as unknown as Record<string, Record<string, unknown>>;
    const rows = raw[scopedComponent.name];
    if (!rows) return;
    const values = rows.value as Uint32Array;
    const modes = rows.mode as Uint32Array;
    const handles = (raw.Entity as Record<string, Uint32Array>).self;
    if (!handles) return;
    for (let i = 0; i < handles.length; i++) {
      if (modes[i] === mode && values[i] === value) {
        despawns.push(handles[i] as unknown as EntityHandle);
      }
    }
  });
  // SceneInstance is resolved by name through the global registry so the state
  // package stays free of a runtime dependency (layering: state -> ecs only).
  const sceneInstance = resolveComponent('SceneInstance');
  // Tear down SceneInstance roots FIRST, via despawnScene (cascade over their
  // instantiated members). This must precede the plain despawns: a scoped scene
  // root is often ChildOf a scoped non-scene entity (e.g. a character rig parented
  // under a KCC body), and despawning that parent first invalidates the root
  // handle before we can cascade it -- leaving the scene's members orphaned with a
  // stale ChildOf -> dead-root ref. Doing the cascades up front guarantees each
  // SceneInstance subtree is fully removed while its root is still live.
  if (sceneInstance !== undefined) {
    for (const e of despawns) {
      if (world.get(e, sceneInstance).ok) world.despawnScene(e);
    }
  }
  for (const e of despawns) {
    // Scene roots already torn down above are now dead -> world.despawn is a
    // tolerated no-op (requirements sec 7); every other scoped entity despawns here.
    world.despawn(e);
  }
}

export function transitionStatesSystem(world: World): void {
  for (const token of getRegisteredTokens().values()) {
    const nsKey = nextStateResourceKey(token);

    // (0) Skip tokens with no Resources yet. getRegisteredTokens() returns every
    // token ever defined, but registerStatesPlugin only inserts Resources for
    // tokens known at plugin time. A token defined after the plugin ran has no
    // NextState Resource; world.getResource would throw ResourceNotFoundError.
    // hasResource guard mirrors setNextState / getState in this package.
    if (!world.hasResource(nsKey)) continue;
    const ns = world.getResource<NextStatePayload | undefined>(nsKey);

    // (1) No pending transition — zero-cost continue
    if (ns === undefined) continue;

    const sKey = stateResourceKey(token);
    const prevIdx = world.getResource<number>(sKey);
    const nextIdx = ns.value;
    const force = ns.force;

    // (2) Same-state no-op (unless force flag overrides)
    if (prevIdx === nextIdx && !force) {
      world.insertResource<NextStatePayload | undefined>(nsKey, undefined);
      continue;
    }

    // (3) Write PreviousState = prev, flip State = next
    const psKey = previousStateResourceKey(token);
    world.insertResource(psKey, prevIdx);
    world.insertResource(sKey, nextIdx);

    // Resolve the per-token ScopedTo component from the global ECS registry
    const scopedComponent = resolveComponent(`__scopedTo__${token.name}`);
    if (scopedComponent) {
      // (4) Despawn exit-scoped entities (mode=0, value=prev)
      scopeDespawn(world, scopedComponent, 0, prevIdx);

      // (5) OnExit dispatch: fire registered callbacks for prev variant.
      // Errors bubble to the transitionStatesSystem call stack per req §7.
      const prevVariant = token.variants[prevIdx];
      if (prevVariant !== undefined) {
        const exitLabel = OnExit(token, prevVariant);
        for (const fn of getCallbacks(exitLabel)) {
          fn(world);
        }
      }

      // (6) Despawn enter-scoped entities (mode=1, value=next)
      scopeDespawn(world, scopedComponent, 1, nextIdx);

      // (7) OnEnter dispatch: fire registered callbacks for next variant.
      // Errors bubble to the transitionStatesSystem call stack per req §7.
      const nextVariant = token.variants[nextIdx];
      if (nextVariant !== undefined) {
        const enterLabel = OnEnter(token, nextVariant);
        for (const fn of getCallbacks(enterLabel)) {
          fn(world);
        }
      }
    }

    // (8) Clear NextState — but only if OnEnter callbacks did not already
    // write a new NextState payload (e.g. nested setNextState). If the
    // payload differs from the original `ns`, leave it for the next frame.
    const nsAfterCallbacks = world.getResource<NextStatePayload | undefined>(nsKey);
    if (
      nsAfterCallbacks !== undefined &&
      nsAfterCallbacks.value === ns.value &&
      nsAfterCallbacks.force === ns.force
    ) {
      world.insertResource<NextStatePayload | undefined>(nsKey, undefined);
    }
    // else: callbacks wrote a new NextState — survive for next frame
  }
}
