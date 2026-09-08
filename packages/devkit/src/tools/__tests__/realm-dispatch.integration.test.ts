import { defineTool, type ToolContribution } from '@forgeax/engine-tool-runtime';
import { describe, expect, it } from 'vitest';
import { createRealmDispatch, type ToolRealmOwner } from '../catalog.js';

const schema = { parse: (value: unknown) => ({ ok: true as const, value }) };

function contribution(id: string, realm: 'build' | 'host' | 'engine'): ToolContribution {
  return defineTool(
    {
      id,
      title: id,
      summary: `Physical ${realm} consumer`,
      realm,
      argsSchema: schema,
      resultSchema: schema,
      evidence: [],
    },
    async () => ({ realm, id }),
  );
}

describe('DevKit physical realm dispatch', () => {
  it('uses one descriptor source for build, host and engine consumers', async () => {
    const build = contribution('project.build', 'build');
    const host = contribution('preview.host', 'host');
    const engine = contribution('preview.engine', 'engine');
    const all = [build, host, engine];
    const owners: ToolRealmOwner[] = [
      { realm: 'build', contributions: [build] },
      { realm: 'host', contributions: [host] },
      { realm: 'engine', contributions: [engine] },
    ];
    const dispatch = createRealmDispatch(all, owners);

    expect(dispatch.list().map((descriptor) => descriptor.id)).toEqual([
      'project.build',
      'preview.host',
      'preview.engine',
    ]);
    for (const item of all) {
      expect(dispatch.describe(item.descriptor.id)).toBe(item.descriptor);
      await expect(dispatch.run(item.descriptor.id, {})).resolves.toMatchObject({
        outcome: 'succeeded',
        result: { id: item.descriptor.id, realm: item.descriptor.realm },
      });
    }
  });

  it('fails closed when a declared realm has no owner', async () => {
    const engine = contribution('preview.engine-unavailable', 'engine');
    const dispatch = createRealmDispatch([engine], [{ realm: 'host', contributions: [] }]);

    await expect(dispatch.run(engine.descriptor.id, {})).resolves.toMatchObject({
      outcome: 'failed',
      failure: {
        code: 'tool-capability-unavailable',
        detail: { capability: 'realm:engine:tool:preview.engine-unavailable', realm: 'engine' },
      },
    });
  });

  it('rejects a consumer that declares a different realm than its owner', () => {
    const engine = contribution('preview.engine-mismatch', 'engine');
    expect(() =>
      createRealmDispatch([engine], [{ realm: 'host', contributions: [engine] }]),
    ).toThrow('declares engine but owner is host');
  });
});
