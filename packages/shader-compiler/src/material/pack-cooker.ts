import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  type CookedMaterialRecord,
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  createMaterialCookIdentity,
  type MaterialCookReceipt,
  type MaterialCookWasmProvenance,
  serializeCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { MaterialAsset } from '@forgeax/engine-types';
import { cookMaterialAsset } from './cook.js';
import { buildMaterialSourceCatalog } from './source-catalog.js';
import { createMaterialSpecializationKey } from './specialization-key.js';

const MATERIAL_COOK_PROFILE = 'webgpu/v1';
const MATERIAL_COOK_COMPILER_VERSION = 'forgeax-material-cooker/1';

interface MaterialPackCookInput {
  readonly guid: string;
  readonly source: MaterialAsset;
  readonly sourceKey?: string;
  readonly sourcePath?: string;
  readonly refs?: readonly string[];
  readonly compilerFingerprint?: string;
  readonly wasm?: MaterialCookWasmProvenance;
}

interface MaterialSourceFile {
  readonly path: string;
  readonly source: string;
  readonly moduleId: string;
}

const require = createRequire(import.meta.url);
const MODULE_ID_RE = /^\s*#define_import_path\s+([A-Za-z0-9_-]+(?:::[A-Za-z0-9_-]+)*)\s*$/m;
const ENGINE_MODULE_ALIASES: Readonly<Record<string, string>> = {
  'forgeax_material::standard': 'forgeax::default-standard-pbr',
  'forgeax_material::unlit': 'forgeax::default-unlit',
  'forgeax_material::pbr-skin': 'forgeax::pbr-skin',
  'forgeax_material::sprite': 'forgeax::sprite',
  'forgeax_material::sprite-lit': 'forgeax::sprite-lit',
};

function moduleIdOf(source: string): string | undefined {
  return MODULE_ID_RE.exec(source)?.[1];
}

function isEngineModule(moduleId: string): boolean {
  return moduleId.startsWith('forgeax_') || moduleId.startsWith('forgeax::');
}

async function collectWgslFiles(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) files.push(...(await collectWgslFiles(path)));
      else if (entry.isFile() && path.endsWith('.wgsl')) files.push(path);
    }
    return files.sort();
  } catch {
    return root.endsWith('.wgsl') ? [root] : [];
  }
}

function packagedShaderRoots(): readonly string[] {
  const roots = [
    resolve(process.cwd(), 'packages/shader/src'),
    resolve(process.cwd(), 'packages/vfx-render/src/shaders'),
  ];
  for (const [packageName, relativePath] of [
    ['@forgeax/engine-shader', 'src'],
    ['@forgeax/engine-vfx-render', 'src/shaders'],
  ] as const) {
    try {
      roots.push(resolve(dirname(require.resolve(`${packageName}/package.json`)), relativePath));
    } catch {
      // Published SDKs may omit source roots that are not needed by a project.
    }
  }
  return [...new Set(roots)];
}

async function collectMaterialSources(roots: readonly string[]): Promise<{
  readonly engine: readonly MaterialSourceFile[];
  readonly project: readonly MaterialSourceFile[];
}> {
  const files = [...new Set((await Promise.all(roots.map(collectWgslFiles))).flat())].sort();
  const records: MaterialSourceFile[] = [];
  for (const path of files) {
    const source = await readFile(path, 'utf8');
    const moduleId = moduleIdOf(source);
    if (moduleId !== undefined) records.push({ path, source, moduleId });
  }
  for (const record of [...records]) {
    const alias = ENGINE_MODULE_ALIASES[record.moduleId];
    if (alias === undefined) continue;
    records.push({
      ...record,
      moduleId: alias,
      source: record.source.replace(
        /^\s*#define_import_path\s+[^\s]+/m,
        `#define_import_path ${alias}`,
      ),
    });
  }
  return {
    engine: records.filter((record) => isEngineModule(record.moduleId)),
    project: records.filter((record) => !isEngineModule(record.moduleId)),
  };
}

function materialInput(value: unknown): MaterialPackCookInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('material cooker expected an object input');
  }
  const input = value as Partial<MaterialPackCookInput>;
  if (
    typeof input.guid !== 'string' ||
    input.source === undefined ||
    input.source === null ||
    input.source.kind !== 'material'
  ) {
    throw new Error('material cooker expected a MaterialAsset source');
  }
  return input as MaterialPackCookInput;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function inputDigest(
  sourceClosure: readonly string[],
  sourceRecords: readonly MaterialSourceFile[],
): string {
  const closurePaths = new Set(sourceClosure);
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        modules: sourceRecords
          .filter((record) => closurePaths.has(record.path) || closurePaths.has(record.moduleId))
          .map((record) => ({ moduleId: record.moduleId, source: record.source }))
          .sort((left, right) => left.moduleId.localeCompare(right.moduleId)),
        declaredSources: sourceRecords.filter(
          (record) => closurePaths.has(record.path) || closurePaths.has(record.moduleId),
        ).length,
      }),
    )
    .digest('hex')}`;
}

function specializationKey(resolved: MaterialAsset, sourceClosureDigest: string): string {
  return createMaterialSpecializationKey({
    contractHash: JSON.stringify(resolved.parameters ?? []),
    passes: (resolved.passes ?? []).map((pass) => ({
      name: pass.name,
      module: pass.program.module,
      entries: {
        vertex: pass.program.vertexEntry ?? '',
        fragment: pass.program.fragmentEntry ?? '',
      },
      sourceClosure: { digest: sourceClosureDigest },
      ...(pass.program.moduleSlots ? { moduleSlots: pass.program.moduleSlots } : {}),
    })),
    vertexInputs: [],
    versions: {
      profile: MATERIAL_COOK_PROFILE,
      adapter: 'generic',
      compiler: MATERIAL_COOK_COMPILER_VERSION,
    },
  }).digest;
}

function cookedRecord(
  input: MaterialPackCookInput,
  resolved: MaterialAsset,
  sourceClosure: readonly string[],
  layoutIdentity: string,
  artifactPath: string,
  artifactBytes: Uint8Array,
  inputFingerprint: string,
): CookedMaterialRecord {
  const artifactDigest = createMaterialArtifactDigest(artifactBytes);
  const materialSpecializationKey = specializationKey(resolved, inputFingerprint);
  const materialContractDigest = createMaterialArtifactDigest(
    new TextEncoder().encode(JSON.stringify(resolved.parameters ?? [])),
  );
  const programIdentity = createMaterialArtifactDigest(
    new TextEncoder().encode(
      JSON.stringify({ specializationKey: materialSpecializationKey, layoutIdentity }),
    ),
  );
  const pipelineIdentity = createMaterialArtifactDigest(
    new TextEncoder().encode(
      JSON.stringify({
        programIdentity,
        renderState: (resolved.passes ?? []).map((pass) => pass.renderState ?? null),
      }),
    ),
  );
  const identity = createMaterialCookIdentity({
    materialContractDigest,
    sourceRevision: inputFingerprint,
    sourceClosureDigest: inputFingerprint,
    layoutIdentity,
    programIdentity,
    pipelineIdentity,
    materialPublicationIdentity: createMaterialArtifactDigest(
      new TextEncoder().encode(JSON.stringify({ guid: input.guid, values: resolved.values ?? {} })),
    ),
    compilerFingerprint: input.compilerFingerprint ?? 'unavailable',
    wasm: input.wasm ?? {
      sourceContentKey: 'unavailable',
      artifactSha256: 'unavailable',
      glueSha256: 'unavailable',
    },
    artifactDigest,
    valueGeneration: 1,
    dependencyGeneration: 1,
    cookGeneration: 1,
  });
  const receipt: MaterialCookReceipt = {
    schemaVersion: 'material-cook/3',
    sourceClosure,
    profile: MATERIAL_COOK_PROFILE,
    compilerVersion: MATERIAL_COOK_COMPILER_VERSION,
    identity,
    derivedInterface: { layoutIdentity },
  };
  const refs = collectMaterialCookRefs(resolved);
  return {
    schemaVersion: 'material-cook/3',
    guid: input.guid,
    materialGuid: input.guid,
    publicationGeneration: 1,
    specializationKey: materialSpecializationKey,
    artifactDigest,
    sourceClosure,
    parameterContract: {
      parameters: resolved.parameters ?? [],
      values: resolved.values ?? {},
    },
    authored: input.source,
    resolved: {
      passes: resolved.passes ?? [],
      parameters: resolved.parameters ?? [],
      values: resolved.values ?? {},
    },
    refs,
    artifact: {
      mediaType: 'text/wgsl',
      path: artifactPath,
      digest: artifactDigest,
      bytes: artifactBytes,
    },
    receipt,
  };
}

/** Build a Pack NativeCooker for authored WGSL material rows. */
export function createMaterialPackCooker(roots: readonly string[] = []): NativeCooker {
  return {
    key: 'material',
    async cook(rawInput: unknown) {
      const input = materialInput(rawInput);
      const sourceRoots = [
        ...roots,
        ...(input.sourcePath === undefined ? [] : [dirname(resolve(input.sourcePath))]),
        ...packagedShaderRoots(),
      ];
      const sources = await collectMaterialSources(sourceRoots);
      const catalog = buildMaterialSourceCatalog({
        roots: sourceRoots,
        engine: sources.engine,
        project: sources.project,
      });
      if (!catalog.ok) {
        throw new Error(`material source catalog failed: ${JSON.stringify(catalog.error)}`);
      }
      const cooked = await cookMaterialAsset({
        material: input.guid,
        table: { [input.guid]: input.source },
        sources: catalog.value,
      });
      if (!cooked.ok) {
        throw new Error(`material shader compile failed: ${JSON.stringify(cooked.error)}`);
      }
      const layoutIdentity = cooked.value.passes[0]?.layoutIdentity;
      if (layoutIdentity === undefined) {
        throw new Error('material shader compile produced no passes');
      }
      if (cooked.value.passes.some((pass) => pass.layoutIdentity !== layoutIdentity)) {
        throw new Error('material shader passes produced different layout identities');
      }
      const artifactBytes = new TextEncoder().encode(
        cooked.value.passes.map((pass) => pass.compile.wgsl).join('\n'),
      );
      const sourceClosure = unique([
        ...(input.sourcePath === undefined ? [] : [resolve(input.sourcePath)]),
        ...(input.sourceKey === undefined || input.sourcePath === undefined
          ? []
          : [resolve(dirname(resolve(input.sourcePath)), input.sourceKey)]),
        ...cooked.value.passes.flatMap((pass) => pass.sourceClosure),
      ]);
      const fingerprint = inputDigest(sourceClosure, [...sources.engine, ...sources.project]);
      const artifactPath = `materials/${input.guid.toLowerCase()}/shader.wgsl`;
      const record = cookedRecord(
        input,
        cooked.value.resolved.asset,
        sourceClosure,
        layoutIdentity,
        artifactPath,
        artifactBytes,
        fingerprint,
      );
      const refs = collectMaterialCookRefs(cooked.value.resolved.asset);
      return {
        guid: input.guid,
        payload: {
          ...input.source,
          cooked: JSON.parse(serializeCookedMaterialRecord(record)) as Record<string, unknown>,
        },
        refs: unique([...(input.refs ?? []), ...refs.parent, ...refs.textures, ...refs.samplers]),
        artifacts: {
          [artifactPath]: { mediaType: 'text/wgsl', bytes: artifactBytes },
        },
        inputFingerprint: fingerprint,
      };
    },
  };
}
