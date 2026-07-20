#!/usr/bin/env node
// scripts/lint/grep-pbr-ibl-callsite.mjs - feat-20260608-ci-time-cut M5 w15.
//
// Prereq: pnpm install && pnpm build (resolves @forgeax/* workspace symlinks
// when standalone-invoked outside `pnpm lint:grep`).
//
// Replaces packages/shader/src/__tests__/pbr-ibl-callsite.test.ts. Mirrors
// the AC-08 grep gate: the engine PBR entry's fs_main must contain at least
// one literal call site to sampleIblDiffuse(...) and sampleIblSpecular(...)
// on a line that is neither a #import directive nor a // comment, AND the
// round-1 placeholder pattern (`var ambient = vec3<f32>(0.0); // M3 placeholder`)
// must NOT survive.
//
// Anchors: feat-20260520-skylight-ibl-cubemap M3 / t41+t48 (re-anchored to
// default-standard-pbr.wgsl by feat-20260523-shader-template-instance-split
// M5 / T09).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const PBR_PATH = resolve(REPO_ROOT, 'packages', 'shader', 'src', 'default-standard-pbr.wgsl');

const failures = [];
const src = readFileSync(PBR_PATH, 'utf8');

function countCallSites(source, fnName) {
  let n = 0;
  const re = new RegExp(`\\b${fnName}\\s*\\(`);
  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith('#import')) continue;
    if (trimmed.startsWith('//')) continue;
    const code = trimmed.replace(/\/\/.*$/, '');
    if (re.test(code)) n += 1;
  }
  return n;
}

if (countCallSites(src, 'sampleIblDiffuse') < 1) {
  failures.push('default-standard-pbr.wgsl has no non-import non-comment sampleIblDiffuse( call');
}
if (countCallSites(src, 'sampleIblSpecular') < 1) {
  failures.push('default-standard-pbr.wgsl has no non-import non-comment sampleIblSpecular( call');
}

if (/M3 placeholder/.test(src)) {
  failures.push('default-standard-pbr.wgsl still carries the round-1 "M3 placeholder" comment');
}

const codeOnly = src
  .split(/\r?\n/)
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');
if (/var\s+ambient\s*=\s*vec3<f32>\(\s*0\.0\s*\)\s*;/.test(codeOnly)) {
  failures.push(
    'default-standard-pbr.wgsl still carries the hardcoded `var ambient = vec3<f32>(0.0)` placeholder',
  );
}

if (failures.length === 0) {
  console.log(
    'grep-pbr-ibl-callsite: pass (sampleIblDiffuse + sampleIblSpecular present, placeholders gone)',
  );
  process.exit(0);
} else {
  console.error('grep-pbr-ibl-callsite: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
