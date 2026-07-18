#!/usr/bin/env node
// AC-09 grep gate: assert `@forgeax/engine-remote` package.json#dependencies
// does NOT include any third-party CLI argparse library (sade / commander /
// cac). The CLI is implemented with stdlib `node:util.parseArgs` + the
// package-internal `defineSubcommand` DSL (plan-strategy D-4 + D-7 / D-P3 RD-3).
//
// Hits in dependencies indicate someone re-introduced an external argparse
// dep. Pattern aligns with `check-no-help-string-array.mjs`: zero npm deps,
// plain `node:fs` + `node:path`, exit 1 on any hit.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const FORBIDDEN_DEPS = ['sade', 'commander', 'cac', 'yargs', 'minimist', 'meow'];

const PKG_PATH = join(process.cwd(), 'packages', 'remote', 'package.json');

function main() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  const hits = [];
  for (const name of FORBIDDEN_DEPS) {
    if (Object.prototype.hasOwnProperty.call(deps, name)) {
      hits.push(name);
    }
  }
  if (hits.length > 0) {
    process.stderr.write(
      `[fail] AC-09: forbidden CLI argparse dep(s) in @forgeax/engine-remote package.json#dependencies:\n`,
    );
    for (const name of hits) {
      process.stderr.write(`  ${name}\n`);
    }
    process.stderr.write(
      `\n  expected: 0 entries from { ${FORBIDDEN_DEPS.join(', ')} }\n` +
        `  hint:     stdlib node:util.parseArgs + defineSubcommand DSL is the locked surface (plan-strategy D-P3 RD-3 + D-4)\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `[ok] AC-09: 0 forbidden CLI argparse deps in @forgeax/engine-remote package.json\n`,
  );
}

main();
