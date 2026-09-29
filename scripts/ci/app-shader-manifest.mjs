#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const APP_SHADER_MANIFEST_DELTA = 'forgeax-app-shader-manifest-delta-v1';

function fail(message) {
  throw new Error(message);
}

function readJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(
      `${description} is not valid JSON: ${path}; ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function manifestRows(value, path, field) {
  if (!Array.isArray(value?.[field])) fail(`${path} is missing a ${field} array`);
  return value[field];
}

function materialShaderKey(entry) {
  return `${entry?.identifier ?? ''}\0${entry?.sourcePath ?? ''}`;
}

function compactSourceTable(publication, entries, materialShaders) {
  if (
    !Array.isArray(publication.fragments) ||
    !publication.sources ||
    typeof publication.sources !== 'object' ||
    Array.isArray(publication.sources)
  ) {
    fail('compact shader manifest is missing fragments or sources');
  }
  const digests = new Set([
    ...entries.map((entry) => entry?.sourceDigest),
    ...materialShaders.flatMap((entry) => [
      entry?.sourceDigest,
      ...(Array.isArray(entry?.variants)
        ? entry.variants.map((variant) => variant?.sourceDigest)
        : []),
    ]),
  ]);
  const fragments = [];
  const indicesByFragment = new Map();
  const sources = {};
  for (const digest of [...digests].sort()) {
    if (
      typeof digest !== 'string' ||
      !Array.isArray(publication.sources[digest]) ||
      publication.sources[digest].length === 0
    ) {
      fail(`compact shader source is missing: ${String(digest)}`);
    }
    sources[digest] = publication.sources[digest].map((sourceIndex) => {
      const fragment = publication.fragments[sourceIndex];
      if (!Number.isSafeInteger(sourceIndex) || typeof fragment !== 'string') {
        fail(`compact shader source has an invalid fragment: ${digest}`);
      }
      let index = indicesByFragment.get(fragment);
      if (index === undefined) {
        index = fragments.length;
        fragments.push(fragment);
        indicesByFragment.set(fragment, index);
      }
      return index;
    });
  }
  return { fragments, sources };
}

function isWithinRoot(root, path) {
  const child = relative(root, path);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

/**
 * Resolve the producer-owned shared shader manifest from either the normal
 * shared-app-inputs extraction layout or the flat layout used by combined
 * build-artifact downloads.
 */
export function readSharedShaderManifest(root, requestedManifest) {
  const requestedPath = resolve(root, requestedManifest);
  const manifestCandidates = [requestedPath, resolve(root, 'manifest.json')].filter(
    (path, index, paths) => paths.indexOf(path) === index,
  );
  const manifestPath = manifestCandidates.find((path) => existsSync(path));
  if (manifestPath === undefined) {
    fail(
      `shared app input manifest is missing: ${manifestCandidates
        .map((path) => relative(root, path))
        .join(', ')}`,
    );
  }

  const wrapper = readJson(manifestPath, 'shared app input manifest');
  const sourceRelative = wrapper?.payload?.engineShaderManifest;
  if (
    wrapper?.schemaVersion !== 1 ||
    wrapper?.producer !== 'shared-app-inputs' ||
    typeof sourceRelative !== 'string'
  ) {
    fail(`shared app input manifest has incompatible producer metadata: ${manifestPath}`);
  }

  const sourceCandidates = [
    resolve(root, sourceRelative),
    resolve(dirname(manifestPath), sourceRelative.replace(/^shared-app-inputs\//, '')),
  ].filter((path, index, paths) => isWithinRoot(root, path) && paths.indexOf(path) === index);
  const sourcePath = sourceCandidates.find((path) => existsSync(path));
  if (sourcePath === undefined) {
    fail(
      `shared engine shader manifest is missing: ${sourceCandidates
        .map((path) => relative(root, path))
        .join(', ')}`,
    );
  }

  const shaderManifest = readJson(sourcePath, 'shared engine shader manifest');
  manifestRows(shaderManifest, sourcePath, 'entries');
  // Older shared-input manifests did not declare materialShaders because no
  // material-owned rows were present. Treat that form as an empty collection
  // so consumers can still materialize the same runtime manifest.
  const manifest = {
    ...shaderManifest,
    materialShaders: Array.isArray(shaderManifest.materialShaders)
      ? shaderManifest.materialShaders
      : [],
  };
  return { manifestPath, sourcePath, manifest };
}

/**
 * Remove the byte-identical shared engine rows from one app manifest. The
 * marker is transport metadata only; consumers replace it with the merged
 * runtime manifest before any smoke or browser process starts.
 */
export function projectAppShaderManifest(appManifest, sharedManifest, sourcePath = 'app manifest') {
  const appEntries = manifestRows(appManifest, sourcePath, 'entries');
  const appMaterialShaders = manifestRows(appManifest, sourcePath, 'materialShaders');
  const sharedEntries = manifestRows(sharedManifest, 'shared engine shader manifest', 'entries');
  const sharedMaterialShaders = manifestRows(
    sharedManifest,
    'shared engine shader manifest',
    'materialShaders',
  );
  const sharedHashes = new Set(sharedEntries.map((entry) => entry?.hash));
  const sharedMaterialRows = new Map(
    sharedMaterialShaders.map((entry) => [materialShaderKey(entry), JSON.stringify(entry)]),
  );

  const entries = appEntries.filter((entry) => !sharedHashes.has(entry?.hash));
  const materialShaders = appMaterialShaders.filter(
    (entry) => JSON.stringify(entry) !== sharedMaterialRows.get(materialShaderKey(entry)),
  );
  if ((appManifest?.schemaVersion === '2.0.0') !== (sharedManifest?.schemaVersion === '2.0.0')) {
    fail(`app and shared shader manifest publication versions differ: ${sourcePath}`);
  }
  return {
    forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
    ...(appManifest?.schemaVersion === '2.0.0'
      ? { schemaVersion: '2.0.0', ...compactSourceTable(appManifest, entries, materialShaders) }
      : {}),
    entries,
    materialShaders,
  };
}

/** Merge one producer delta with the shared engine rows for runtime use. */
export function mergeAppShaderManifest(sharedManifest, deltaManifest, sourcePath = 'app manifest') {
  if (deltaManifest?.forgeaxTransport !== APP_SHADER_MANIFEST_DELTA) {
    fail(`unsupported app shader manifest transport: ${sourcePath}`);
  }
  const sharedEntries = manifestRows(sharedManifest, 'shared engine shader manifest', 'entries');
  const sharedMaterialShaders = manifestRows(
    sharedManifest,
    'shared engine shader manifest',
    'materialShaders',
  );
  const deltaEntries = manifestRows(deltaManifest, sourcePath, 'entries');
  const deltaMaterialShaders = manifestRows(deltaManifest, sourcePath, 'materialShaders');

  const entriesByHash = new Map(sharedEntries.map((entry) => [entry?.hash, entry]));
  for (const entry of deltaEntries) entriesByHash.set(entry?.hash, entry);
  const materialShadersByKey = new Map(
    sharedMaterialShaders.map((entry) => [materialShaderKey(entry), entry]),
  );
  for (const entry of deltaMaterialShaders)
    materialShadersByKey.set(materialShaderKey(entry), entry);

  const entries = [...entriesByHash.values()];
  const materialShaders = [...materialShadersByKey.values()];
  if ((sharedManifest?.schemaVersion === '2.0.0') !== (deltaManifest?.schemaVersion === '2.0.0')) {
    fail(`shared and delta shader manifest publication versions differ: ${sourcePath}`);
  }
  const compact = sharedManifest?.schemaVersion === '2.0.0';
  let sources;
  if (compact) {
    if (
      !Array.isArray(deltaManifest.fragments) ||
      !deltaManifest.sources ||
      typeof deltaManifest.sources !== 'object' ||
      Array.isArray(deltaManifest.sources)
    ) {
      fail(`compact app shader delta is missing fragments or sources: ${sourcePath}`);
    }
    const fragments = [...sharedManifest.fragments, ...deltaManifest.fragments];
    const mergedSources = { ...sharedManifest.sources };
    for (const [digest, indices] of Object.entries(deltaManifest.sources)) {
      if (!Array.isArray(indices)) fail(`compact app shader delta has invalid source: ${digest}`);
      mergedSources[digest] = indices.map((index) => index + sharedManifest.fragments.length);
    }
    sources = compactSourceTable({ fragments, sources: mergedSources }, entries, materialShaders);
  }
  return {
    ...sharedManifest,
    ...sources,
    entries,
    materialShaders,
  };
}
