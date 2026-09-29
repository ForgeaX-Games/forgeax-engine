import * as AjvCoreModule from 'ajv/dist/core.js';
import * as AddMetaSchema2020Module from 'ajv/dist/refs/json-schema-2020-12/index.js';
import * as Draft2020Module from 'ajv/dist/vocabularies/draft2020.js';
import schemaDocument from '../schema/profile-capture.schema.json' with { type: 'json' };
import type { ProfileCapture, ProfileRecord } from './generated/profile-capture.js';
import type { ProfileResult } from './types.js';

export type ProfileArtifactError = {
  readonly code: 'profile-artifact-invalid' | 'profile-artifact-incompatible';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly path: string; readonly message: string };
};

// Ajv publishes this entry as CommonJS. Native Node ESM exposes the CJS module
// object as `default`, while Vite's browser interop exposes the constructor
// directly. Normalize that boundary once so both config-time and browser-time
// imports instantiate the same constructor.
function resolveCommonJsDefault<T>(
  moduleDefault: unknown,
  isExpected: (value: unknown) => value is T,
): T {
  if (isExpected(moduleDefault)) return moduleDefault;
  const nestedDefault = (moduleDefault as { default?: unknown } | null)?.default;
  if (isExpected(nestedDefault)) return nestedDefault;
  throw new TypeError('Ajv CommonJS export shape is unsupported');
}

const AjvCore = resolveCommonJsDefault(
  AjvCoreModule.default,
  (value): value is typeof AjvCoreModule.default => typeof value === 'function',
);
const addMetaSchema2020 = resolveCommonJsDefault(
  AddMetaSchema2020Module.default,
  (value): value is typeof AddMetaSchema2020Module.default => typeof value === 'function',
);
const draft2020 = resolveCommonJsDefault(
  Draft2020Module.default,
  (value): value is typeof Draft2020Module.default => Array.isArray(value),
);

const ajv = new AjvCore({
  allErrors: true,
  dynamicRef: true,
  meta: false,
  next: true,
  strict: true,
  unevaluated: true,
});
for (const vocabulary of draft2020) ajv.addVocabulary(vocabulary);
addMetaSchema2020.call(ajv, false);
const validator = ajv.compile(schemaDocument);

function error(
  code: ProfileArtifactError['code'],
  path: string,
  message: string,
): ProfileResult<never, ProfileArtifactError> {
  return {
    ok: false,
    error: {
      code,
      expected: 'a schema-valid ProfileCapture v1 artifact',
      hint: 'Regenerate or select a compatible ProfileCapture artifact before retrying.',
      detail: { path, message },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateSemanticRules(
  value: Record<string, unknown>,
): ProfileResult<ProfileCapture, ProfileArtifactError> {
  const catalog = value.phaseCatalog as { app: string[]; render: string[] };
  const records = value.records as ProfileRecord[];
  let previousFrameId = 0;

  for (const [index, record] of records.entries()) {
    if (record.frameId < previousFrameId) {
      return error(
        'profile-artifact-invalid',
        `/records/${index}/frameId`,
        'frameId must not decrease',
      );
    }
    previousFrameId = record.frameId;
    if (!catalog[record.source].includes(record.phase)) {
      return error(
        'profile-artifact-invalid',
        `/records/${index}/phase`,
        'phase is absent from its source catalog',
      );
    }
    if (record.kind === 'phase' && record.parentPhase !== undefined) {
      const parentCatalog = catalog[record.parentSource ?? record.source];
      if (!parentCatalog.includes(record.parentPhase)) {
        return error(
          'profile-artifact-invalid',
          `/records/${index}/parentPhase`,
          'parentPhase is absent from its source catalog',
        );
      }
      if (record.parentPhase === record.phase) {
        return error(
          'profile-artifact-invalid',
          `/records/${index}/parentPhase`,
          'parentPhase must differ from phase',
        );
      }
    } else if (record.kind === 'phase' && record.parentSource !== undefined) {
      return error(
        'profile-artifact-invalid',
        `/records/${index}/parentSource`,
        'parentSource requires parentPhase',
      );
    }
    if (record.kind === 'phase') {
      if (record.endMicros < record.startMicros) {
        return error(
          'profile-artifact-invalid',
          `/records/${index}/endMicros`,
          'endMicros must not precede startMicros',
        );
      }
      if (record.durationMicros !== record.endMicros - record.startMicros) {
        return error(
          'profile-artifact-invalid',
          `/records/${index}/durationMicros`,
          'durationMicros must equal endMicros - startMicros',
        );
      }
    }
  }

  const completeness = value.completeness as ProfileCapture['completeness'];
  if (completeness.retainedEventCount !== records.length) {
    return error(
      'profile-artifact-invalid',
      '/completeness/retainedEventCount',
      'retainedEventCount must equal records.length',
    );
  }
  if (completeness.status === 'complete') {
    if (completeness.incompleteReason !== undefined || completeness.droppedEventCount !== 0) {
      return error(
        'profile-artifact-invalid',
        '/completeness',
        'complete captures cannot contain incomplete evidence',
      );
    }
  }
  if (completeness.status === 'partial' && completeness.incompleteReason === undefined) {
    return error(
      'profile-artifact-invalid',
      '/completeness/incompleteReason',
      'partial captures require incompleteReason',
    );
  }
  if (completeness.status === 'overflow') {
    if (completeness.droppedEventCount === 0) {
      return error(
        'profile-artifact-invalid',
        '/completeness/droppedEventCount',
        'overflow captures require dropped events',
      );
    }
    if (
      completeness.firstAffectedFrameId === undefined ||
      completeness.lastAffectedFrameId === undefined
    ) {
      return error(
        'profile-artifact-invalid',
        '/completeness',
        'overflow captures require affected frame bounds',
      );
    }
  }
  return { ok: true, value: value as unknown as ProfileCapture };
}

export function validateProfileCapture(
  value: unknown,
): ProfileResult<ProfileCapture, ProfileArtifactError> {
  if (!isRecord(value)) return error('profile-artifact-invalid', '', 'artifact must be an object');
  if (value.schemaVersion !== '1.0') {
    return error(
      'profile-artifact-incompatible',
      '/schemaVersion',
      'reader supports schema version 1.0 only',
    );
  }
  if (!validator(value)) {
    const issue = validator.errors?.[0];
    return error(
      'profile-artifact-invalid',
      issue?.instancePath ?? '',
      issue?.message ?? 'schema validation failed',
    );
  }
  return validateSemanticRules(value);
}
