#!/usr/bin/env node
// scripts/lint/grep-image-kind-convergence.mjs — feat-20260629-importer-self-declared-fold-contract M3 / w8 (D-2).
//
// Reverse grep gate: detects `"kind": "image"` in .meta.json sidecar files
// under forgeax-engine-assets/, packages/, and apps/.  After P1 (M2) migrated
// all 183 submodule sidecars + 16 source sites from image -> texture, and D-1
// (M3 / w7) removed the closed enum from meta.schema.json, a stray
// `"kind": "image"` in any .meta.json sidecar would silently pass schema
// validation.  This gate catches regressions: any .meta.json containing
// `"kind": "image"` after P1+M3 is a missed migration.
//
// Invocation:
//   node scripts/lint/grep-image-kind-convergence.mjs
//
// Exit:
//   0 — zero `"kind": "image"` hits in .meta.json files (pass).
//   1 — at least one violation; file list printed to stdout with `::error::`
//       prefix so downstream CI runners surface the violation.

import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const cmd =
  `grep -rlE '"kind": *"image"'` +
  ` --include='*.meta.json'` +
  ` ${REPO_ROOT}/forgeax-engine-assets ${REPO_ROOT}/packages ${REPO_ROOT}/apps` +
  ` 2>/dev/null`;

let output = '';
try {
  output = execSync(cmd, { encoding: 'utf8', cwd: REPO_ROOT }).trim();
} catch (e) {
  // grep exits 1 when no matches found — that's success for us.
  if (e.status !== 1) {
    console.error(
      `grep-image-kind-convergence.mjs: internal error running grep (status ${e.status})`,
    );
    process.exit(2);
  }
}

if (output.length > 0) {
  const header = 'linter(grep): prohibited `"kind": "image"` found in .meta.json sidecar files:';
  console.log(`::error::${header}`);
  for (const line of output.split('\n').filter((l) => l.trim().length > 0)) {
    console.log(`::error::  ${line}`);
  }
  console.log(
    'P1 (feat-20260629 M2) migrated all 183 submodule sidecars + 16 source sites from image -> texture. If a new .meta.json contains kind:image, it must be migrated to kind:texture.',
  );
  process.exit(1);
}

// Clean exit — zero violations.
process.exit(0);
