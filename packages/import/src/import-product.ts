import type {
  ArtifactDescriptor,
  AssetRef,
  CookProduct,
  ImportedArtifactBody,
  ImportedAsset,
  ImportProduct,
  MaterialAsset,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export interface MaterialImportRefs {
  readonly parent: readonly string[];
  readonly textures: readonly string[];
  readonly samplers: readonly string[];
  readonly modules: readonly string[];
}

export interface MaterialSourceEvidence {
  readonly inputFingerprint: string;
  readonly importerVersion: string;
}

export interface MaterialImportProductInput {
  readonly guid: string;
  readonly sourcePath: string;
  readonly material: MaterialAsset;
  readonly refs: MaterialImportRefs;
  readonly sourceEvidence: MaterialSourceEvidence;
}

export interface MaterialImportProduct {
  readonly asset: ImportedAsset<MaterialAsset>;
  readonly sourcePath: string;
  readonly sourceEvidence: MaterialSourceEvidence;
}

export interface MaterialImportProductError {
  readonly code: 'material-import-product-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string };
}

function invalid(field: string): Result<never, MaterialImportProductError> {
  return err({
    code: 'material-import-product-invalid',
    expected: 'an authored MaterialAsset with complete dependency references',
    hint: 'declare every material dependency before the product enters the cook pipeline',
    detail: { field },
  });
}

function distinct(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function createMaterialImportProduct(
  input: MaterialImportProductInput,
): Result<MaterialImportProduct, MaterialImportProductError> {
  if (!input.guid || !input.sourcePath) return invalid('guid/sourcePath');
  if (input.material.kind !== 'material') return invalid('material.kind');
  if (!input.sourceEvidence.inputFingerprint || !input.sourceEvidence.importerVersion) {
    return invalid('sourceEvidence');
  }
  const refs = distinct([
    ...input.refs.parent,
    ...input.refs.textures,
    ...input.refs.samplers,
    ...input.refs.modules,
  ]);
  return ok({
    sourcePath: input.sourcePath,
    sourceEvidence: input.sourceEvidence,
    asset: {
      guid: input.guid,
      kind: 'material',
      payload: input.material,
      refs: refs.map((guid): AssetRef => ({ guid })),
      artifacts: {},
    },
  });
}

export function materialImportProductReady(
  product: MaterialImportProduct,
  availableRefs: ReadonlySet<string>,
): boolean {
  return product.asset.refs.every((reference) => availableRefs.has(reference.guid));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('Web Crypto API is required for importer digests');
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await subtle.digest('SHA-256', owned.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function artifactDigest(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`;
}

function concatBytes(chunks: readonly (Uint8Array | string)[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) =>
    typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
  );
  const totalLength = encoded.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of encoded) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function productDigest(
  asset: ImportedAsset<unknown>,
  artifacts: Readonly<Record<string, ArtifactDescriptor>>,
): Promise<string> {
  const chunks: (Uint8Array | string)[] = [
    JSON.stringify(digestPayload(asset)),
    JSON.stringify(asset.refs.map((ref) => ref.guid)),
    JSON.stringify(artifacts),
  ];
  for (const [key, artifact] of Object.entries(asset.artifacts).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    chunks.push(key, artifact.bytes);
  }
  return `sha256:${await sha256Hex(concatBytes(chunks))}`;
}

async function artifactDescriptors(
  artifacts: Readonly<Record<string, ImportedArtifactBody>>,
): Promise<Readonly<Record<string, ArtifactDescriptor>>> {
  const entries: [string, ArtifactDescriptor][] = [];
  for (const [path, artifact] of Object.entries(artifacts)) {
    entries.push([
      path,
      {
        path,
        mediaType: artifact.mediaType,
        byteLength: artifact.bytes.byteLength,
        integrity: { algorithm: 'sha256' as const, digest: await artifactDigest(artifact.bytes) },
        ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
      },
    ]);
  }
  return Object.fromEntries(entries);
}

function digestPayload(asset: ImportedAsset<unknown>): unknown {
  if (Object.keys(asset.artifacts).length === 0) return asset.payload;
  if (asset.kind === 'mesh') return { kind: 'mesh' };
  if (asset.kind === 'texture' || asset.kind === 'equirect') {
    const payload = asset.payload as Record<string, unknown>;
    const { data: _runtimeBytes, ...metadata } = payload;
    return metadata;
  }
  return asset.payload;
}

/** Convert each importer asset into the shared completed producer product. */
export function finalizeImportProducts(
  product: ImportProduct<unknown>,
  inputFingerprint: string,
): Promise<readonly CookProduct[]> {
  return (async () => {
    const products: CookProduct[] = [];
    for (const asset of product.assets) {
      const artifacts = await artifactDescriptors(asset.artifacts);
      const digest = await productDigest(asset, artifacts);
      products.push({
        guid: asset.guid,
        payload: asset.payload,
        refs: asset.refs.map((ref) => ref.guid),
        artifacts,
        digest,
        receipt: {
          guid: asset.guid,
          origin: 'sourceMeta' as const,
          status: 'succeeded' as const,
          inputFingerprint,
          outputDigest: digest,
        },
      });
    }
    return products;
  })();
}
