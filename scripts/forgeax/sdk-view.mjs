import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Publish the bundled tool without its contributor-only workspace packages. */
export async function stageViewToolPackage(viewRoot, packageRoot, version) {
  await mkdir(packageRoot, { recursive: true });
  const files = [
    'dist',
    'host.pack.json',
    'skills',
    'README.md',
    'LICENSE',
    'scripts/browser-proof-workload.mjs',
    'scripts/runtime-content-import.mjs',
    'scripts/verify-runtime-content-engine.mjs',
    'scripts/verify-game3d-workspace.mjs',
  ];
  for (const file of files)
    await cp(resolve(viewRoot, file), resolve(packageRoot, file), { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(viewRoot, 'package.json'), 'utf8'));
  for (const field of ['devDependencies', 'forgeax', 'bin', 'scripts']) delete manifest[field];
  delete manifest.exports['./build'];
  manifest.files = files;
  const graph = JSON.parse(await readFile(resolve(viewRoot, 'dist/native-build.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies))
    if (name.startsWith('@forgeax/view-')) delete manifest.dependencies[name];
  for (const output of Object.values(graph.outputs))
    for (const item of output.imports) {
      if (!item.external) continue;
      if (item.path.startsWith('@forgeax/view-'))
        throw new Error(`sdk-view-unbundled-workspace-package: ${item.path}`);
      if (item.path.startsWith('@forgeax/engine'))
        manifest.dependencies[item.path.split('/').slice(0, 2).join('/')] = version;
    }
  for (const name of Object.keys(manifest.dependencies))
    if (name === '@forgeax/engine' || name.startsWith('@forgeax/engine-'))
      manifest.dependencies[name] = version;
  await rm(resolve(packageRoot, 'dist/native-build.json'));
  await rm(resolve(packageRoot, 'dist/viewer/panel-graph.json'), { force: true });
  await writeFile(resolve(packageRoot, 'package.json'), JSON.stringify(manifest, null, 2));
}
