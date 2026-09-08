import { describe, expect, it } from 'vitest';
import { createInitPlan } from '../init.js';
import type { ProjectFacts } from '../types.js';

function facts(packageJson: Record<string, unknown>): ProjectFacts {
  return {
    root: '/game',
    id: 'game',
    name: 'Game',
    entry: 'main.ts',
    plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
    assetRoots: ['assets'],
    packageJson,
  };
}

describe('createInitPlan', () => {
  it('replaces workspace dependencies and adds the standard product scripts', () => {
    const result = createInitPlan(
      facts({ dependencies: { '@forgeax/engine-app': 'workspace:*', three: '1.0.0' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dependencyChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '@forgeax/engine-app', from: 'workspace:*', to: '0.0.0' }),
        expect.objectContaining({ name: '@forgeax/engine-devkit', to: '0.0.0' }),
      ]),
    );
    expect(result.value.scriptChanges).toHaveLength(7);
    expect(result.value.scriptChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'preview', to: 'forgeax preview' }),
        expect.objectContaining({ name: 'package', to: 'forgeax package' }),
      ]),
    );
  });

  it('fails closed instead of overwriting a consumer script', () => {
    const result = createInitPlan(facts({ scripts: { build: 'custom-build' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('project-script-conflict');
  });

  it('reconciles the complete offline TypeScript toolchain', () => {
    const result = createInitPlan(
      facts({ devDependencies: { typescript: '5.0.0', '@types/node': '18.0.0' } }),
      {
        sdkVersion: '0.1.0',
        packages: [],
        requirements: { node: '>=22.13.0', pnpm: '11.7.0', pnpmStoreFormat: 'v11' },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dependencyChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'typescript', from: '5.0.0', to: '6.0.3' }),
        expect.objectContaining({ name: '@types/node', from: '18.0.0', to: '20.19.40' }),
      ]),
    );
  });

  it('keeps the archive-backed Vitest toolchain on the supported version', () => {
    const result = createInitPlan(facts({}), {
      sdkVersion: '0.1.0',
      packages: [],
      requirements: { node: '>=22.13.0', pnpm: '11.7.0', pnpmStoreFormat: 'v11' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dependencyChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'vitest', to: '4.1.11' })]),
    );
  });
});
