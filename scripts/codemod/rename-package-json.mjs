#!/usr/bin/env node
/**
 * scripts/codemod/rename-package-json.mjs
 *
 * Phase A: rewrite every workspace package.json's `name`, `dependencies`,
 * `devDependencies`, `peerDependencies`, and `optionalDependencies` so that
 * any `@forgeax/<old>` key or string value becomes `@forgeax/engine-<new>`,
 * per rename-map.json (SSOT). Also rewrites `description` text occurrences.
 *
 * Special cases:
 *   - templates/threejs-mvp/package.json#name: the template uses
 *     `@forgeax/engine` as its name (because it ships with that placeholder
 *     today); rename to `@forgeax/engine-template-threejs-mvp`. This overrides
 *     the default engine→engine-runtime rule for this one file.
 *   - packages/console/package.json#bin: the key `forgeax` → `forgeax-engine-console`.
 *   - packages/engine/package.json#name remains `@forgeax/engine` AFTER the
 *     placeholder takeover (handled by phase-g-placeholder.mjs), but BEFORE
 *     that the rewrite is engine → engine-runtime. To keep this script
 *     idempotent, the bare-engine rename uses literal equality, not regex.
 *
 * Idempotency: re-running on already-renamed packages produces zero diff.
 *
 * Usage:
 *   node scripts/codemod/rename-package-json.mjs            (rewrite)
 *   node scripts/codemod/rename-package-json.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DRY_RUN = process.argv.includes('--dry-run');

const ENTRIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'rename-map.json'), 'utf8'));
const DICT = new Map(ENTRIES.map((e) => [e.old, e.new]));

const TEMPLATE_NAME_OVERRIDE = {
  // templates/threejs-mvp historically uses `@forgeax/engine` as its own name.
  // Override to a dedicated template name (decisions D-01 + plan-strategy §1).
  path: path.join('templates', 'threejs-mvp', 'package.json'),
  oldName: '@forgeax/engine',
  newName: '@forgeax/engine-template-threejs-mvp',
};

const CONSOLE_BIN_OVERRIDE = {
  // packages/console/package.json#bin: the key `forgeax` → `forgeax-engine-console`
  // (decisions D-02). Phase F per the plan, but we do it here for idempotency
  // and because the file is the same.
  path: path.join('packages', 'console', 'package.json'),
  oldKey: 'forgeax',
  newKey: 'forgeax-engine-console',
};

function* iterPackageJsonPaths() {
  // Workspaces: packages/*/package.json, apps/*/package.json,
  // templates/*/package.json, and the root package.json.
  const candidates = [
    'package.json',
    ...listSubdirs('packages').map((d) => path.join('packages', d, 'package.json')),
    ...listSubdirs('apps').map((d) => path.join('apps', d, 'package.json')),
    ...listSubdirs('templates').map((d) => path.join('templates', d, 'package.json')),
  ];
  for (const rel of candidates) {
    const abs = path.join(REPO_ROOT, rel);
    if (fs.existsSync(abs)) yield rel;
  }
}

function listSubdirs(rel) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function renameString(str) {
  // Literal equality only — never substring match.
  return DICT.has(str) ? DICT.get(str) : str;
}

function renameDepsObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  let mutated = false;
  for (const k of Object.keys(obj)) {
    const nk = DICT.has(k) ? DICT.get(k) : k;
    if (nk !== k) mutated = true;
    // Deduplicate when @forgeax/core → @forgeax/engine-ecs collides with an
    // existing @forgeax/ecs key. The merge winner is the value of @forgeax/ecs
    // (already correct); just drop the core entry.
    if (nk in out) {
      mutated = true;
      continue;
    }
    out[nk] = obj[k];
  }
  return mutated ? out : obj;
}

function renameDescription(desc) {
  if (typeof desc !== 'string') return desc;
  let next = desc;
  for (const e of ENTRIES) {
    if (e.old === '@forgeax/engine') continue;
    if (next.indexOf(e.old) !== -1) {
      next = next.split(e.old).join(e.new);
    }
  }
  // Bare @forgeax/engine with look-ahead anchor.
  next = next.replace(/@forgeax\/engine(?![-\w])/g, '@forgeax/engine-runtime');
  return next;
}

function processPackageJson(rel) {
  const abs = path.join(REPO_ROOT, rel);
  const raw = fs.readFileSync(abs, 'utf8');
  const pkg = JSON.parse(raw);
  let mutated = false;

  if (typeof pkg.name === 'string') {
    let nextName;
    if (rel === TEMPLATE_NAME_OVERRIDE.path && pkg.name === TEMPLATE_NAME_OVERRIDE.oldName) {
      nextName = TEMPLATE_NAME_OVERRIDE.newName;
    } else {
      nextName = renameString(pkg.name);
    }
    if (nextName !== pkg.name) {
      pkg.name = nextName;
      mutated = true;
    }
  }

  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkg[k]) {
      const next = renameDepsObject(pkg[k]);
      if (next !== pkg[k]) {
        pkg[k] = next;
        mutated = true;
      }
    }
  }

  if (typeof pkg.description === 'string') {
    const nextDesc = renameDescription(pkg.description);
    if (nextDesc !== pkg.description) {
      pkg.description = nextDesc;
      mutated = true;
    }
  }

  // bin key rename (special for packages/console/package.json)
  if (rel === CONSOLE_BIN_OVERRIDE.path && pkg.bin && typeof pkg.bin === 'object') {
    if (CONSOLE_BIN_OVERRIDE.oldKey in pkg.bin) {
      const value = pkg.bin[CONSOLE_BIN_OVERRIDE.oldKey];
      const nextBin = {};
      for (const k of Object.keys(pkg.bin)) {
        if (k === CONSOLE_BIN_OVERRIDE.oldKey) {
          nextBin[CONSOLE_BIN_OVERRIDE.newKey] = value;
        } else {
          nextBin[k] = pkg.bin[k];
        }
      }
      pkg.bin = nextBin;
      mutated = true;
    }
  }

  if (!mutated) return { changed: false };
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  const next = JSON.stringify(pkg, null, 2) + trailingNewline;
  if (!DRY_RUN) fs.writeFileSync(abs, next, 'utf8');
  return { changed: true };
}

function main() {
  let changed = 0;
  let scanned = 0;
  for (const rel of iterPackageJsonPaths()) {
    scanned += 1;
    const r = processPackageJson(rel);
    if (r.changed) {
      changed += 1;
      console.warn(`[edit] ${rel}`);
    }
  }
  console.warn(`[rename-package-json] scanned=${scanned} changed=${changed} dry-run=${DRY_RUN}`);
}

main();
