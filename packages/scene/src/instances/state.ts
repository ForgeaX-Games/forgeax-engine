import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { Handle, LocalEntityId } from '@forgeax/engine-types';
import type { MountOverride } from './runtime-types.js';

/** Internal state retained by a SceneInstance root. */
export interface SceneInstanceStatePayload {
  readonly source: Handle<'SceneAsset', 'shared'>;
  readonly sceneSourceKey?: string;
  /** Authored key for each private numeric slot, retained for collection. */
  readonly keyByLocalId: Map<number, string>;
  /** Authored key of this instance when it is nested in a parent scene. */
  readonly instanceKey?: string;
  readonly bindings: Map<string, EntityHandle>;
  readonly entityToLocalId: Map<EntityHandle, LocalEntityId>;
  readonly detachedLocalIds: Set<LocalEntityId>;
  readonly overrides: Map<
    LocalEntityId,
    Map<string, { readonly comp: string; readonly field?: string; readonly value: unknown }>
  >;
  readonly rootEntities: EntityHandle[];
  readonly mountRoots: EntityHandle[];
  readonly totalSlots: number;
  readonly mountTimeOverrides: readonly MountOverride[];
}

export interface SceneWorldState {
  resolver: unknown;
  readonly statePayloads: Map<number, unknown>;
}

const sceneWorldStates = new WeakMap<World, SceneWorldState>();

export function sceneWorldState(world: World): SceneWorldState {
  const current = sceneWorldStates.get(world);
  if (current !== undefined) return current;
  const created: SceneWorldState = { resolver: null, statePayloads: new Map<number, unknown>() };
  sceneWorldStates.set(world, created);
  return created;
}

export function mountOverrideStateKey(ov: MountOverride): string {
  return ov.field !== undefined ? `${ov.comp}:${ov.field}` : ov.comp;
}

export function isPrimitiveScalarFieldType(fieldType: string): boolean {
  if (
    fieldType === 'f32' ||
    fieldType === 'f64' ||
    fieldType === 'u32' ||
    fieldType === 'i32' ||
    fieldType === 'u8' ||
    fieldType === 'i8' ||
    fieldType === 'u16' ||
    fieldType === 'i16' ||
    fieldType === 'bool' ||
    fieldType === 'string'
  ) {
    return true;
  }
  return fieldType.startsWith('enum<');
}

export function primitiveJsType(fieldType: string): string {
  if (fieldType === 'bool') return 'boolean';
  if (fieldType === 'string') return 'string';
  return 'number';
}
