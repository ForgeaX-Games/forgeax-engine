import type {
  MaterialParameter,
  ParamSchemaEntry,
  ResolvedMaterial,
  Result,
} from '@forgeax/engine-types';
import {
  createMaterialError,
  type DerivedMaterialInterface,
  derive,
  err,
  type MaterialError,
  type MaterialParameterProjection,
  ok,
} from '@forgeax/engine-types';
import { compareParamSchemaSuperset } from '../compare-param-schema.js';
import { ShaderError } from '../errors.js';
import { type CompileResult, compileShader } from '../index.js';
import { compareDerivedMaterialInterface } from '../reflection.js';
import { type MaterialTable, resolveMaterialAsset } from './resolve.js';
import type { MaterialSourceCatalog } from './source-catalog.js';
import { lowerMaterialVariantContext, type MaterialVariantContext } from './variant-context.js';

export interface MaterialCookRequest {
  readonly material: string;
  readonly table: MaterialTable;
  readonly sources: MaterialSourceCatalog;
  readonly context?: MaterialVariantContext;
}

export interface MaterialCookedPass {
  readonly pass: string;
  readonly module: string;
  readonly parameters: readonly MaterialParameter[];
  readonly paramSchema: readonly ParamSchemaEntry[];
  readonly generatedModule: string;
  readonly sourceClosure: readonly string[];
  readonly compile: CompileResult;
  readonly layoutIdentity: string;
}

export type GeneratedMaterialParameterProjection = MaterialParameterProjection;

export interface MaterialCookedAsset {
  readonly resolved: ResolvedMaterial;
  readonly passes: readonly MaterialCookedPass[];
}

export type MaterialCookError = MaterialError | ShaderError;

const DEFAULT_MATERIAL_VARIANT_CONTEXT: MaterialVariantContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};

const IMPORT_RE = /^\s*#import\s+([A-Za-z0-9_:-]+)/gm;

function newlineCount(source: string): number {
  return source.match(/\n/g)?.length ?? 0;
}

function mapCookErrorToAuthoredSource(
  error: ShaderError,
  authoredSource: string,
  composedSource: string,
): ShaderError {
  if (error.lineNum === undefined) return error;
  const header = /^(\s*#define_import_path[^\n]*(?:\r?\n|$))/m.exec(authoredSource);
  if (header === null) return error;
  const authoredRemainder = authoredSource.slice(header[0].length);
  const composedRemainder = composedSource.lastIndexOf(authoredRemainder);
  if (composedRemainder < 0) return error;
  const composedPrefix = composedSource.slice(0, composedRemainder);
  const offset = newlineCount(composedPrefix) - newlineCount(header[0]);
  if (offset <= 0 || error.lineNum <= newlineCount(composedPrefix)) return error;
  return new ShaderError({
    code: error.code,
    expected: error.expected,
    message: error.message,
    hint: error.hint,
    lineNum: error.lineNum - offset,
    ...(error.linePos === undefined ? {} : { linePos: error.linePos }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  });
}

function materialTypeToSchema(parameter: MaterialParameter): ParamSchemaEntry | undefined {
  switch (parameter.type) {
    case 'bool':
      return undefined;
    case 'f32':
    case 'i32':
    case 'u32':
    case 'vec2':
    case 'vec3':
    case 'vec4':
    case 'color': {
      const value = parameter.default;
      const defaultValue =
        typeof value === 'number' || Array.isArray(value) ? { default: value } : {};
      return { name: parameter.name, type: parameter.type, ...defaultValue } as ParamSchemaEntry;
    }
    case 'texture':
      return { name: parameter.name, type: 'texture2d' };
  }
}

function projectParameterSchema(
  parameters: readonly MaterialParameter[],
): Result<readonly ParamSchemaEntry[], MaterialError> {
  const projected: ParamSchemaEntry[] = [];
  for (const parameter of parameters) {
    const schema = materialTypeToSchema(parameter);
    if (schema !== undefined) projected.push(schema);
  }
  return ok(projected);
}

function wgslType(parameter: ParamSchemaEntry): string {
  switch (parameter.type) {
    case 'f32':
      return 'f32';
    case 'i32':
      return 'i32';
    case 'u32':
      return 'u32';
    case 'vec2':
      return 'vec2<f32>';
    case 'vec3':
      return 'vec3<f32>';
    case 'vec4':
    case 'color':
      return 'vec4<f32>';
    case 'texture2d':
      return 'texture_2d<f32>';
    case 'texture_cube':
      return 'texture_cube<f32>';
    case 'texture_depth_2d':
      return 'texture_depth_2d';
    case 'texture_cube_array':
      return 'texture_cube_array<f32>';
    case 'sampler':
    case 'sampler_comparison':
      return 'sampler';
    case 'storage_buffer':
      return 'array<u32>';
  }
}

export function generateParameterModule(schema: readonly ParamSchemaEntry[]): string {
  const derived = derive(schema);
  const coordinateRecords = derived.coordinateRecords ?? [];
  const resourceBindings = derived.resourceBindings ?? [];
  const fields = schema
    .flatMap((parameter) => {
      if (isNumericParameter(parameter)) {
        return [`  ${parameter.name} : ${wgslType(parameter)},`];
      }
      if (isTextureParameter(parameter)) {
        const coordinates = coordinateRecords.find((record) => record.parameter === parameter.name);
        if (coordinates === undefined) return [];
        return [
          `  ${coordinates.transformMember} : vec4<f32>,`,
          `  ${coordinates.metadataMember} : vec4<f32>,`,
        ];
      }
      return [];
    })
    .join('\n');
  const lines = ['#define_import_path forgeax_material::parameters'];
  if (fields.length > 0) {
    lines.push(`struct MaterialParameters {\n${fields}\n}`);
  }

  const parameterByName = new Map(schema.map((parameter) => [parameter.name, parameter]));
  const uniformBinding = derived.bglEntries.find(
    (entry) => entry.buffer?.type === 'uniform',
  )?.binding;
  const declarations = new Map<number, string>();
  if (uniformBinding !== undefined) {
    declarations.set(
      uniformBinding,
      `@group(1) @binding(${uniformBinding}) var<uniform> material : MaterialParameters;`,
    );
  }
  for (const resource of resourceBindings) {
    const parameter = parameterByName.get(resource.parameter ?? resource.name);
    if (parameter === undefined) continue;
    if (resource.kind === 'sampler') {
      declarations.set(
        resource.binding,
        `@group(1) @binding(${resource.binding}) var ${resource.name} : sampler;`,
      );
    } else if (resource.kind === 'texture') {
      declarations.set(
        resource.binding,
        `@group(1) @binding(${resource.binding}) var ${resource.name} : ${wgslType(parameter)};`,
      );
    } else {
      declarations.set(
        resource.binding,
        `@group(1) @binding(${resource.binding}) var ${resource.name} : array<u32>;`,
      );
    }
  }
  for (const binding of [...declarations.keys()].sort((left, right) => left - right)) {
    lines.push(declarations.get(binding) as string);
  }
  return `${lines.join('\n')}\n`;
}

function isNumericParameter(parameter: ParamSchemaEntry): boolean {
  return ['f32', 'i32', 'u32', 'vec2', 'vec3', 'vec4', 'color'].includes(parameter.type);
}

function isTextureParameter(parameter: ParamSchemaEntry): boolean {
  return ['texture2d', 'texture_cube', 'texture_depth_2d', 'texture_cube_array'].includes(
    parameter.type,
  );
}

function hasAuthoredMaterialInterface(source: string): boolean {
  return (
    /\bstruct\s+Material\s*\{/.test(source) &&
    /@group\(1\)\s*@binding\(0\)\s*var<uniform>\s+material\s*:\s*Material\s*;/.test(source)
  );
}

function importModuleIds(source: string): readonly string[] {
  const ids: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const raw = match[1];
    if (raw !== undefined) ids.push(raw.replace(/::$/, '').split('::{')[0] ?? raw);
  }
  return ids;
}

function collectSourceClosure(
  source: string,
  sources: MaterialSourceCatalog,
  generated: string,
): Result<Readonly<Record<string, string>>, MaterialError> {
  const result: Record<string, string> = { 'forgeax_material::parameters': generated };
  const pending = [...importModuleIds(source)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const moduleId = pending.shift();
    if (moduleId === undefined || visited.has(moduleId)) continue;
    visited.add(moduleId);
    if (moduleId === 'forgeax_material::parameters') continue;
    const record = sources.get(moduleId);
    if (!record.ok) return err(record.error);
    result[moduleId] = record.value.source;
    pending.push(...importModuleIds(record.value.source));
  }
  return ok(result);
}

function applyModuleSlots(
  source: string,
  sourceModuleId: string,
  moduleSlots: Readonly<Record<string, string>> | undefined,
  sources: MaterialSourceCatalog,
): Result<string, MaterialError> {
  let selectedSource = source;
  for (const [slotName, moduleId] of Object.entries(moduleSlots ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const selected = sources.resolveSlot(sourceModuleId, slotName, moduleId);
    if (!selected.ok) return err(selected.error);
    const marker = new RegExp(
      `(\\#import\\s+forgeax_material::slot::${slotName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}::\\{[^\\n]+\\})`,
      'g',
    );
    if (!marker.test(selectedSource)) {
      return err(
        createMaterialError('shader-module-not-found', {
          code: 'shader-module-not-found',
          module: `${sourceModuleId}::${slotName}=${moduleId}`,
          source: sourceModuleId,
        }),
      );
    }
    selectedSource = selectedSource.replace(marker, (line) =>
      line.replace(`forgeax_material::slot::${slotName}`, selected.value.moduleId),
    );
  }
  return ok(selectedSource);
}

export async function cookMaterialAsset(
  request: MaterialCookRequest,
): Promise<Result<MaterialCookedAsset, MaterialCookError>> {
  const resolved = resolveMaterialAsset(request.material, request.table);
  if (!resolved.ok) return err(resolved.error);
  const parameters = resolved.value.asset.parameters ?? [];
  const schema = projectParameterSchema(parameters);
  if (!schema.ok) return schema;
  const derived: DerivedMaterialInterface = derive(schema.value);
  const generatedModule = generateParameterModule(schema.value);
  const cooked: MaterialCookedPass[] = [];

  for (const pass of resolved.value.asset.passes ?? []) {
    const sourceRecord = request.sources.get(pass.program.module);
    if (!sourceRecord.ok) return err(sourceRecord.error);
    const source = sourceRecord.value.source;
    const composedSource = applyModuleSlots(
      source,
      pass.program.module,
      pass.program.moduleSlots,
      request.sources,
    );
    if (!composedSource.ok) return composedSource;
    const imports = collectSourceClosure(composedSource.value, request.sources, generatedModule);
    if (!imports.ok) return imports;
    const sourceWithInterface =
      composedSource.value.includes('forgeax_material::parameters') ||
      hasAuthoredMaterialInterface(composedSource.value)
        ? composedSource.value
        : composedSource.value.replace(
            /^(\s*#define_import_path\s+[^\n]+\n?)/,
            `$1${generatedModule.replace(/^#define_import_path[^\n]+\n?/, '')}\n`,
          );
    const compiled = await compileShader(sourceWithInterface, {
      id: `${pass.program.module}::${pass.name}`,
      imports: imports.value,
      defines: {
        ...lowerMaterialVariantContext(request.context ?? DEFAULT_MATERIAL_VARIANT_CONTEXT),
      },
    });
    if (!compiled.ok) {
      return err(mapCookErrorToAuthoredSource(compiled.error, source, sourceWithInterface));
    }
    if (!hasAuthoredMaterialInterface(composedSource.value)) {
      const checked = compareParamSchemaSuperset(
        schema.value,
        compiled.value.bindings,
        pass.program.module,
      );
      if (!checked.ok) return checked;
    }
    const reflectionChecked = compareDerivedMaterialInterface(derived, compiled.value.reflection);
    if (!reflectionChecked.ok) return reflectionChecked;
    cooked.push({
      pass: pass.name,
      module: pass.program.module,
      parameters,
      paramSchema: schema.value,
      generatedModule,
      sourceClosure: [sourceRecord.value.path, ...Object.keys(imports.value).sort()],
      compile: compiled.value,
      layoutIdentity: derived.layoutIdentity,
    });
  }

  return ok({ resolved: resolved.value, passes: cooked });
}
