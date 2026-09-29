import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from './errors';
import type { ReplayReadbackResult, ReplaySession } from './replay/session';

export interface BufferRecordLayout {
  readonly stride: number;
  readonly fields: readonly {
    readonly name: string;
    readonly offset: number;
    readonly type: 'f32' | 'u32' | 'i32';
    readonly components: 1 | 2 | 3 | 4;
  }[];
}

export type BufferScalar = number | 'NaN' | '+Infinity' | '-Infinity';
export interface BufferRecords {
  readonly provenance: ReplayReadbackResult['provenance'];
  readonly records: readonly {
    readonly index: number;
    readonly fields: Readonly<Record<string, readonly BufferScalar[]>>;
  }[];
}

/** Explicit layout interpretation of one bounded post-work buffer range; no second artifact. */
export async function inspectBufferRecords(
  session: ReplaySession,
  resourceId: string,
  workIndex: number,
  layout: BufferRecordLayout,
  range: { readonly first: number; readonly count: number },
  signal?: AbortSignal,
): Promise<Result<BufferRecords, RhiDebugError>> {
  const invalid = validateLayout(layout, range);
  if (invalid !== undefined) return invalid;
  const read = await session.readResourceAtWork(
    resourceId,
    workIndex,
    {
      offset: layout.stride * range.first,
      size: layout.stride * range.count,
    },
    signal,
  );
  if (!read.ok) return read;
  return decodeBufferRecords(read.value, layout, range);
}

/** Preserve mixed integer/floating fields and nonfinite values without converting IDs to floats. */
export function decodeBufferRecords(
  read: ReplayReadbackResult,
  layout: BufferRecordLayout,
  range: { readonly first: number; readonly count: number },
): Result<BufferRecords, RhiDebugError> {
  const invalid = validateLayout(layout, range);
  if (invalid !== undefined) return invalid;
  if (read.kind !== 'buffer' || read.bytes.byteLength !== layout.stride * range.count)
    return failure('expected the exact requested buffer record range');
  const view = new DataView(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
  return ok({
    provenance: read.provenance,
    records: Array.from({ length: range.count }, (_, i) => ({
      index: range.first + i,
      fields: Object.fromEntries(
        layout.fields.map((field) => [
          field.name,
          Array.from({ length: field.components }, (_, component): BufferScalar => {
            const offset = i * layout.stride + field.offset + component * 4;
            const value =
              field.type === 'f32'
                ? view.getFloat32(offset, true)
                : field.type === 'u32'
                  ? view.getUint32(offset, true)
                  : view.getInt32(offset, true);
            return Number.isNaN(value)
              ? 'NaN'
              : value === Infinity
                ? '+Infinity'
                : value === -Infinity
                  ? '-Infinity'
                  : value;
          }),
        ]),
      ),
    })),
  });
}

function validateLayout(
  layout: BufferRecordLayout,
  range: { first: number; count: number },
): Result<never, RhiDebugError> | undefined {
  if (
    !Number.isSafeInteger(layout.stride) ||
    layout.stride < 4 ||
    layout.stride % 4 !== 0 ||
    layout.stride > 65_536 ||
    !Number.isSafeInteger(range.first) ||
    range.first < 0 ||
    !Number.isInteger(range.count) ||
    range.count < 1 ||
    range.count > 4096 ||
    !Number.isSafeInteger((range.first + range.count) * layout.stride) ||
    layout.stride * range.count > 16 * 1024 * 1024
  )
    return failure('expected an aligned bounded range: 1..4096 records and at most 16 MiB');
  if (
    layout.fields.length === 0 ||
    layout.fields.length > 64 ||
    new Set(layout.fields.map((f) => f.name)).size !== layout.fields.length
  )
    return failure('expected 1..64 uniquely named fields');
  for (const field of layout.fields) {
    if (
      !field.name ||
      !Number.isInteger(field.offset) ||
      field.offset < 0 ||
      field.offset % 4 !== 0 ||
      !['f32', 'u32', 'i32'].includes(field.type) ||
      ![1, 2, 3, 4].includes(field.components) ||
      field.offset + field.components * 4 > layout.stride
    )
      return failure(`field ${field.name} exceeds or disagrees with its record layout`);
  }
  return undefined;
}

function failure(cause: string): Result<never, RhiDebugError> {
  return err(createRhiDebugError('readback-failed', { stage: 'readback', cause }));
}
