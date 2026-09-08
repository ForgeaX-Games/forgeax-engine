import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack';

export interface MaterialLoadRequest {
  readonly guid: string;
  readonly specializationKey: string;
}

export interface MaterialReady {
  readonly status: 'Ready';
  readonly guid: string;
  readonly materialGuid: string;
  readonly publicationGeneration: number;
  readonly specializationKey: string;
  readonly artifactDigest: string;
  readonly sourceClosure: readonly string[];
  readonly parameterContract: NonNullable<CookedMaterialRecord['parameterContract']>;
  readonly record: CookedMaterialRecord;
  readonly artifact: CookedMaterialRecord['artifact'];
}

export interface MaterialPublication {
  readonly guid: string;
  readonly record: unknown;
  readonly artifactError?: {
    readonly code: 'asset-artifact-missing' | 'asset-artifact-integrity-mismatch';
    readonly expected: string;
    readonly actual?: string;
  };
  readonly artifact?: {
    readonly bytes: Uint8Array;
    readonly digest?: string;
  };
}

export type MaterialLoadErrorCode =
  | 'material-specialization-not-cooked'
  | 'asset-artifact-missing'
  | 'asset-artifact-integrity-mismatch'
  | 'material-cook-record-invalid'
  | 'material-reference-not-ready';

export interface MaterialLoadErrorDetail {
  readonly guid: string;
  readonly specializationKey: string;
  readonly publicationGeneration?: number;
  readonly field?: string;
  readonly missing?: readonly string[];
  readonly expected?: string;
  readonly actual?: string;
}

export interface MaterialLoadError {
  readonly status: 'Error';
  readonly error: {
    readonly code: MaterialLoadErrorCode;
    readonly expected: string;
    readonly hint: string;
    readonly retryable: boolean;
    readonly recoveryActions: readonly string[];
    readonly detail: MaterialLoadErrorDetail;
  };
}

export interface MaterialLoaderOptions {
  readonly loadPublication: (
    guid: string,
    specializationKey: string,
  ) => Promise<MaterialPublication | undefined>;
  readonly loadReference?: (guid: string) => Promise<boolean>;
}

function materialError(
  request: MaterialLoadRequest,
  code: MaterialLoadErrorCode,
  expected: string,
  hint: string,
  detail: Omit<MaterialLoadErrorDetail, 'guid' | 'specializationKey'> = {},
  retryable = false,
): MaterialLoadError {
  return {
    status: 'Error',
    error: {
      code,
      expected,
      hint,
      retryable,
      recoveryActions: retryable ? ['retry-material-load'] : ['recook-material-publication'],
      detail: { guid: request.guid, specializationKey: request.specializationKey, ...detail },
    },
  };
}

function missingCook(request: MaterialLoadRequest): MaterialLoadError {
  return materialError(
    request,
    'material-specialization-not-cooked',
    'a cooked material specialization record and artifact',
    'run the build-time material cooker for this specialization before loading it at runtime',
    {},
    true,
  );
}

function recordError(
  request: MaterialLoadRequest,
  field: string,
  expected = 'a complete material-cook/3 publication record',
): MaterialLoadError {
  return materialError(
    request,
    'material-cook-record-invalid',
    expected,
    're-publish the material record and its artifact as one immutable publication',
    { field },
  );
}

function immutableBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function immutableParameterContract(
  parameterContract: NonNullable<CookedMaterialRecord['parameterContract']>,
): NonNullable<CookedMaterialRecord['parameterContract']> {
  return Object.freeze({
    parameters: Object.freeze([...parameterContract.parameters]),
    values: Object.freeze({ ...parameterContract.values }),
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function completeTupleField(record: CookedMaterialRecord): string | undefined {
  if (
    typeof record.materialGuid !== 'string' ||
    !Number.isSafeInteger(record.publicationGeneration) ||
    (record.publicationGeneration as number) < 1
  )
    return 'publicationGeneration';
  if (typeof record.specializationKey !== 'string' || record.specializationKey.length === 0)
    return 'specializationKey';
  if (typeof record.artifactDigest !== 'string' || record.artifactDigest.length === 0)
    return 'artifactDigest';
  if (
    !Array.isArray(record.sourceClosure) ||
    record.sourceClosure.some((path) => typeof path !== 'string' || path.length === 0)
  )
    return 'sourceClosure';
  const parameterContract = record.parameterContract;
  if (
    parameterContract === undefined ||
    !Array.isArray(parameterContract.parameters) ||
    parameterContract.values === null ||
    typeof parameterContract.values !== 'object' ||
    Array.isArray(parameterContract.values)
  )
    return 'parameterContract';
  const receipt = record.receipt;
  if (
    !Array.isArray(receipt.sourceClosure) ||
    receipt.sourceClosure.some((path) => typeof path !== 'string' || path.length === 0) ||
    receipt.sourceClosure.length !== record.sourceClosure.length ||
    receipt.sourceClosure.some((path, index) => path !== record.sourceClosure?.[index])
  )
    return 'receipt.sourceClosure';
  if (
    typeof receipt.profile !== 'string' ||
    receipt.profile.length === 0 ||
    typeof receipt.compilerVersion !== 'string' ||
    receipt.compilerVersion.length === 0 ||
    typeof receipt.identity.cookIdentity !== 'string' ||
    receipt.identity.cookIdentity.length === 0 ||
    receipt.identity.artifactDigest !== record.artifactDigest ||
    receipt.identity.cookGeneration !== record.publicationGeneration
  )
    return 'receipt';
  if (
    typeof receipt.identity.layoutIdentity !== 'string' ||
    receipt.identity.layoutIdentity.length === 0 ||
    receipt.derivedInterface?.layoutIdentity !== receipt.identity.layoutIdentity
  )
    return 'receipt.identity.layoutIdentity';
  if (
    typeof record.artifact.mediaType !== 'string' ||
    record.artifact.mediaType.length === 0 ||
    typeof record.artifact.path !== 'string' ||
    record.artifact.path.length === 0
  )
    return 'artifact';
  return undefined;
}

export function createMaterialLoader(options: MaterialLoaderOptions) {
  return {
    async load(request: MaterialLoadRequest): Promise<MaterialReady | MaterialLoadError> {
      const publication = await options.loadPublication(request.guid, request.specializationKey);
      if (publication === undefined) return missingCook(request);
      if (publication.artifactError !== undefined) {
        return materialError(
          request,
          publication.artifactError.code,
          publication.artifactError.expected,
          'restore the published material artifact and retry the load',
          {
            expected: publication.artifactError.expected,
            ...(publication.artifactError.actual === undefined
              ? {}
              : { actual: publication.artifactError.actual }),
          },
          true,
        );
      }
      const parsed = validateCookedMaterialRecord(publication.record);
      if (!parsed.ok) return recordError(request, parsed.error.detail.field);
      const record = parsed.value;
      const invalidTupleField = completeTupleField(record);
      if (invalidTupleField !== undefined) return recordError(request, invalidTupleField);
      const publicationGeneration = record.publicationGeneration;
      const sourceClosure = record.sourceClosure;
      const parameterContract = record.parameterContract;
      const materialGuid = record.materialGuid;
      const recordSpecializationKey = record.specializationKey;
      const artifactDigest = record.artifactDigest;
      if (publicationGeneration === undefined) return recordError(request, 'publicationGeneration');
      if (sourceClosure === undefined) return recordError(request, 'sourceClosure');
      if (parameterContract === undefined) return recordError(request, 'parameterContract');
      if (materialGuid === undefined) return recordError(request, 'materialGuid');
      if (recordSpecializationKey === undefined) return recordError(request, 'specializationKey');
      if (artifactDigest === undefined) return recordError(request, 'artifactDigest');
      if (
        publication.guid.toLowerCase() !== request.guid.toLowerCase() ||
        record.guid.toLowerCase() !== request.guid.toLowerCase()
      ) {
        return recordError(
          request,
          'guid',
          `record GUID ${request.guid} to match the requested GUID`,
        );
      }
      if (materialGuid.toLowerCase() !== request.guid.toLowerCase())
        return recordError(request, 'materialGuid');
      if (recordSpecializationKey !== request.specializationKey) return missingCook(request);
      if (publication.artifact === undefined) {
        return materialError(
          request,
          'asset-artifact-missing',
          `published artifact for material ${request.guid}`,
          'publish the immutable material artifact before loading the specialization',
          { publicationGeneration },
          true,
        );
      }
      const artifactBytes = immutableBytes(publication.artifact.bytes);
      const actualDigest = createMaterialArtifactDigest(artifactBytes);
      if (
        actualDigest !== artifactDigest ||
        (publication.artifact.digest !== undefined && publication.artifact.digest !== actualDigest)
      ) {
        return materialError(
          request,
          'asset-artifact-integrity-mismatch',
          `artifact digest ${artifactDigest}`,
          'restore the published artifact bytes or re-publish the matching material record',
          {
            publicationGeneration,
            expected: artifactDigest,
            actual: actualDigest,
          },
        );
      }
      if (!sameBytes(record.artifact.bytes, artifactBytes)) {
        return recordError(
          request,
          'artifact.bytes',
          'record artifact bytes to match the published artifact bytes',
        );
      }
      const refs = [
        ...record.refs.parent,
        ...record.refs.textures,
        ...record.refs.samplers,
        ...record.refs.modules,
      ];
      const missing = options.loadReference
        ? (
            await Promise.all(
              refs.map(async (reference) =>
                (await options.loadReference?.(reference)) ? undefined : reference,
              ),
            )
          ).filter((reference): reference is string => reference !== undefined)
        : [];
      if (missing.length > 0) {
        return materialError(
          request,
          'material-reference-not-ready',
          'all cooked material references to be available',
          'load referenced parent, texture, sampler, and module assets before publishing Ready',
          { publicationGeneration, missing },
          true,
        );
      }
      return {
        status: 'Ready',
        guid: request.guid,
        materialGuid,
        publicationGeneration,
        specializationKey: request.specializationKey,
        artifactDigest,
        sourceClosure: Object.freeze([...sourceClosure]),
        parameterContract: immutableParameterContract(parameterContract),
        record,
        artifact: Object.freeze({
          ...record.artifact,
          bytes: artifactBytes,
        }),
      };
    },
  };
}
