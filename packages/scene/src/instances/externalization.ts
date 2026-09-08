import type { AssetRef, MountOverride, SceneAsset } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';

export type SceneComponentSchemaResolver = (
  componentName: string,
) => Readonly<Record<string, string>> | undefined;

export interface SceneExternalizationError {
  readonly field: string;
  readonly value: unknown;
}

export interface ExternalizedSceneAsset {
  readonly payload: Record<string, unknown>;
  readonly refs: readonly AssetRef[];
}

function sharedKind(type: string | undefined): 'one' | 'many' | undefined {
  if (type?.startsWith('shared<')) return 'one';
  if (type?.startsWith('array<shared<')) return 'many';
  return undefined;
}

function overrideGuids(
  override: MountOverride,
  resolveSchema: SceneComponentSchemaResolver,
): readonly { field: string; guid: string }[] {
  const schema = resolveSchema(override.comp);
  const values =
    override.field !== undefined
      ? [[override.field, override.value] as const]
      : override.value !== null &&
          typeof override.value === 'object' &&
          !Array.isArray(override.value)
        ? Object.entries(override.value as Record<string, unknown>)
        : [];
  return values.flatMap(([field, value]) => {
    const kind = sharedKind(schema?.[field]);
    if (kind === 'one' && typeof value === 'string') return [{ field, guid: value }];
    if (kind === 'many' && Array.isArray(value)) {
      return value.flatMap((item) => (typeof item === 'string' ? [{ field, guid: item }] : []));
    }
    return [];
  });
}

/** Project a SceneAsset's shared asset fields into a payload plus indexed refs. */
export function externalizeSceneAsset(
  scene: SceneAsset,
  resolveSchema: SceneComponentSchemaResolver,
): Result<ExternalizedSceneAsset, SceneExternalizationError> {
  const refs: AssetRef[] = [];
  const indexByGuid = new Map<string, number>();
  const addRef = (
    guid: string,
    sourceField: NonNullable<AssetRef['sourceField']>,
    sceneEntityId?: number,
  ): number => {
    const prior = indexByGuid.get(guid);
    if (prior !== undefined) return prior;
    const index = refs.length;
    refs.push({ guid, sourceField, ...(sceneEntityId === undefined ? {} : { sceneEntityId }) });
    indexByGuid.set(guid, index);
    return index;
  };

  const entities = scene.entities.map((entity) => {
    const components: Record<string, Record<string, unknown>> = {};
    for (const componentName of Object.keys(entity.components)) {
      const schema = resolveSchema(componentName);
      const source = entity.components[componentName] as Record<string, unknown> | undefined;
      if (source === undefined) continue;
      const fields: Record<string, unknown> = {};
      for (const fieldName of Object.keys(source)) {
        const value = source[fieldName];
        if (value === undefined) continue;
        const kind = sharedKind(schema?.[fieldName]);
        if (kind === 'one' && typeof value === 'string') {
          fields[fieldName] = addRef(value, { componentName, fieldName }, entity.localId as number);
        } else if (kind === 'many' && Array.isArray(value)) {
          fields[fieldName] = value.map((item, arrayIndex) =>
            typeof item === 'string'
              ? addRef(item, { componentName, fieldName, arrayIndex }, entity.localId as number)
              : item,
          );
        } else {
          fields[fieldName] = value;
        }
      }
      if (Object.keys(fields).length > 0 || Object.keys(schema ?? {}).length === 0) {
        components[componentName] = fields;
      }
    }
    return { localId: entity.localId as number, components };
  });

  const mounts = scene.mounts?.map((mount) => {
    const source =
      typeof mount.source === 'string'
        ? addRef(
            mount.source,
            { componentName: 'SceneInstance', fieldName: 'source' },
            mount.localId as number,
          )
        : (mount.source as number);
    for (const { field, guid } of (mount.overrides ?? []).flatMap((override) =>
      overrideGuids(override, resolveSchema),
    )) {
      addRef(guid, { componentName: 'SceneInstance', fieldName: `overrides.${field}` });
    }
    return {
      localId: mount.localId as number,
      source,
      memberFirst: mount.memberFirst as number,
      memberCount: mount.memberCount,
      ...(mount.parent === undefined ? {} : { parent: mount.parent as number }),
      ...(mount.publicationFence === undefined ? {} : { publicationFence: mount.publicationFence }),
      ...(mount.overrides === undefined
        ? {}
        : { overrides: mount.overrides.map((item) => ({ ...item })) }),
    };
  });
  for (const [arrayIndex, guid] of (scene.skinGuids ?? []).entries()) {
    if (typeof guid !== 'string') return err({ field: 'skinGuids', value: guid });
    addRef(guid, { componentName: '<scene>', fieldName: 'skinGuids', arrayIndex });
  }
  return ok({
    payload: {
      entities,
      ...(mounts === undefined || mounts.length === 0 ? {} : { mounts }),
      ...(scene.skinGuids === undefined
        ? {}
        : { skinGuids: scene.skinGuids.map((guid) => indexByGuid.get(guid) as number) }),
    },
    refs,
  });
}
