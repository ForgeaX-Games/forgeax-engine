import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { CommandResult, ProjectFacts } from './types.js';

interface DistArtifact {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DistManifest {
  readonly schemaVersion: '1.0.0';
  readonly project: { readonly id: string; readonly name: string };
  readonly base: string;
  readonly runtime: {
    readonly packIndexUrl: string;
    readonly shaderManifestUrl: string;
  };
  readonly artifacts: readonly DistArtifact[];
}

function mediaType(path: string): string {
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

async function filesUnder(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const info = await stat(path);
    if (info.isDirectory()) result.push(...(await filesUnder(root, path)));
    else if (info.isFile() && name !== 'forgeax-dist.json') result.push(path);
  }
  return result;
}

export async function writeDistManifest(facts: ProjectFacts, base: string): Promise<DistManifest> {
  const root = resolve(facts.root, 'dist');
  const artifacts = await Promise.all(
    (await filesUnder(root)).map(async (path): Promise<DistArtifact> => {
      const bytes = await readFile(path);
      return {
        path: relative(root, path).split(sep).join('/'),
        mediaType: mediaType(path),
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  );
  const manifest: DistManifest = {
    schemaVersion: '1.0.0',
    project: { id: facts.id, name: facts.name },
    base,
    runtime: {
      packIndexUrl: 'pack-index.json',
      shaderManifestUrl: 'shaders/manifest.json',
    },
    artifacts,
  };
  await writeFile(resolve(root, 'forgeax-dist.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyDist(rootInput: string): Promise<CommandResult<DistManifest>> {
  const root = resolve(rootInput);
  let manifest: DistManifest;
  try {
    manifest = JSON.parse(
      await readFile(resolve(root, 'forgeax-dist.json'), 'utf8'),
    ) as DistManifest;
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'dist-manifest-unreadable',
        expected: 'a readable dist/forgeax-dist.json',
        hint: 'Run forgeax build and do not edit its derived manifest.',
        detail: { root, reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
  if (manifest.schemaVersion !== '1.0.0' || !Array.isArray(manifest.artifacts)) {
    return {
      ok: false,
      error: {
        code: 'dist-manifest-invalid',
        expected: 'forgeax-dist schema 1.0.0',
        hint: 'Rebuild the game with a compatible ForgeaX DevKit.',
        detail: { root },
      },
    };
  }
  const declaredPaths = new Set(manifest.artifacts.map((artifact) => artifact.path));
  if (declaredPaths.size !== manifest.artifacts.length) {
    return {
      ok: false,
      error: {
        code: 'dist-artifact-duplicate',
        expected: 'every dist artifact path to be declared exactly once',
        hint: 'Rebuild the derived dist manifest.',
        detail: { root },
      },
    };
  }
  for (const artifact of manifest.artifacts) {
    const path = resolve(root, artifact.path);
    if (relative(root, path).startsWith('..')) {
      return {
        ok: false,
        error: {
          code: 'dist-path-escape',
          expected: 'every artifact path to remain inside dist',
          hint: 'Rebuild the derived dist manifest.',
          detail: { path: artifact.path },
        },
      };
    }
    try {
      const bytes = await readFile(path);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.byteLength !== artifact.bytes || digest !== artifact.sha256) {
        return {
          ok: false,
          error: {
            code: 'dist-artifact-mismatch',
            expected: 'artifact bytes and SHA-256 to match forgeax-dist.json',
            hint: 'Restore the built artifact or rebuild the complete dist.',
            detail: { path: artifact.path },
          },
        };
      }
    } catch {
      return {
        ok: false,
        error: {
          code: 'dist-artifact-missing',
          expected: 'every declared dist artifact to exist',
          hint: 'Restore the built artifact or rebuild the complete dist.',
          detail: { path: artifact.path },
        },
      };
    }
  }
  for (const required of [
    'index.html',
    manifest.runtime.packIndexUrl,
    manifest.runtime.shaderManifestUrl,
  ]) {
    if (!manifest.artifacts.some((artifact) => artifact.path === required)) {
      return {
        ok: false,
        error: {
          code: 'dist-required-artifact-missing',
          expected: 'HTML, Pack index, and Shader manifest in the dist closure',
          hint: 'Rebuild after repairing the owning producer.',
          detail: { path: required },
        },
      };
    }
  }
  for (const path of await filesUnder(root)) {
    const artifactPath = relative(root, path).split(sep).join('/');
    if (!declaredPaths.has(artifactPath)) {
      return {
        ok: false,
        error: {
          code: 'dist-artifact-undeclared',
          expected: 'every file in dist to be covered by forgeax-dist.json',
          hint: 'Remove the foreign file or rebuild the complete dist.',
          detail: { path: artifactPath },
        },
      };
    }
  }
  return { ok: true, value: manifest };
}
