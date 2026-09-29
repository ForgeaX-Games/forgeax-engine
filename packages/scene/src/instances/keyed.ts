import type { Component, World } from '@forgeax/engine-ecs';
import { classifyEntityField, remapEntityFieldValue } from '@forgeax/engine-ecs/externalization';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import type {
  ComponentValuesMap,
  LocalEntityId,
  SceneAsset,
  SceneEntityAddress,
} from '@forgeax/engine-types';
import {
  err,
  type Handle,
  ok,
  PACK_ERROR_HINTS,
  type Result,
  type SceneEntity,
} from '@forgeax/engine-types';
import { migrateLegacySceneComponentFields, normalizeLegacySceneAsset } from './legacy.js';
import type { MountOverride, SceneInstanceMount } from './runtime-types.js';

/** Numeric representation used only inside the Scene runtime. */
export interface CompiledSceneEntity {
  readonly localId: LocalEntityId;
  readonly components: Partial<ComponentValuesMap>;
}

export interface CompiledSceneAsset {
  readonly kind: 'scene';
  readonly entities: readonly CompiledSceneEntity[];
  readonly mounts?: readonly SceneInstanceMount[];
  readonly skinGuids?: readonly string[];
}

export interface CompiledSceneResult {
  readonly asset: CompiledSceneAsset;
  readonly keyByLocalId: ReadonlyMap<number, string>;
  readonly mountKeyByLocalId: ReadonlyMap<number, string>;
  /** Private slots that attach directly to this scene's synthetic root. */
  readonly rootLocalIds: readonly number[];
  /** Effective private ChildOf edges, including nested scene attachment. */
  readonly hierarchyParentByLocalId: ReadonlyMap<number, number>;
  readonly resolveAddress: (address: unknown, field?: string) => number | undefined;
}

export interface KeyedSceneCompileContext {
  readonly resolveSource: (
    source: string,
    parent: Handle<'SceneAsset', 'shared'>,
  ) => Result<Handle<'SceneAsset', 'shared'>, unknown>;
  readonly resolveAsset: (handle: Handle<'SceneAsset', 'shared'>) => Result<SceneAsset, unknown>;
  readonly stack: ReadonlySet<number>;
}

function fail(reason: string, detail: Record<string, unknown> = {}): Result<never, unknown> {
  return err({
    code: 'asset-package-invalid',
    expected: 'a keyed SceneAsset with valid entity and instance addresses',
    hint: 'repair the SceneAsset source and recook the asset',
    detail: { reason, ...detail },
  });
}

function keyList(entities: Readonly<Record<string, SceneEntity>>): string[] {
  return Object.keys(entities).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function addressParts(value: unknown): readonly string[] | undefined {
  if (typeof value === 'string' && value.length > 0) return [value];
  // ScriptablePack 0.1.27 serialized ChildOf/Children addresses as numeric
  // local IDs. Accept that legacy wire form only at this compiler boundary;
  // the authoring contract remains string keyed.
  if (Number.isSafeInteger(value)) return [String(value)];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((part) => typeof part === 'string' && part.length > 0)) return undefined;
  return value as readonly string[];
}

function fieldRemap(
  world: World,
  componentName: string,
  fields: Record<string, unknown>,
  resolveAddress: (address: unknown, field: string) => number | undefined,
  entityKey?: string,
): Result<Record<string, unknown>, unknown> {
  const token = world.components.resolve(componentName);
  if (token === undefined) return fail('unknown component', { component: componentName });
  const schema = componentSchema(token) as Record<string, string>;
  const out: Record<string, unknown> = {};
  for (const [fieldName, value] of Object.entries(
    migrateLegacySceneComponentFields(componentName, fields),
  )) {
    const fieldType = schema[fieldName];
    if (fieldType === undefined) {
      return fail('unknown component field', {
        component: componentName,
        field: fieldName,
        ...(entityKey === undefined ? {} : { entity: entityKey }),
      });
    }
    const kind = classifyEntityField(token as Component, fieldName);
    if (kind === null) {
      out[fieldName] = value;
      continue;
    }
    const remap = (address: number): number =>
      resolveAddress(address, `${componentName}.${fieldName}`) ?? address;
    // The keyed authoring model uses string addresses for scalar entity fields
    // and an address per element for array<entity>. The ECS kernel still gets
    // numeric local slots, so conversion is complete before spawn.
    if (kind.isArray) {
      if (!Array.isArray(value))
        return fail('array entity field is not an array', {
          component: componentName,
          field: fieldName,
        });
      const numeric: number[] = [];
      for (const item of value) {
        const parts = addressParts(item);
        if (parts === undefined)
          return fail('invalid entity address', {
            component: componentName,
            field: fieldName,
            address: item,
          });
        const slot = resolveAddress(parts, `${componentName}.${fieldName}`);
        if (slot === undefined)
          return fail('missing entity address target', {
            component: componentName,
            field: fieldName,
            address: parts,
          });
        numeric.push(slot);
      }
      out[fieldName] = remapEntityFieldValue(numeric, kind, remap);
      continue;
    }
    if (value === null) {
      out[fieldName] = null;
      continue;
    }
    const parts = addressParts(value);
    if (parts === undefined)
      return fail('invalid entity address', {
        component: componentName,
        field: fieldName,
        address: value,
      });
    const slot = resolveAddress(parts, `${componentName}.${fieldName}`);
    if (slot === undefined)
      return fail('missing entity address target', {
        component: componentName,
        field: fieldName,
        address: parts,
      });
    out[fieldName] = remapEntityFieldValue(slot, kind, remap);
  }
  return ok(out);
}

/**
 * Compile keyed author data to the private numeric Scene representation. The
 * compiler establishes every local and nested address before the caller starts
 * spawning entities, so malformed references and recursive instances cannot
 * leave a partially usable World projection.
 */
export function compileKeyedSceneAsset(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  asset: SceneAsset,
  context: KeyedSceneCompileContext,
): Result<CompiledSceneResult, unknown> {
  asset = normalizeLegacySceneAsset(asset);
  if (
    asset.kind !== 'scene' ||
    asset.entities === null ||
    typeof asset.entities !== 'object' ||
    Array.isArray(asset.entities)
  ) {
    return fail('entities must be a keyed object');
  }
  const currentRaw = Number(handle);
  const activeStack = context.stack.has(currentRaw)
    ? context.stack
    : new Set([...context.stack, currentRaw]);
  const keys = keyList(asset.entities);
  if (keys.some((key) => key.length === 0)) return fail('entity keys must be non-empty');

  const ownKeys = keys.filter((key) => asset.entities[key]?.instance === undefined);
  const instanceKeys = keys.filter((key) => asset.entities[key]?.instance !== undefined);
  const ownSlotByKey = new Map<string, number>();
  const instanceSlotByKey = new Map<string, number>();
  const keyByLocalId = new Map<number, string>();
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index] as string;
    ownSlotByKey.set(key, index);
    keyByLocalId.set(index, key);
  }
  for (let index = 0; index < instanceKeys.length; index += 1) {
    const key = instanceKeys[index] as string;
    const slot = ownKeys.length + index;
    instanceSlotByKey.set(key, slot);
    keyByLocalId.set(slot, key);
  }

  const childCompiled = new Map<
    string,
    { handle: Handle<'SceneAsset', 'shared'>; compiled: CompiledSceneResult }
  >();
  for (const key of instanceKeys) {
    const declaration = asset.entities[key]?.instance;
    if (
      declaration === undefined ||
      typeof declaration.source !== 'string' ||
      declaration.source.length === 0
    ) {
      return fail('instance source must be a non-empty GUID', { entity: key });
    }
    const childHandle = context.resolveSource(declaration.source, handle);
    if (!childHandle.ok) return childHandle;
    const childRaw = Number(childHandle.value);
    if (activeStack.has(childRaw)) {
      return err({
        code: 'pack-cyclic-reference',
        expected: 'acyclic SceneAsset instance graph',
        hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
        detail: {
          code: 'pack-cyclic-reference',
          kind: 'mount-asset',
          cycle: [...activeStack, childRaw].map(String),
        },
      });
    }
    const childAsset = context.resolveAsset(childHandle.value);
    if (!childAsset.ok) return childAsset;
    const childContext: KeyedSceneCompileContext = {
      ...context,
      stack: activeStack,
    };
    const compiled = compileKeyedSceneAsset(
      world,
      childHandle.value,
      childAsset.value,
      childContext,
    );
    if (!compiled.ok) return compiled;
    childCompiled.set(key, { handle: childHandle.value, compiled: compiled.value });
  }

  const mountKeyByLocalId = new Map<number, string>();
  const mounts: SceneInstanceMount[] = [];
  let nextMemberFirst = ownKeys.length + instanceKeys.length;
  for (let index = 0; index < instanceKeys.length; index += 1) {
    const key = instanceKeys[index] as string;
    const slot = instanceSlotByKey.get(key) as number;
    const child = childCompiled.get(key) as {
      handle: Handle<'SceneAsset', 'shared'>;
      compiled: CompiledSceneResult;
    };
    const node = asset.entities[key] as SceneEntity;
    mountKeyByLocalId.set(slot, key);
    mounts.push({
      localId: slot as LocalEntityId,
      source: Number(child.handle),
      memberFirst: nextMemberFirst as LocalEntityId,
      memberCount:
        child.compiled.asset.entities.length +
        (child.compiled.asset.mounts?.length ?? 0) +
        (child.compiled.asset.mounts ?? []).reduce((sum, mount) => sum + mount.memberCount, 0),
      ...(Object.keys(node.components).length > 0 ? { components: node.components } : {}),
    });
    nextMemberFirst += mounts[index]?.memberCount ?? 0;
  }

  const mountByKey = new Map<string, SceneInstanceMount>();
  for (const mount of mounts)
    mountByKey.set(mountKeyByLocalId.get(Number(mount.localId)) as string, mount);

  const resolveInChild = (
    childResult: CompiledSceneResult,
    value: unknown,
    _field?: string,
  ): number | undefined => {
    const parts = addressParts(value);
    if (parts === undefined) return undefined;
    return childResult.resolveAddress(parts);
  };

  const resolveAddress = (value: unknown, field?: string): number | undefined => {
    const parts = addressParts(value);
    if (parts === undefined) return undefined;
    const first = parts[0];
    if (first === undefined) return undefined;
    const own = ownSlotByKey.get(first) ?? instanceSlotByKey.get(first);
    if (own !== undefined && parts.length === 1) return own;
    const mount = mountByKey.get(first);
    if (mount === undefined) return undefined;
    const child = childCompiled.get(first);
    if (child === undefined) return undefined;
    const childSlot = resolveInChild(child.compiled, parts.slice(1), field);
    return childSlot === undefined ? undefined : (mount.memberFirst as number) + childSlot;
  };

  // Instance entities carry their own authored components. They occupy the
  // mount slot in the private representation, so run the same schema driven
  // conversion as ordinary entities before any spawn occurs.
  for (const key of instanceKeys) {
    const node = asset.entities[key] as SceneEntity;
    const mount = mountByKey.get(key) as SceneInstanceMount;
    const convertedFields = Object.fromEntries(
      Object.entries(node.components).map(([componentName, raw]) => [
        componentName,
        fieldRemap(
          world,
          componentName,
          { ...(raw as Record<string, unknown>) },
          resolveAddress,
          key,
        ),
      ]),
    ) as Record<string, Result<Record<string, unknown>, unknown>>;
    const bad = Object.values(convertedFields).find((result) => !result.ok);
    if (bad !== undefined && !bad.ok) return bad;
    const components: Record<string, Record<string, unknown>> = {};
    for (const [componentName, result] of Object.entries(convertedFields)) {
      if (!result.ok) return result;
      components[componentName] = result.value;
    }
    const index = mounts.findIndex((item) => item.localId === mount.localId);
    if (index >= 0) {
      const childOf = components.ChildOf?.parent;
      // An instance declaration's ChildOf belongs to the private mount slot,
      // whose deferred parent wiring runs after own entities exist. Keeping it
      // inside mount.components would remap the parent before that slot is
      // live and silently lose the authored hierarchy edge.
      if (typeof childOf === 'number') {
        const { ChildOf: _ignored, ...mountComponents } = components;
        void _ignored;
        mounts[index] = { ...mount, components: mountComponents, parent: childOf as LocalEntityId };
      } else {
        mounts[index] = { ...mount, components };
      }
    }
  }

  const converted: CompiledSceneEntity[] = [];
  for (const key of ownKeys) {
    const node = asset.entities[key] as SceneEntity;
    const components: Record<string, Record<string, unknown>> = {};
    for (const [componentName, raw] of Object.entries(node.components)) {
      const convertedFields = fieldRemap(
        world,
        componentName,
        { ...(raw as Record<string, unknown>) },
        resolveAddress,
        key,
      );
      if (!convertedFields.ok) return convertedFields;
      components[componentName] = convertedFields.value;
    }
    converted.push({ localId: ownSlotByKey.get(key) as LocalEntityId, components });
  }

  // Convert ordered child-relative overrides into the private field patch
  // representation. Values resolve in the declaring parent namespace.
  // A component declaration that is absent on the target is represented as one
  // component-add override; an existing component stays field-granular so an
  // override cannot erase fields that were not mentioned by the author.
  const childHasComponent = (
    result: CompiledSceneResult,
    target: number,
    componentName: string,
  ): boolean => {
    const own = result.asset.entities.find((entity) => Number(entity.localId) === target);
    if (own !== undefined && own.components[componentName] !== undefined) return true;
    const mount = result.asset.mounts?.find((entry) => Number(entry.localId) === target);
    return mount?.components?.[componentName] !== undefined;
  };
  for (const key of instanceKeys) {
    const node = asset.entities[key] as SceneEntity;
    const declaration = node.instance as NonNullable<SceneEntity['instance']>;
    const mount = mountByKey.get(key) as SceneInstanceMount;
    const child = childCompiled.get(key) as { compiled: CompiledSceneResult };
    const childSlot = (target: SceneEntityAddress): number | undefined =>
      resolveInChild(child.compiled, target, `${key}.instance`);
    const overrides: MountOverride[] = [];
    for (const override of declaration.overrides ?? []) {
      const target = childSlot(override.target);
      if (target === undefined)
        return fail('instance override target does not exist', {
          entity: key,
          target: override.target,
        });
      for (const [componentName, fields] of Object.entries(override.components)) {
        const convertedFields = fieldRemap(
          world,
          componentName,
          { ...(fields as Record<string, unknown>) },
          resolveAddress,
          `${key}.instance.${override.target.join('.')}`,
        );
        if (!convertedFields.ok) return convertedFields;
        if (!childHasComponent(child.compiled, target, componentName)) {
          overrides.push({
            localId: ((mount.memberFirst as number) + target) as LocalEntityId,
            comp: componentName,
            value: convertedFields.value,
          });
        } else {
          overrides.push(
            ...Object.entries(convertedFields.value).map(([field, value]) => ({
              localId: ((mount.memberFirst as number) + target) as LocalEntityId,
              comp: componentName,
              field,
              value,
            })),
          );
        }
      }
    }
    if (overrides.length > 0) {
      const index = mounts.findIndex((item) => item.localId === mount.localId);
      const existing = mounts[index];
      if (index >= 0 && existing !== undefined) mounts[index] = { ...existing, overrides };
    }
  }

  const rootLocalIds: number[] = [
    ...convertedRootLocalIds(converted),
    ...mounts.filter((mount) => mount.parent === undefined).map((mount) => Number(mount.localId)),
  ];

  // Validate the authored hierarchy using the same keyed address resolver that
  // will be used for component fields. General component reference cycles are
  // legal; only ChildOf cycles are rejected before any spawn.
  const hierarchyParentByLocalId = new Map<number, number>();
  for (const node of converted) {
    const parent = node.components.ChildOf?.parent;
    if (typeof parent === 'number' && parent >= 0) {
      hierarchyParentByLocalId.set(Number(node.localId), parent);
    }
  }
  for (const mount of mounts) {
    if (mount.parent !== undefined) {
      hierarchyParentByLocalId.set(Number(mount.localId), mount.parent);
    }
    const key = mountKeyByLocalId.get(Number(mount.localId));
    const child = key === undefined ? undefined : childCompiled.get(key);
    if (child !== undefined) {
      for (const [childLocalId, childParent] of child.compiled.hierarchyParentByLocalId) {
        hierarchyParentByLocalId.set(
          Number(mount.memberFirst) + childLocalId,
          Number(mount.memberFirst) + childParent,
        );
      }
      for (const childRoot of child.compiled.rootLocalIds) {
        hierarchyParentByLocalId.set(Number(mount.memberFirst) + childRoot, Number(mount.localId));
      }
    }
    for (const override of mount.overrides ?? []) {
      if (override.comp !== 'ChildOf') continue;
      if (override.field === 'parent' && typeof override.value === 'number') {
        hierarchyParentByLocalId.set(Number(override.localId), override.value);
      } else if (
        override.field === undefined &&
        typeof override.value === 'object' &&
        override.value !== null
      ) {
        const parentValue = (override.value as Record<string, unknown>).parent;
        if (typeof parentValue === 'number') {
          hierarchyParentByLocalId.set(Number(override.localId), parentValue);
        }
      }
    }
  }
  for (const start of hierarchyParentByLocalId.keys()) {
    const seen = new Set<number>();
    let current: number | undefined = start;
    while (current !== undefined && hierarchyParentByLocalId.has(current)) {
      if (seen.has(current))
        return fail('hierarchy cycle', { entity: keyByLocalId.get(start), address: [...seen] });
      seen.add(current);
      current = hierarchyParentByLocalId.get(current);
    }
  }

  return ok({
    asset: {
      kind: 'scene',
      entities: converted,
      ...(mounts.length > 0 ? { mounts } : {}),
      ...(asset.skinGuids === undefined ? {} : { skinGuids: asset.skinGuids }),
    },
    keyByLocalId,
    mountKeyByLocalId,
    rootLocalIds,
    hierarchyParentByLocalId,
    resolveAddress,
  });
}

function convertedRootLocalIds(nodes: readonly CompiledSceneEntity[]): number[] {
  return nodes
    .filter((node) => node.components.ChildOf === undefined)
    .map((node) => Number(node.localId));
}
