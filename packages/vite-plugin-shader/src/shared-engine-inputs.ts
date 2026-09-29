import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  expandShaderManifestPublication,
  type MaterialShaderArtifactReceipt,
  readShaderManifestPublication,
} from '@forgeax/engine-shader';
import { SURFACE_SLOT_MODULE } from './engine-inputs/load-engine-shader-entries.js';
import {
  engineShaderSourceDigest,
  PACKAGED_SOURCE_RECORD,
  type PackagedSourceRecord,
} from './engine-inputs/source-digest.js';

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
    readonly receipt?: MaterialShaderArtifactReceipt;
  }[];
  readonly uvSetCount?: number;
  readonly receipt?: MaterialShaderArtifactReceipt;
}

export const SHARED_ENGINE_SHADERS_CLASS = 'shared-engine-shaders';
export const SHARED_ENGINE_SHADERS_MANIFEST = 'shared-build-inputs/shaders/manifest.json';

/** Packaged profiles are read during synchronous Vite plugin construction. */
function readPackagedPublication(value: unknown): {
  entries: ShaderManifestInput[];
  materialShaders: SharedMaterialShaderManifestEntry[];
} {
  const expanded = expandShaderManifestPublication(value);
  for (const [digest, source] of expanded.sources) {
    if (createHash('sha256').update(source).digest('hex') !== digest) {
      throw new Error(`packaged shader source digest mismatch: ${digest}`);
    }
  }
  const manifest = expanded.manifest as {
    entries?: ShaderManifestInput[];
    materialShaders?: SharedMaterialShaderManifestEntry[];
  };
  if (!Array.isArray(manifest?.entries) || !Array.isArray(manifest.materialShaders)) {
    throw new Error('packaged shader manifest is missing rows');
  }
  return { entries: manifest.entries, materialShaders: manifest.materialShaders };
}

/**
 * A release-input directory is only usable when it contains the engine rows
 * that the runtime boot contract consumes. An interrupted or first-time
 * source build can leave the generated manifest present but empty; treating
 * that placeholder as a successful packaged input silently suppresses the
 * source compiler and leaves the renderer without its Standard entry.
 */
export function hasUsablePackagedEngineShaderInputs(input: {
  readonly entries: readonly ShaderManifestInput[];
  readonly materialShaders: readonly SharedMaterialShaderManifestEntry[];
}): boolean {
  return (
    input.entries.length > 0 &&
    input.materialShaders.some((entry) => entry.identifier === 'forgeax::default-standard-pbr') &&
    input.materialShaders.some((entry) => entry.identifier === 'forgeax::default-unlit')
  );
}

const reportedStaleProfiles = new Set<string>();

/**
 * A packaged profile is compiled output, valid only for the exact engine WGSL
 * it was prepared from. A checkout keeps a profile left by an earlier SDK or
 * Dawn preparation across source edits; using it would publish shaders whose
 * bindings no longer match the renderer, so any mismatch compiles from source.
 */
export function packagedProfileMatchesSource(
  inputRoot: string,
  shaderSourceRoot: string | undefined,
): boolean {
  let recorded: string | undefined;
  try {
    const record = JSON.parse(
      readFileSync(resolve(inputRoot, PACKAGED_SOURCE_RECORD), 'utf8'),
    ) as Partial<PackagedSourceRecord>;
    recorded = record.shaderSourceDigest;
  } catch {
    recorded = undefined;
  }
  const current =
    shaderSourceRoot === undefined ? undefined : engineShaderSourceDigest(shaderSourceRoot);
  if (recorded !== undefined && recorded === current) return true;
  if (!reportedStaleProfiles.has(inputRoot)) {
    reportedStaleProfiles.add(inputRoot);
    console.warn(
      `[forgeax-shader] packaged engine shader profile ${inputRoot} was not prepared from the current engine WGSL sources; compiling engine shaders from source. Re-prepare or delete the profile to silence this.`,
    );
  }
  return false;
}

export function loadPackagedEngineShaderInputs(
  pointShadows: boolean,
  hdrpSsao: boolean,
): {
  readonly entries: ShaderManifestInput[];
  readonly materialShaders: SharedMaterialShaderManifestEntry[];
  readonly imports: Record<string, string>;
} | null {
  if (process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD === '1') return null;
  const require = createRequire(import.meta.url);
  let packageRoot: string;
  try {
    packageRoot = dirname(require.resolve('@forgeax/engine-vite-plugin-shader/package.json'));
  } catch {
    return null;
  }
  // SSAO is an independent utility entry, not a material compilation axis.
  const profile = `${pointShadows ? 'point' : 'base'}-ssao`;
  const inputRoot = resolve(packageRoot, 'dist/engine-inputs', profile);
  const manifestPath = resolve(inputRoot, 'manifest.json');
  const importsPath = resolve(inputRoot, 'imports.json');
  if (!existsSync(manifestPath) || !existsSync(importsPath)) return null;
  let shaderSourceRoot: string | undefined;
  try {
    shaderSourceRoot = resolve(
      dirname(require.resolve('@forgeax/engine-shader/package.json')),
      'src',
    );
  } catch {
    shaderSourceRoot = undefined;
  }
  if (!packagedProfileMatchesSource(inputRoot, shaderSourceRoot)) return null;
  const manifest = readPackagedPublication(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const imports = JSON.parse(readFileSync(importsPath, 'utf8')) as Record<string, string>;
  if (manifest.entries === undefined || manifest.materialShaders === undefined) {
    throw new Error(`packaged engine shader manifest is incomplete: ${manifestPath}`);
  }
  if (
    !hasUsablePackagedEngineShaderInputs(
      manifest as {
        readonly entries: ShaderManifestInput[];
        readonly materialShaders: SharedMaterialShaderManifestEntry[];
      },
    )
  ) {
    return null;
  }
  if (typeof imports[SURFACE_SLOT_MODULE] !== 'string') {
    throw new Error(
      `packaged engine shader imports are missing ${SURFACE_SLOT_MODULE}: ${importsPath}`,
    );
  }
  return {
    entries: projectOptionalEngineEntries(manifest.entries, hdrpSsao),
    materialShaders: manifest.materialShaders,
    imports,
  };
}

/** The source producer adds SSAO as one independent fullscreen utility. */
export function projectOptionalEngineEntries<T extends ShaderManifestInput>(
  entries: readonly T[],
  hdrpSsao: boolean,
): T[] {
  return entries.filter(
    (entry) =>
      hdrpSsao || !(entry.wgsl.includes('fs_ssao_calc') && entry.wgsl.includes('fs_ssao_blur')),
  );
}

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

export async function loadSharedEngineShaderManifest(manifestPath: string): Promise<{
  readonly entries: ShaderManifestInput[];
  readonly materialShaders: SharedMaterialShaderManifestEntry[];
}> {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly schemaVersion?: number;
    readonly producer?: string;
    readonly inputFingerprint?: string;
    readonly inventory?: readonly string[];
    readonly payload?: { readonly engineShaderManifest?: string };
  };
  const path = manifest.payload?.engineShaderManifest;
  if (path === undefined)
    throw new Error(`shared shader manifest lacks serialized payload: ${manifestPath}`);
  const repositoryRoot = dirname(dirname(manifestPath));
  if (manifest.schemaVersion === 2) {
    if (manifest.producer !== 'repo-build-inputs' || manifest.inputFingerprint === undefined) {
      throw new Error(`shared shader manifest has invalid producer metadata: ${manifestPath}`);
    }
    if (!Array.isArray(manifest.inventory) || !manifest.inventory.includes(path)) {
      throw new Error(`shared shader manifest inventory does not declare ${path}: ${manifestPath}`);
    }
    for (const inventoryPath of manifest.inventory) {
      if (!existsSync(resolve(repositoryRoot, inventoryPath))) {
        throw new Error(
          `shared shader manifest inventory is missing ${inventoryPath}: ${manifestPath}`,
        );
      }
    }
  }
  const shaderManifest = (await readShaderManifestPublication(
    JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')),
  )) as {
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
