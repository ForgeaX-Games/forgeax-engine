import type { TextureFormat } from '@forgeax/engine-rhi';
import type { TemporalFrame, TemporalResetReason } from './temporal/frame';

export type TemporalInspectionStatus =
  | 'authored-off'
  | 'available'
  | 'capability-unavailable'
  | 'temporal-degraded';

export interface TemporalInspection {
  readonly status: TemporalInspectionStatus;
  readonly resetReason: TemporalResetReason;
  readonly historyEpoch: number;
  readonly deviceEpoch: number;
  readonly backend: string | undefined;
  readonly format: TextureFormat | undefined;
  readonly limits: Readonly<{
    readonly maxTextureDimension2D?: number;
    readonly maxTextureDimension3D?: number;
    readonly maxTextureArrayLayers?: number;
  }>;
  readonly compute: 'available' | 'unavailable';
  readonly storage: 'available' | 'unavailable';
}

export interface TemporalInspectionInput {
  readonly authored: boolean;
  readonly capability: 'available' | 'unavailable';
  readonly degraded?: boolean;
  readonly frame?: TemporalFrame;
  readonly backend?: string;
  readonly format?: TextureFormat;
  readonly limits?: Readonly<Record<string, number>>;
}

export function inspectTemporalFrame(input: TemporalInspectionInput): TemporalInspection {
  const frame = input.frame;
  const status: TemporalInspectionStatus = !input.authored
    ? 'authored-off'
    : input.capability === 'unavailable'
      ? 'capability-unavailable'
      : input.degraded === true
        ? 'temporal-degraded'
        : 'available';
  return Object.freeze({
    status,
    resetReason: frame?.resetReason ?? 'none',
    historyEpoch: frame?.historyEpoch ?? 0,
    deviceEpoch: frame?.deviceEpoch ?? 0,
    backend: input.backend,
    format: input.format,
    limits: Object.freeze({
      ...(typeof input.limits?.maxTextureDimension2D === 'number'
        ? { maxTextureDimension2D: input.limits.maxTextureDimension2D }
        : {}),
      ...(typeof input.limits?.maxTextureDimension3D === 'number'
        ? { maxTextureDimension3D: input.limits.maxTextureDimension3D }
        : {}),
      ...(typeof input.limits?.maxTextureArrayLayers === 'number'
        ? { maxTextureArrayLayers: input.limits.maxTextureArrayLayers }
        : {}),
    }),
    compute: input.capability === 'available' ? 'available' : 'unavailable',
    storage: input.capability === 'available' ? 'available' : 'unavailable',
  });
}
