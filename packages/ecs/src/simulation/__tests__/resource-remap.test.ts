import { describe, expect, it } from 'vitest';
import { type Component, defineComponent } from '../../component';
import { projectComponentData } from '../../externalization';
import { createEntityRemap } from '../../externalization/remap';
import { defineRecoverableResource } from '../../resource';

const Links = defineComponent('SimulationResourceRemapLinks', {
  target: { type: 'entity' },
  targets: { type: 'array<entity>', default: [] },
  derived: { type: 'f32', default: 0, transient: true },
});

describe('simulation resource classification and entity remap', () => {
  it('requires an explicit recoverable resource descriptor', () => {
    const descriptor = defineRecoverableResource('simulation.score', {
      schemaFingerprint: 'score-v1',
      clone: (value: unknown) => value,
    });

    expect(descriptor.key).toBe('simulation.score');
    expect(descriptor.classification).toBe('recoverable');
    expect(descriptor.schemaFingerprint).toBe('score-v1');
  });

  it('remaps scalar and array references while omitting transient fields', () => {
    const source = projectComponentData(Links as Component, {
      target: 7,
      targets: [7, 9],
      derived: 99,
    });
    const remap = createEntityRemap([0, 0, 0, 0, 0, 0, 0, 700, 0, 900]);
    const projected = projectComponentData(Links as Component, source, remap);

    expect(projected).toEqual({ target: 700, targets: [700, 900] });
    expect(projected.target).not.toBe(7);
  });

  it('fails instead of silently retaining a source entity with no target mapping', () => {
    const strictRemap = createEntityRemap([0, 100], { missing: 'error' });

    expect(() => strictRemap(8)).toThrowError(/mapping/i);
  });
});
