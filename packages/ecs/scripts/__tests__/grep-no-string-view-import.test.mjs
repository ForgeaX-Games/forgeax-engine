// w15 — colocated test for packages/ecs/scripts/grep-no-string-view-import.mjs.
//
// feat-20260515-string-managed-collapse M4 / w15 — verifies the two-mode
// contract of the StringView-import freeze gate:
//   (a) clean tree (default scan, scriptmode skipping fixtures) -> exit 0
//   (b) seeded fixture under __tests__/fixtures/string-view-import-bad/
//       containing `import { StringView } from '...'` -> exit 1 + stderr
//       triple ([reason] / [rerun] / [hint]).
//
// The fixture lives inside packages/ecs/scripts/__tests__/fixtures and is
// passed as an explicit root to the gate so it is in-scope; default-mode
// runs of the gate skip /scripts/__tests__/fixtures/ and therefore stay
// green on the live tree.
//
// Pattern mirrors scripts/__tests__/grep-gates.test.ts.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';

const here = resolve(fileURLToPath(import.meta.url), '..');
const repoRoot = resolve(here, '..', '..', '..', '..');
const script = resolve(here, '..', 'grep-no-string-view-import.mjs');
const fixtureDir = resolve(here, 'fixtures', 'string-view-import-bad');

beforeAll(() => {
  mkdirSync(fixtureDir, { recursive: true });
  // Seeded violation file. The gate must hit this when the fixture root is
  // explicitly passed (with --scan-fixtures) but NOT when the live tree is
  // walked from packages/ apps/ templates/ (the FIXTURE_DIR_FRAGMENT skip).
  writeFileSync(
    resolve(fixtureDir, 'bad.ts'),
    "import { StringView } from './string-view';\nexport type X = StringView;\n",
    'utf8',
  );
});

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('grep-no-string-view-import', () => {
  it('exits 0 on the live tree (default scan, fixtures skipped)', () => {
    const r = run([]);
    expect(r.status).toBe(0);
  });

  it('exits 1 with stderr triple when scanning the seeded fixture root', () => {
    const r = run(['--scan-fixtures', fixtureDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[reason\] StringView import detected at/);
    expect(r.stderr).toMatch(/\[rerun\] pnpm grep:no-string-view-import/);
    expect(r.stderr).toMatch(/\[hint\] StringView class deleted in feat-20260515/);
  });
});
