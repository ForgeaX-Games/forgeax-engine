import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function publicEngineMembers(repositoryRoot) {
  const members = [];
  for (const entry of await readdir(resolve(repositoryRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'engine') continue;
    try {
      const manifest = JSON.parse(
        await readFile(resolve(repositoryRoot, 'packages', entry.name, 'package.json'), 'utf8'),
      );
      if (
        manifest.private !== true &&
        typeof manifest.name === 'string' &&
        manifest.name.startsWith('@forgeax/engine-')
      ) {
        members.push({ directory: entry.name, exports: manifest.exports, name: manifest.name });
      }
    } catch {
      // A non-package directory is outside the generated public facade set.
    }
  }
  return members.sort((left, right) => left.directory.localeCompare(right.directory));
}

export function publicEngineFacades(members) {
  const facades = [];
  for (const member of members) {
    const packageExports = member.exports;
    const hasRootExport =
      packageExports === undefined ||
      packageExports === null ||
      typeof packageExports !== 'object' ||
      Array.isArray(packageExports) ||
      Object.hasOwn(packageExports, '.');
    if (hasRootExport) facades.push({ subpath: member.directory, source: member.name });
    if (
      packageExports === null ||
      typeof packageExports !== 'object' ||
      Array.isArray(packageExports)
    ) {
      continue;
    }
    for (const subpath of Object.keys(packageExports)) {
      if (subpath === '.' || subpath === './package.json' || subpath.includes('*')) continue;
      const relativeSubpath = subpath.slice(2);
      facades.push({
        subpath: `${member.directory}/${relativeSubpath}`,
        source: `${member.name}/${relativeSubpath}`,
      });
    }
  }
  return facades;
}

export function publicEngineFacadeSubpaths(members) {
  return new Set(publicEngineFacades(members).map(({ subpath }) => subpath));
}
