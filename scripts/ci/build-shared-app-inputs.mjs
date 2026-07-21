#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { build } from 'vite';

const HELP = `Build the shared app-neutral LearnOpenGL inputs for CI app shards.

Shared scope: one asset catalog/payload and one engine built-in shader manifest.
App boundary: each app still owns its final pack-index, deployment base, dev server,
HMR, and custom shader entries. This command does not build an app deployment.

Producer: shared-app-inputs
Consumers: app-shard-0, app-shard-1, app-shard-2
Contract: scripts/ci/build-artifact-contract.json (sharedInputs)
Validate: node scripts/ci/verify-build-artifact-input.mjs --consumer app-shard --input-root <download-dir>
Recover: rebuild this command when the manifest is missing or stale; download the
complete shared-app-inputs artifact when provenance or inventory validation fails.
The retention/fallback policy is a charter-insufficient gap; cache is only an accelerator.

Options:
  --root <dir>         Repository root (default: .)
  --out <dir>          Output directory (default: shared-app-inputs)
  --asset-root <dir>   LearnOpenGL source root
  --shader-root <dir>  Engine shader source root
  --github-output <p>  Write the trusted producer fingerprint to this output file
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const root = resolve(option('--root', '.'));
const output = resolve(root, option('--out', 'shared-app-inputs'));
const assetRoot = resolve(root, option('--asset-root', 'forgeax-engine-assets/learn-opengl'));
const shaderRoot = resolve(root, option('--shader-root', 'packages/shader/src'));
const githubOutput = option('--github-output', null);
const staging = join(output, '.build');
const VIRTUAL_ENTRY = 'virtual:forgeax/shared-app-inputs-entry';
const productionStartedAt = performance.now();

function files(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
}

async function fingerprint(roots) {
  const hash = createHash('sha256');
  for (const sourceRoot of roots) {
    for (const path of files(sourceRoot)) {
      hash.update(`${relative(root, path).replaceAll('\\', '/')}\0`);
      hash.update(await readFile(path));
    }
  }
  return hash.digest('hex');
}

for (const source of [assetRoot, shaderRoot]) {
  if (!statSync(source).isDirectory()) {
    throw new Error(`shared input source is not a directory: ${source}`);
  }
}
const assetRootRelative = relative(root, assetRoot);
if (assetRootRelative.startsWith('..')) {
  throw new Error(`--asset-root must be inside --root: ${assetRoot}`);
}
const engineShaderRoot = resolve(
  dirname(createRequire(import.meta.url).resolve('@forgeax/engine-shader/package.json')),
  'src',
);
if (realpathSync(shaderRoot) !== realpathSync(engineShaderRoot)) {
  throw new Error(
    `--shader-root must name the engine shader source compiled by forgeaxShader: ${engineShaderRoot}`,
  );
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  plugins: [
    {
      name: 'forgeax:shared-app-inputs-entry',
      resolveId(id) {
        return id === VIRTUAL_ENTRY ? id : null;
      },
      load(id) {
        return id === VIRTUAL_ENTRY ? 'export {};' : null;
      },
    },
    forgeaxShader(),
    pluginPack({ roots: [assetRoot], base: '' }),
  ],
  build: {
    emptyOutDir: true,
    outDir: staging,
    assetsInlineLimit: 0,
    rollupOptions: { input: VIRTUAL_ENTRY },
  },
});

const catalogPath = join(staging, 'pack-index.json');
const shaderManifestPath = join(staging, 'shaders', 'manifest.json');
if (!statSync(catalogPath).isFile() || !statSync(shaderManifestPath).isFile()) {
  throw new Error('shared input build did not emit a pack catalog and engine shader manifest');
}

mkdirSync(join(output, 'assets'), { recursive: true });
mkdirSync(join(output, 'shaders'), { recursive: true });
cpSync(catalogPath, join(output, 'assets', 'catalog.json'));
const payloadRoot = join(output, 'assets', 'payload');
cpSync(assetRoot, join(payloadRoot, assetRootRelative), { recursive: true });
cpSync(join(staging, 'assets'), join(payloadRoot, 'assets'), { recursive: true });
cpSync(join(staging, 'shaders'), join(output, 'shaders'), { recursive: true });
rmSync(staging, { recursive: true, force: true });

const inventory = files(output)
  .map((path) => relative(root, path).replaceAll('\\', '/'))
  .sort();
const manifest = {
  schemaVersion: 1,
  producer: 'shared-app-inputs',
  inputFingerprint: await fingerprint([assetRoot, shaderRoot]),
  inventory: ['shared-app-inputs/assets/catalog.json', 'shared-app-inputs/shaders/manifest.json'],
  payload: {
    assetCatalog: 'shared-app-inputs/assets/catalog.json',
    assetPayloadRoot: 'shared-app-inputs/assets/payload',
    engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
  },
  payloadInventory: inventory,
};
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// These counters describe work this producer actually performed. Compressed artifact
// bytes and whole-job duration are deliberately left to the reporter, which reads
// GitHub's artifact and job records after upload.
const productionFacts = {
  schemaVersion: 1,
  producer: manifest.producer,
  inputFingerprint: manifest.inputFingerprint,
  cacheState: 'cold',
  sourceScanCount: 1,
  sourceFileCount: files(assetRoot).length,
  payloadEmitCount: 2,
  engineCompileCount: 1,
  buildDurationSeconds: Number(((performance.now() - productionStartedAt) / 1000).toFixed(3)),
};
writeFileSync(
  join(output, 'production-facts.json'),
  `${JSON.stringify(productionFacts, null, 2)}\n`,
);
if (githubOutput !== null)
  appendFileSync(githubOutput, `input_fingerprint=${manifest.inputFingerprint}\n`);
process.stdout.write(`${JSON.stringify(manifest)}\n`);
