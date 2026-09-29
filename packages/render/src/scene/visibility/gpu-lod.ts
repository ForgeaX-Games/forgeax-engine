import { GPU_SCENE_LAYOUTS, GPU_SCENE_SCHEMAS } from '../../gpu-scene-schema';
import { type LodSelection, selectLod } from './lod-selector';

export const GPU_LOD_ROW_SCHEMA = GPU_SCENE_SCHEMAS.lod;
export const GPU_LOD_ROW_LAYOUT = GPU_SCENE_LAYOUTS.lod;

export interface LodDrawRange {
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly baseVertex: number;
}

export interface GpuLodRowsInput {
  readonly generation: number;
  readonly hysteresis: number;
  readonly ranges: readonly LodDrawRange[];
  /** Absolute projected-height thresholds, including root at index zero. */
  readonly coverages: readonly number[];
  readonly ready: readonly boolean[];
}

export interface GpuLodRow extends LodDrawRange {
  readonly generation: number;
  readonly level: number;
  readonly screenCoverage: number;
  readonly hysteresis: number;
  readonly ready: boolean;
}

function finiteInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function finiteFraction(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be in [0, 1]`);
  }
  return value;
}

/** Projects one stable row per draw range; it never contains a per-view choice. */
export function buildGpuLodRows(input: GpuLodRowsInput): readonly GpuLodRow[] {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new RangeError('generation must be a non-negative safe integer');
  }
  if (input.ranges.length === 0 || input.ranges.length !== input.coverages.length) {
    throw new RangeError('ranges and coverages must have the same non-zero length');
  }
  if (input.ready.length !== input.ranges.length) {
    throw new RangeError('ready must have one value for every LOD range');
  }
  if (!Number.isFinite(input.hysteresis) || input.hysteresis < 0 || input.hysteresis >= 1) {
    throw new RangeError('hysteresis must be in [0, 1)');
  }
  let previousCoverage = 1;
  return Object.freeze(
    input.ranges.map((range, level) => {
      const coverage = finiteFraction(input.coverages[level] ?? Number.NaN, `coverage[${level}]`);
      if (level === 0 && coverage !== 1) throw new RangeError('root coverage must be 1');
      if (level > 0 && coverage >= previousCoverage) {
        throw new RangeError('LOD coverages must be strictly decreasing');
      }
      previousCoverage = coverage;
      return Object.freeze({
        generation: input.generation,
        level,
        firstIndex: finiteInteger(range.firstIndex, `ranges[${level}].firstIndex`),
        indexCount: finiteInteger(range.indexCount, `ranges[${level}].indexCount`),
        baseVertex: Number.isSafeInteger(range.baseVertex) ? range.baseVertex : 0,
        screenCoverage: coverage,
        hysteresis: input.hysteresis,
        ready: input.ready[level] === true,
      });
    }),
  );
}

export function encodeGpuLodRows(rows: readonly GpuLodRow[]): Uint8Array {
  const bytes = new Uint8Array(GPU_LOD_ROW_LAYOUT.stride * rows.length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const row of rows) {
    const offset = row.level * GPU_LOD_ROW_LAYOUT.stride;
    view.setUint32(offset, row.generation, true);
    view.setUint32(offset + 4, row.level, true);
    view.setUint32(offset + 8, row.firstIndex, true);
    view.setUint32(offset + 12, row.indexCount, true);
    view.setInt32(offset + 16, row.baseVertex, true);
    view.setFloat32(offset + 20, row.screenCoverage, true);
    view.setFloat32(offset + 24, row.hysteresis, true);
    view.setUint32(offset + 28, row.ready ? 1 : 0, true);
  }
  return bytes;
}

export interface GpuLodSelectionInput {
  readonly projectedHeight: number;
  readonly previousLevel: number;
  readonly historyValid: boolean;
}

/** CPU reference used by both the GPU selector contract and unsupported fallback. */
export function selectGpuLod(
  rows: readonly GpuLodRow[],
  input: GpuLodSelectionInput,
): LodSelection {
  const first = rows[0];
  if (first === undefined) return { level: 0, confidence: 1 };
  return selectLod({
    levels: rows.slice(1),
    projectedHeight: input.projectedHeight,
    previousLevel: input.previousLevel,
    hysteresis: first.hysteresis,
    ready: rows.map((row) => row.ready),
    historyValid: input.historyValid,
  });
}
