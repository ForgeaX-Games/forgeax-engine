import type { EntityHandle } from '@forgeax/engine-ecs';

export interface SkinJointPathUnresolved {
  readonly code: 'skin-joint-path-unresolved';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly skinEntity: number;
    readonly path: readonly string[];
    readonly failedAtIndex: number;
  };
}

export type SkinBindingError = SkinJointPathUnresolved;

export function resolveSkinJoints(
  jointPaths: readonly string[],
  names: ReadonlyMap<string, EntityHandle>,
  skinEntity: EntityHandle,
): { ok: true; value: Uint32Array } | { ok: false; error: SkinBindingError } {
  const joints: number[] = [];
  for (const path of jointPaths) {
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const failedAtIndex = segments.length - 1;
    const entity = names.get(segments[failedAtIndex] ?? '');
    if (entity === undefined) {
      return {
        ok: false,
        error: {
          code: 'skin-joint-path-unresolved',
          expected: `joint entity with Name="${segments[failedAtIndex]}" exists`,
          hint: 'verify imported joint names and rebind the Skin component',
          detail: { skinEntity: skinEntity as number, path: segments, failedAtIndex },
        },
      };
    }
    joints.push(entity as number);
  }
  return { ok: true, value: new Uint32Array(joints) };
}
