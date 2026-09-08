import { createHash } from 'node:crypto';
import type {
  AssetPublicationEnvelope,
  AssetPublicationExternalEvidence,
  AssetPublicationOutput,
} from '@forgeax/engine-types';

export interface RuntimePackAssetInput {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: unknown;
  readonly refs?: readonly string[];
  readonly artifacts?: Readonly<Record<string, unknown>>;
}

export interface RuntimePackInput {
  readonly assets: readonly RuntimePackAssetInput[];
}

export interface RuntimePackEnvelope {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'internal-text-package';
  readonly scopeId: string;
  readonly generation: number;
  readonly digest: string;
  readonly outputSetDigest: string;
  readonly assets: readonly RuntimePackAsset[];
}

export interface RuntimePackPublication {
  readonly pack: RuntimePackEnvelope;
  readonly publication: AssetPublicationEnvelope;
}

interface RuntimePackAsset extends RuntimePackAssetInput {
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, unknown>>;
}

export interface RuntimePackPublicationInput {
  readonly pack: RuntimePackInput;
  readonly scopeId: string;
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly packageUrl: string;
  readonly inputFingerprint?: string;
  readonly digest?: string;
  readonly generation?: number;
  readonly outputs?: readonly AssetPublicationOutput[];
  readonly externalEvidence?: readonly AssetPublicationExternalEvidence[];
}

function stable(value: unknown): string {
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString('base64')}`;
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

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
}

function normalizedAssets(pack: RuntimePackInput): readonly RuntimePackAsset[] {
  return pack.assets.map((asset) => {
    const payload = asset.payload;
    const canonicalPayload =
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      !(payload instanceof Uint8Array) &&
      typeof (payload as Record<string, unknown>).kind !== 'string'
        ? { ...(payload as Record<string, unknown>), kind: asset.kind }
        : payload;
    return {
      ...asset,
      payload: canonicalPayload,
      refs: [...(asset.refs ?? [])].map((ref) => ref.toLowerCase()),
      artifacts: asset.artifacts ?? {},
    };
  });
}

function outputFor(asset: RuntimePackAsset): AssetPublicationOutput {
  return {
    guid: asset.guid.toLowerCase(),
    sourceKey: asset.guid.toLowerCase(),
    kind: asset.kind,
    digest: digest({
      guid: asset.guid.toLowerCase(),
      kind: asset.kind,
      name: asset.name,
      payload: asset.payload,
      refs: asset.refs,
      artifacts: asset.artifacts,
    }),
    refs: asset.refs,
  };
}

function outputSetDigest(outputs: readonly AssetPublicationOutput[]): string {
  return digest(
    outputs.map((output) => ({
      guid: output.guid.toLowerCase(),
      sourceKey: output.sourceKey,
      kind: output.kind,
      digest: output.digest,
      refs: [...output.refs].map((guid) => guid.toLowerCase()),
    })),
  );
}

function publicationGeneration(
  sourceRevision: string,
  valueDigest: string,
  outputs: string,
): number {
  const value = createHash('sha256')
    .update(sourceRevision)
    .update('\n')
    .update(valueDigest)
    .update('\n')
    .update(outputs)
    .digest('hex');
  const generation = Number.parseInt(value.slice(0, 8), 16);
  return generation > 0 ? generation : 1;
}

export function createRuntimePackPublication(
  input: RuntimePackPublicationInput,
): RuntimePackPublication {
  const assets = normalizedAssets(input.pack);
  const semantic = {
    schemaVersion: '2.0.0' as const,
    kind: 'internal-text-package' as const,
    assets: [...assets].sort((left, right) =>
      left.guid.toLowerCase().localeCompare(right.guid.toLowerCase()),
    ),
  };
  const valueDigest = input.digest ?? digest(semantic);
  const outputs = input.outputs ?? assets.map(outputFor);
  const outputDigest = outputSetDigest(outputs);
  const generation =
    input.generation ?? publicationGeneration(input.sourceRevision, valueDigest, outputDigest);
  const externalEvidence = input.externalEvidence ?? [];
  const inputFingerprint = input.inputFingerprint ?? input.sourceRevision;
  const publication: AssetPublicationEnvelope = {
    schemaVersion: 'asset-publication/1',
    sourcePath: input.sourcePath,
    sourceRevision: input.sourceRevision,
    generation,
    digest: valueDigest,
    outputSetDigest: outputDigest,
    outputs,
    receipt: {
      schemaVersion: 'asset-publication-receipt/1',
      sourcePath: input.sourcePath,
      sourceRevision: input.sourceRevision,
      inputFingerprint,
      outputDigest: valueDigest,
      outputSetDigest: outputDigest,
      externalEvidence,
    },
    externalEvidence,
    current: {
      generation,
      digest: valueDigest,
      outputSetDigest: outputDigest,
      packageUrl: input.packageUrl,
      receiptKey: inputFingerprint,
    },
  };
  return {
    pack: {
      ...semantic,
      scopeId: input.scopeId,
      generation,
      digest: valueDigest,
      outputSetDigest: outputDigest,
    },
    publication,
  };
}
