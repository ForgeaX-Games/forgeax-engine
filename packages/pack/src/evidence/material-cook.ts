import type {
  MaterialAsset,
  MaterialParameter,
  MaterialPass,
  MaterialTextureReference,
  MaterialTextureValue,
  MaterialValue,
  Result,
} from '@forgeax/engine-types';
import { err, MATERIAL_TEXTURE_SLOTS, ok } from '@forgeax/engine-types';
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

export interface MaterialCookWasmProvenance {
  readonly sourceContentKey: string;
  readonly artifactSha256: string;
  readonly glueSha256: string;
}

export interface MaterialCookIdentity {
  readonly materialContractDigest: string;
  readonly sourceRevision: string;
  readonly sourceClosureDigest: string;
  readonly layoutIdentity: string;
  readonly programIdentity: string;
  readonly pipelineIdentity: string;
  readonly materialPublicationIdentity: string;
  readonly cookIdentity: string;
  readonly compilerFingerprint: string;
  readonly wasm: MaterialCookWasmProvenance;
  readonly artifactDigest: string;
  readonly valueGeneration: number;
  readonly dependencyGeneration: number;
  readonly cookGeneration: number;
}

export type MaterialCookIdentityInput = Omit<MaterialCookIdentity, 'cookIdentity'>;

export interface MaterialCookReceipt {
  readonly schemaVersion: 'material-cook/3';
  readonly sourceClosure: readonly string[];
  readonly profile: string;
  readonly compilerVersion: string;
  readonly identity: MaterialCookIdentity;
  readonly derivedInterface: { readonly layoutIdentity: string };
}

export interface MaterialParameterContract {
  readonly parameters: readonly MaterialParameter[];
  readonly values: Readonly<Record<string, MaterialValue | null>>;
}

export interface CookedMaterialRecord {
  readonly schemaVersion: 'material-cook/3';
  readonly guid: string;
  readonly authored?: MaterialAsset;
  readonly materialGuid?: string;
  readonly publicationGeneration?: number;
  readonly specializationKey?: string;
  readonly artifactDigest?: string;
  readonly sourceClosure?: readonly string[];
  readonly parameterContract?: MaterialParameterContract;
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
  readonly detail: {
    readonly field: string;
    readonly actual?: unknown;
    readonly action: string;
  };
}

export interface MaterialCookIdentityExpectation {
  readonly layoutIdentity?: string;
  readonly artifactDigest?: string;
  readonly inputDigest?: string;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function guidText(value: string | Uint8Array): string {
  return typeof value === 'string'
    ? value
    : Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cookGuidText(value: MaterialTextureReference): string | undefined {
  return typeof value === 'number' ? undefined : guidText(value);
}

function textureValues(
  values: Readonly<Record<string, MaterialValue | null>> | undefined,
  textureFields: ReadonlySet<string>,
): readonly MaterialTextureValue[] {
  return Object.entries(values ?? {}).flatMap(([name, value]) => {
    if (value === null) return [];
    if (typeof value === 'string') {
      return textureFields.has(name) ? [{ texture: value }] : [];
    }
    return value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'texture' in value
      ? [value as MaterialTextureValue]
      : [];
  });
}

export function collectMaterialCookRefs(material: Partial<MaterialAsset>): MaterialCookRefs {
  const textureFields =
    material.parameters === undefined
      ? new Set<string>(MATERIAL_TEXTURE_SLOTS)
      : new Set(
          material.parameters
            .filter((parameter) => parameter.type === 'texture')
            .map((parameter) => parameter.name),
        );
  const textures = textureValues(material.values, textureFields);
  return {
    parent: material.parent ? [guidText(material.parent)] : [],
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

export function createMaterialCookIdentity(input: MaterialCookIdentityInput): MaterialCookIdentity {
  const cookIdentity = createMaterialArtifactDigest(
    new TextEncoder().encode(
      JSON.stringify(
        jsonValue({
          materialContractDigest: input.materialContractDigest,
          sourceRevision: input.sourceRevision,
          sourceClosureDigest: input.sourceClosureDigest,
          layoutIdentity: input.layoutIdentity,
          programIdentity: input.programIdentity,
          pipelineIdentity: input.pipelineIdentity,
          compilerFingerprint: input.compilerFingerprint,
          wasm: input.wasm,
          artifactDigest: input.artifactDigest,
        }),
      ),
    ),
  );
  return { ...input, cookIdentity };
}

export function serializeCookedMaterialRecord(record: CookedMaterialRecord): string {
  return JSON.stringify(jsonValue(record));
}

export function serializeMaterialCookReceipt(receipt: MaterialCookReceipt): string {
  return JSON.stringify(jsonValue({ ...receipt, sourceClosure: unique(receipt.sourceClosure) }));
}

function invalid(field: string, actual?: unknown): Result<never, MaterialCookRecordError> {
  return err({
    code: 'material-cook-record-invalid',
    expected: 'a complete material-cook/3 record with layered identity and provenance',
    hint: 're-cook the material and publish its record, artifact, references, and receipt together',
    detail: {
      field,
      ...(actual === undefined ? {} : { actual }),
      action: 'inspect the named field and recook the material generation',
    },
  });
}

const IDENTITY_FIELDS = [
  'materialContractDigest',
  'sourceRevision',
  'sourceClosureDigest',
  'layoutIdentity',
  'programIdentity',
  'pipelineIdentity',
  'materialPublicationIdentity',
  'cookIdentity',
  'compilerFingerprint',
  'artifactDigest',
] as const;

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function validateIdentity(value: unknown): Result<MaterialCookIdentity, MaterialCookRecordError> {
  if (value === null || typeof value !== 'object') return invalid('receipt.identity', value);
  const candidate = value as Record<string, unknown>;
  for (const field of IDENTITY_FIELDS) {
    if (typeof candidate[field] !== 'string' || candidate[field].length === 0) {
      return invalid(`receipt.identity.${field}`, candidate[field]);
    }
  }
  if (candidate.wasm === null || typeof candidate.wasm !== 'object') {
    return invalid('receipt.identity.wasm', candidate.wasm);
  }
  const wasm = candidate.wasm as Record<string, unknown>;
  for (const field of ['sourceContentKey', 'artifactSha256', 'glueSha256']) {
    if (typeof wasm[field] !== 'string' || wasm[field].length === 0) {
      return invalid(`receipt.identity.wasm.${field}`, wasm[field]);
    }
  }
  for (const field of ['valueGeneration', 'dependencyGeneration', 'cookGeneration']) {
    if (!isGeneration(candidate[field]))
      return invalid(`receipt.identity.${field}`, candidate[field]);
  }
  return ok({
    ...candidate,
    wasm: wasm as unknown as MaterialCookWasmProvenance,
  } as MaterialCookIdentity);
}

export function validateMaterialCookReceipt(
  value: unknown,
  expected: MaterialCookIdentityExpectation = {},
): Result<MaterialCookReceipt, MaterialCookRecordError> {
  if (value === null || typeof value !== 'object') return invalid('receipt');
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 'material-cook/3')
    return invalid('receipt.schemaVersion', candidate.schemaVersion);
  const identityResult = validateIdentity(candidate.identity);
  if (!identityResult.ok) return identityResult;
  const identity = identityResult.value;
  if (candidate.derivedInterface === null || typeof candidate.derivedInterface !== 'object') {
    return invalid('receipt.derivedInterface', candidate.derivedInterface);
  }
  const derivedInterface = candidate.derivedInterface as Record<string, unknown>;
  if (derivedInterface.layoutIdentity !== identity.layoutIdentity) {
    return invalid('receipt.derivedInterface.layoutIdentity', derivedInterface.layoutIdentity);
  }
  for (const field of ['sourceClosure', 'profile', 'compilerVersion']) {
    const fieldValue = candidate[field];
    if (
      (field === 'sourceClosure' && !Array.isArray(fieldValue)) ||
      (field !== 'sourceClosure' && typeof fieldValue !== 'string')
    ) {
      return invalid(`receipt.${field}`, fieldValue);
    }
  }
  const sourceClosure = candidate.sourceClosure;
  if (Array.isArray(sourceClosure) && sourceClosure.some((path) => typeof path !== 'string')) {
    return invalid('receipt.sourceClosure', sourceClosure);
  }
  if (
    expected.layoutIdentity !== undefined &&
    identity.layoutIdentity !== expected.layoutIdentity
  ) {
    return invalid('receipt.identity.layoutIdentity', identity.layoutIdentity);
  }
  if (
    expected.artifactDigest !== undefined &&
    identity.artifactDigest !== expected.artifactDigest
  ) {
    return invalid('receipt.identity.artifactDigest', identity.artifactDigest);
  }
  if (expected.inputDigest !== undefined && identity.cookIdentity !== expected.inputDigest) {
    return invalid('receipt.identity.cookIdentity', identity.cookIdentity);
  }
  return ok({
    schemaVersion: 'material-cook/3',
    sourceClosure: candidate.sourceClosure as string[],
    profile: candidate.profile as string,
    compilerVersion: candidate.compilerVersion as string,
    identity,
    derivedInterface: { layoutIdentity: derivedInterface.layoutIdentity as string },
  });
}

export function validateCookedMaterialRecord(
  value: unknown,
): Result<CookedMaterialRecord, MaterialCookRecordError> {
  if (value === null || typeof value !== 'object') return invalid('record');
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 'material-cook/3')
    return invalid('schemaVersion', candidate.schemaVersion);
  if (typeof candidate.guid !== 'string' || !candidate.guid) return invalid('guid');
  if (candidate.materialGuid !== undefined && typeof candidate.materialGuid !== 'string')
    return invalid('materialGuid');
  if (
    candidate.publicationGeneration !== undefined &&
    !isGeneration(candidate.publicationGeneration)
  )
    return invalid('publicationGeneration', candidate.publicationGeneration);
  if (candidate.specializationKey !== undefined && typeof candidate.specializationKey !== 'string')
    return invalid('specializationKey');
  if (candidate.artifactDigest !== undefined && typeof candidate.artifactDigest !== 'string')
    return invalid('artifactDigest');
  if (
    candidate.sourceClosure !== undefined &&
    (!Array.isArray(candidate.sourceClosure) ||
      candidate.sourceClosure.some((path) => typeof path !== 'string'))
  )
    return invalid('sourceClosure');
  if (candidate.parameterContract !== undefined) {
    if (candidate.parameterContract === null || typeof candidate.parameterContract !== 'object')
      return invalid('parameterContract');
    const parameterContract = candidate.parameterContract as Record<string, unknown>;
    if (!Array.isArray(parameterContract.parameters))
      return invalid('parameterContract.parameters');
    if (
      parameterContract.values === null ||
      typeof parameterContract.values !== 'object' ||
      Array.isArray(parameterContract.values)
    )
      return invalid('parameterContract.values');
  }
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
  const receiptResult = validateMaterialCookReceipt(candidate.receipt, {
    artifactDigest: artifact.digest as string,
  });
  if (!receiptResult.ok) return receiptResult;
  if (candidate.artifactDigest !== undefined && candidate.artifactDigest !== artifact.digest)
    return invalid('artifactDigest', candidate.artifactDigest);
  if (
    candidate.publicationGeneration !== undefined &&
    receiptResult.value.identity.cookGeneration !== candidate.publicationGeneration
  )
    return invalid('receipt.identity.cookGeneration', receiptResult.value.identity.cookGeneration);
  const normalized = {
    ...candidate,
    artifact: {
      ...artifact,
      bytes: ArrayBuffer.isView(artifact.bytes)
        ? Uint8Array.from(artifact.bytes as Uint8Array)
        : Uint8Array.from(artifact.bytes as number[]),
    },
    receipt: receiptResult.value,
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
