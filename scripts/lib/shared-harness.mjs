import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/**
 * Mount one primary Harness; initialize that owner once when it is absent.
 * @param {string} root
 * @param {string} [commonRoot]
 * @returns {boolean}
 */
export function shareHarness(root, commonRoot) {
  if (commonRoot === undefined) {
    const probe = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (probe.status !== 0 || !probe.stdout.trim()) return false;
    commonRoot = dirname(resolve(root, probe.stdout.trim()));
  }
  const target = resolve(root, '.forgeax-harness');
  const shared = resolve(commonRoot, '.forgeax-harness');
  if (target === shared) return false;
  if (!existsSync(resolve(shared, '.git'))) {
    if (existsSync(target))
      throw new Error(`independent Harness at ${target}; consolidate its data into ${shared}`);
    const initialize = spawnSync(
      process.execPath,
      [resolve(commonRoot, 'scripts/sync-harness.mjs')],
      {
        cwd: commonRoot,
        stdio: 'inherit',
      },
    );
    if (initialize.status !== 0 || !existsSync(resolve(shared, '.git')))
      throw new Error(
        `primary Harness unavailable at ${shared}; run pnpm harness:sync in ${commonRoot}`,
      );
  }
  const owner = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: shared,
    encoding: 'utf8',
  });
  if (owner.status !== 0 || realpathSync(owner.stdout.trim()) !== realpathSync(shared))
    throw new Error(`primary Harness has an unexpected Git owner at ${shared}`);
  // A report checkout may have its own files/branch while sharing the same store.
  if (existsSync(target)) {
    const commonDir = (cwd) => {
      const probe = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd,
        encoding: 'utf8',
      });
      return probe.status === 0 && probe.stdout.trim()
        ? realpathSync(resolve(cwd, probe.stdout.trim()))
        : undefined;
    };
    const sharedOwner = commonDir(shared);
    if (sharedOwner !== undefined && commonDir(target) === sharedOwner) return true;
    throw new Error(`independent Harness at ${target}; consolidate its data into ${shared}`);
  }
  symlinkSync(relative(root, shared), target, process.platform === 'win32' ? 'junction' : 'dir');
  return true;
}
