#!/usr/bin/env node
// bevy-coverage-audit.mjs — coverage map of Bevy's examples vs forgeax apps.
//
// The North-Star for the forgeax-solo `bevy-examples` loop is "reproduce every
// demo on bevy.org/examples". This script answers, mechanically, "which ones do
// we already cover?" so a demo round starts by READING coverage, not guessing it.
//
// Design (mirrors the forgeax.metrics SSOT pattern, scripts/check-metrics-declared.mjs):
//   - Each app SELF-DECLARES the Bevy demo it reproduces in
//     package.json#forgeax.bevyExample = { name, category, status, shelvedFeedback? }.
//     `name` is the join key — it matches a Bevy [[example]] `name` in Cargo.toml.
//   - The Bevy demo list is DERIVED from the synced Bevy checkout's Cargo.toml
//     (architecture-principle §2 Derive, Don't Duplicate) — never hand-copied here.
//   - This is a LOOP INSTRUMENT, not a CI gate: the Bevy checkout lives under the
//     gitignored .forgeax-harness/ and is ABSENT in CI + fresh worktrees. When the
//     checkout is missing the script degrades gracefully (§9): it prints the
//     forgeax-side declared map and exits 0, never a hard red.
//   - When the checkout IS present it also VALIDATES: a declared bevyExample.name
//     that is not a real Bevy example fails structured [reason]/[rerun]/[hint].
//
// Usage:
//   node scripts/bevy-coverage-audit.mjs [--root <dir>] [--bevy <cargoTomlPath>]
//                                        [--json] [--category <name>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const args = { json: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) args.root = argv[++i];
  else if (argv[i] === '--bevy' && argv[i + 1]) args.bevy = argv[++i];
  else if (argv[i] === '--category' && argv[i + 1]) args.category = argv[++i];
  else if (argv[i] === '--json') args.json = true;
}

const root = resolve(args.root ?? process.cwd());
const bevyCargo = resolve(
  args.bevy ?? `${root}/.forgeax-harness/knowledge-base/references/repos/bevy/Cargo.toml`,
);

function fail(code, expected, hint) {
  process.stderr.write(
    `[reason] ${code}: ${expected}\n[rerun]  node scripts/bevy-coverage-audit.mjs\n[hint]   ${hint}\n`,
  );
  process.exit(1);
}

// --- 1. Enumerate apps + read self-declared forgeax.bevyExample ------------
// Recursive walk of apps/ (globs nest: apps/*, apps/hello/*, apps/learn-render/*/*).
// An app = a dir with a package.json; we stop descending once one is found.
function findAppPackageJsons(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath) && dir !== resolve(root, 'apps')) {
    acc.push(pkgPath);
    return acc; // don't descend into an app's own subdirs (node_modules etc.)
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    findAppPackageJsons(join(dir, e.name), acc);
  }
  return acc;
}

const VALID_STATUS = new Set(['implemented', 'partial', 'shelved']);
/** @type {{app:string, name:string, category?:string, status:string, shelvedFeedback?:string}[]} */
const declared = [];
for (const pkgPath of findAppPackageJsons(resolve(root, 'apps'))) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    fail('bevy-example-malformed', `${pkgPath} is valid JSON`, `parse error: ${e.message}`);
  }
  const be = pkg?.forgeax?.bevyExample;
  if (be == null) continue;
  const decls = Array.isArray(be) ? be : [be]; // an app may reproduce >1 demo
  for (const d of decls) {
    if (!d || typeof d !== 'object' || typeof d.name !== 'string' || !d.name) {
      fail(
        'bevy-example-malformed',
        `${pkg.name}.forgeax.bevyExample has a string 'name'`,
        `see the field shape in scripts/bevy-coverage-audit.mjs header; got ${JSON.stringify(d)}`,
      );
    }
    if (!VALID_STATUS.has(d.status)) {
      fail(
        'bevy-example-status-unknown',
        `${pkg.name}.forgeax.bevyExample.status in {implemented, partial, shelved}`,
        `got '${d.status}' for demo '${d.name}'`,
      );
    }
    declared.push({
      app: pkg.name,
      name: d.name,
      category: d.category,
      status: d.status,
      shelvedFeedback: d.shelvedFeedback,
    });
  }
}

// --- 2. Derive the Bevy demo list from Cargo.toml (SSOT) -------------------
// Narrow line parser: we need only [[example]] name+path and the paired
// [package.metadata.example.<name>] category/description/wasm/hidden. A full
// TOML dep is unwarranted for two block shapes.
function parseBevyExamples(tomlText) {
  const lines = tomlText.split('\n');
  /** @type {Map<string,{name:string, path?:string, display?:string, description?:string, category?:string, wasm?:boolean, hidden?:boolean}>} */
  const byName = new Map();
  let section = null; // {kind:'example'} | {kind:'meta', name}
  const str = (v) => v.trim().replace(/^"(.*)"$/, '$1');
  let pendingExampleName = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '[[example]]') {
      section = { kind: 'example' };
      pendingExampleName = null;
      continue;
    }
    const meta = line.match(/^\[package\.metadata\.example\.([A-Za-z0-9_]+)\]$/);
    if (meta) {
      section = { kind: 'meta', name: meta[1] };
      if (!byName.has(meta[1])) byName.set(meta[1], { name: meta[1] });
      continue;
    }
    if (line.startsWith('[')) {
      section = null; // left the blocks we care about
      continue;
    }
    if (!section || !line.includes('=')) continue;
    const [k, ...rest] = line.split('=');
    const key = k.trim();
    const val = rest.join('=').trim();
    if (section.kind === 'example') {
      if (key === 'name') {
        pendingExampleName = str(val);
        if (!byName.has(pendingExampleName))
          byName.set(pendingExampleName, { name: pendingExampleName });
      } else if (key === 'path' && pendingExampleName) {
        byName.get(pendingExampleName).path = str(val);
      }
    } else if (section.kind === 'meta') {
      const rec = byName.get(section.name);
      if (key === 'name') rec.display = str(val);
      else if (key === 'description') rec.description = str(val);
      else if (key === 'category') rec.category = str(val);
      else if (key === 'wasm') rec.wasm = val.trim() === 'true';
      else if (key === 'hidden') rec.hidden = val.trim() === 'true';
    }
  }
  return byName;
}

const bevyPresent = existsSync(bevyCargo) && statSync(bevyCargo).isFile();

// --- 3. Graceful degrade when the Bevy checkout is absent (CI / fresh wt) --
if (!bevyPresent) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ bevyCheckout: 'absent', declared }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[note] Bevy checkout absent at ${bevyCargo}\n` +
        `       (it lives under gitignored .forgeax-harness/ — expected in CI / fresh worktrees).\n` +
        `       Showing forgeax-side declared coverage only; run locally with the checkout\n` +
        `       synced (references/sync-references.sh bevy) for the full Bevy join.\n\n` +
        `forgeax apps declaring a Bevy demo: ${declared.length}\n`,
    );
    for (const d of declared.sort((a, b) => a.name.localeCompare(b.name))) {
      process.stdout.write(`  ${d.status.padEnd(11)} ${d.name}  (${d.app})\n`);
    }
  }
  process.exit(0);
}

const bevy = parseBevyExamples(readFileSync(bevyCargo, 'utf8'));

// --- 4. Validate declared names against the Bevy SSOT ----------------------
for (const d of declared) {
  if (!bevy.has(d.name)) {
    fail(
      'bevy-example-unknown',
      `bevyExample.name '${d.name}' (declared by ${d.app}) is a real Bevy example`,
      `no [[example]] name='${d.name}' in ${bevyCargo}; check spelling against Cargo.toml`,
    );
  }
}

// --- 5. Join + per-category coverage --------------------------------------
const declaredByName = new Map();
for (const d of declared) {
  if (!declaredByName.has(d.name)) declaredByName.set(d.name, []);
  declaredByName.get(d.name).push(d);
}

/** @type {Map<string,{total:number, covered:number, shelved:number, uncovered:string[]}>} */
const cats = new Map();
for (const ex of bevy.values()) {
  if (ex.hidden) continue; // hidden examples aren't user-facing demos
  const cat = ex.category ?? '(uncategorized)';
  if (!cats.has(cat)) cats.set(cat, { total: 0, covered: 0, shelved: 0, uncovered: [] });
  const c = cats.get(cat);
  c.total++;
  const decls = declaredByName.get(ex.name);
  if (decls?.some((d) => d.status === 'implemented' || d.status === 'partial')) c.covered++;
  else if (decls?.some((d) => d.status === 'shelved')) c.shelved++;
  else c.uncovered.push(ex.display ?? ex.name);
}

if (args.json) {
  const out = {};
  for (const [cat, c] of [...cats].sort()) out[cat] = c;
  process.stdout.write(
    `${JSON.stringify({ bevyCheckout: 'present', categories: out, declared }, null, 2)}\n`,
  );
  process.exit(0);
}

// --- 6. Human report ------------------------------------------------------
const entries = [...cats].sort((a, b) => b[1].total - a[1].total);
let gTotal = 0,
  gCovered = 0,
  gShelved = 0;
process.stdout.write(
  'Bevy examples ↔ forgeax coverage (SSOT: Bevy Cargo.toml + apps forgeax.bevyExample)\n\n',
);
process.stdout.write('  category                        covered  shelved  uncovered  total\n');
process.stdout.write(`  ${'-'.repeat(70)}\n`);
for (const [cat, c] of entries) {
  if (args.category && cat !== args.category) continue;
  gTotal += c.total;
  gCovered += c.covered;
  gShelved += c.shelved;
  process.stdout.write(
    `  ${cat.padEnd(30)} ${String(c.covered).padStart(7)} ${String(c.shelved).padStart(8)} ${String(c.uncovered.length).padStart(10)} ${String(c.total).padStart(6)}\n`,
  );
}
process.stdout.write(`  ${'-'.repeat(70)}\n`);
process.stdout.write(
  `  ${'TOTAL'.padEnd(30)} ${String(gCovered).padStart(7)} ${String(gShelved).padStart(8)} ${String(gTotal - gCovered - gShelved).padStart(10)} ${String(gTotal).padStart(6)}\n\n`,
);

// uncovered detail for the focused category (or all when --category given)
for (const [cat, c] of entries) {
  if (args.category && cat !== args.category) continue;
  if (!args.category && c.uncovered.length > 0 && c.covered + c.shelved === 0) continue; // skip fully-untouched noise in the overview
  if (c.uncovered.length === 0) continue;
  if (!args.category && c.covered + c.shelved === 0) continue;
  process.stdout.write(`  uncovered in ${cat} (${c.uncovered.length}):\n`);
  for (const n of c.uncovered.sort()) process.stdout.write(`    - ${n}\n`);
  process.stdout.write('\n');
}

process.stdout.write(
  `[ok] ${gCovered}/${gTotal} demos covered, ${gShelved} shelved, ${gTotal - gCovered - gShelved} untouched across ${cats.size} categories\n`,
);
