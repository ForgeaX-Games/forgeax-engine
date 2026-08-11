import type {
  SimulationErrorCode,
  SimulationErrorDetailMap,
  SimulationErrorFor,
} from '../simulation/types';

const SIMULATION_ERROR_POLICY = {
  'simulation-record-invalid': {
    expected: 'a complete SimulationRecordV1 with a matching fingerprint',
    hint: 'Repair the record path or use a compatible in-process v1 record.',
  },
  'simulation-state-unsupported': {
    expected: 'only reflected portable simulation state',
    hint: 'Mark the value transient or add an owner-level portable descriptor.',
  },
  'simulation-resource-invalid': {
    expected: 'a registered recoverable resource with a matching schema',
    hint: 'Register the recoverable resource descriptor before recording or restoring.',
  },
  'simulation-entity-unmapped': {
    expected: 'every recorded entity reference to map to a target entity',
    hint: 'Restore into a fresh target and preserve every recorded entity mapping.',
  },
  'simulation-participant-duplicate': {
    expected: 'one participant registration per stable id',
    hint: 'Keep one participant registration for the stable participant id.',
  },
  'simulation-participant-missing': {
    expected: 'every recorded participant to be registered on the target',
    hint: 'Register the participant on the fresh target and retry.',
  },
  'simulation-participant-version-mismatch': {
    expected: 'the participant version declared by the target',
    hint: 'Use the same participant version or create a compatible record.',
  },
  'simulation-participant-schema-mismatch': {
    expected: 'the participant schema fingerprint declared by the target',
    hint: 'Use the same participant schema or create a compatible record.',
  },
  'simulation-participant-not-ready': {
    expected: 'the participant readiness contract to be true',
    hint: 'Wait for the participant to become ready, then retry on a fresh target.',
  },
  'simulation-participant-prepare-failed': {
    expected: 'participant preparation to succeed before commit',
    hint: 'Dispose the staging result and retry with a fresh target.',
  },
  'simulation-trace-invalid': {
    expected: 'one strictly increasing sample for every recorded tick',
    hint: 'Repair the trace tick sequence before restoring the record.',
  },
  'simulation-compare-invalid': {
    expected: 'finite field values and a declared field-level tolerance',
    hint: 'Declare a finite non-negative tolerance for every numeric comparison field.',
  },
  'simulation-target-not-fresh': {
    expected: 'a target without existing simulation entities',
    hint: 'Create a new target World and retry without reusing partial state.',
  },
} satisfies {
  readonly [C in SimulationErrorCode]: {
    readonly expected: string;
    readonly hint: string;
  };
};

export function createSimulationError<C extends SimulationErrorCode>(
  code: C,
  detail: SimulationErrorDetailMap[C],
): SimulationErrorFor<C> {
  const policy = SIMULATION_ERROR_POLICY[code];
  const error = new Error(`${code}: ${policy.expected}`) as SimulationErrorFor<C>;
  Object.assign(error, {
    code,
    expected: policy.expected,
    hint: policy.hint,
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
