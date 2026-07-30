import { type CookedMaterialRecord, validateCookedMaterialRecord } from '@forgeax/engine-pack';

export interface MaterialLoadRequest {
  readonly guid: string;
  readonly specializationKey: string;
}

export interface MaterialReady {
  readonly status: 'Ready';
  readonly guid: string;
  readonly specializationKey: string;
  readonly record: CookedMaterialRecord;
  readonly artifact: CookedMaterialRecord['artifact'];
}

export interface MaterialLoadError {
  readonly status: 'Error';
  readonly error: {
    readonly code:
      | 'material-specialization-not-cooked'
      | 'material-cook-record-invalid'
      | 'material-reference-not-ready';
    readonly expected: string;
    readonly hint: string;
    readonly detail: {
      readonly guid: string;
      readonly specializationKey: string;
      readonly missing?: readonly string[];
    };
  };
}

export interface MaterialLoaderOptions {
  readonly loadRecord: (guid: string, specializationKey: string) => Promise<unknown>;
  readonly loadReference?: (guid: string) => Promise<boolean>;
}

function missingCook(request: MaterialLoadRequest): MaterialLoadError {
  return {
    status: 'Error',
    error: {
      code: 'material-specialization-not-cooked',
      expected: 'a cooked material specialization record and artifact',
      hint: 'run the build-time material cooker for this specialization before loading it at runtime',
      detail: { guid: request.guid, specializationKey: request.specializationKey },
    },
  };
}

export function createMaterialLoader(options: MaterialLoaderOptions) {
  return {
    async load(request: MaterialLoadRequest): Promise<MaterialReady | MaterialLoadError> {
      const raw = await options.loadRecord(request.guid, request.specializationKey);
      if (raw === undefined) return missingCook(request);
      const parsed = validateCookedMaterialRecord(raw);
      if (!parsed.ok) {
        return {
          status: 'Error',
          error: {
            ...parsed.error,
            detail: {
              ...parsed.error.detail,
              guid: request.guid,
              specializationKey: request.specializationKey,
            },
          },
        };
      }
      const refs = [
        ...parsed.value.refs.parent,
        ...parsed.value.refs.textures,
        ...parsed.value.refs.samplers,
        ...parsed.value.refs.modules,
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
        return {
          status: 'Error',
          error: {
            code: 'material-reference-not-ready',
            expected: 'all cooked material references to be available',
            hint: 'load referenced parent, texture, sampler, and module assets before publishing Ready',
            detail: { guid: request.guid, specializationKey: request.specializationKey, missing },
          },
        };
      }
      return {
        status: 'Ready',
        guid: request.guid,
        specializationKey: request.specializationKey,
        record: parsed.value,
        artifact: parsed.value.artifact,
      };
    },
  };
}
