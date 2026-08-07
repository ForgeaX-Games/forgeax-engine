import type {
  MaterialAsset,
  MaterialParameter,
  MaterialPass,
  MaterialTextureValue,
  MaterialValue,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface MaterialCookRefs {
  readonly parent: readonly string[];
  readonly textures: readonly string[];
  readonly samplers: readonly string[];
  readonly modules: readonly string[];
}

export interface MaterialCookArtifact {
  readonly mediaType: string;
  readonly path: string;
  readonly digest: string;
  readonly bytes: Uint8Array;
}

export interface MaterialCookReceipt {
  readonly sourceClosure: readonly string[];
  readonly profile: string;
  readonly compilerVersion: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
}

export interface CookedMaterialRecord {
  readonly schemaVersion: 'material-cook/1';
  readonly guid: string;
  readonly authored?: MaterialAsset;
  readonly resolved: {
    readonly passes: readonly MaterialPass[];
    readonly parameters: readonly MaterialParameter[];
    readonly values: Readonly<Record<string, MaterialValue | null>>;
  };
  readonly refs: MaterialCookRefs;
  readonly artifact: MaterialCookArtifact;
  readonly receipt: MaterialCookReceipt;
}

export interface MaterialCookRecordError {
  readonly code: 'material-cook-record-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function guidText(value: string | Uint8Array): string {
  return typeof value === 'string'
    ? value
    : Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
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
    parent: material.parent ? [guidText(material.parent)] : [],
    textures: unique(textures.map((value) => guidText(value.texture))),
    samplers: unique(textures.flatMap((value) => (value.sampler ? [guidText(value.sampler)] : []))),
    modules: unique((material.passes ?? []).map((pass) => pass.program.module)),
  };
}

export function createMaterialArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  }
  return value;
}

export function serializeCookedMaterialRecord(record: CookedMaterialRecord): string {
  return JSON.stringify(jsonValue(record));
}

export function serializeMaterialCookReceipt(receipt: MaterialCookReceipt): string {
  return JSON.stringify(jsonValue({ ...receipt, sourceClosure: unique(receipt.sourceClosure) }));
}

function invalid(field: string): Result<never, MaterialCookRecordError> {
  return err({
    code: 'material-cook-record-invalid',
    expected: 'a complete material-cook/1 record',
    hint: 're-cook the material and publish its record, artifact, references, and receipt together',
    detail: { field },
  });
}

export function validateCookedMaterialRecord(
  value: unknown,
): Result<CookedMaterialRecord, MaterialCookRecordError> {
  if (value === null || typeof value !== 'object') return invalid('record');
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 'material-cook/1') return invalid('schemaVersion');
  if (typeof candidate.guid !== 'string' || !candidate.guid) return invalid('guid');
  if (candidate.resolved === null || typeof candidate.resolved !== 'object')
    return invalid('resolved');
  if (candidate.refs === null || typeof candidate.refs !== 'object') return invalid('refs');
  if (candidate.artifact === null || typeof candidate.artifact !== 'object')
    return invalid('artifact');
  if (candidate.receipt === null || typeof candidate.receipt !== 'object')
    return invalid('receipt');
  const artifact = candidate.artifact as Record<string, unknown>;
  if (
    typeof artifact.digest !== 'string' ||
    (!Array.isArray(artifact.bytes) && !ArrayBuffer.isView(artifact.bytes))
  ) {
    return invalid('artifact');
  }
  const normalized = {
    ...candidate,
    artifact: {
      ...artifact,
      bytes: ArrayBuffer.isView(artifact.bytes)
        ? Uint8Array.from(artifact.bytes as Uint8Array)
        : Uint8Array.from(artifact.bytes as number[]),
    },
  } as CookedMaterialRecord;
  return ok(normalized);
}

export function projectCookedMaterialRecord(
  record: CookedMaterialRecord,
): Omit<CookedMaterialRecord, 'guid' | 'authored'> {
  return {
    resolved: record.resolved,
    refs: record.refs,
    artifact: record.artifact,
    receipt: record.receipt,
    schemaVersion: record.schemaVersion,
  };
}
