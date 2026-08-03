import { describe, expect, it } from 'vitest';
import { type ParticleEffectSource, parseParticleEffectSource } from '../source.js';

const validSource: ParticleEffectSource = {
  schemaVersion: 1,
  emitters: [
    {
      id: 'valid',
      capacity: 16,
      space: 'local',
      schedule: { rate: 1, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 1 } }],
        initialize: [{ kind: 'initialize-life', version: 1, params: { seconds: 1 } }],
        update: [{ kind: 'update-drag', version: 1, params: { factor: 0.1 } }],
        output: [{ kind: 'output-billboard', version: 1, params: { size: 1 } }],
      },
      output: { kind: 'billboard', material: 'material' },
    },
  ],
};

function expectInvalid(source: unknown, path: string) {
  const result = parseParticleEffectSource(source);

  expect(result.ok).toBe(false);
  if (result.ok) return;

  expect(result.error.code).toBe('vfx-source-invalid');
  expect(result.error.detail.path).toBe(path);
  expect(result.error.expected.length).toBeGreaterThan(0);
  expect(result.error.hint.length).toBeGreaterThan(0);
}

describe('ParticleEffectSource invalid matrix', () => {
  it('rejects an effect without emitters', () => {
    expectInvalid({ ...validSource, emitters: [] }, 'effect.emitters');
  });

  it('rejects duplicate emitter ids as a whole-source error', () => {
    const duplicate = {
      ...validSource,
      emitters: [validSource.emitters[0], { ...validSource.emitters[0], id: 'valid' }],
    };

    expectInvalid(duplicate, 'effect.emitters[1].id');
  });

  it('rejects non-positive capacity and non-finite schedule values', () => {
    expectInvalid(
      { ...validSource, emitters: [{ ...validSource.emitters[0], capacity: 0 }] },
      'effect.emitters[0].capacity',
    );
    expectInvalid(
      {
        ...validSource,
        emitters: [{ ...validSource.emitters[0], schedule: { rate: Number.NaN, bursts: [] } }],
      },
      'effect.emitters[0].schedule.rate',
    );
  });

  it('rejects invalid bounds, curve, and gradient ranges', () => {
    expectInvalid(
      {
        ...validSource,
        emitters: [{ ...validSource.emitters[0], bounds: { min: [1, 1, 1], max: [-1, -1, -1] } }],
      },
      'effect.emitters[0].bounds',
    );
    expectInvalid(
      {
        ...validSource,
        emitters: [
          {
            ...validSource.emitters[0],
            curves: {
              alpha: {
                points: [
                  { time: 1, value: 0 },
                  { time: 0, value: 1 },
                ],
              },
            },
          },
        ],
      },
      'effect.emitters[0].curves.alpha.points[1].time',
    );
    expectInvalid(
      {
        ...validSource,
        emitters: [
          {
            ...validSource.emitters[0],
            gradients: { color: { stops: [{ time: 0, color: [2, 0, 0, 1] }] } },
          },
        ],
      },
      'effect.emitters[0].gradients.color.stops[0].color[0]',
    );
  });

  it('rejects an emitter without output intent', () => {
    const [validEmitter] = validSource.emitters;
    if (validEmitter === undefined) throw new Error('fixture must contain an emitter');
    const { output: _output, ...withoutOutput } = validEmitter;
    expectInvalid({ ...validSource, emitters: [withoutOutput] }, 'effect.emitters[0].output');
  });

  it('rejects derived runtime fields duplicated into authored source', () => {
    expectInvalid(
      { ...validSource, runtimeProgram: { format: 'forgeax-vfx-program-1' } },
      'effect.runtimeProgram',
    );
    expectInvalid(
      {
        ...validSource,
        emitters: [{ ...validSource.emitters[0], backendPlan: { backends: ['cpu'] } }],
      },
      'effect.emitters[0].backendPlan',
    );
  });
});
