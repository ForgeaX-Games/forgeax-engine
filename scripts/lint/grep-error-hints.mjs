#!/usr/bin/env node
// scripts/lint/grep-error-hints.mjs - feat-20260608-ci-time-cut M5 w15.
//
// Replaces packages/types/src/__tests__/error-hints.test.ts. Mirrors the
// 12 it blocks with direct fs/regex checks against
// packages/types/src/index.ts (the SSOT source) plus runtime imports of the
// PACK_ERROR_HINTS / GLTF_ERROR_HINTS objects.
//
// Anchors: feat-20260517 D-7 (binary form + historical narrative sinks to
// detail) + AC-12 / AC-13.
//
// Behaviour: exit 0 when all checks pass; exit 1 with concrete failure list
// otherwise.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const TYPES_INDEX = resolve(REPO_ROOT, 'packages', 'types', 'src', 'index.ts');

const failures = [];
const src = readFileSync(TYPES_INDEX, 'utf8');

const { PACK_ERROR_HINTS } = await import(
  resolve(REPO_ROOT, 'packages', 'types', 'src', 'index.ts')
).catch(async () => {
  // Fall back to the .mjs build artefact if the .ts cannot be ESM-loaded directly.
  return import(resolve(REPO_ROOT, 'packages', 'types', 'dist', 'index.mjs'));
});

// GltfErrorCode/GLTF_ERROR_HINTS migrated to @forgeax/engine-gltf
// in feat-20260615-fbx-importer-via-sdk per DIP (types stays unaware of importer error codes).
const { GLTF_ERROR_HINTS } = await import(
  resolve(REPO_ROOT, 'packages', 'gltf', 'src', 'errors.ts')
).catch(async () => {
  return import(resolve(REPO_ROOT, 'packages', 'gltf', 'dist', 'errors.mjs'));
});

// (a1-a3) PACK_ERROR_HINTS three subcommand-form hints reference the binary form.
for (const code of ['pack-meta-missing', 'pack-guid-collision', 'pack-cyclic-reference']) {
  const h = PACK_ERROR_HINTS[code];
  if (!h) {
    failures.push(`(a) PACK_ERROR_HINTS missing key "${code}"`);
    continue;
  }
  if (!/forgeax-engine-console-asset\s/.test(h)) {
    failures.push(
      `(a) PACK_ERROR_HINTS["${code}"] does not reference \`forgeax-engine-console-asset\` binary; got: ${h}`,
    );
  }
  if (h.includes('forgeax-engine-console asset ')) {
    failures.push(
      `(a) PACK_ERROR_HINTS["${code}"] still references the deleted subcommand form \`forgeax-engine-console asset \`; got: ${h}`,
    );
  }
}

// (b1-b2) GLTF_ERROR_HINTS two subcommand-form hints reference the binary form.
for (const code of ['gltf-malformed-header', 'gltf-meta-missing']) {
  const h = GLTF_ERROR_HINTS[code];
  if (!h) {
    failures.push(`(b) GLTF_ERROR_HINTS missing key "${code}"`);
    continue;
  }
  if (!/forgeax-engine-console-gltf\s/.test(h)) {
    failures.push(
      `(b) GLTF_ERROR_HINTS["${code}"] does not reference \`forgeax-engine-console-gltf\` binary; got: ${h}`,
    );
  }
  if (h.includes('forgeax-engine-console gltf ')) {
    failures.push(
      `(b) GLTF_ERROR_HINTS["${code}"] still references the deleted subcommand form \`forgeax-engine-console gltf \`; got: ${h}`,
    );
  }
}

// (c1-c3) types/index.ts grep gate complement (zero hits for deleted subcommand forms).
for (const tok of [
  'forgeax-engine-console asset ',
  'forgeax-engine-console gltf ',
  'forgeax-engine-console inspect',
]) {
  if (src.includes(tok)) {
    failures.push(`(c) types/index.ts still contains deleted token "${tok}"`);
  }
}

// (d) console-startup-failed inspect-routing hint template surfaces binary form.
if (!/did you mean 'forgeax-engine-console-ecs\s+\$\{[^}]*\}'/.test(src)) {
  failures.push(
    `(d) types/index.ts is missing the "did you mean 'forgeax-engine-console-ecs ...'" hint template`,
  );
}

// (e) InspectorErrorDetail console-startup-failed variant declares removedAt + docAnchor.
if (!/console-startup-failed[\s\S]{0,400}?removedAt/.test(src)) {
  failures.push(
    `(e) types/index.ts InspectorErrorDetail console-startup-failed variant missing removedAt sub-field`,
  );
}
if (!/console-startup-failed[\s\S]{0,400}?docAnchor/.test(src)) {
  failures.push(
    `(e) types/index.ts InspectorErrorDetail console-startup-failed variant missing docAnchor sub-field`,
  );
}

// (f) hint literals do not embed historical narrative tokens.
for (const [name, hints] of [
  ['PACK_ERROR_HINTS', PACK_ERROR_HINTS],
  ['GLTF_ERROR_HINTS', GLTF_ERROR_HINTS],
]) {
  for (const [code, hint] of Object.entries(hints)) {
    for (const tok of ['removedAt', 'docAnchor']) {
      if (hint.includes(tok)) {
        failures.push(`(f) ${name}["${code}"] embeds historical-narrative token "${tok}"`);
      }
    }
  }
}

// (g) InspectorErrorCode closed union still surfaces all 6 members in source.
const inspectorCodes = [
  "'script-syntax-error'",
  "'script-runtime-error'",
  "'script-timeout'",
  "'inspector-write-denied'",
  "'console-startup-failed'",
  "'console-not-running'",
];
for (const code of inspectorCodes) {
  if (!src.includes(code)) {
    failures.push(`(g) types/index.ts is missing InspectorErrorCode member ${code}`);
  }
}

if (failures.length === 0) {
  console.log('grep-error-hints: pass (PACK + GLTF binary-form hints + 6 inspector members)');
  process.exit(0);
} else {
  console.error('grep-error-hints: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
