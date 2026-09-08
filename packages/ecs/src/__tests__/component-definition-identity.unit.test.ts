import { describe, expect, it } from 'vitest';

describe('component definition identity', () => {
  it('shares token reflection between root and externalization bundles', async () => {
    const indexPath = '../../dist/index.mjs';
    const externalizationPath = '../../dist/externalization/index.mjs';
    const [
      { componentDefinition, defineComponent },
      { classifyEntityField, projectComponentData },
    ] = await Promise.all([import(indexPath), import(externalizationPath)]);
    const Probe = defineComponent('ComponentDefinitionIdentityProbe', {
      target: 'entity',
      targets: 'array<entity>',
    });

    expect(componentDefinition(Probe).fields.target?.type).toBe('entity');
    expect(classifyEntityField(Probe, 'target')).toEqual({ kind: 'entity', isArray: false });
    expect(classifyEntityField(Probe, 'targets')).toEqual({ kind: 'entity', isArray: true });
    expect(projectComponentData(Probe, { target: 7, targets: [8, 9] })).toEqual({
      target: 7,
      targets: [8, 9],
    });
  });
});
