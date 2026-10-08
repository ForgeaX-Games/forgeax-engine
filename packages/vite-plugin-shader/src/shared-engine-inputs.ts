import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  expandShaderManifestPublication,
  type MaterialShaderManifestEntry,
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

/** Node publications share strict expansion and native source-byte verification. */
function readNodePublication(value: unknown): {
  entries: ShaderManifestInput[];
  materialShaders: MaterialShaderManifestEntry[];
  sourceFragments: ReadonlyMap<string, readonly string[]>;
} {
  const expanded = expandShaderManifestPublication(value);
  // Retain the admitted transport blocks with these inputs, never in a process-global cache.
  const sourceFragments = new Map<string, readonly string[]>();
  const publication = value as {
    fragments: string[];
    sources: Record<string, number[]>;
  };
  for (const [digest, source] of expanded.sources) {
    if (createHash('sha256').update(source).digest('hex') !== digest) {
      throw new Error(`shader source digest mismatch: ${digest}`);
    }
    sourceFragments.set(
      source,
      (publication.sources[digest] as number[]).map(
        (index) => publication.fragments[index] as string,
      ),
    );
  }
  const manifest = expanded.manifest as {
    entries?: ShaderManifestInput[];
    materialShaders?: MaterialShaderManifestEntry[];
  };
  if (!Array.isArray(manifest?.entries) || !Array.isArray(manifest.materialShaders)) {
    throw new Error('shader manifest is missing rows');
  }
  return { entries: manifest.entries, materialShaders: manifest.materialShaders, sourceFragments };
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
  readonly materialShaders: readonly MaterialShaderManifestEntry[];
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
  readonly materialShaders: MaterialShaderManifestEntry[];
  readonly imports: Record<string, string>;
  readonly sourceFragments: ReadonlyMap<string, readonly string[]>;
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
  const manifest = readNodePublication(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const imports = JSON.parse(readFileSync(importsPath, 'utf8')) as Record<string, string>;
  if (!hasUsablePackagedEngineShaderInputs(manifest)) return null;
  if (typeof imports[SURFACE_SLOT_MODULE] !== 'string') {
    throw new Error(
      `packaged engine shader imports are missing ${SURFACE_SLOT_MODULE}: ${importsPath}`,
    );
  }
  return {
    entries: projectOptionalEngineEntries(manifest.entries, hdrpSsao),
    materialShaders: manifest.materialShaders,
    imports,
    sourceFragments: manifest.sourceFragments,
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

export async function loadSharedEngineShaderManifest(manifestPath: string): Promise<{
  readonly entries: ShaderManifestInput[];
  readonly materialShaders: MaterialShaderManifestEntry[];
  readonly sourceFragments: ReadonlyMap<string, readonly string[]>;
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
  return readNodePublication(JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')));
}
