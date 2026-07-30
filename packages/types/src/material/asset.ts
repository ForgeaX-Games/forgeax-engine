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
