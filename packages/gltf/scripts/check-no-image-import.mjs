#!/usr/bin/env node
// check-no-image-import.mjs - feat-20260608 M3 D-1 / D-7 grep gate.
//
// @forgeax/engine-gltf must NOT statically import from @forgeax/engine-image
// (any sub-export). The image decode seam is `ImportContext.decodeImage`
// — a callback the runner injects (D-1). A static edge would re-bundle the
// decoder transitively into any consumer of engine-gltf, narrowing the
// public surface to nothing AI users can reason about.
//
// Algorithm: walk `packages/gltf/src/**/*.{ts,mjs}` and reject any line
// matching `import ... from '@forgeax/engine-image(/...)?'`. Comments
// containing the literal name are allowed (the import-statement regex
// requires the leading `import` keyword + the full `from '...'` clause).
//
// Self-test: pass --root <fixture-dir> to point the scanner at a hermetic
// fixture tree (used by scripts/__tests__).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ARGV = process.argv.slice(2);
const ROOT_FLAG_INDEX = ARGV.indexOf('--root');
const ROOT =
  ROOT_FLAG_INDEX >= 0 && ARGV[ROOT_FLAG_INDEX + 1] !== undefined
    ? ARGV[ROOT_FLAG_INDEX + 1]
    : process.cwd();

const TARGET_DIR = join(ROOT, 'packages', 'gltf', 'src');

// Match any static import line:
//   import ... from '@forgeax/engine-image';
//   import ... from "@forgeax/engine-image/sub-path";
//   import type ... from '@forgeax/engine-image';
const IMPORT_RE =
  /^\s*import\b[\s\S]*?from\s+['"]@forgeax\/engine-image(?:\/[^'"]+)?['"]\s*;?/gm;

function walk(dir) {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  const out = [];
  for (const ent of readdirSync(dir)) {
    const full = join(dir, ent);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|mjs|cjs)$/.test(ent)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(TARGET_DIR);
const failures = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const upto = text.slice(0, m.index);
    const line = upto.split('\n').length;
    failures.push(`${f}:${line}: static import of @forgeax/engine-image — use ctx.decodeImage seam`);
  }
}

if (failures.length > 0) {
  process.stderr.write(failures.join('\n') + '\n');
  process.stderr.write(
    '\n[hint] @forgeax/engine-gltf must funnel image decode through ImportContext.decodeImage (feat-20260608 M3 D-1). ' +
      'Remove the static import and call ctx.decodeImage(bytes, mime, settings) instead. ' +
      'The runner host (vite-plugin-pack / cli-gltf / tests) wires the concrete decoder.\n',
  );
  process.exit(1);
}
process.stdout.write(`check-no-image-import OK: ${files.length} files clean\n`);
