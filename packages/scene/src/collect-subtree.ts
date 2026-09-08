// Scene-owned hierarchy traversal shared by scene collection and render hooks.

import type { EntityHandle, World } from '@forgeax/engine-ecs';

import { Children } from './components/children';

/** Walk a Children hierarchy breadth-first, reusing an optional visited set. */
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
    const current = queue.shift() as number;
    const children = world.get(current as EntityHandle, Children);
    if (!children.ok) continue;
    const entities = children.value.entities as ArrayLike<number>;
    for (let index = 0; index < entities.length; index += 1) {
      const child = entities[index] as number;
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push(child);
    }
  }
  return visited;
}
