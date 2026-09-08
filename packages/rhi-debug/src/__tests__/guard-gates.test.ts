// @forgeax/engine-rhi-debug/src/__tests__/guard-gates.test.ts
//
// Build-time codebase guard assertions using filesystem reads. These act as canaries: any future change that adds a
// flag-drift point or a second error owner turns this test red.
//
// AC-07: full-repo grep zero-hit for --runId / --ws-url (flag drift).
// AC-08 partial: import.meta.hot usage in create-app.ts is inside the
//   rhiDebugFlag === '1' guard block.
//
// t10; requirements AC-07/AC-08/AC-09; plan-strategy §2 D-8.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function flagDriftHits(root: string): string[] {
  const hits: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'node_modules') continue;
        visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.mjs'))) {
        continue;
      }
      if (entry.name === 'guard-gates.test.ts') continue;
      const absolute = path.join(directory, entry.name);
      const source = readFileSync(absolute, 'utf8');
      if (source.includes('--runId') || source.includes('--ws-url')) {
        hits.push(path.relative(ENGINE_ROOT, absolute));
      }
    }
  };
  visit(root);
  return hits.sort();
}

describe('AC-07: flag drift grep gate', () => {
  it('zero hits for --runId / --ws-url across apps/ packages/ (excluding dist, node_modules, self)', () => {
    expect([
      ...flagDriftHits(path.join(ENGINE_ROOT, 'apps')),
      ...flagDriftHits(path.join(ENGINE_ROOT, 'packages')),
    ]).toEqual([]);
  });
});

describe('RHI-debug error owner gate', () => {
  it('keeps the v7 error union as the only error owner', () => {
    const errorsPath = path.resolve(__dirname, '..', '..', 'src', 'errors.ts');
    const content = readFileSync(errorsPath, 'utf-8');
    expect(content).toContain('export type RhiDebugErrorCode =');
    expect(content).not.toMatch(/\bDebugErrorCode\b/);
  });
});

describe('W92: readback staging usage owner', () => {
  it('keeps one COPY_DST | MAP_READ owner for all three readback paths', () => {
    const readbackPath = path.resolve(__dirname, '..', '..', 'src', 'readback.ts');
    const content = readFileSync(readbackPath, 'utf-8');
    expect(content.match(/const COPY_DST_MAP_READ = 9/g)).toHaveLength(1);
    expect(content.match(/usage: COPY_DST_MAP_READ/g)).toHaveLength(3);
  });
});

describe('AC-08 partial: import.meta.hot in rhiDebugFlag guard', () => {
  it('all hotMeta.hot / import.meta.hot code references are inside rhiDebugFlag guard block', () => {
    const createAppPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'packages',
      'app',
      'src',
      'create-app.ts',
    );
    const content = readFileSync(createAppPath, 'utf-8');
    const lines = content.split('\n');

    const guardConditionIdx = lines.findIndex((l) => l.includes("rhiDebugFlag === '1'"));
    expect(guardConditionIdx).not.toBe(-1);
    let guardOpenIdx = -1;
    for (let i = guardConditionIdx; i >= 0; i--) {
      if (lines[i]?.includes('if (')) {
        guardOpenIdx = i;
        break;
      }
    }
    expect(guardOpenIdx).not.toBe(-1);

    const guardBraceIdx = lines.findIndex(
      (l, index) => index >= guardConditionIdx && l.includes('{'),
    );
    expect(guardBraceIdx).not.toBe(-1);

    // Find the matching '}' at the same indent level as the 'if' statement.
    // Avoid counting braces inside template literals or strings by matching
    // the exact indent prefix.
    const guardLine = lines[guardBraceIdx];
    if (guardLine === undefined) throw new Error('unreachable: guardBraceIdx verified above');
    const indentMatch = guardLine.match(/^(\s*)/);
    if (indentMatch === null)
      throw new Error('unreachable: every line matches the whitespace regex');
    const indent = indentMatch[1];
    let guardCloseIdx = -1;
    for (let i = guardBraceIdx + 1; i < lines.length; i++) {
      if (lines[i] === `${indent}}`) {
        guardCloseIdx = i;
        break;
      }
    }
    expect(guardCloseIdx).not.toBe(-1);

    // Verify all hotMeta / import.meta.hot references in non-comment lines
    // fall within the guard block.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) break;
      const trimmed = line.trimStart();
      // Skip comment-only lines.
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (
        trimmed.includes('hotMeta') ||
        (trimmed.includes('import.meta') && trimmed.includes('hot'))
      ) {
        expect(
          i,
          `import.meta.hot reference at line ${i + 1} is outside rhiDebugFlag guard (guard: ${guardOpenIdx + 1}-${guardCloseIdx + 1})`,
        ).toBeGreaterThanOrEqual(guardOpenIdx);
        expect(
          i,
          `import.meta.hot reference at line ${i + 1} is outside rhiDebugFlag guard (guard: ${guardOpenIdx + 1}-${guardCloseIdx + 1})`,
        ).toBeLessThanOrEqual(guardCloseIdx);
      }
    }
  });
});

describe('RHI-debug smoke roster gate', () => {
  it('resolves every declared hello and learn-render smoke at 300 frames', () => {
    const rosterPath = path.resolve(ENGINE_ROOT, 'scripts', 'rhi-debug-smoke-roster.mjs');
    const result = spawnSync(
      process.execPath,
      [
        rosterPath,
        '--apps-root',
        'apps/hello',
        '--learn-root',
        'apps/learn-render',
        '--frames',
        '300',
      ],
      { cwd: ENGINE_ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    const roster = JSON.parse(result.stdout) as {
      status: string;
      frameCount: number;
      execution: { status: string; mode: string };
      entries: readonly {
        frames: number;
        command: string;
        invocation: string;
        tokens: readonly string[];
      }[];
      unavailable: readonly { reason: string }[];
    };
    expect(roster.status).toBe('unavailable');
    expect(roster.execution).toMatchObject({ status: 'not-executed', mode: 'declaration-only' });
    expect(roster.frameCount).toBe(300);
    expect(roster.entries.length).toBeGreaterThan(0);
    expect(
      roster.entries.every(
        (entry) =>
          entry.frames === 300 &&
          entry.command === entry.invocation &&
          entry.tokens.join(' ') === entry.invocation &&
          entry.tokens[0] === 'pnpm' &&
          entry.tokens[1] === '--filter',
      ),
    ).toBe(true);
    expect(roster.entries.some((entry) => entry.invocation.includes('format-tier1 build'))).toBe(
      true,
    );
    expect(roster.unavailable.length).toBeGreaterThan(0);
    expect(roster.unavailable.every((item) => item.reason.length > 0)).toBe(true);
  });

  it('executes every declared command in a temporary workspace and fails closed', {
    timeout: 30_000,
  }, () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'forgeax-rhi-debug-roster-'));
    const appRoot = path.join(fixture, 'apps', 'hello');
    const packageRoot = path.join(appRoot, 'fake-smoke');
    const learnRoot = path.join(fixture, 'apps', 'learn-render');
    const learnPackageRoot = path.join(learnRoot, 'fake-learn-smoke');
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(learnPackageRoot, { recursive: true });
    writeFileSync(path.join(fixture, 'pnpm-workspace.yaml'), 'packages:\n  - apps/**\n');
    const manifestPath = path.join(packageRoot, 'package.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: '@fake/smoke',
        private: true,
        scripts: { 'smoke:browser': 'node -e "console.log(\'fake browser smoke\')"' },
        forgeax: { smokeInvocation: 'pnpm --filter @fake/smoke smoke:browser' },
      }),
    );
    writeFileSync(
      path.join(learnPackageRoot, 'package.json'),
      JSON.stringify({
        name: '@fake/learn-smoke',
        private: true,
        scripts: { 'smoke:browser': 'node -e "console.log(\'fake learn browser smoke\')"' },
        forgeax: { smokeInvocation: 'pnpm --filter @fake/learn-smoke smoke:browser' },
      }),
    );
    const rosterPath = path.resolve(ENGINE_ROOT, 'scripts', 'rhi-debug-smoke-roster.mjs');
    try {
      const passed = spawnSync(
        process.execPath,
        [
          rosterPath,
          '--apps-root',
          appRoot,
          '--learn-root',
          learnRoot,
          '--cwd',
          fixture,
          '--frames',
          '300',
          '--execute',
        ],
        { cwd: ENGINE_ROOT, encoding: 'utf8' },
      );
      expect(passed.status).toBe(0);
      const passedRoster = JSON.parse(passed.stdout) as {
        status: string;
        execution: { status: string; mode: string; passedCount: number; failedCount: number };
        entries: readonly {
          status: string;
          returnCode: number | null;
          stdout: string;
          invocation: string;
          tokens: readonly string[];
          backend: string;
          frames: number;
        }[];
      };
      expect(passedRoster.status).toBe('passed');
      expect(passedRoster.execution).toMatchObject({
        status: 'passed',
        mode: 'execute',
        passedCount: 2,
        failedCount: 0,
      });
      const passedEntry = passedRoster.entries.find(
        (entry) => entry.invocation === 'pnpm --filter @fake/smoke smoke:browser',
      );
      expect(passedEntry).toMatchObject({
        status: 'passed',
        returnCode: 0,
        invocation: 'pnpm --filter @fake/smoke smoke:browser',
        tokens: ['pnpm', '--filter', '@fake/smoke', 'smoke:browser'],
        backend: 'browser',
        frames: 300,
      });
      expect(passedEntry?.stdout).toContain('fake browser smoke');

      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: '@fake/smoke',
          private: true,
          scripts: {
            'smoke:browser': 'node -e "console.error(\'fake failure\'); process.exit(7)"',
          },
          forgeax: { smokeInvocation: 'pnpm --filter @fake/smoke smoke:browser' },
        }),
      );
      const failed = spawnSync(
        process.execPath,
        [
          rosterPath,
          '--apps-root',
          appRoot,
          '--learn-root',
          learnRoot,
          '--cwd',
          fixture,
          '--execute',
        ],
        { cwd: ENGINE_ROOT, encoding: 'utf8' },
      );
      expect(failed.status).toBe(1);
      const failedRoster = JSON.parse(failed.stdout) as {
        status: string;
        execution: { status: string; failedCount: number };
        entries: readonly { status: string; returnCode: number | null; stderr: string }[];
      };
      expect(failedRoster.status).toBe('failed');
      expect(failedRoster.execution).toMatchObject({ status: 'failed', failedCount: 1 });
      expect(failedRoster.entries[0]).toMatchObject({ status: 'failed', returnCode: 7 });
      expect(failedRoster.entries[0]?.stderr).toContain('fake failure');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
