#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compressZstd } from '@forgeax/engine-codec/encode';
import { decompressZstd } from '@forgeax/engine-codec';
import { reimportReuseMeta } from '@forgeax/engine-image';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { scan } from '@forgeax/engine-pack/scanner';
import { loadGameProjectSync } from '@forgeax/engine-project';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(here, '..', '..', '..', '..');

function fail(message) { throw new Error(`[m2-content] ${message}`); }
function expectOk(result, label) {
  if (!result.ok) fail(`${label}: ${result.error.code}`);
  return result.value;
}

const project = loadGameProjectSync((path) => readFileSync(resolve(root, 'templates/game-default', path), 'utf8'));
if (!project.ok || project.value.name !== '_template') fail(`project manifest rejected: ${project.ok ? project.value.name : project.error.code}`);
console.log('[m2-content] project manifest: PASS');

const roots = [
  resolve(root, 'apps/hello/custom-importer/assets'),
  resolve(root, 'apps/hello/gltf/assets'),
  resolve(root, 'forgeax-engine-assets/learn-opengl/objects/planet'),
  resolve(root, 'forgeax-engine-assets/learn-opengl/textures/pbr/wall'),
  resolve(root, 'forgeax-engine-assets/dejavu-fonts'),
  resolve(root, 'forgeax-engine-assets/vendor/fbx-test'),
];
for (const assetRoot of roots) {
  if (!existsSync(assetRoot)) fail(`asset root missing: ${assetRoot}`);
}
const entries = expectOk(await scan(roots), 'sidecar scan');
const sidecars = entries.map((entry) => JSON.parse(readFileSync(resolve(root, entry), 'utf8')));
const importers = new Set(sidecars.map((entry) => entry.importer).filter((importer) => typeof importer === 'string'));
if (!importers.has('gltf') || !importers.has('reel-game-blob')) fail(`expected gltf + host importer entries, got ${[...importers].join(', ')}`);
const fbxEntries = sidecars.filter((entry) => entry.importer === 'fbx');
const fontPack = sidecars.find((entry) => entry.kind === 'internal-text-package' && entry.assets?.some((asset) => asset.kind === 'font'));
if (fbxEntries.length !== 2 || fontPack === undefined) fail(`expected 2 FBX sidecars + one font pack, got fbx=${fbxEntries.length}, fontPack=${fontPack !== undefined}`);
console.log(`[m2-content] sidecar scan: PASS entries=${entries.length} importers=${[...importers].sort().join(',')}`);

execFileSync('pnpm', ['--filter', '@forgeax/hello-custom-importer', 'smoke'], { cwd: root, stdio: 'inherit' });
console.log('[m2-content] host importer delivery: PASS');

execFileSync('pnpm', ['--filter', '@forgeax/hello-custom-importer', 'smoke:browser'], { cwd: root, stdio: 'inherit' });
console.log('[m2-content] browser HMR delivery: PASS');

execFileSync('node', [resolve(here, 'real-fixtures.mjs')], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@forgeax/hello-text', 'smoke'], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@forgeax/hello-fbx-cube', 'smoke'], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@forgeax/hello-fbx-skin', 'smoke'], { cwd: root, stdio: 'inherit' });
console.log('[m2-content] font + FBX fixture delivery: PASS');

const imageMetaPath = resolve(root, 'forgeax-engine-assets/learn-opengl/objects/planet/mars.png.meta.json');
const imageMeta = JSON.parse(readFileSync(imageMetaPath, 'utf8'));
const stableGuid = imageMeta.subAssets[0]?.guid;
if (typeof stableGuid !== 'string') fail('image sidecar has no stable texture GUID');
const decoded = { bytes: new Uint8Array([137, 80, 78, 71]), width: 1, height: 1, mime: 'image/png', colorSpace: 'srgb', mipmap: true };
const reused = reimportReuseMeta(decoded, imageMeta);
if (reused[0]?.guid !== stableGuid) fail(`reimport changed GUID: ${reused[0]?.guid}`);
const parsedGuid = AssetGuid.parse(stableGuid);
if (!parsedGuid.ok) fail(`stable GUID is malformed: ${parsedGuid.error.code}`);
const malformed = AssetGuid.parse('not-a-guid');
if (malformed.ok || malformed.error.code !== 'pack-guid-malformed') fail('malformed GUID did not reject structurally');
console.log(`[m2-content] GUID reimport: PASS stable=${stableGuid} malformed=${malformed.error.code}`);

const original = new Uint8Array(4096).fill(65);
const compressed = expectOk(await compressZstd(original), 'zstd encode');
const restored = expectOk(await decompressZstd(compressed), 'zstd decode');
if (restored.length !== original.length || restored.some((value, index) => value !== original[index])) fail('codec bytes changed after round-trip');
console.log(`[m2-content] codec round-trip: PASS original=${original.length} compressed=${compressed.length}`);

console.log('[m2-content] PASS - M2 partial content pipeline gates GREEN');
console.log('[m2-content] deferred: font bake in plain Node requires a Worker-capable host; semantic source-changing reimport across every importer family remains open.');
