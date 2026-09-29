import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';

/** Generate the sole material parameter module from the derived root schema. */
export function generateParameterModule(schema: readonly ParamSchemaEntry[]): string {
  const derived = derive(schema);
  const coordinateRecords = derived.coordinateRecords ?? [];
  const resourceBindings = derived.resourceBindings ?? [];
  const fields = schema
    .flatMap((parameter) => {
      if (isNumericParameter(parameter)) return [`  ${parameter.name} : ${wgslType(parameter)},`];
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
  if (fields.length > 0) lines.push(`struct MaterialParameters {\n${fields}\n}`);

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
  return [
    'texture2d',
    'texture2d_array',
    'texture3d',
    'texture_cube',
    'texture_depth_2d',
    'texture_cube_array',
  ].includes(parameter.type);
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
    case 'texture2d_array':
      return 'texture_2d_array<f32>';
    case 'texture3d':
      return 'texture_3d<f32>';
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
  throw new Error('unsupported material parameter type');
}
