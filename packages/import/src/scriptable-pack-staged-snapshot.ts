import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ScriptablePackError } from '@forgeax/engine-pack/source';
import type { Asset, AssetGuid as AssetGuidType, ImportError, Result } from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import type {
  ScriptablePackAssetSnapshot,
  ScriptablePackAssetSnapshotSource,
  ScriptablePackDomainError,
  ScriptablePackStagedOutput,
} from './scriptable-pack.js';

export type ScriptablePackSnapshotError =
  | AssetError
  | ImportError
  | ScriptablePackError
  | ScriptablePackDomainError;

export interface ScriptablePackStagedOwner {
  readonly id: string;
  readonly guids: readonly AssetGuidType[];
  build(
    source: ScriptablePackAssetSnapshotSource,
  ): Promise<Result<readonly ScriptablePackStagedOutput[], ScriptablePackSnapshotError>>;
}

export interface ScriptablePackStagedSnapshotOptions {
  readonly generation: number;
  readonly owners: readonly ScriptablePackStagedOwner[];
  readonly declaredExternalOutputs?: readonly ScriptablePackStagedOutput[];
}

function stable(value: unknown): string {
  if (ArrayBuffer.isView(value)) {
    return `${value.constructor.name}:${JSON.stringify(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)))}`;
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function assetDigest(asset: Asset): Promise<string> {
  const bytes = new TextEncoder().encode(stable(asset));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function cycleError(stack: readonly string[], owner: string, guid: string): ScriptablePackError {
  const cycleStart = stack.indexOf(owner);
  const cycle = [...stack.slice(cycleStart), owner];
  return {
    code: 'pack-source-build-cycle',
    expected: 'an acyclic graph of ScriptablePack content dependencies',
    actual: cycle.join(' -> '),
    hint: 'break one content read edge or convert it to a reference-only dependency',
    retryable: false,
    recoveryActions: ['inspect-content-dependency-graph', 'edit-source'],
    detail: { sourcePath: owner, sourceKey: guid, incomingRefs: cycle },
  };
}

function missingOutputError(owner: string, guid: string): ScriptablePackError {
  return {
    code: 'pack-source-output-invalid',
    expected: `owner ${owner} to stage every declared output including ${guid}`,
    hint: 'return one output for every GUID declared by the staged owner',
    detail: { missingGuids: [guid], unexpectedSourceKeys: [], kindMismatches: [] },
  };
}

/**
 * One-build authority for current-generation ScriptablePack content reads.
 * Local owners are built lazily, memoized, and never resolved through an old Catalog/DDC generation.
 */
export function createScriptablePackStagedAssetSnapshotSource(
  options: ScriptablePackStagedSnapshotOptions,
): ScriptablePackAssetSnapshotSource {
  const owners =
    options.declaredExternalOutputs === undefined || options.declaredExternalOutputs.length === 0
      ? options.owners
      : [
          {
            id: '<declared-pack-external>',
            guids: options.declaredExternalOutputs.map((output) => output.guid),
            async build() {
              return ok(options.declaredExternalOutputs ?? []);
            },
          } satisfies ScriptablePackStagedOwner,
          ...options.owners,
        ];
  const ownerByGuid = new Map<string, ScriptablePackStagedOwner>();
  for (const owner of owners) {
    if (owner.id.trim().length === 0) throw new TypeError('staged owner id must be non-empty');
    for (const guid of owner.guids) {
      const key = AssetGuid.format(guid).toLowerCase();
      const existing = ownerByGuid.get(key);
      if (existing !== undefined) {
        throw new TypeError(`staged GUID ${key} is owned by both ${existing.id} and ${owner.id}`);
      }
      ownerByGuid.set(key, owner);
    }
  }

  const snapshots = new Map<string, ScriptablePackAssetSnapshot>();
  const builds = new Map<string, Promise<Result<void, ScriptablePackSnapshotError>>>();

  const sourceFor = (stack: readonly string[]): ScriptablePackAssetSnapshotSource => ({
    async readByGuid(guid) {
      const key = AssetGuid.format(guid).toLowerCase();
      const cached = snapshots.get(key);
      if (cached !== undefined) return ok(structuredClone(cached));
      const owner = ownerByGuid.get(key);
      if (owner === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-imported',
            expected: 'a staged local owner for the requested GUID',
            hint: 'declare the local ScriptablePack output before rebuilding the generation',
          }),
        );
      }
      if (stack.includes(owner.id)) return err(cycleError(stack, owner.id, key));

      let building = builds.get(owner.id);
      if (building === undefined) {
        building = (async () => {
          const built = await owner.build(sourceFor([...stack, owner.id]));
          if (!built.ok) {
            builds.delete(owner.id);
            return built;
          }
          const next = new Map<string, ScriptablePackAssetSnapshot>();
          for (const output of built.value) {
            const outputGuid = AssetGuid.format(output.guid).toLowerCase();
            if (ownerByGuid.get(outputGuid) !== owner) {
              builds.delete(owner.id);
              return err(missingOutputError(owner.id, outputGuid));
            }
            next.set(outputGuid, {
              asset: structuredClone(output.asset),
              generation: options.generation,
              digest: output.digest ?? (await assetDigest(output.asset)),
            });
          }
          for (const declared of owner.guids) {
            const declaredGuid = AssetGuid.format(declared).toLowerCase();
            if (!next.has(declaredGuid)) {
              builds.delete(owner.id);
              return err(missingOutputError(owner.id, declaredGuid));
            }
          }
          for (const [outputGuid, snapshot] of next) snapshots.set(outputGuid, snapshot);
          return ok(undefined);
        })();
        builds.set(owner.id, building);
      }
      const built = await building;
      if (!built.ok) return built;
      const staged = snapshots.get(key);
      return staged === undefined
        ? err(missingOutputError(owner.id, key))
        : ok(structuredClone(staged));
    },
  });

  return sourceFor([]);
}
