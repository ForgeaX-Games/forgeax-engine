import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contextJob,
  extractRunCommands,
  isRunnerProvisioning,
  jobDependencies,
  localTargets,
  requiredContexts,
  targetsForGroup,
} from '../local-verify.mjs';

const root = resolve(import.meta.dirname, '..', '..', '..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

describe('local PR CI projection', () => {
  it('covers every required context and maps matrix legs to their workflow job', () => {
    const contexts = requiredContexts();
    expect(contexts).toContain('smoke-fleet-0');
    expect(contexts).toContain('bevy-smoke-fleet-2');
    expect(contextJob('smoke-fleet')).toBe('smoke-fleet-required-context');
    expect(contextJob('smoke-fleet-1')).toBe('smoke-fleet');
    expect(contextJob('bevy-smoke-fleet-2')).toBe('bevy-smoke-fleet');
    expect(contextJob('primary-pnpm')).toBe('primary-pnpm');
    expect(localTargets(workflow)).toEqual(
      expect.arrayContaining([
        'core-build',
        'shared-app-inputs',
        'app-shard-0',
        'app-shard-1',
        'app-shard-2',
      ]),
    );
    expect(targetsForGroup('smoke-fleet-1', workflow)).toEqual([
      'core-build',
      'shared-app-inputs',
      'app-shard-0',
      'app-shard-1',
      'app-shard-2',
      'build-artifacts',
      'post-merge-gate',
      'smoke-fleet',
    ]);
    expect(jobDependencies(workflow, 'build-artifacts')).toEqual([
      'core-build',
      'shared-app-inputs',
      'app-shard-0',
      'app-shard-1',
      'app-shard-2',
    ]);
    for (const target of localTargets(workflow)) {
      expect(workflow).toContain(`  ${target}:`);
    }
    expect(isRunnerProvisioning('echo "$RUNNER_TEMP" >> "$GITHUB_PATH"')).toBe(true);
    expect(isRunnerProvisioning('nproc && cat /proc/cpuinfo')).toBe(true);
  });

  it('extracts the workflow shell commands rather than a copied smoke ledger', () => {
    const start = workflow.indexOf('  smoke-fleet:');
    const end = workflow.indexOf('\n  smoke-fleet-required-context:', start);
    const commands = extractRunCommands(workflow.slice(start, end));
    expect(commands).toContain('pnpm --filter @forgeax/hello-triangle smoke');
    expect(commands.some((command) => command.includes('@forgeax/hello-custom-shader smoke'))).toBe(
      true,
    );
  });
});
