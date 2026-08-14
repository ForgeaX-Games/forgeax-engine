#!/usr/bin/env node
// Produce the app-neutral engine inputs consumed by every app build.
// Asset catalogs intentionally do not belong here: roots and deployment URL
// projection remain app-owned. CI may use its separate LearnOpenGL producer.

import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { build } from 'vite';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    'Usage: node scripts/build-shared-inputs.mjs [--root <dir>] [--out <dir>]\n',
  );
  process.exit(0);
}

const root = resolve(option('--root', '.'));
const output = resolve(root, option('--out', 'shared-build-inputs'));
const staging = join(output, '.build');
const virtualEntry = 'virtual:forgeax/repo-build-inputs-entry';
const sourceRoots = [
  join(root, 'packages/shader/src'),
  join(root, 'packages/vfx-render/src/shaders'),
];

function files(directory) {
  if (!statSync(directory).isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
}

function fingerprint(paths) {
  const hash = createHash('sha256');
  for (const path of paths.flatMap(files).sort()) {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
  }
  return `sha256:${hash.digest('hex')}`;
}

for (const sourceRoot of sourceRoots) {
  if (!statSync(sourceRoot).isDirectory())
    throw new Error(`shared shader source is not a directory: ${sourceRoot}`);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const startedAt = performance.now();
await build({
  configFile: false,
  root,
  logLevel: 'warn',
  plugins: [
    {
      name: 'forgeax:repo-build-inputs-entry',
      resolveId(id) {
        return id === virtualEntry ? id : null;
      },
      load(id) {
        return id === virtualEntry ? 'export {};' : null;
      },
    },
    forgeaxShader({
      engineEntries: {
        pointShadows: process.argv.includes('--point-shadows'),
        hdrpSsao: process.argv.includes('--hdrp-ssao'),
      },
    }),
  ],
  build: {
    emptyOutDir: true,
    outDir: staging,
    assetsInlineLimit: 0,
    rollupOptions: { input: virtualEntry },
  },
});

const shaderManifest = join(staging, 'shaders/manifest.json');
if (!statSync(shaderManifest).isFile())
  throw new Error('shared shader producer did not emit manifest.json');
mkdirSync(join(output, 'shaders'), { recursive: true });
cpSync(join(staging, 'shaders'), join(output, 'shaders'), { recursive: true });
rmSync(staging, { recursive: true, force: true });

const outputRelative = relative(root, output).replaceAll('\\', '/');
const inventory = files(output)
  .map((path) => relative(root, path).replaceAll('\\', '/'))
  .sort();
const manifest = {
  schemaVersion: 2,
  producer: 'repo-build-inputs',
  inputFingerprint: fingerprint(sourceRoots),
  payload: { engineShaderManifest: `${outputRelative}/shaders/manifest.json` },
  inventory: inventory.length > 0 ? inventory : [`${outputRelative}/shaders/manifest.json`],
};
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const facts = {
  schemaVersion: 2,
  producer: manifest.producer,
  inputFingerprint: manifest.inputFingerprint,
  engineShaderCompileCount: 1,
  assetCookHitCount: 0,
  assetCookMissCount: 0,
  assetCookWriteFailureCount: 0,
  stageDurationMs: { producer: Number((performance.now() - startedAt).toFixed(1)) },
};
writeFileSync(join(output, 'production-facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...manifest, facts })}\n`);
