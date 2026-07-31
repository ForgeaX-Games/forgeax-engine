import type {
  MaterialParameter,
  MaterialValue,
  ParamSchemaEntry,
  ResolvedMaterial,
  Result,
} from '@forgeax/engine-types';
import { createMaterialError, derive, err, type MaterialError, ok } from '@forgeax/engine-types';
import { compareParamSchemaSuperset } from '../compare-param-schema.js';
import type { ShaderError } from '../errors.js';
import { type CompileResult, compileShader } from '../index.js';
import { type MaterialTable, resolveMaterialAsset } from './resolve.js';
import type { MaterialSourceCatalog } from './source-catalog.js';

export interface MaterialCookRequest {
  readonly material: string;
  readonly table: MaterialTable;
  readonly sources: MaterialSourceCatalog;
  readonly defines?: Readonly<Record<string, boolean>>;
}

export interface MaterialCookedPass {
  readonly pass: string;
  readonly module: string;
  readonly parameters: readonly MaterialParameter[];
  readonly paramSchema: readonly ParamSchemaEntry[];
  readonly generatedModule: string;
  readonly sourceClosure: readonly string[];
  readonly compile: CompileResult;
}

export interface MaterialCookedAsset {
  readonly resolved: ResolvedMaterial;
  readonly passes: readonly MaterialCookedPass[];
}

export type MaterialCookError = MaterialError | ShaderError;

const IMPORT_RE = /^\s*#import\s+([A-Za-z0-9_:-]+)/gm;
const PRAGMA_RE = /^\s*#pragma\s+\S.*$/gm;

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
  material: string,
  parameters: readonly MaterialParameter[],
): Result<readonly ParamSchemaEntry[], MaterialError> {
  const projected: ParamSchemaEntry[] = [];
  for (const parameter of parameters) {
    if (parameter.static === true && parameter.type !== 'bool') {
      return err(
        createMaterialError('material-contract-program-mismatch', {
          code: 'material-contract-program-mismatch',
          material,
          pass: 'parameters',
          program: parameter.name,
          expectedProgram: 'static parameters are boolean module slots',
        }),
      );
    }
    const schema = materialTypeToSchema(parameter);
    if (schema !== undefined) projected.push(schema);
    if (parameter.type === 'bool' && parameter.static !== true) {
      return err(
        createMaterialError('material-contract-program-mismatch', {
          code: 'material-contract-program-mismatch',
          material,
          pass: 'parameters',
          program: parameter.name,
          expectedProgram: 'boolean parameters must be static module slots',
        }),
      );
    }
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

function generateParameterModule(schema: readonly ParamSchemaEntry[]): string {
  const derived = derive(schema);
  const fields = schema
    .filter(
      (parameter) => !parameter.type.startsWith('texture') && !parameter.type.startsWith('sampler'),
    )
    .filter((parameter) => parameter.type !== 'storage_buffer')
    .map((parameter) => `  ${parameter.name} : ${wgslType(parameter)},`)
    .join('\n');
  const lines = ['#define_import_path forgeax_material::parameters'];
  if (fields.length > 0) {
    lines.push(`struct MaterialParameters {\n${fields}\n}`);
  }

  let emittedUniform = false;
  let binding = 0;
  for (const parameter of schema) {
    if (parameter.type === 'storage_buffer') {
      lines.push(`@group(1) @binding(${binding}) var ${parameter.name} : array<u32>;`);
      binding += 1;
      continue;
    }
    if (
      parameter.type === 'f32' ||
      parameter.type === 'i32' ||
      parameter.type === 'u32' ||
      parameter.type === 'vec2' ||
      parameter.type === 'vec3' ||
      parameter.type === 'vec4' ||
      parameter.type === 'color'
    ) {
      if (!emittedUniform) {
        lines.push(`@group(1) @binding(${binding}) var<uniform> material : MaterialParameters;`);
        emittedUniform = true;
        binding += 1;
      }
      continue;
    }
    if (
      parameter.type === 'texture2d' ||
      parameter.type === 'texture_cube' ||
      parameter.type === 'texture_depth_2d' ||
      parameter.type === 'texture_cube_array'
    ) {
      lines.push(`@group(1) @binding(${binding}) var ${parameter.name}_sampler : sampler;`);
      lines.push(
        `@group(1) @binding(${binding + 1}) var ${parameter.name} : ${wgslType(parameter)};`,
      );
      binding += 2;
      continue;
    }
    lines.push(`@group(1) @binding(${binding}) var ${parameter.name} : ${wgslType(parameter)};`);
    binding += 1;
  }
  if (derived.userRegionBindingEnd !== binding) {
    throw new Error('material parameter interface and derived binding layout diverged');
  }
  return `${lines.join('\n')}\n`;
}

function parameterModuleImports(schema: readonly ParamSchemaEntry[]): string {
  const names: string[] = [];
  if (
    schema.some((parameter) =>
      ['f32', 'i32', 'u32', 'vec2', 'vec3', 'vec4', 'color'].includes(parameter.type),
    )
  ) {
    names.push('material');
  }
  for (const parameter of schema) {
    if (
      parameter.type === 'texture2d' ||
      parameter.type === 'texture_cube' ||
      parameter.type === 'texture_depth_2d' ||
      parameter.type === 'texture_cube_array'
    ) {
      names.push(`${parameter.name}_sampler`, parameter.name);
    }
  }
  return names.join(', ');
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

function moduleDefines(
  material: string,
  pass: string,
  parameters: readonly MaterialParameter[],
  values: Readonly<Record<string, MaterialValue | null>> | undefined,
  slots: Readonly<Record<string, string>> | undefined,
  overrides: Readonly<Record<string, boolean>> | undefined,
): Result<Record<string, boolean>, MaterialError> {
  const definitions: Record<string, boolean> = {};
  for (const parameter of parameters) {
    if (parameter.type !== 'bool' || parameter.static !== true) continue;
    const raw = slots?.[parameter.name] ?? values?.[parameter.name] ?? parameter.default;
    if (typeof raw === 'boolean') definitions[parameter.name] = raw;
  }
  Object.assign(definitions, overrides ?? {});
  for (const [name, value] of Object.entries(slots ?? {})) {
    if (value !== 'true' && value !== 'false') {
      return err(
        createMaterialError('material-contract-program-mismatch', {
          code: 'material-contract-program-mismatch',
          material,
          pass,
          program: name,
          expectedProgram: 'module slot values must be true or false',
        }),
      );
    }
    definitions[name] = value === 'true';
  }
  return ok(definitions);
}

export async function cookMaterialAsset(
  request: MaterialCookRequest,
): Promise<Result<MaterialCookedAsset, MaterialCookError>> {
  const resolved = resolveMaterialAsset(request.material, request.table);
  if (!resolved.ok) return err(resolved.error);
  const parameters = resolved.value.asset.parameters ?? [];
  const schema = projectParameterSchema(request.material, parameters);
  if (!schema.ok) return schema;
  const generatedModule = generateParameterModule(schema.value);
  const cooked: MaterialCookedPass[] = [];

  for (const pass of resolved.value.asset.passes ?? []) {
    const sourceRecord = request.sources.get(pass.program.module);
    if (!sourceRecord.ok) return err(sourceRecord.error);
    const source = sourceRecord.value.source.replace(PRAGMA_RE, '');
    const imports = collectSourceClosure(source, request.sources, generatedModule);
    if (!imports.ok) return imports;
    const defines = moduleDefines(
      request.material,
      pass.name,
      parameters,
      resolved.value.asset.values,
      pass.program.moduleSlots,
      request.defines,
    );
    if (!defines.ok) return defines;
    const sourceWithInterface = source.includes('forgeax_material::parameters')
      ? source
      : source.replace(
          /^(\s*#define_import_path\s+[^\n]+\n?)/,
          `$1#import forgeax_material::parameters::{${parameterModuleImports(schema.value)}}\n`,
        );
    const compiled = await compileShader(sourceWithInterface, {
      id: `${pass.program.module}::${pass.name}`,
      imports: imports.value,
      defines: defines.value,
    });
    if (!compiled.ok) return compiled;
    const checked = compareParamSchemaSuperset(
      schema.value,
      compiled.value.bindings,
      pass.program.module,
    );
    if (!checked.ok) return checked;
    cooked.push({
      pass: pass.name,
      module: pass.program.module,
      parameters,
      paramSchema: schema.value,
      generatedModule,
      sourceClosure: [sourceRecord.value.path, ...Object.keys(imports.value).sort()],
      compile: compiled.value,
    });
  }

  return ok({ resolved: resolved.value, passes: cooked });
}
