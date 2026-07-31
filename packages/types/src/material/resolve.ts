import { err, ok, type Result } from '../result.js';
import type { MaterialAsset, MaterialParameter, MaterialPass, MaterialValue } from './asset.js';
import type { MaterialError } from './errors.js';
import { createMaterialError } from './errors.js';

export type MaterialTable = Readonly<Record<string, MaterialAsset>>;

export interface ResolvedMaterial {
  readonly leaf: string;
  readonly chain: readonly string[];
  readonly asset: MaterialAsset;
}

export function materialGuidText(value: string | Uint8Array): string {
  return typeof value === 'string'
    ? value
    : Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function valueType(value: MaterialValue): string {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return `vec${value.length}`;
  return 'texture';
}

function parameterTypeMatches(parameter: MaterialParameter, value: MaterialValue): boolean {
  switch (parameter.type) {
    case 'bool':
      return typeof value === 'boolean';
    case 'f32':
    case 'i32':
    case 'u32':
      return typeof value === 'number';
    case 'vec2':
      return Array.isArray(value) && value.length === 2;
    case 'vec3':
      return Array.isArray(value) && value.length === 3;
    case 'vec4':
    case 'color':
      return Array.isArray(value) && value.length === 4;
    case 'texture':
      // Runtime asset handles are branded numbers at the type level. The
      // brand is erased before a material reaches the resolver, so numeric
      // handles must remain valid texture values alongside structured
      // texture descriptors.
      return (
        (typeof value === 'number' && Number.isInteger(value) && value >= 0) ||
        (typeof value === 'object' && !Array.isArray(value))
      );
  }
}

function validateValues(
  material: string,
  values: Readonly<Record<string, MaterialValue | null>>,
  parameters: readonly MaterialParameter[] | undefined,
): Result<true, MaterialError> {
  if (parameters === undefined) return ok(true);
  const declarations = new Map(parameters.map((parameter) => [parameter.name, parameter]));
  for (const [name, value] of Object.entries(values)) {
    const parameter = declarations.get(name);
    if (parameter === undefined) {
      return err(
        createMaterialError('material-value-unknown', {
          code: 'material-value-unknown',
          material,
          parameter: name,
        }),
      );
    }
    if (value === null) {
      if (!parameter.optional) {
        return err(
          createMaterialError('material-value-type-mismatch', {
            code: 'material-value-type-mismatch',
            material,
            parameter: name,
            expectedType: parameter.type,
            actualType: 'null',
          }),
        );
      }
      continue;
    }
    if (!parameterTypeMatches(parameter, value)) {
      return err(
        createMaterialError('material-value-type-mismatch', {
          code: 'material-value-type-mismatch',
          material,
          parameter: name,
          expectedType: parameter.type,
          actualType: valueType(value),
        }),
      );
    }
  }
  return ok(true);
}

function mergePasses(
  inherited: readonly MaterialPass[] | undefined,
  override: readonly MaterialPass[] | undefined,
): readonly MaterialPass[] | undefined {
  if (inherited === undefined && override === undefined) return undefined;
  const passes = [...(inherited ?? [])];
  for (const next of override ?? []) {
    const index = passes.findIndex((current) => current.name === next.name);
    if (index === -1) passes.push(next);
    else passes[index] = next;
  }
  return passes;
}

function mergeMaterial(parent: MaterialAsset, child: MaterialAsset): MaterialAsset {
  const values: Record<string, MaterialValue> = {};
  for (const [name, value] of Object.entries(parent.values ?? {})) {
    if (value !== null) values[name] = value;
  }
  for (const [name, value] of Object.entries(child.values ?? {})) {
    if (value === null) delete values[name];
    else values[name] = value;
  }
  const passes = mergePasses(parent.passes, child.passes);
  return {
    kind: 'material',
    ...(passes !== undefined && passes.length > 0
      ? { passes: passes as NonNullable<MaterialAsset['passes']> }
      : {}),
    ...(parent.parameters !== undefined ? { parameters: parent.parameters } : {}),
    ...(Object.keys(values).length > 0 ? { values } : {}),
  };
}

function resolveChain(
  id: string,
  leaf: string,
  table: MaterialTable,
  stack: readonly string[],
): Result<ResolvedMaterial, MaterialError> {
  if (stack.includes(id)) {
    return err(
      createMaterialError('material-circular-inheritance', {
        code: 'material-circular-inheritance',
        leaf,
        chain: [...stack, id],
      }),
    );
  }
  const current = table[id];
  if (current === undefined) {
    return err(
      createMaterialError('material-parent-not-found', {
        code: 'material-parent-not-found',
        leaf,
        missingParent: id,
        chain: [...stack, id],
      }),
    );
  }
  const parent = current.parent === undefined ? undefined : materialGuidText(current.parent);
  if (parent === undefined) {
    if (current.passes === undefined || current.passes.length === 0) {
      return err(
        createMaterialError('material-no-effective-pass', {
          code: 'material-no-effective-pass',
          material: leaf,
        }),
      );
    }
    const values: Record<string, MaterialValue> = {};
    for (const [name, value] of Object.entries(current.values ?? {})) {
      if (value !== null) values[name] = value;
    }
    const valid = validateValues(id, values, current.parameters);
    if (!valid.ok) return valid;
    return ok({ leaf, chain: [id], asset: { ...current, values } });
  }

  const parentResult = resolveChain(parent, leaf, table, [...stack, id]);
  if (!parentResult.ok) return parentResult;
  const valid = validateValues(id, current.values ?? {}, parentResult.value.asset.parameters);
  if (!valid.ok) return valid;
  const merged = mergeMaterial(parentResult.value.asset, current);
  if (merged.passes === undefined || merged.passes.length === 0) {
    return err(
      createMaterialError('material-no-effective-pass', {
        code: 'material-no-effective-pass',
        material: leaf,
      }),
    );
  }
  return ok({ leaf, chain: [...parentResult.value.chain, id], asset: merged });
}

export function resolveMaterialAsset(
  leaf: string,
  table: MaterialTable,
): Result<ResolvedMaterial, MaterialError> {
  return resolveChain(leaf, leaf, table, []);
}
