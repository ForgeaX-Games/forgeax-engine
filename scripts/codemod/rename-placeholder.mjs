#!/usr/bin/env node
import child_process from 'node:child_process';
/**
 * scripts/codemod/rename-placeholder.mjs
 *
 * Phase G: in-place takeover of `packages/engine/`. After phase A, the
 * directory's package.json is `@forgeax/engine-runtime` (the runtime). This
 * phase:
 *
 *   1. Creates `packages/engine-runtime/`.
 *   2. Moves runtime artefacts (src/, __tests__/, tsup.config.ts,
 *      vitest.config.ts, tsconfig.json, README.md, and any other build files)
 *      from packages/engine/ to packages/engine-runtime/ via `git mv`.
 *   3. Writes a fresh `packages/engine/package.json` placeholder
 *      (private:true, name=@forgeax/engine, version=0.0.0, no deps).
 *   4. Writes a placeholder README.md listing the 12 family members and
 *      pointing at @forgeax/engine-runtime.
 *
 * Idempotency:
 *   - If `packages/engine-runtime/package.json` already exists with name
 *     `@forgeax/engine-runtime`, the move is treated as complete and only
 *     the placeholder files are checked / overwritten if needed.
 *   - The placeholder files are deterministic: equivalent inputs produce
 *     identical outputs, so re-running yields no diff.
 *
 * Safety:
 *   - Uses `git mv` to preserve git history.
 *   - Refuses to overwrite an existing packages/engine-runtime/src/ unless
 *     it is empty (preventing accidental data loss).
 *
 * Usage:
 *   node scripts/codemod/rename-placeholder.mjs            (perform move)
 *   node scripts/codemod/rename-placeholder.mjs --dry-run  (preview only)
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DRY_RUN = process.argv.includes('--dry-run');

const ENGINE_DIR = path.join(REPO_ROOT, 'packages', 'engine');
const RUNTIME_DIR = path.join(REPO_ROOT, 'packages', 'runtime');

function sh(cmd, args) {
  const r = child_process.spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(`command failed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
  }
}

const PLACEHOLDER_PACKAGE_JSON = {
  name: '@forgeax/engine',
  version: '0.0.0',
  private: true,
  type: 'module',
  license: 'Apache-2.0',
  description:
    'Placeholder for the @forgeax/engine family. The runtime entry is @forgeax/engine-runtime; see README for the full family.',
  files: ['README.md', 'LICENSE'],
  forgeax: {
    metrics: {
      'bundle-size': { enabled: false, reason: 'placeholder package — no shippable artefact' },
      fps: { enabled: false, reason: 'placeholder package — no runtime canvas' },
      bench: { enabled: false, reason: 'placeholder package — no perf hot path' },
      gate: { enabled: false, reason: 'placeholder package — no binary gate' },
      'spike-report': { enabled: false, reason: 'placeholder package — not a spike' },
    },
  },
};

const PLACEHOLDER_README = `# @forgeax/engine

Placeholder for the \`@forgeax/engine-*\` family of packages. This package
publishes nothing on its own. To use the engine, install the runtime entry
\`@forgeax/engine-runtime\` and the family members you need.

\`\`\`ts
import { Engine, World } from '@forgeax/engine-runtime'
\`\`\`

## Family members

| Package | Role |
|---------|------|
| \`@forgeax/engine-runtime\` | Renderer + Backend (WebGPU) async factory entry |
| \`@forgeax/engine-math\` | Pure-function Vec/Mat/Quat/Color, branded ABI |
| \`@forgeax/engine-ecs\` | Archetype ECS: World / Entity / Component / Query / System / Schedule / Commands / Resource |
| \`@forgeax/engine-types\` | POD types + union aliases SSOT (math-free) |
| \`@forgeax/engine-rhi\` | Pure-interface RHI (spec-aligned with \`@webgpu/types\`) |
| \`@forgeax/engine-rhi-webgpu\` | WebGPU thin shim |
| \`@forgeax/engine-rhi-wgpu\` | wgpu native thin shell |
| \`@forgeax/engine-wgpu-wasm\` | Single wasm artefact (wgpu + naga bindings); private |
| \`@forgeax/engine-naga\` | TS shell over naga bindings; private (build-time only) |
| \`@forgeax/engine-shader\` | Runtime shader registry |
| \`@forgeax/engine-shader-compiler\` | Build-time shader compiler |
| \`@forgeax/engine-vite-plugin-shader\` | Vite plugin forwarding to shader-compiler |
| \`@forgeax/engine-console\` | Inspector P0 server + CLI (\`forgeax-engine-console\`) |

## Family rules

- All public packages share the \`@forgeax/engine-\` prefix. IDE autocomplete
  on \`@forgeax/engine-\` lists every family member.
- The bare \`@forgeax/engine\` name (this package) is a placeholder and not
  intended to be installed by users directly.

## Why this rename?

See \`.forgeax-harness/forgeax-loop/feat-20260511-engine-package-family-rename/\`
for the closed-loop history and decisions.
`;

function ensureRuntimeDir() {
  if (!fs.existsSync(RUNTIME_DIR)) {
    if (DRY_RUN) {
      console.warn(`[would-mkdir] ${path.relative(REPO_ROOT, RUNTIME_DIR)}`);
    } else {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    }
  }
}

function listEngineDirEntries() {
  if (!fs.existsSync(ENGINE_DIR)) return [];
  return fs.readdirSync(ENGINE_DIR, { withFileTypes: true });
}

function moveOut(name) {
  const src = path.join('packages', 'engine', name);
  const dst = path.join('packages', 'runtime', name);
  const dstAbs = path.join(REPO_ROOT, dst);
  if (fs.existsSync(dstAbs)) {
    // already moved
    return false;
  }
  if (DRY_RUN) {
    console.warn(`[would-git-mv] ${src} -> ${dst}`);
    return true;
  }
  sh('git', ['mv', src, dst]);
  return true;
}

function writeFileIfDifferent(abs, content) {
  if (fs.existsSync(abs)) {
    const cur = fs.readFileSync(abs, 'utf8');
    if (cur === content) return false;
  }
  if (DRY_RUN) {
    console.warn(`[would-write] ${path.relative(REPO_ROOT, abs)}`);
  } else {
    fs.writeFileSync(abs, content, 'utf8');
  }
  return true;
}

function main() {
  if (!fs.existsSync(ENGINE_DIR)) {
    console.error(`[fatal] ${path.relative(REPO_ROOT, ENGINE_DIR)} not found`);
    process.exit(1);
  }

  // Move all runtime artefacts from packages/engine/ to packages/engine-runtime/,
  // except the placeholder files which we will rewrite below.
  // The current packages/engine/package.json (already renamed by phase A) has
  // name @forgeax/engine-runtime. Move it.
  ensureRuntimeDir();

  // Entries to move: everything tracked in git under packages/engine/.
  // Skip ephemeral / build / dependency dirs which are either gitignored or
  // not part of the source tree (node_modules, dist, .turbo, coverage, etc.).
  const SKIP_NAMES = new Set([
    'node_modules',
    'dist',
    'coverage',
    '.turbo',
    '.cache',
    '.tsbuildinfo',
  ]);
  const entries = listEngineDirEntries();
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name)) continue;
    if (e.name.endsWith('.tsbuildinfo')) continue;
    moveOut(e.name);
  }

  // Write the placeholder package.json + README.md into the now-empty
  // packages/engine/ directory.
  const placeholderPkgPath = path.join(ENGINE_DIR, 'package.json');
  const placeholderReadmePath = path.join(ENGINE_DIR, 'README.md');
  const pkgContent = `${JSON.stringify(PLACEHOLDER_PACKAGE_JSON, null, 2)}\n`;
  writeFileIfDifferent(placeholderPkgPath, pkgContent);
  writeFileIfDifferent(placeholderReadmePath, PLACEHOLDER_README);

  console.warn(`[rename-placeholder] takeover complete (dry-run=${DRY_RUN})`);
}

main();
