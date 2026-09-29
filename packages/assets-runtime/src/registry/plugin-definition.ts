import { AssetGuid } from '@forgeax/engine-pack/guid';
import { validatePluginAsset } from '@forgeax/engine-pack/runtime';
import {
  AssetError,
  type AssetPublicationTuple,
  err,
  ok,
  type PluginAssetDefinition,
  type Result,
} from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry.js';
import { PackReader } from '../internal/pack-reader.js';
import {
  fetchAndCachePackFile,
  resolveCatalogEntry,
  validateRegistryReferences,
} from './load-by-guid.js';

export async function readPluginDefinition(
  registry: AssetRegistry,
  guid: string,
  expectedScope?: string,
  isSourceCurrent: () => boolean = () => true,
): Promise<Result<PluginAssetDefinition, unknown>> {
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) return err(parsed.error);
  const generation = registry.generations.get(guid.toLowerCase());
  const globalGeneration = registry.globalGeneration;
  const entry = await resolveCatalogEntry(registry, guid);
  if (!entry || entry.kind !== 'plugin')
    return err(
      new AssetError({
        code: 'asset-not-found',
        expected: `a plugin Catalog row for ${guid}`,
        hint: 'inspect and rebuild the plugin Pack',
      }),
    );
  const before = validateRegistryReferences(registry, guid);
  if (!before.ok) return before;
  if (!registry.packFileCache.has(entry.packageUrl)) {
    const loaded = await fetchAndCachePackFile(
      registry,
      entry.packageUrl,
      guid,
      undefined,
      isSourceCurrent,
    );
    if (!loaded.ok) return loaded;
  }
  const raw = structuredClone(registry.packFileCache.get(entry.packageUrl));
  const observed = raw as unknown as AssetPublicationTuple;
  const expected = {
    ...observed,
    ...entry.publication,
    scopeId: expectedScope ?? observed?.scopeId,
  };
  const pack = new PackReader().verify(raw, expected);
  if (!pack.ok) return pack;
  const envelope = pack.value.assets.find((asset) => asset.guid === guid);
  const definition = validatePluginAsset(envelope?.payload);
  if (!definition.ok) return definition;
  const after = validateRegistryReferences(registry, guid);
  if (!after.ok) return after;
  const current = registry.packIndexCache?.get(guid.toLowerCase());
  if (
    !isSourceCurrent() ||
    registry.globalGeneration !== globalGeneration ||
    registry.generations.get(guid.toLowerCase()) !== generation ||
    current?.packageUrl !== entry.packageUrl ||
    current?.publication?.generation !== entry.publication?.generation ||
    current?.publication?.digest !== entry.publication?.digest ||
    current?.publication?.outputSetDigest !== entry.publication?.outputSetDigest
  )
    return err(
      new AssetError({
        code: 'asset-invalidated',
        expected: 'the same plugin publication after reading its definition',
        hint: 'read the current definition before mounting',
      }),
    );
  const { scopeId, generation: publicationGeneration, digest, outputSetDigest } = pack.value;
  return ok({
    guid,
    asset: definition.value,
    evidence: {
      kind: 'publication',
      publication: { scopeId, generation: publicationGeneration, digest, outputSetDigest },
    },
  });
}
