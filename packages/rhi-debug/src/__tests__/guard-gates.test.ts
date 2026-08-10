// @forgeax/engine-rhi-debug/src/__tests__/guard-gates.test.ts
//
// Build-time codebase guard assertions using filesystem reads. These act as canaries: any future change that adds a
// flag-drift point or an unexpected DebugErrorCode member turns this test red.
//
// AC-07: full-repo grep zero-hit for --runId / --ws-url (flag drift).
// AC-09: DebugErrorCode union member count = 15 (closed, OOS-6).
// AC-08 partial: import.meta.hot usage in create-app.ts is inside the
//   rhiDebugFlag === '1' guard block.
//
// t10; requirements AC-07/AC-08/AC-09; plan-strategy §2 D-8.

import { readdirSync, readFileSync } from 'node:fs';
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

describe('AC-09: DebugErrorCode member count gate', () => {
  it('DebugErrorCode union has exactly 15 members', () => {
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
    expect(memberCount).toBe(15);
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
