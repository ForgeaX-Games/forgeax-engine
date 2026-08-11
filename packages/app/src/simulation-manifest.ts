import {
  SIMULATION_COMPARISON_DOMAINS,
  SIMULATION_ERROR_CODES,
  type SimulationComparisonEntry,
  type SimulationError,
  type SimulationErrorCode,
} from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';

export const SIMULATION_INSPECTION_MANIFEST_VERSION = 1 as const;
export const SIMULATION_INSPECTION_RECORD_OWNER = '@forgeax/engine-ecs' as const;
export const SIMULATION_INSPECTION_SCHEMA_OWNER = '@forgeax/engine-ecs' as const;
export const SIMULATION_INSPECTION_ERROR_FIELDS = ['code', 'expected', 'hint', 'detail'] as const;

export interface SimulationInspectionManifestParticipant {
  readonly id: string;
  readonly version: string;
  readonly schemaFingerprint: string;
  readonly ready: boolean;
}

export interface SimulationInspectionError {
  readonly code: SimulationErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SimulationError['detail'];
}

export interface SimulationInspectionManifest {
  readonly formatVersion: typeof SIMULATION_INSPECTION_MANIFEST_VERSION;
  readonly recordOwner: typeof SIMULATION_INSPECTION_RECORD_OWNER;
  readonly schemaOwner: typeof SIMULATION_INSPECTION_SCHEMA_OWNER;
  readonly baselineFingerprint: string;
  readonly participants: readonly SimulationInspectionManifestParticipant[];
  readonly errors: {
    readonly codes: readonly SimulationErrorCode[];
    readonly fields: typeof SIMULATION_INSPECTION_ERROR_FIELDS;
  };
  readonly trace: { readonly recordTick: number; readonly sampleCount: number };
  readonly report: {
    readonly verdict: 'match' | 'mismatch';
    readonly domains: typeof SIMULATION_COMPARISON_DOMAINS;
    readonly tolerance: {
      readonly required: true;
      readonly fields: Readonly<Record<string, number>>;
    };
    readonly entries: readonly SimulationComparisonEntry[];
  };
  readonly error?: SimulationInspectionError;
}

export interface SimulationManifestInvalidError {
  readonly code: 'simulation-manifest-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly path: string; readonly received?: unknown };
}

function invalid(
  path: string,
  expected: string,
  received?: unknown,
): SimulationManifestInvalidError {
  return {
    code: 'simulation-manifest-invalid',
    expected,
    hint: `repair manifest field '${path}' and validate it again`,
    detail: { path, ...(received === undefined ? {} : { received }) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSimulationErrorCode(value: unknown): value is SimulationErrorCode {
  return (
    typeof value === 'string' &&
    SIMULATION_ERROR_CODES.includes(value as (typeof SIMULATION_ERROR_CODES)[number])
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasSimulationDomains(value: unknown): value is typeof SIMULATION_COMPARISON_DOMAINS {
  return (
    Array.isArray(value) &&
    value.length === SIMULATION_COMPARISON_DOMAINS.length &&
    SIMULATION_COMPARISON_DOMAINS.every((domain, index) => value[index] === domain)
  );
}

function validateEntry(value: unknown, path: string): SimulationManifestInvalidError | undefined {
  if (!isRecord(value)) return invalid(path, 'a comparison entry object');
  if (
    !SIMULATION_COMPARISON_DOMAINS.includes(value.domain as never) ||
    !isNonEmptyString(value.path)
  ) {
    return invalid(`${path}.domain`, 'a known domain and non-empty path');
  }
  if (value.verdict !== 'match' && value.verdict !== 'mismatch') {
    return invalid(`${path}.verdict`, "'match' or 'mismatch'");
  }
  if (!('expected' in value) || !('actual' in value)) {
    return invalid(path, 'expected and actual values');
  }
  if (
    'tolerance' in value &&
    (typeof value.tolerance !== 'number' ||
      !Number.isFinite(value.tolerance) ||
      value.tolerance < 0)
  ) {
    return invalid(`${path}.tolerance`, 'a finite non-negative number');
  }
  if (
    'difference' in value &&
    (typeof value.difference !== 'number' ||
      !Number.isFinite(value.difference) ||
      value.difference < 0)
  ) {
    return invalid(`${path}.difference`, 'a finite non-negative number');
  }
  return undefined;
}

function validateError(value: unknown, path: string): SimulationManifestInvalidError | undefined {
  if (!isRecord(value)) return invalid(path, 'a structured simulation error');
  for (const field of SIMULATION_INSPECTION_ERROR_FIELDS) {
    if (!(field in value)) return invalid(`${path}.${field}`, 'a required error field');
  }
  if (!isSimulationErrorCode(value.code)) {
    return invalid(`${path}.code`, 'a known SimulationErrorCode');
  }
  for (const field of ['expected', 'hint'] as const) {
    if (!isNonEmptyString(value[field])) {
      return invalid(`${path}.${field}`, 'a non-empty string');
    }
  }
  return undefined;
}

export function validateSimulationInspectionManifest(
  value: unknown,
): Result<SimulationInspectionManifest, SimulationManifestInvalidError> {
  if (!isRecord(value)) return err(invalid('manifest', 'an object'));
  if (value.formatVersion !== SIMULATION_INSPECTION_MANIFEST_VERSION) {
    return err(invalid('formatVersion', 'the supported simulation inspection manifest version 1'));
  }
  for (const [field, expected] of [
    ['recordOwner', SIMULATION_INSPECTION_RECORD_OWNER],
    ['schemaOwner', SIMULATION_INSPECTION_SCHEMA_OWNER],
  ] as const) {
    if (value[field] !== expected) return err(invalid(field, expected, value[field]));
  }
  if (!isNonEmptyString(value.baselineFingerprint)) {
    return err(invalid('baselineFingerprint', 'a non-empty simulation fingerprint'));
  }
  if (!Array.isArray(value.participants)) return err(invalid('participants', 'an array'));
  for (const [index, participant] of value.participants.entries()) {
    if (!isRecord(participant)) return err(invalid(`participants.${index}`, 'an object'));
    for (const field of ['id', 'version', 'schemaFingerprint'] as const) {
      if (!isNonEmptyString(participant[field])) {
        return err(invalid(`participants.${index}.${field}`, 'a non-empty string'));
      }
    }
    if (typeof participant.ready !== 'boolean') {
      return err(invalid(`participants.${index}.ready`, 'a boolean'));
    }
  }
  if (!isRecord(value.errors)) return err(invalid('errors', 'an object'));
  if (!Array.isArray(value.errors.codes) || !value.errors.codes.every(isSimulationErrorCode)) {
    return err(invalid('errors.codes', 'an array of error code strings'));
  }
  const errorFields = value.errors.fields;
  if (
    !Array.isArray(errorFields) ||
    errorFields.length !== SIMULATION_INSPECTION_ERROR_FIELDS.length ||
    SIMULATION_INSPECTION_ERROR_FIELDS.some((field, index) => errorFields[index] !== field)
  ) {
    return err(invalid('errors.fields', "['code', 'expected', 'hint', 'detail']"));
  }
  if (!isRecord(value.trace)) return err(invalid('trace', 'an object'));
  if (!isNonNegativeInteger(value.trace.recordTick)) {
    return err(invalid('trace.recordTick', 'a non-negative safe integer'));
  }
  if (!isNonNegativeInteger(value.trace.sampleCount)) {
    return err(invalid('trace.sampleCount', 'a non-negative safe integer'));
  }
  if (!isRecord(value.report)) return err(invalid('report', 'an object'));
  if (value.report.verdict !== 'match' && value.report.verdict !== 'mismatch') {
    return err(invalid('report.verdict', "'match' or 'mismatch'"));
  }
  if (!hasSimulationDomains(value.report.domains)) {
    return err(invalid('report.domains', 'the ordered simulation comparison domains'));
  }
  if (!isRecord(value.report.tolerance)) return err(invalid('report.tolerance', 'an object'));
  if (value.report.tolerance.required !== true) {
    return err(invalid('report.tolerance.required', 'true'));
  }
  if (!isRecord(value.report.tolerance.fields)) {
    return err(invalid('report.tolerance.fields', 'an object of finite non-negative numbers'));
  }
  for (const [path, fieldTolerance] of Object.entries(value.report.tolerance.fields)) {
    if (
      typeof fieldTolerance !== 'number' ||
      !Number.isFinite(fieldTolerance) ||
      fieldTolerance < 0
    ) {
      return err(invalid(`report.tolerance.fields.${path}`, 'a finite non-negative number'));
    }
  }
  if (!Array.isArray(value.report.entries)) return err(invalid('report.entries', 'an array'));
  for (const [index, entry] of value.report.entries.entries()) {
    const error = validateEntry(entry, `report.entries.${index}`);
    if (error !== undefined) return err(error);
  }
  if (value.error !== undefined) {
    const error = validateError(value.error, 'error');
    if (error !== undefined) return err(error);
  }
  return ok(value as unknown as SimulationInspectionManifest);
}
