// M1 shared util — collectSubtree (AC-16).
// Extracted from post-spawn-resolve-joints.ts:116-133.
// Walks Children.entities BFS from spawnRoot; accepts optional external visited Set
// for cross-root de-duplication (AC-03).

import type { EntityHandle, World } from '@forgeax/engine-ecs';

import { Children } from '../components/children';

/**
 * Walk `Children.entities` BFS from `spawnRoot` to collect all descendant
 * entities (incl. spawnRoot itself). When a shared `visited` Set is passed,
 * it is reused across roots for cross-root de-duplication; when omitted a
 * fresh Set is created (single-root / backward-compat).
 *
 * Entities without a `Children` component surface as leaves.
 */
export function collectSubtree(
  world: World,
  spawnRoot: EntityHandle,
  visited?: Set<number>,
): Set<number> {
  if (visited === undefined) visited = new Set<number>();
  if (visited.has(spawnRoot as number)) return visited;
  const queue: number[] = [spawnRoot as number];
  visited.add(spawnRoot as number);
  while (queue.length > 0) {
    const cur = queue.shift() as number;
    const childrenData = world.get(cur as EntityHandle, Children);
    if (!childrenData.ok) continue;
    const list = childrenData.value.entities as ArrayLike<number>;
    for (let i = 0; i < list.length; i++) {
      const child = list[i] as number;
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push(child);
    }
  }
  return visited;
}
