import {
  createMaterialCookIdentity,
  createMaterialArtifactDigest as createPackArtifactDigest,
  type MaterialCookWasmProvenance,
  type CookedMaterialRecord as PackCookedMaterialRecord,
  type MaterialCookReceipt as PackMaterialCookReceipt,
  serializeCookedMaterialRecord as serializePackCookedMaterialRecord,
  serializeMaterialCookReceipt as serializePackMaterialCookReceipt,
} from '@forgeax/engine-pack';
import type {
  AssetGuid,
  CookProduct,
  MaterialAsset,
  MaterialTextureReference,
  MaterialTextureValue,
  MaterialValue,
} from '@forgeax/engine-types';
import { createMaterialSpecializationKey } from './specialization-key.js';

export interface MaterialCookRequest {
  readonly guid: string;
  readonly sourceClosure: readonly string[];
  readonly profile: string;
  readonly compilerVersion: string;
  readonly material: MaterialAsset;
  readonly moduleSources?: Readonly<Record<string, string>>;
  readonly sourceRevision?: string;
  readonly sourceClosureDigest?: string;
  readonly compilerFingerprint?: string;
  readonly wasm?: MaterialCookWasmProvenance;
  readonly valueGeneration?: number;
  readonly dependencyGeneration?: number;
}

export interface MaterialCookArtifact {
  readonly mediaType: string;
  readonly path: string;
  readonly digest: string;
  readonly bytes: Uint8Array;
}

export interface MaterialCookRefs {
  readonly parent: readonly string[];
  readonly textures: readonly string[];
  readonly samplers: readonly string[];
  readonly modules: readonly string[];
}

export type MaterialCookReceipt = PackMaterialCookReceipt;
export type CookedMaterialRecord = PackCookedMaterialRecord;

export interface MaterialCookCatalogEntry {
  readonly guid: string;
  readonly key: string;
  readonly artifactPath: string;
  readonly artifactDigest: string;
}

export interface MaterialCookPublication {
  readonly cache: 'cold' | 'hit';
  readonly key: string;
  readonly record: CookedMaterialRecord;
  readonly recordBytes: Uint8Array;
  readonly artifact: MaterialCookArtifact;
  readonly artifactBytes: Uint8Array;
  readonly receiptBytes: Uint8Array;
  readonly catalog: MaterialCookCatalogEntry;
}

export interface MaterialNativeCookerOptions {
  readonly compile: (request: MaterialCookRequest) => Promise<Uint8Array>;
}

const publications = new WeakMap<object, MaterialCookPublication>();

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function guidText(value: AssetGuid | string): string {
  return typeof value === 'string'
    ? value
    : Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cookGuidText(value: MaterialTextureReference): string | undefined {
  return typeof value === 'number' ? undefined : guidText(value);
}

function textureValues(
  values: Readonly<Record<string, MaterialValue | null>> | undefined,
): readonly MaterialTextureValue[] {
  return Object.values(values ?? {}).filter(
    (value): value is MaterialTextureValue =>
      value !== null && typeof value === 'object' && 'texture' in value,
  );
}

export function collectMaterialCookRefs(material: Partial<MaterialAsset>): MaterialCookRefs {
  const textures = textureValues(material.values);
  return {
    parent: material.parent === undefined ? [] : [guidText(material.parent)],
    textures: unique(
      textures.flatMap((value) => {
        const guid = cookGuidText(value.texture);
        return guid === undefined ? [] : [guid];
      }),
    ),
    samplers: unique(
      textures.flatMap((value) => {
        if (value.sampler === undefined) return [];
        const guid = cookGuidText(value.sampler);
        return guid === undefined ? [] : [guid];
      }),
    ),
    modules: unique((material.passes ?? []).map((pass) => pass.program.module)),
  };
}

export function createMaterialArtifactDigest(bytes: Uint8Array): string {
  return createPackArtifactDigest(bytes);
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  }
  return value;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function digestText(value: unknown): string {
  return createMaterialArtifactDigest(encode(JSON.stringify(jsonValue(value))));
}

function sourceClosureDigest(request: MaterialCookRequest, refs: MaterialCookRefs): string {
  if (request.sourceClosureDigest !== undefined) return request.sourceClosureDigest;
  return digestText({
    modules: refs.modules.map((moduleId) => ({
      moduleId,
      source: request.moduleSources?.[moduleId] ?? null,
    })),
  });
}

function buildKey(request: MaterialCookRequest, sourceDigest: string): string {
  const specialization = createMaterialSpecializationKey({
    contractHash: JSON.stringify(request.material.parameters ?? []),
    passes: (request.material.passes ?? []).map((pass) => ({
      name: pass.name,
      module: pass.program.module,
      entries: {
        vertex: pass.program.vertexEntry ?? '',
        fragment: pass.program.fragmentEntry ?? '',
      },
      sourceClosure: { digest: sourceDigest },
      ...(pass.program.moduleSlots ? { moduleSlots: pass.program.moduleSlots } : {}),
    })),
    vertexInputs: [],
    versions: {
      profile: request.profile,
      adapter: 'generic',
      compiler: request.compilerVersion,
    },
  });
  return specialization.digest;
}

/** Return the owner publication associated with a material product. */
export function materialCookPublication(
  product: CookProduct<MaterialAsset>,
): MaterialCookPublication | undefined {
  return publications.get(product);
}

/** Build-time material cooker and finalizer owned by shader-compiler. */
export function createMaterialNativeCooker(options: MaterialNativeCookerOptions) {
  const cache = new Map<string, CookProduct<MaterialAsset>>();

  return {
    async cook(request: MaterialCookRequest): Promise<CookProduct<MaterialAsset>> {
      const refs = collectMaterialCookRefs(request.material);
      const closureDigest = sourceClosureDigest(request, refs);
      const key = buildKey(request, closureDigest);
      const previous = cache.get(key);
      const previousPublication = previous === undefined ? undefined : publications.get(previous);
      const artifactBytes = previousPublication?.artifactBytes ?? (await options.compile(request));
      const artifactDigest = createMaterialArtifactDigest(artifactBytes);
      const artifactPath = `materials/${request.guid}/shader.wgsl`;
      const artifact: MaterialCookArtifact = {
        mediaType: 'text/wgsl',
        path: artifactPath,
        digest: artifactDigest,
        bytes: artifactBytes,
      };
      const layoutIdentity =
        request.material.parameters === undefined
          ? 'sha256:material-layout-unknown'
          : digestText(request.material.parameters);
      const materialContractDigest = digestText({ parameters: request.material.parameters ?? [] });
      const sourceRevision = request.sourceRevision ?? closureDigest;
      const compilerFingerprint =
        request.compilerFingerprint ?? digestText(request.compilerVersion);
      const wasm = request.wasm ?? {
        sourceContentKey: 'unavailable',
        artifactSha256: 'unavailable',
        glueSha256: 'unavailable',
      };
      const programIdentity = digestText({ key, closureDigest, layoutIdentity });
      const pipelineIdentity = digestText({
        programIdentity,
        renderState: (request.material.passes ?? []).map((pass) => pass.renderState ?? null),
      });
      const valueGeneration = request.valueGeneration ?? 1;
      const dependencyGeneration = request.dependencyGeneration ?? 1;
      const materialPublicationIdentity = digestText({
        guid: request.guid,
        values: request.material.values ?? {},
        refs,
        valueGeneration,
        dependencyGeneration,
      });
      const identity = createMaterialCookIdentity({
        materialContractDigest,
        sourceRevision,
        sourceClosureDigest: closureDigest,
        layoutIdentity,
        programIdentity,
        pipelineIdentity,
        materialPublicationIdentity,
        compilerFingerprint,
        wasm,
        artifactDigest,
        valueGeneration,
        dependencyGeneration,
        cookGeneration: (previousPublication?.record.receipt.identity.cookGeneration ?? 0) + 1,
      });
      const receipt: MaterialCookReceipt = {
        schemaVersion: 'material-cook/3',
        sourceClosure: request.sourceClosure,
        profile: request.profile,
        compilerVersion: request.compilerVersion,
        identity,
        derivedInterface: { layoutIdentity },
      };
      const record: CookedMaterialRecord = {
        schemaVersion: 'material-cook/3',
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
      const refsList = [...refs.parent, ...refs.textures, ...refs.samplers, ...refs.modules];
      const artifactDescriptor = {
        path: artifactPath,
        mediaType: artifact.mediaType,
        byteLength: artifactBytes.byteLength,
        integrity: { algorithm: 'sha256' as const, digest: artifactDigest },
      };
      const productReceipt = {
        guid: request.guid,
        origin: 'authoredPack' as const,
        status: 'succeeded' as const,
        inputFingerprint: identity.cookIdentity,
        outputDigest: artifactDigest,
      };
      const result: CookProduct<MaterialAsset> = {
        guid: request.guid,
        payload: request.material,
        refs: refsList,
        artifacts: { [artifactPath]: artifactDescriptor },
        digest: artifactDigest,
        receipt: productReceipt,
      };
      if (
        previous !== undefined &&
        previousPublication !== undefined &&
        previousPublication.record.receipt.identity.materialPublicationIdentity ===
          identity.materialPublicationIdentity &&
        previousPublication.record.receipt.identity.pipelineIdentity ===
          identity.pipelineIdentity &&
        unique(previousPublication.record.receipt.sourceClosure).join('\n') ===
          unique(receipt.sourceClosure).join('\n')
      ) {
        publications.set(previous, { ...previousPublication, cache: 'hit' });
        return previous;
      }
      publications.set(result, {
        cache: previousPublication === undefined ? 'cold' : 'hit',
        key,
        record,
        recordBytes: encode(serializePackCookedMaterialRecord(record)),
        artifact,
        artifactBytes,
        receiptBytes: encode(serializePackMaterialCookReceipt(receipt)),
        catalog: { guid: request.guid, key, artifactPath, artifactDigest },
      });
      cache.set(key, result);
      return result;
    },
  };
}
