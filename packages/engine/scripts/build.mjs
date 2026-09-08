import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicEngineFacades, publicEngineMembers } from './public-facades.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const dist = resolve(packageRoot, 'dist');
const check = process.argv.includes('--check');
const members = await publicEngineMembers(repositoryRoot);

const expectedDependencyNames = members.map(({ name }) => name).sort();
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
const actualDependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
if (JSON.stringify(expectedDependencyNames) !== JSON.stringify(actualDependencyNames)) {
  throw new Error('engine-facade-dependency-drift: package dependencies must match public members');
}
if (check) process.exit(0);

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, 'facades'), { recursive: true });
await mkdir(resolve(dist, 'bin'), { recursive: true });
await writeFile(resolve(dist, 'index.mjs'), "export * from '@forgeax/engine-runtime';\n");
await writeFile(resolve(dist, 'index.d.ts'), "export * from '@forgeax/engine-runtime';\n");
for (const { source, subpath } of publicEngineFacades(members)) {
  const target = resolve(dist, 'facades', subpath);
  const facadeSource = `export * from '${source}';\n`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.mjs`, facadeSource);
  await writeFile(`${target}.d.ts`, facadeSource);
}
await writeFile(
  resolve(dist, 'bin', 'forgeax.mjs'),
  "#!/usr/bin/env node\nimport '@forgeax/engine-devkit/cli';\n",
  { mode: 0o755 },
);
