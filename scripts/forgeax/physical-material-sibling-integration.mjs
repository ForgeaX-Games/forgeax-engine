import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const PHYSICAL_MATERIAL_SIBLING_INTEGRATION = Object.freeze({
  siblingFeatureId: 'feat-20260831-import-first-surface-material-standard-pipeline',
  siblingBranch: 'codex/feat-20260831-import-first-surface-material-standard-pipeline',
  siblingHead: '47b45416141503d485c4a1f4549c2b16cfe7e03d',
  siblingLiveStep: 'requirements',
  siblingWorktree:
    '/Users/you/projects/ForgeaX-Games/forgeax-engine/.worktrees/feat-20260831-import-first-surface-material-standard-pipeline',
  surfacePath: 'packages/shader/src/surface_v1.wgsl',
  assemblyPath: 'packages/render/src/assembly/material/assembly.ts',
  surfaceDigest: 'sha256:9b8dde6703a8e4d49934643ed4ca2c79814573a49d5460187a4b2282999d5a42',
  assemblyDigest: 'sha256:f80cf734c710b74228573ef427a3b39768401d19bc031f1f3e7f846da484d104',
});

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function captureSiblingIntegration(siblingPath, run = execFileSync) {
  const head = run('git', ['-C', siblingPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = run('git', ['-C', siblingPath, 'status', '--porcelain=v1'], {
    encoding: 'utf8',
  }).trim();
  const surface = run(
    'git',
    ['-C', siblingPath, 'show', `HEAD:${PHYSICAL_MATERIAL_SIBLING_INTEGRATION.surfacePath}`],
    { encoding: 'buffer' },
  );
  return {
    siblingHead: head,
    dirty: status.length > 0,
    status,
    liveStep: PHYSICAL_MATERIAL_SIBLING_INTEGRATION.siblingLiveStep,
    sourceClosure: [
      {
        path: PHYSICAL_MATERIAL_SIBLING_INTEGRATION.surfacePath,
        digest: digest(surface),
      },
    ],
  };
}
