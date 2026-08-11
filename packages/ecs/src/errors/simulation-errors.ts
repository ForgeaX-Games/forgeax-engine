import type {
  SimulationErrorCode,
  SimulationErrorDetailMap,
  SimulationErrorFor,
} from '../simulation/types';

const EXPECTED: { readonly [C in SimulationErrorCode]: string } = {
  'simulation-record-invalid': 'a complete SimulationRecordV1 with a matching fingerprint',
  'simulation-state-unsupported': 'only reflected portable simulation state',
  'simulation-resource-invalid': 'a registered recoverable resource with a matching schema',
  'simulation-entity-unmapped': 'every recorded entity reference to map to a target entity',
  'simulation-participant-duplicate': 'one participant registration per stable id',
  'simulation-participant-missing': 'every recorded participant to be registered on the target',
  'simulation-participant-version-mismatch': 'the participant version declared by the target',
  'simulation-participant-schema-mismatch':
    'the participant schema fingerprint declared by the target',
  'simulation-participant-not-ready': 'the participant readiness contract to be true',
  'simulation-participant-prepare-failed': 'participant preparation to succeed before commit',
  'simulation-trace-invalid': 'one strictly increasing sample for every recorded tick',
  'simulation-compare-invalid': 'finite field values and a declared field-level tolerance',
  'simulation-target-not-fresh': 'a target without existing simulation entities',
};

const HINT: { readonly [C in SimulationErrorCode]: string } = {
  'simulation-record-invalid': 'Repair the record path or use a compatible in-process v1 record.',
  'simulation-state-unsupported':
    'Mark the value transient or add an owner-level portable descriptor.',
  'simulation-resource-invalid':
    'Register the recoverable resource descriptor before recording or restoring.',
  'simulation-entity-unmapped':
    'Restore into a fresh target and preserve every recorded entity mapping.',
  'simulation-participant-duplicate':
    'Keep one participant registration for the stable participant id.',
  'simulation-participant-missing': 'Register the participant on the fresh target and retry.',
  'simulation-participant-version-mismatch':
    'Use the same participant version or create a compatible record.',
  'simulation-participant-schema-mismatch':
    'Use the same participant schema or create a compatible record.',
  'simulation-participant-not-ready':
    'Wait for the participant to become ready, then retry on a fresh target.',
  'simulation-participant-prepare-failed':
    'Dispose the staging result and retry with a fresh target.',
  'simulation-trace-invalid': 'Repair the trace tick sequence before restoring the record.',
  'simulation-compare-invalid':
    'Declare a finite non-negative tolerance for every numeric comparison field.',
  'simulation-target-not-fresh':
    'Create a new target World and retry without reusing partial state.',
};

export function createSimulationError<C extends SimulationErrorCode>(
  code: C,
  detail: SimulationErrorDetailMap[C],
): SimulationErrorFor<C> {
  const error = new Error(`${code}: ${EXPECTED[code]}`) as SimulationErrorFor<C>;
  Object.assign(error, {
    code,
    expected: EXPECTED[code],
    hint: HINT[code],
    detail,
  });
  return error;
}

export type {
  SimulationError,
  SimulationErrorCode,
  SimulationErrorDetailMap,
  SimulationErrorFor,
} from '../simulation/types';
