import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const sourceRoot = resolve(root, 'packages/shader/src');
const outputRoot = resolve(root, 'packages/vite-plugin-shader/dist/engine-inputs');
const inputIndex = process.argv.indexOf('--input');
const inputRoot = resolve(
  root,
  inputIndex >= 0
    ? (process.argv[inputIndex + 1] ?? 'shared-build-inputs-release')
    : 'shared-build-inputs-release',
);
const importPattern = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/m;

const imports = {};
for (const name of (await readdir(sourceRoot)).filter((entry) => entry.endsWith('.wgsl')).sort()) {
  const source = await readFile(resolve(sourceRoot, name), 'utf8');
  const identifier = importPattern.exec(source)?.[1];
  if (identifier !== undefined) imports[identifier] = source;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const profiles = ['base-base', 'point-base', 'base-ssao', 'point-ssao'];
await Promise.all(
  profiles.map(async (profile) => {
    const target = resolve(outputRoot, profile);
    await mkdir(target, { recursive: true });
    await Promise.all([
      cp(resolve(inputRoot, profile, 'shaders/manifest.json'), resolve(target, 'manifest.json')),
      writeFile(resolve(target, 'imports.json'), `${JSON.stringify(imports, null, 2)}\n`),
    ]);
  }),
);

process.stdout.write(
  `${JSON.stringify({ outputRoot, profiles, imports: Object.keys(imports).length }, null, 2)}\n`,
);
