import { describe, expect, it } from 'vitest';
import { createBuildContributionService } from '../build/contributions.js';

describe('build contribution service', () => {
  it('runs a project custom importer through the one build service', async () => {
    const service = createBuildContributionService('/tmp/forgeax-custom-importer');
    const events: string[] = [];

    const release = service.register({
      id: 'fixture-importer',
      kind: 'importer',
      run: async (input: { readonly projectRoot: string; readonly sourceKey: string }) => {
        events.push(`${input.projectRoot}:${input.sourceKey}`);
        return { sourceKey: input.sourceKey, payload: 'cooked' };
      },
    });

    await expect(
      service.run('fixture-importer', {
        projectRoot: '/tmp/forgeax-custom-importer',
        sourceKey: 'fixture/source',
      }),
    ).resolves.toEqual({ sourceKey: 'fixture/source', payload: 'cooked' });
    expect(events).toEqual(['/tmp/forgeax-custom-importer:fixture/source']);

    await release.dispose();
    await expect(
      service.run('fixture-importer', {
        projectRoot: '/tmp/forgeax-custom-importer',
        sourceKey: 'fixture/source',
      }),
    ).rejects.toMatchObject({ code: 'build-contribution-missing' });
  });

  it('rejects duplicate contribution ids before either callback can run', () => {
    const service = createBuildContributionService('/tmp/forgeax-build');
    const first = service.register({
      id: 'duplicate',
      kind: 'importer',
      run: async () => 'first',
    });

    expect(() =>
      service.register({
        id: 'duplicate',
        kind: 'importer',
        run: async () => 'second',
      }),
    ).toThrowError(expect.objectContaining({ code: 'build-contribution-duplicate' }));
    expect(first).toMatchObject({ id: 'duplicate' });
  });
});
