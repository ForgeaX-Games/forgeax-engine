import { describe, expect, it } from 'vitest';
import { createInitPlan } from '../init.js';
import type { ProjectFacts } from '../types.js';

function facts(packageJson: Record<string, unknown>): ProjectFacts {
  return {
    root: '/game',
    id: 'game',
    name: 'Game',
    entry: 'main.ts',
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
    expect(result.value.scriptChanges).toHaveLength(5);
  });

  it('fails closed instead of overwriting a consumer script', () => {
    const result = createInitPlan(facts({ scripts: { build: 'custom-build' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('project-script-conflict');
  });
});
