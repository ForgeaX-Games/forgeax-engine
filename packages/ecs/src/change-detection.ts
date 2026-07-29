// @forgeax/engine-ecs — per-entity and per-resource change ticks.

export interface ChangeTicks {
  added: number;
  changed: number;
}

export const NEVER_CHANGED_TICK = -1;

export function createChangeTicks(tick: number): ChangeTicks {
  return { added: tick, changed: tick };
}
