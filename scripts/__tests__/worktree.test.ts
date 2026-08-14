import { describe, expect, it } from 'vitest';
import {
  branchFor,
  directoryFor,
  parseWorktreeOptions,
  submoduleStatusProblems,
  submoduleUpdateArgs,
} from '../worktree.ts';

describe('worktree option parsing', () => {
  it('uses a safe codex branch and worktree directory', () => {
    expect(branchFor('feature/render-grid')).toBe('codex/feature/render-grid');
    expect(directoryFor('feature/render-grid')).toBe('feature-render-grid');
  });

  it('accepts the complete bootstrap flags', () => {
    expect(
      parseWorktreeOptions(['codex/demo', '--from', 'origin/main', '--jobs', '3', '--fast']),
    ).toEqual({
      name: 'codex/demo',
      from: 'origin/main',
      jobs: 3,
      dryRun: false,
      noSetup: true,
      keepOnFailure: false,
    });
  });

  it('supports a non-mutating plan and failure retention', () => {
    expect(parseWorktreeOptions(['demo', '--dry-run', '--keep-on-failure'])).toMatchObject({
      name: 'demo',
      dryRun: true,
      keepOnFailure: true,
    });
  });

  it('rejects traversal and unbounded submodule jobs', () => {
    expect(() => parseWorktreeOptions(['../outside'])).toThrow(/git-safe name/);
    expect(() => parseWorktreeOptions(['demo', '--jobs', '9'])).toThrow(/1 to 8/);
  });
});

describe('worktree bootstrap plans', () => {
  it('bounds recursive shallow submodule work', () => {
    expect(submoduleUpdateArgs(4)).toEqual([
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--depth',
      '1',
      '--jobs',
      '4',
    ]);
    expect(submoduleUpdateArgs(4, '/tmp/assets-reference')).toContain('--reference');
  });

  it('reports unresolved or detached submodules', () => {
    expect(
      submoduleStatusProblems(
        '-abcdef0123456789 forgeax-engine-assets\n+1234567890abcdef other-sub',
      ),
    ).toEqual(['forgeax-engine-assets', 'other-sub']);
    expect(submoduleStatusProblems(' abcdef0123456789 forgeax-engine-assets')).toEqual([]);
  });
});
