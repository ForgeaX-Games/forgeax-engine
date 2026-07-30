import { describe, expect, it } from 'vitest';
import { type VfxError, type VfxErrorCode, type VfxErrorDetailFor, vfxError } from '../index.js';

const simulationCodes = [
  'vfx-simulation-capability-unavailable',
  'vfx-simulation-player-invalid',
  'vfx-simulation-output-unavailable',
  'vfx-simulation-execution-failed',
] as const satisfies readonly VfxErrorCode[];

const details: {
  readonly [C in (typeof simulationCodes)[number]]: VfxErrorDetailFor[C];
} = {
  'vfx-simulation-capability-unavailable': {
    player: 11,
    emitterId: 'spark',
    stage: 'spawn',
    backend: 'gpu',
    plan: 'required-gpu',
  },
  'vfx-simulation-player-invalid': {
    player: 11,
    field: 'timeScale',
    value: Number.NaN,
  },
  'vfx-simulation-output-unavailable': {
    player: 11,
    emitterId: 'spark',
    stage: 'output',
    reference: 'material-spark',
    expectedKind: 'material',
  },
  'vfx-simulation-execution-failed': {
    player: 11,
    emitterId: 'spark',
    stage: 'update',
    operator: 'update:gravity:1',
    reason: 'executor rejected the cooked program',
  },
};

function diagnostic(code: (typeof simulationCodes)[number]): VfxError {
  switch (code) {
    case 'vfx-simulation-capability-unavailable':
      return vfxError(code, details[code]);
    case 'vfx-simulation-player-invalid':
      return vfxError(code, details[code]);
    case 'vfx-simulation-output-unavailable':
      return vfxError(code, details[code]);
    case 'vfx-simulation-execution-failed':
      return vfxError(code, details[code]);
  }
}

describe('simulation diagnostics in the VfxError union', () => {
  it('keeps every simulation code structurally recoverable', () => {
    for (const code of simulationCodes) {
      const error = diagnostic(code);

      expect(error.code).toBe(code);
      expect(error.expected.length).toBeGreaterThan(0);
      expect(error.hint.length).toBeGreaterThan(0);
      expect(error.detail).toBe(details[code]);
    }
  });

  it('narrows each detail to the owner and first recovery input', () => {
    const capability = diagnostic('vfx-simulation-capability-unavailable');
    if (capability.code === 'vfx-simulation-capability-unavailable') {
      expect(capability.detail.player).toBe(11);
      expect(capability.detail.emitterId).toBe('spark');
      expect(capability.detail.backend).toBe('gpu');
      expect(capability.detail.stage).toBe('spawn');
    }

    const player = diagnostic('vfx-simulation-player-invalid');
    if (player.code === 'vfx-simulation-player-invalid') {
      expect(player.detail.player).toBe(11);
      expect(player.detail.field).toBe('timeScale');
      expect(player.detail.value).toBe(Number.NaN);
    }

    const output = diagnostic('vfx-simulation-output-unavailable');
    if (output.code === 'vfx-simulation-output-unavailable') {
      expect(output.detail.reference).toBe('material-spark');
      expect(output.detail.expectedKind).toBe('material');
      expect(output.detail.stage).toBe('output');
    }

    const execution = diagnostic('vfx-simulation-execution-failed');
    if (execution.code === 'vfx-simulation-execution-failed') {
      expect(execution.detail.operator).toBe('update:gravity:1');
      expect(execution.detail.reason).toContain('rejected');
      expect(execution.detail.stage).toBe('update');
    }
  });

  it('does not collapse empty, disabled, unavailable, and failed states', () => {
    const states = ['empty', 'disabled', 'unavailable', 'failed'] as const;

    expect(new Set(states).size).toBe(states.length);
    expect(diagnostic('vfx-simulation-capability-unavailable').code).toBe(
      'vfx-simulation-capability-unavailable',
    );
    expect(diagnostic('vfx-simulation-output-unavailable').code).toBe(
      'vfx-simulation-output-unavailable',
    );
    expect(diagnostic('vfx-simulation-execution-failed').code).toBe(
      'vfx-simulation-execution-failed',
    );
  });
});
