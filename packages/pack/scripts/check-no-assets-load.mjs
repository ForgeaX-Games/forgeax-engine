#!/usr/bin/env node
// check-no-assets-load.mjs
// Gate: assert that engine.assets.load( does not appear in source files.
// Exit 0 = clean; exit 1 = pattern found (use loadByGuid instead).

import { execSync } from 'node:child_process';

const searchPaths = ['packages/', 'apps/', 'templates/'];
const excludes = [
  '--exclude-dir=dist',
  '--exclude-dir=node_modules',
  '--exclude-dir=.forgeax-harness',
  '--exclude=*.d.ts',
  '--exclude=check-no-assets-load.mjs',
];

let output = '';

try {
  output = execSync(
    `grep -rn 'engine\\.assets\\.load(' ${searchPaths.join(' ')} ${excludes.join(' ')} 2>/dev/null`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
} catch (e) {
  // grep exits 1 when no matches found (which is success for this gate)
  const status = (e && typeof e.status === 'number') ? e.status : 1;
  if (status === 1) {
    process.exit(0);
  }
  process.exit(status);
}

if (output.trim().length > 0) {
  process.stderr.write(
    '[check-no-assets-load] FAIL: engine.assets.load( found in source files.\n' +
    'Use loadByGuid() instead (feat-20260513-guid-asset-package-system AC-09a).\n\n' +
    output,
  );
  process.exit(1);
}

process.exit(0);
