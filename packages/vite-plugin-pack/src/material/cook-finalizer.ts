import {
  type CookedMaterialRecord,
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  type MaterialCookArtifact,
  type MaterialCookRefs,
  serializeCookedMaterialRecord,
  serializeMaterialCookReceipt,
} from '@forgeax/engine-pack';
import { createMaterialSpecializationKey } from '@forgeax/engine-shader-compiler';
import type { MaterialAsset } from '@forgeax/engine-types';

export interface MaterialCookRequest {
  readonly guid: string;
  readonly sourceClosure: readonly string[];
  readonly profile: string;
  readonly compilerVersion: string;
  readonly material: MaterialAsset;
}

export interface MaterialCookCatalogEntry {
  readonly guid: string;
  readonly key: string;
  readonly artifactPath: string;
  readonly artifactDigest: string;
}

export interface MaterialCookResult {
  readonly cache: 'cold' | 'hit';
  readonly key: string;
  readonly record: CookedMaterialRecord;
  readonly recordBytes: Uint8Array;
  readonly artifact: MaterialCookArtifact;
  readonly artifactBytes: Uint8Array;
  readonly receiptBytes: Uint8Array;
  readonly catalog: MaterialCookCatalogEntry;
}

export interface MaterialCookFinalizerOptions {
  readonly compile: (request: MaterialCookRequest) => Promise<Uint8Array>;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function buildKey(request: MaterialCookRequest, refs: MaterialCookRefs): string {
  return `${
    createMaterialSpecializationKey({
      contractHash: JSON.stringify(request.material.parameters ?? []),
      passes: (request.material.passes ?? []).map((pass) => ({
        name: pass.name,
        module: pass.program.module,
        entries: {
          vertex: pass.program.vertexEntry ?? '',
          fragment: pass.program.fragmentEntry ?? '',
        },
        sourceClosure: Object.fromEntries(request.sourceClosure.map((path) => [path, 'declared'])),
        ...(pass.program.moduleSlots ? { moduleSlots: pass.program.moduleSlots } : {}),
        ...(pass.renderState ? { renderState: pass.renderState } : {}),
      })),
      vertexInputs: [],
      versions: { profile: request.profile, adapter: 'generic', compiler: request.compilerVersion },
    }).digest
  }:${refs.parent.join(',')}:${refs.textures.join(',')}:${refs.samplers.join(',')}`;
}

export function createMaterialCookFinalizer(options: MaterialCookFinalizerOptions) {
  const cache = new Map<string, MaterialCookResult>();

  return {
    async cook(request: MaterialCookRequest): Promise<MaterialCookResult> {
      const refs = collectMaterialCookRefs(request.material);
      const key = buildKey(request, refs);
      const previous = cache.get(key);
      if (previous !== undefined) return { ...previous, cache: 'hit' };
      const artifactBytes = await options.compile(request);
      const artifactDigest = createMaterialArtifactDigest(artifactBytes);
      const artifactPath = `materials/${request.guid}/shader.wgsl`;
      const artifact: MaterialCookArtifact = {
        mediaType: 'text/wgsl',
        path: artifactPath,
        digest: artifactDigest,
        bytes: artifactBytes,
      };
      const receipt = {
        sourceClosure: request.sourceClosure,
        profile: request.profile,
        compilerVersion: request.compilerVersion,
        inputDigest: `sha256:${key}`,
        outputDigest: artifactDigest,
      };
      const record: CookedMaterialRecord = {
        schemaVersion: 'material-cook/1',
        guid: request.guid,
        authored: request.material,
        resolved: {
          passes: request.material.passes ?? [],
          parameters: request.material.parameters ?? [],
          values: request.material.values ?? {},
        },
        refs,
        artifact,
        receipt,
      };
      const result: MaterialCookResult = {
        cache: 'cold',
        key,
        record,
        recordBytes: encode(serializeCookedMaterialRecord(record)),
        artifact,
        artifactBytes,
        receiptBytes: encode(serializeMaterialCookReceipt(receipt)),
        catalog: { guid: request.guid, key, artifactPath, artifactDigest },
      };
      cache.set(key, result);
      return result;
    },
  };
}
