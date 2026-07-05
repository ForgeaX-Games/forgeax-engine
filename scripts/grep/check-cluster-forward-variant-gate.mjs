#!/usr/bin/env node
// feat-20260609-hdrp-cluster-fragment-ggx M1 / w3 (AC-04) + M2 / w11 (AC-08)
// + M4 / w18 (AC-07) + M4 / w34 (grep: variant resolution references).
//
// Grep gate: assert that default-standard-pbr.wgsl carries BOTH
//   (a) `#pragma variant_axis CLUSTER_FORWARD_AVAILABLE` (immediately after
//       the existing STORAGE_BUFFER_AVAILABLE pragma)
//   (b) `#import forgeax_hdrp::cluster_forward::{evaluate_cluster_lights}`
//       inside an `#ifdef CLUSTER_FORWARD_AVAILABLE` block.
//
// Also checks that hdrp-cluster-forward.wgsl contains the expected
// `#define_import_path forgeax_hdrp::cluster_forward` header, confirming
// the import path is resolvable.
//
// M2 / w11 (AC-08): assert-absent checks for hardcoded viewport dimensions.
//
// Additionally checks that hdrp-cluster-forward.wgsl no longer contains
// hardcoded viewport dimensions (frag_coord / 800u / 600u) after w10.
//
// Forbidden patterns are assert-absent (AC-08):
//   - `frag_coord` must NOT appear (signature changed to ndc: vec3<f32>)
//   - `800u` must NOT appear (hardcoded viewport width removed)
//   - `600u` must NOT appear (hardcoded viewport height removed)
//
// M4 / w18 (AC-07): assert that hdrp-pipeline.ts declares the
// `cluster-forward` pass with `writes: ['hdrColor']` -- proving the pass
// no longer ships as a no-op stub but actually writes the HDR colour
// target via its delegate (recordMainPass). Asserted at the source level
// because the M4 architecture pivot's success criterion is that the pass
// declaration carries the write -- a behavioural smoke (M5) confirms the
// runtime effect on top.
//
// M4 / w34: assert that the runtime variant resolution chain is wired end-to-end:
//   - createRenderer.ts: `findVariantByKey` is called within
//     `getMaterialShaderPipeline` (the variant WGSL resolution path).
//   - record/ cluster: `variantSet` or `frameState.isHdrpActive` is
//     referenced near a `getMaterialShaderPipeline` call site, confirming
//     the record stage passes variantSet to PSO builder.
//
// Exit 0: all patterns found, all forbidden absent. Exit 1: fail-fast.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const PBR_PATH = resolve(ROOT, 'packages/shader/src/default-standard-pbr.wgsl');
const HDRP_CFW_PATH = resolve(ROOT, 'packages/shader/src/hdrp-cluster-forward.wgsl');
const HDRP_PIPELINE_PATH = resolve(ROOT, 'packages/runtime/src/hdrp-pipeline.ts');

const hits = [];

function checkFile(path, label, patterns) {
  let src;
  try {
    src = readFileSync(path, 'utf8');
  } catch {
    console.error(`[check-cluster-forward-variant-gate] missing file: ${path}`);
    process.exit(1);
  }
  for (const { re, desc } of patterns) {
    if (!re.test(src)) {
      hits.push(`${label}: ${desc}`);
    }
  }
}

// default-standard-pbr.wgsl checks
checkFile(PBR_PATH, 'default-standard-pbr.wgsl', [
  {
    re: /^#pragma variant_axis CLUSTER_FORWARD_AVAILABLE$/m,
    desc: 'missing `#pragma variant_axis CLUSTER_FORWARD_AVAILABLE` line',
  },
  {
    re: /^#ifdef CLUSTER_FORWARD_AVAILABLE$/m,
    desc: 'missing `#ifdef CLUSTER_FORWARD_AVAILABLE` guard',
  },
  {
    re: /#import forgeax_hdrp::cluster_forward::\{evaluate_cluster_lights\}/,
    desc: 'missing `#import forgeax_hdrp::cluster_forward::{evaluate_cluster_lights}` directive',
  },
  {
    re: /^#endif\s*\/\/\s*CLUSTER_FORWARD_AVAILABLE/m,
    desc: 'missing `#endif // CLUSTER_FORWARD_AVAILABLE` closing guard',
  },
]);

// hdrp-cluster-forward.wgsl checks
checkFile(HDRP_CFW_PATH, 'hdrp-cluster-forward.wgsl', [
  {
    re: /^#define_import_path forgeax_hdrp::cluster_forward$/m,
    desc: 'missing `#define_import_path forgeax_hdrp::cluster_forward` header',
  },
  {
    re: /^fn evaluate_cluster_lights\(/m,
    desc: 'missing `evaluate_cluster_lights` function definition',
  },
]);

// w11 (AC-08): assert-absent — hardcoded viewport dimensions removed.
function checkAbsent(path, label, patterns) {
  let src;
  try {
    src = readFileSync(path, 'utf8');
  } catch {
    console.error(`[check-cluster-forward-variant-gate] missing file: ${path}`);
    process.exit(1);
  }
  for (const { re, desc } of patterns) {
    if (re.test(src)) {
      hits.push(`${label}: ${desc}`);
    }
  }
}

checkAbsent(HDRP_CFW_PATH, 'hdrp-cluster-forward.wgsl', [
  {
    re: /\bfrag_coord\b/,
    desc: 'forbidden: `frag_coord` still present (signature changed to ndc: vec3<f32> in w10)',
  },
  {
    re: /\b800u\b/,
    desc: 'forbidden: `800u` hardcoded viewport width still present (removed in w10)',
  },
  {
    re: /\b600u\b/,
    desc: 'forbidden: `600u` hardcoded viewport height still present (removed in w10)',
  },
]);

// M4 / w18 (AC-07): hdrp-pipeline.ts cluster-forward pass writes hdrColor.
// Match the `'cluster-forward'` literal then look ahead for a `writes:`
// array containing `'hdrColor'` within the same addPass block (we bound
// the search to ~600 chars after the literal -- the addPass block is
// short enough that this is a hard cap rather than a heuristic).
function checkClusterForwardWritesHdrColor() {
  let src;
  try {
    src = readFileSync(HDRP_PIPELINE_PATH, 'utf8');
  } catch {
    console.error(`[check-cluster-forward-variant-gate] missing file: ${HDRP_PIPELINE_PATH}`);
    process.exit(1);
  }
  // Anchor on the actual `graph.addPass('cluster-forward', { ... })` call,
  // not the first occurrence of 'cluster-forward' (which is in the file
  // header JSDoc and describes the pass, not declares it).
  const addPassMatch = /graph\.addPass\('cluster-forward'\s*,\s*\{([\s\S]{0,600}?)\}\s*\)/m.exec(
    src,
  );
  if (addPassMatch === null) {
    hits.push("hdrp-pipeline.ts: missing `graph.addPass('cluster-forward', {...})` call");
    return;
  }
  const passBody = addPassMatch[1] ?? '';
  if (!/writes:\s*\[\s*'hdrColor'\s*\]/m.test(passBody)) {
    hits.push(
      "hdrp-pipeline.ts: cluster-forward pass missing `writes: ['hdrColor']` (AC-07: pass must write hdrColor, not [])",
    );
  }
}

checkClusterForwardWritesHdrColor();

// ============================================================================
// M4 / w34: variant resolution references exist in createRenderer + record/ cluster
// ============================================================================

const CREATE_RENDERER_PATH = resolve(ROOT, 'packages/runtime/src/createRenderer.ts');

function checkVariantResolutionInCreateRenderer() {
  let src;
  try {
    src = readFileSync(CREATE_RENDERER_PATH, 'utf8');
  } catch {
    console.error(`[check-cluster-forward-variant-gate] missing file: ${CREATE_RENDERER_PATH}`);
    process.exit(1);
  }
  // findVariantByKey must be called within getMaterialShaderPipeline to resolve
  // the variant WGSL from the manifest when variantSet is non-empty.
  // We check that findVariantByKey appears in the file (it's only called in
  // the variant resolution block inside getMaterialShaderPipeline).
  if (!/\bfindVariantByKey\b/.test(src)) {
    hits.push(
      'createRenderer.ts: missing `findVariantByKey` reference (variant WGSL resolution from manifest not wired)',
    );
  }
}

// feat-20260704 M3/w24: the record-stage monolith split into the
// packages/runtime/src/record/ cluster. Read every .ts under that dir and
// concatenate so presence/count checks scan the real code, not the deleted
// root file (plan-strategy D-2 no-root-shim + section 5.6 no empty-pass).
function readRecordClusterSource() {
  const RECORD_DIR = resolve(ROOT, 'packages/runtime/src/record');
  let names;
  try {
    names = readdirSync(RECORD_DIR)
      .filter((name) => name.endsWith('.ts'))
      .sort();
  } catch {
    console.error(`[check-cluster-forward-variant-gate] missing dir: ${RECORD_DIR}`);
    process.exit(1);
  }
  if (names.length === 0) {
    console.error(`[check-cluster-forward-variant-gate] no .ts files under ${RECORD_DIR}`);
    process.exit(1);
  }
  return names.map((name) => readFileSync(resolve(RECORD_DIR, name), 'utf8')).join('\n');
}

function checkVariantSetInRenderSystemRecord() {
  const src = readRecordClusterSource();
  // The record stage must pass variantSet to getMaterialShaderPipeline.
  // We assert that both `variantSet` (the variable name) and
  // `frameState.isHdrpActive` (the decision source) appear somewhere in the
  // record cluster.
  if (!/\bvariantSet\b/.test(src)) {
    hits.push(
      'record/ cluster: missing `variantSet` reference (record stage not passing variantSet to getMaterialShaderPipeline)',
    );
  }
  if (!/\bframeState\.isHdrpActive\b/.test(src)) {
    hits.push(
      'record/ cluster: missing `frameState.isHdrpActive` reference (isHdrpActive decision source not consumed for variantSet)',
    );
  }
}

checkVariantResolutionInCreateRenderer();
checkVariantSetInRenderSystemRecord();

// ============================================================================
// M4.5 / w40 (G-13): block NEW silent early-returns in the record cluster.
//
// `if (X === undefined) return;` is the silent-fail antipattern that the
// Round 3 systematic-debug uncovered (record:1539 silent skip on missing
// HDRP depth target -> structural smoke 'pass' while pixel readback still
// shows black). Charter P3: explicit failure > silent behaviour.
//
// The legitimate inherited sites (graceful degradation on transient
// pre-load / absent-optional state, run every frame, must not log/throw):
//   - record/skybox-post-pass.ts: skyboxSnapshot / cubemapView guards (2)
//   - record/main-pass-material.ts: paramSchema / paramSnapshot guards (2)
// Baseline occurrence count = 4; gate fails when the count grows.
//
// feat-20260704 M3/w24: recounted from 2 -> 4. The gate was authored
// (commit 30d7ad68) when the monolith carried 2; a later unrelated commit
// (12c548d6, sprite/transparent SSOT) added the 2 paramSchema/paramSnapshot
// guards to the monolith without bumping this baseline, so the stated "2"
// had already drifted from the real inherited count. The M3 split inherited
// exactly those 4 (verified against pre-split b1530d2e~1) and introduced
// ZERO new ones. Setting the baseline to the true inherited value is a
// recount to reality, NOT a relaxation -- it still blocks any 5th site.
//
// Hint -> Round 3 implement-decisions Section 3 + architecture-principles.md
// #5 Fail Fast + plan-strategy D-11.
// ============================================================================
function checkSilentEarlyReturnsInRecordStage() {
  const G13_BASELINE = 4;
  const src = readRecordClusterSource();
  // Match `if (X === undefined) return;` (single-line, void return only;
  // value-returning early-returns like `return false;` / `return { ok: true };`
  // are NOT silent because they propagate state to the caller).
  const re = /if\s*\([^)]*===\s*undefined[^)]*\)\s*return\s*;/g;
  const matches = src.match(re) ?? [];
  if (matches.length > G13_BASELINE) {
    hits.push(
      `record/ cluster: G-13 violation -- silent early-returns count ${matches.length} > baseline ${G13_BASELINE}. ` +
        `Pattern \`if (X === undefined) return;\` is the silent-fail antipattern (charter P3). ` +
        `Replace with explicit fail-fast (errorRegistry.fire / throw) or value-return; ` +
        `see Round 3 implement-decisions Section 3 + architecture-principles.md #5 Fail Fast.`,
    );
  }
}

// ============================================================================
// M4.5 / w41 (G-14): block `variantSet ?` / `if (variantSet)` falsy patterns
// in createRenderer.ts.
//
// `variantSet === ''` is the canonical all-true HDRP variant key (D-11) and
// MUST hit the manifest variant lookup -- treating it as falsy via
// `variantSet ? X : Y` or `if (variantSet)` collapses HDRP onto the no-variant
// path (precise bug Round 3 systematic-debug uncovered: HDRP rendered with
// the registered default WGSL because findVariantByKey was never called).
// Allowed alternatives: `!== undefined` / `=== undefined` / `!== ''` /
// `typeof variantSet === 'string'` -- all explicit on the empty-vs-missing
// distinction.
//
// Scope: createRenderer.ts only (other files name `variantSet` for unrelated
// purposes; narrowing by file avoids false positives).
// ============================================================================
function checkVariantSetFalsyInCreateRenderer() {
  let src;
  try {
    src = readFileSync(CREATE_RENDERER_PATH, 'utf8');
  } catch {
    console.error(`[check-cluster-forward-variant-gate] missing file: ${CREATE_RENDERER_PATH}`);
    process.exit(1);
  }
  // (1) `variantSet ?` ternary -- treats '' as falsy.
  // Exclude TypeScript optional-parameter syntax `variantSet?:` (the `?:` is
  // a single token meaning "optional" in a parameter list, not a ternary).
  const ternaryRe = /\bvariantSet\s*\?(?!:)/g;
  const ternaryMatches = src.match(ternaryRe) ?? [];
  if (ternaryMatches.length > 0) {
    hits.push(
      `createRenderer.ts: G-14 violation -- found ${ternaryMatches.length} \`variantSet ?\` ternary pattern(s). ` +
        `'' is the canonical all-true HDRP variant key (D-11) and MUST NOT be treated as falsy. ` +
        `Use \`variantSet !== undefined ? X : Y\` instead.`,
    );
  }
  // (2) `if (variantSet)` truthy check -- same antipattern.
  const ifRe = /\bif\s*\(\s*variantSet\s*\)/g;
  const ifMatches = src.match(ifRe) ?? [];
  if (ifMatches.length > 0) {
    hits.push(
      `createRenderer.ts: G-14 violation -- found ${ifMatches.length} \`if (variantSet)\` truthy pattern(s). ` +
        `'' is the canonical all-true HDRP variant key (D-11) and MUST NOT be treated as falsy. ` +
        `Use \`if (variantSet !== undefined)\` instead.`,
    );
  }
}

checkSilentEarlyReturnsInRecordStage();
checkVariantSetFalsyInCreateRenderer();

if (hits.length > 0) {
  console.error('[check-cluster-forward-variant-gate] violated:');
  for (const h of hits) {
    console.error(`  - ${h}`);
  }
  console.error(
    '\nfeat-20260609-hdrp-cluster-fragment-ggx requires:\n' +
      '  AC-04: #pragma variant_axis CLUSTER_FORWARD_AVAILABLE + #import cluster_forward\n' +
      '  AC-07: hdrp-pipeline.ts cluster-forward pass writes hdrColor (M4)\n' +
      '  AC-08: frag_coord / 800u / 600u absent from hdrp-cluster-forward.wgsl\n' +
      '  G-13:  no new silent early-returns in the record/ cluster (Fail Fast)\n' +
      '  G-14:  no `variantSet ?` / `if (variantSet)` falsy patterns in createRenderer.ts (D-11)',
  );
  process.exit(1);
}

console.log(
  '[check-cluster-forward-variant-gate] OK -- ' +
    '#pragma variant_axis CLUSTER_FORWARD_AVAILABLE + #import cluster_forward present, ' +
    "hdrp-pipeline.ts cluster-forward writes: ['hdrColor'] present, " +
    'hardcoded viewport dimensions absent, ' +
    'G-13 silent-early-return baseline maintained, ' +
    'G-14 variantSet falsy patterns absent.',
);
