import {
  type AssetDecoder,
  type AssetDecoderContribution,
  type AssetKind,
  type AssetLoadError,
  err,
  ok,
  type Result,
  type SceneAsset,
  type SceneEntity,
  type SceneInstanceMount,
} from '@forgeax/engine-types';

export const sceneAssetKind: AssetKind<SceneAsset, 'scene'> = {
  kind: 'scene',
} as AssetKind<SceneAsset, 'scene'>;

function invalidScene(guid: string, reason: string): Result<SceneAsset, AssetLoadError> {
  return err({
    code: 'asset-package-invalid',
    expected: 'a scene payload with an entities array',
    hint: 'recook the SceneAsset and publish its complete envelope',
    detail: { guid, reason },
  });
}

type SceneWireRefResult =
  | { readonly ok: true; readonly value: SceneAsset }
  | { readonly ok: false; readonly reason: string };

// The Pack envelope owns refs[] while the decoded SceneAsset remains the
// portable payload. Keep that wire-only fact beside the decoded object so the
// World-local projection can interpret shared-field indices without putting a
// component registry or World into the decoder contract.
const sceneWireRefs = new WeakMap<object, readonly string[]>();

/** @internal Read the Pack refs[] retained for a decoded SceneAsset payload. */
export function sceneAssetWireRefs(asset: SceneAsset): readonly string[] | undefined {
  return sceneWireRefs.get(asset);
}

function resolveWireRef(
  refs: readonly string[],
  value: number,
  location: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  const guid = refs[value];
  if (!Number.isInteger(value) || value < 0 || guid === undefined) {
    return {
      ok: false,
      reason: `${location} references refs[${value}], but refs contains ${refs.length} entries`,
    };
  }
  return { ok: true, value: guid };
}

function resolveMounts(
  mounts: readonly SceneInstanceMount[] | undefined,
  refs: readonly string[],
):
  | { readonly ok: true; readonly value: readonly SceneInstanceMount[] | undefined }
  | { readonly ok: false; readonly reason: string } {
  if (mounts === undefined) return { ok: true, value: undefined };
  const resolved: SceneInstanceMount[] = [];
  for (const mount of mounts) {
    if (typeof mount.source !== 'number' || !Number.isInteger(mount.source)) {
      resolved.push(mount);
      continue;
    }
    const ref = resolveWireRef(refs, mount.source, `mount ${mount.localId} source`);
    if (!ref.ok) return ref;
    resolved.push({ ...mount, source: ref.value });
  }
  return { ok: true, value: resolved };
}

function resolveSkinGuids(
  skinGuids: readonly (number | string)[] | undefined,
  refs: readonly string[],
):
  | { readonly ok: true; readonly value: readonly string[] | undefined }
  | { readonly ok: false; readonly reason: string } {
  if (skinGuids === undefined) return { ok: true, value: undefined };
  const resolved: string[] = [];
  for (let index = 0; index < skinGuids.length; index += 1) {
    const value = skinGuids[index];
    if (typeof value === 'string') {
      resolved.push(value);
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { ok: false, reason: `skinGuids[${index}] is not a GUID or refs index` };
    }
    const ref = resolveWireRef(refs, value, `skinGuids[${index}]`);
    if (!ref.ok) return ref;
    resolved.push(ref.value);
  }
  return { ok: true, value: resolved };
}

function resolveSceneWireRefs(payload: SceneAsset, refs: readonly string[]): SceneWireRefResult {
  const entities: SceneEntity[] = [];
  for (const entity of payload.entities) {
    const components: Record<string, Record<string, unknown>> = {};
    for (const [componentName, rawFields] of Object.entries(entity.components)) {
      // Component schema lookup is World-local after the ECS core reduction.
      // The runtime projection owns the World-local schema and converts
      // authored GUID fields into World.sharedRefs handles. Keep this loader
      // boundary POD-only instead of consulting a removed process-global ECS
      // component registry.
      components[componentName] = { ...(rawFields as Record<string, unknown>) };
    }
    entities.push({ localId: entity.localId, components });
  }

  const mounts = resolveMounts(payload.mounts, refs);
  if (!mounts.ok) return mounts;
  const skinGuids = resolveSkinGuids(
    payload.skinGuids as readonly (number | string)[] | undefined,
    refs,
  );
  if (!skinGuids.ok) return skinGuids;

  return {
    ok: true,
    value: {
      kind: 'scene',
      entities,
      ...(mounts.value === undefined ? {} : { mounts: mounts.value }),
      ...(skinGuids.value === undefined ? {} : { skinGuids: skinGuids.value }),
    },
  };
}

/** Scene owns structural validation; World-local projection resolves shared refs. */
export const sceneAssetDecoder: AssetDecoder<SceneAsset> = {
  async decode({ envelope }): Promise<Result<SceneAsset, AssetLoadError>> {
    const payload = envelope.payload;
    if (payload.kind !== 'scene' || !Array.isArray(payload.entities)) {
      return invalidScene(envelope.guid, 'scene payload is missing entities');
    }
    const resolved = resolveSceneWireRefs(payload, envelope.refs);
    if (!resolved.ok) return invalidScene(envelope.guid, resolved.reason);
    sceneWireRefs.set(resolved.value, Object.freeze([...envelope.refs]));
    return ok(resolved.value);
  },
};

export const sceneAssetContribution: AssetDecoderContribution<SceneAsset, 'scene'> = {
  kind: sceneAssetKind,
  decoder: sceneAssetDecoder,
  consumer: 'Scene',
};
