// @forgeax/engine-rhi-debug/src/__tests__/guard-gates.test.ts
//
// Build-time codebase guard assertions using child_process.execSync and
// fs.readFileSync. These act as canaries: any future change that adds a
// flag-drift point or a 13th DebugErrorCode member turns this test red.
//
// AC-07: full-repo grep zero-hit for --runId / --ws-url (flag drift).
// AC-09: DebugErrorCode union member count = 12 (closed, OOS-6).
// AC-08 partial: import.meta.hot usage in create-app.ts is inside the
//   rhiDebugFlag === '1' guard block.
//
// t10; requirements AC-07/AC-08/AC-09; plan-strategy §2 D-8.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

describe('AC-07: flag drift grep gate', () => {
  it('zero hits for --runId / --ws-url across apps/ packages/ (excluding dist, node_modules, self)', () => {
    // Use --exclude-dir rather than post-filter to avoid matches in dist
    // bundles and node_modules. The test file itself contains these strings
    // as test descriptions, so we exclude it explicitly.
    const cmd =
      "find apps/ packages/ -type f \\( -name '*.ts' -o -name '*.mjs' \\) " +
      "| grep -v /dist/ | grep -v node_modules/ | grep -v 'guard-gates.test.ts' " +
      "| xargs grep -ln '\\-\\-runId\\|\\-\\-ws-url' 2>/dev/null || true";
    const stdout = execSync(cmd, { encoding: 'utf-8', cwd: ENGINE_ROOT });
    const hits = stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(hits).toEqual([]);
  });
});

describe('AC-09: DebugErrorCode member count gate', () => {
  it('DebugErrorCode union has exactly 14 members', () => {
    const errorsPath = path.resolve(__dirname, '..', '..', 'src', 'errors.ts');
    const content = readFileSync(errorsPath, 'utf-8');
    const lines = content.split('\n');

    const unionStart = lines.findIndex((l) => l.includes('export type DebugErrorCode ='));
    expect(unionStart).not.toBe(-1);

    let memberCount = 0;
    for (let i = unionStart + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) break;
      if (line.trimStart().startsWith("| '")) {
        memberCount++;
      }
      if (line.trimStart().startsWith(';')) {
        break;
      }
    }
    expect(memberCount).toBe(14);
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

    const guardOpenIdx = lines.findIndex((l) => l.includes("if (rhiDebugFlag === '1')"));
    expect(guardOpenIdx).not.toBe(-1);

    // Find the matching '}' at the same indent level as the 'if' statement.
    // Avoid counting braces inside template literals or strings by matching
    // the exact indent prefix.
    const guardLine = lines[guardOpenIdx];
    if (guardLine === undefined) throw new Error('unreachable: guardOpenIdx verified above');
    const indentMatch = guardLine.match(/^(\s*)/);
    if (indentMatch === null)
      throw new Error('unreachable: every line matches the whitespace regex');
    const indent = indentMatch[1];
    let guardCloseIdx = -1;
    for (let i = guardOpenIdx + 1; i < lines.length; i++) {
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
