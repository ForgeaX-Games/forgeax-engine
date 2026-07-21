export interface ShaderManifestInput {
  readonly hash: string;
  readonly wgsl: string;
  readonly bindings: string;
}

export interface SharedMaterialShaderManifestEntry {
  readonly identifier: string;
  readonly sourcePath: string;
  readonly composedWgsl: string;
  readonly paramSchema: string;
  readonly variants: readonly {
    readonly definesKey: string;
    readonly defines: Record<string, boolean>;
    readonly composedWgsl: string;
  }[];
  readonly uvSetCount?: number;
}

export const SHARED_ENGINE_SHADERS_CLASS = 'shared-engine-shaders';
export const SHARED_ENGINE_SHADERS_MANIFEST = 'shared-app-inputs/shaders/manifest.json';

/**
 * Projects engine and app entries into an app-local manifest. Engine entry
 * production remains shareable while app custom transforms continue to own the
 * map that is passed here.
 */
export function projectShaderManifestEntries(
  entries: ReadonlyMap<string, ShaderManifestInput>,
): Array<ShaderManifestInput & { readonly glsl: '' }> {
  // `undefined` disappears during JSON serialization, but `glsl` is a required
  // manifest field at the runtime boundary. The empty string is the declared
  // WebGPU-only placeholder and survives serialization.
  return [...entries.values()].map((entry) => ({ ...entry, glsl: '' }));
}

export function mergeSharedEngineShaderEntries<T extends ShaderManifestInput>(
  appEntries: ReadonlyMap<string, T>,
  sharedEntries: readonly T[] = [],
): Map<string, T> {
  const merged = new Map<string, T>();
  for (const entry of sharedEntries) merged.set(`shared:${entry.hash}`, entry);
  for (const [key, entry] of appEntries) merged.set(key, entry);
  return merged;
}

export function loadSharedEngineShaderManifest(manifestPath: string): {
  readonly entries: ShaderManifestInput[];
  readonly materialShaders: SharedMaterialShaderManifestEntry[];
} {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly payload?: { readonly engineShaderManifest?: string };
  };
  const path = manifest.payload?.engineShaderManifest;
  if (path === undefined)
    throw new Error(`shared shader manifest lacks serialized payload: ${manifestPath}`);
  const repositoryRoot = dirname(dirname(manifestPath));
  const shaderManifest = JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')) as {
    readonly entries?: ShaderManifestInput[];
    readonly materialShaders?: SharedMaterialShaderManifestEntry[];
  };
  if (shaderManifest.entries === undefined) {
    throw new Error(`shared engine shader payload lacks entries: ${manifestPath}`);
  }
  if (shaderManifest.materialShaders === undefined) {
    throw new Error(`shared engine shader payload lacks material shaders: ${manifestPath}`);
  }
  return { entries: shaderManifest.entries, materialShaders: shaderManifest.materialShaders };
}

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
