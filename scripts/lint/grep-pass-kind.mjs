#!/usr/bin/env node
// scripts/lint/grep-pass-kind.mjs - feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w8.
//
// Reverse grep gate: detects 'shadow-depth-only' string literals in .ts / .wgsl / .mjs
// source files under packages/ and apps/ (excluding dist/ and node_modules).
// The literal was renamed to 'shadow-caster' in w7; this gate ensures no regressions.
//
// Invocation:
//   node scripts/lint/grep-pass-kind.mjs
//
// Exit:
//   0 -- zero 'shadow-depth-only' literals found (pass).
//   1 -- at least one violation; file list printed to stdout with '::error::' prefix
//        so downstream CI runners surface the violation in their issue tracker.

import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const cmd =
  `grep --color=never -rn "'shadow-depth-only'" ${REPO_ROOT}/packages/ ${REPO_ROOT}/apps/ ` +
  `2>/dev/null | grep --color=never -v node_modules | grep --color=never -v '/dist/'`;

let output = '';
try {
  output = execSync(cmd, { encoding: 'utf8', cwd: REPO_ROOT }).trim();
} catch (e) {
  // grep exits 1 when no matches found -- that's success for us.
  if (e.status !== 1) {
    console.error(`grep-pass-kind.mjs: internal error running grep (status ${e.status})`);
    process.exit(2);
  }
}

if (output.length > 0) {
  // Check if all hits are comment-only documentation explaining the rename.
  // The types/index.ts JSDoc comment and the pipeline-cache-keying test comment
  // explaining the rename history are the sole allowed residues.
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  const allowed = lines.every(
    (line) => line.includes('renamed from') || line.includes('The pre-rename value'),
  );

  if (!allowed) {
    const header = "linter(grep): prohibited string literal 'shadow-depth-only' found in source:";
    console.log(`::error::${header}`);
    for (const line of lines) {
      console.log(`::error::  ${line}`);
    }
    console.log(
      "Use 'shadow-caster' instead (renamed in feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w7).",
    );
    process.exit(1);
  }
}

// Clean exit -- zero violations (or only allowed comment residue).
process.exit(0);
