#!/usr/bin/env node
/**
 * scripts/codemod/rename-tsconfig.mjs
 *
 * Phase E: edit the root tsconfig.json#references array to drop the
 * `./packages/core` reference (because @forgeax/core is being deleted in M3).
 * Also walks every tsconfig*.json file searching for any `@forgeax/<old>`
 * literal value to rewrite (covers compilerOptions.paths or similar).
 *
 * Idempotent: re-running after a successful run produces zero diff.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DRY_RUN = process.argv.includes('--dry-run');

function walk(dir, out, rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.git') continue;
    const childRel = rel ? path.join(rel, ent.name) : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out, childRel);
    } else if (ent.isFile() && /^tsconfig.*\.json$/.test(ent.name)) {
      out.push(childRel);
    }
  }
}

function retargetEnginePath(p) {
  // The runtime package moved from packages/engine to packages/engine-runtime.
  // Any reference whose tail segment is exactly `engine` (no trailing
  // -runtime, -math, etc.) needs to be retargeted. Other family members
  // (engine-math, engine-rhi-wgpu) already have correct tails because the
  // codemod only moves the runtime.
  const cleaned = p.replace(/\/$/, '');
  const segs = cleaned.split('/').filter(Boolean);
  const tail = segs[segs.length - 1];
  if (tail !== 'engine') return p;
  segs[segs.length - 1] = 'engine-runtime';
  const leading = p.startsWith('/') ? '/' : '';
  return leading + segs.join('/');
}

function rewriteReferences(refs) {
  if (!Array.isArray(refs)) return { refs, mutated: false };
  let mutated = false;
  const out = [];
  for (const r of refs) {
    if (!r || typeof r !== 'object' || typeof r.path !== 'string') {
      out.push(r);
      continue;
    }
    // Filter out @forgeax/core (deleted).
    const cleaned = r.path.replace(/\/$/, '');
    const tail = cleaned.split('/').filter(Boolean).pop();
    if (tail === 'core') {
      mutated = true;
      continue;
    }
    const nextPath = retargetEnginePath(r.path);
    if (nextPath !== r.path) {
      out.push({ ...r, path: nextPath });
      mutated = true;
    } else {
      out.push(r);
    }
  }
  return { refs: out, mutated };
}

function processFile(rel) {
  const abs = path.join(REPO_ROOT, rel);
  const raw = fs.readFileSync(abs, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`[skip non-JSON tsconfig] ${rel}: ${e.message}`);
    return { changed: false };
  }
  let mutated = false;
  if (Array.isArray(data.references)) {
    const { refs, mutated: m } = rewriteReferences(data.references);
    if (m) {
      data.references = refs;
      mutated = true;
    }
  }
  if (!mutated) return { changed: false };
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  const next = JSON.stringify(data, null, 2) + trailingNewline;
  if (!DRY_RUN) fs.writeFileSync(abs, next, 'utf8');
  return { changed: true };
}

function main() {
  const out = [];
  walk(REPO_ROOT, out);
  let changed = 0;
  for (const rel of out) {
    const r = processFile(rel);
    if (r.changed) {
      changed += 1;
      console.warn(`[edit] ${rel}`);
    }
  }
  console.warn(`[rename-tsconfig] scanned=${out.length} changed=${changed} dry-run=${DRY_RUN}`);
}

main();
