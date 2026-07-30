import { describe, expect, it } from 'vitest';
import {
  normalizeParticleEffectSource,
  type ParticleEffectSource,
  parseParticleEffectSource,
  serializeParticleEffectSource,
} from '../source.js';

const source: ParticleEffectSource = {
  schemaVersion: 1,
  emitters: [
    {
      id: 'smoke',
      capacity: 128,
      space: 'local',
      schedule: {
        rate: 12,
        bursts: [{ time: 0, count: 4 }],
      },
      bounds: {
        min: [-1, -1, -1],
        max: [1, 1, 1],
      },
      backendPolicy: {
        kind: 'preferred',
        backend: 'gpu',
        fallback: 'cpu',
      },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 12 } }],
        initialize: [{ kind: 'initialize-life', version: 1, params: { seconds: 2 } }],
        update: [{ kind: 'update-gravity', version: 1, params: { strength: 0.5 } }],
        output: [{ kind: 'output-billboard', version: 1, params: { size: 0.25 } }],
      },
      curves: {
        alpha: {
          points: [
            { time: 0, value: 0 },
            { time: 1, value: 1 },
          ],
        },
      },
      gradients: {
        color: {
          stops: [
            { time: 0, color: [1, 0.5, 0.1, 1] },
            { time: 1, color: [0.1, 0.1, 0.1, 0] },
          ],
        },
      },
      output: { kind: 'billboard', material: 'smoke-material' },
    },
    {
      id: 'sparks',
      capacity: 32,
      space: 'world',
      schedule: { rate: 0, bursts: [{ time: 0.25, count: 8 }] },
      bounds: {
        min: [-0.25, -0.25, -0.25],
        max: [0.25, 0.25, 0.25],
      },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      operators: {
        spawn: [{ kind: 'spawn-burst', version: 1, params: { count: 8 } }],
        initialize: [{ kind: 'initialize-life', version: 1, params: { seconds: 0.5 } }],
        update: [{ kind: 'update-drag', version: 1, params: { factor: 0.1 } }],
        output: [{ kind: 'output-mesh', version: 1, params: { mesh: 'spark' } }],
      },
      output: { kind: 'mesh', material: 'spark-material', mesh: 'spark' },
    },
  ],
};

describe('ParticleEffectSource JSON roundtrip', () => {
  it('preserves emitter and operator semantic order after normalization', () => {
    const normalized = normalizeParticleEffectSource(source);

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    expect(normalized.value.emitters.map((emitter) => emitter.id)).toEqual(['smoke', 'sparks']);
    expect(normalized.value.emitters[0]?.operators.spawn[0]?.kind).toBe('spawn-rate');
    expect(normalized.value.emitters[0]?.operators.output[0]?.kind).toBe('output-billboard');
  });

  it('keeps normalized semantics through parse, serialize, and parse', () => {
    const parsed = parseParticleEffectSource(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const serialized = serializeParticleEffectSource(parsed.value);
    const reparsed = parseParticleEffectSource(JSON.parse(serialized));

    expect(reparsed).toEqual(parsed);
    expect(JSON.parse(serialized)).toEqual(
      JSON.parse(serializeParticleEffectSource(reparsed.unwrap())),
    );
  });
});
