import { describe, expect, it } from 'vitest';
import { parseParticleEffectSourceV2 } from '../code-source.js';

const rendererSource = (renderer: unknown) => ({
  schemaVersion: 2,
  emitters: [
    {
      id: 'showcase',
      capacity: 64,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 4 },
      schedule: { rate: 4 },
      program: { module: 'forgeax_vfx::default' },
      renderers: [renderer],
    },
  ],
});

describe('Batch B renderer source contract', () => {
  it.each([
    ['billboard', { kind: 'billboard', material: 'vfx', sorting: 'emitter' }],
    ['ribbon', { kind: 'ribbon', material: 'vfx', stripKey: 'alive-index', capacity: 32 }],
    ['trail', { kind: 'trail', material: 'vfx', historyLength: 8, capacity: 32 }],
    ['beam', { kind: 'beam', material: 'vfx', endpointField: 'velocity', capacity: 16 }],
  ])('parses the independent %s topology', (_kind, renderer) => {
    const parsed = parseParticleEffectSourceV2(rendererSource(renderer));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.emitters[0]?.renderers[0]).toMatchObject(renderer);
  });

  it('rejects zero topology capacity instead of silently disabling output', () => {
    const parsed = parseParticleEffectSourceV2(
      rendererSource({ kind: 'trail', material: 'vfx', historyLength: 8, capacity: 0 }),
    );

    expect(parsed).toMatchObject({
      ok: false,
      error: { code: 'vfx-source-renderer-invalid' },
    });
  });

  it('keeps an explicitly disabled renderer distinguishable from an empty list', () => {
    const parsed = parseParticleEffectSourceV2(
      rendererSource({
        kind: 'ribbon',
        material: 'vfx',
        stripKey: 'alive-index',
        capacity: 32,
        enabled: false,
      }),
    );

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.emitters[0]?.renderers[0]).toMatchObject({ enabled: false });
  });
});
