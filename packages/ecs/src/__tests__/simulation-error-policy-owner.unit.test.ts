import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createSimulationError,
  SIMULATION_ERROR_CODES,
  type SimulationError,
  type SimulationErrorCode,
  type SimulationErrorDetailMap,
  type SimulationErrorFor,
} from '../index';

const expectedCodes = [
  'simulation-record-invalid',
  'simulation-state-unsupported',
  'simulation-resource-invalid',
  'simulation-entity-unmapped',
  'simulation-participant-duplicate',
  'simulation-participant-missing',
  'simulation-participant-version-mismatch',
  'simulation-participant-schema-mismatch',
  'simulation-participant-not-ready',
  'simulation-participant-prepare-failed',
  'simulation-trace-invalid',
  'simulation-compare-invalid',
  'simulation-target-not-fresh',
] as const;

const expectedPolicy = {
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
} satisfies Record<SimulationErrorCode, { expected: string; hint: string }>;

describe('SimulationError policy ownership', () => {
  it('preserves the exact thirteen-code tuple and its public type', () => {
    expect(SIMULATION_ERROR_CODES).toEqual(expectedCodes);
    expect(SIMULATION_ERROR_CODES).toHaveLength(13);
    expect(new Set(SIMULATION_ERROR_CODES).size).toBe(13);
    expectTypeOf<typeof SIMULATION_ERROR_CODES>().toEqualTypeOf<typeof expectedCodes>();
    expectTypeOf<SimulationErrorCode>().toEqualTypeOf<(typeof expectedCodes)[number]>();
  });

  it('preserves every expected and hint value through the public factory', () => {
    for (const code of expectedCodes) {
      const error = createSimulationError(code, {} as SimulationErrorDetailMap[typeof code]);

      expect(error.expected).toBe(expectedPolicy[code].expected);
      expect(error.hint).toBe(expectedPolicy[code].hint);
    }
  });

  it('keeps correlated detail inference and Error field behavior', () => {
    const detail = { path: 'trace[0].tick', expected: 'a strictly increasing tick' } as const;
    const error = createSimulationError('simulation-trace-invalid', detail);

    expectTypeOf(error).toEqualTypeOf<SimulationErrorFor<'simulation-trace-invalid'>>();
    expectTypeOf<SimulationError>().toMatchTypeOf<SimulationErrorFor<SimulationErrorCode>>();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('Error');
    expect(error.message).toBe(
      `simulation-trace-invalid: ${expectedPolicy['simulation-trace-invalid'].expected}`,
    );
    expect(error.detail).toEqual(detail);
    expect(Object.keys(error)).toEqual(['code', 'expected', 'hint', 'detail']);

    for (const field of ['code', 'expected', 'hint', 'detail'] as const) {
      expect(Object.getOwnPropertyDescriptor(error, field)).toMatchObject({
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
  });

  it('keeps another correlated participant detail intact', () => {
    const detail = { id: 'forgeax.test.participant' } as const;
    const error = createSimulationError('simulation-participant-duplicate', detail);

    expectTypeOf(error).toEqualTypeOf<SimulationErrorFor<'simulation-participant-duplicate'>>();
    expect(error.detail.id).toBe(detail.id);
    expect(error.expected).toBe(expectedPolicy['simulation-participant-duplicate'].expected);
    expect(error.hint).toBe(expectedPolicy['simulation-participant-duplicate'].hint);
  });
});
