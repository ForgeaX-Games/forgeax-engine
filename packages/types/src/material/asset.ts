import type { AssetGuid } from '../index.js';

export type MaterialParameterType =
  | 'bool'
  | 'f32'
  | 'i32'
  | 'u32'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'color'
  | 'texture';

export interface MaterialParameter {
  readonly name: string;
  readonly type: MaterialParameterType;
  readonly default?: MaterialValue;
  readonly optional?: boolean;
  readonly static?: boolean;
}

export interface MaterialTextureCoordinates {
  readonly set?: number;
  readonly transform?: {
    readonly offset?: readonly [number, number];
    readonly scale?: readonly [number, number];
    readonly rotation?: number;
  };
}

export interface MaterialTextureValue {
  readonly texture: AssetGuid;
  readonly sampler?: AssetGuid;
  readonly coordinates?: MaterialTextureCoordinates;
  readonly normalScale?: number;
  readonly occlusionStrength?: number;
}

export type MaterialValue = boolean | number | readonly number[] | MaterialTextureValue;

export interface MaterialProgram {
  readonly module: string;
  readonly vertexEntry?: string;
  readonly fragmentEntry?: string;
  readonly moduleSlots?: Readonly<Record<string, string>>;
}

export interface MaterialPass {
  readonly name: string;
  readonly program: MaterialProgram;
  readonly renderState?: Readonly<Record<string, unknown>>;
}

export type MaterialPassList = readonly [MaterialPass, ...MaterialPass[]];

export interface MaterialAsset {
  readonly kind: 'material';
  readonly parent?: AssetGuid;
  readonly passes?: MaterialPassList;
  readonly parameters?: readonly MaterialParameter[];
  readonly values?: Readonly<Record<string, MaterialValue | null>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate JSON-authored material descriptors at their loading boundary. */
export function assertMaterialAsset(
  value: unknown,
  context = 'material',
): asserts value is MaterialAsset {
  if (!isRecord(value) || value.kind !== 'material') {
    throw new Error(`${context}: expected a material asset`);
  }
  if (value.passes !== undefined) {
    if (!Array.isArray(value.passes) || value.passes.length === 0) {
      throw new Error(`${context}: passes must be a non-empty array`);
    }
    for (const [index, pass] of value.passes.entries()) {
      if (!isRecord(pass) || typeof pass.name !== 'string' || !isRecord(pass.program)) {
        throw new Error(`${context}: pass ${index} is malformed`);
      }
      if (typeof pass.program.module !== 'string' || pass.program.module.length === 0) {
        throw new Error(`${context}: pass ${index} has no module identity`);
      }
      if (
        (pass.program.vertexEntry !== undefined && typeof pass.program.vertexEntry !== 'string') ||
        (pass.program.fragmentEntry !== undefined && typeof pass.program.fragmentEntry !== 'string')
      ) {
        throw new Error(`${context}: pass ${index} has malformed entry points`);
      }
      if (pass.program.moduleSlots !== undefined) {
        if (!isRecord(pass.program.moduleSlots)) {
          throw new Error(`${context}: pass ${index} has malformed module slots`);
        }
        for (const [name, slot] of Object.entries(pass.program.moduleSlots)) {
          if (typeof slot !== 'string')
            throw new Error(`${context}: module slot ${name} is not a string`);
        }
      }
    }
  }
  if (value.parameters !== undefined) {
    if (!Array.isArray(value.parameters))
      throw new Error(`${context}: parameters must be an array`);
    for (const [index, parameter] of value.parameters.entries()) {
      if (
        !isRecord(parameter) ||
        typeof parameter.name !== 'string' ||
        typeof parameter.type !== 'string'
      ) {
        throw new Error(`${context}: parameter ${index} is malformed`);
      }
    }
  }
}
