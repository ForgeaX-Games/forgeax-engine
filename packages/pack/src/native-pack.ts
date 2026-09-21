import type { Asset, Result } from '@forgeax/engine-types';
import { PackageId } from './guid.js';
import type { AssetReader, ScriptablePackSceneComponentInput } from './scriptable-pack.js';

/** Native v2 author source, before Engine discovers its output identities. */
export interface NativePackDefinition {
  readonly schemaVersion: '2.0.0';
  readonly packageId: PackageId;
  readonly name?: string;
  readonly sceneComponents?: readonly ScriptablePackSceneComponentInput[];
  readonly build: (
    context: AssetReader & { readonly packageId: PackageId },
  ) =>
    | Result<Readonly<Record<string, Asset>>, unknown>
    | Promise<Result<Readonly<Record<string, Asset>>, unknown>>;
}

export function definePackageId(value: string | PackageId): PackageId {
  if (typeof value !== 'string') {
    if (!(value instanceof Uint8Array) || value.byteLength !== 16)
      throw new TypeError('pack-package-id-invalid: expected a 16-byte PackageId');
    return value.slice() as PackageId;
  }
  const parsed = PackageId.parse(value);
  if (!parsed.ok) throw new TypeError('pack-package-id-invalid: expected a UUID packageId');
  return parsed.value;
}

/** Keep source executable; discovery belongs to the existing isolated Engine loader. */
export function definePack(definition: NativePackDefinition): Readonly<NativePackDefinition> {
  if (definition.schemaVersion !== '2.0.0' || typeof definition.build !== 'function')
    throw new TypeError('pack-source-definition-invalid: expected a native v2 build definition');
  if ('parameters' in definition)
    throw new TypeError(
      'pack-source-parameters-unsupported: parameterized sources require the parameter-instance runtime',
    );
  return Object.freeze({ ...definition, packageId: definePackageId(definition.packageId) });
}
