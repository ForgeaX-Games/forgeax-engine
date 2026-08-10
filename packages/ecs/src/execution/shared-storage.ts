import type { QuerySpan } from '../query/query';
import type { SharedKernelDispatch } from './shared-kernel';

export type SharedFieldView =
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array;

export interface SharedSpanBinding {
  readonly length: number;
  readonly read: Readonly<Record<string, Readonly<Record<string, SharedFieldView>>>>;
  readonly write: Readonly<Record<string, Readonly<Record<string, SharedFieldView>>>>;
}

function sliceFields(
  fields: Readonly<Record<string, SharedFieldView>>,
  start: number,
  end: number,
): Readonly<Record<string, SharedFieldView>> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, view]) => [name, view.subarray(start, end)]),
  );
}

export function bindSharedSpan(
  kernel: SharedKernelDispatch,
  span: QuerySpan,
  queryIndex: number,
): SharedSpanBinding {
  const descriptor = kernel.queries[queryIndex];
  if (descriptor === undefined) throw new Error(`Missing query descriptor ${queryIndex}.`);
  const read = Object.fromEntries(
    (descriptor.read ?? []).map((component) => [
      component.name,
      span.get(component) as unknown as Record<string, SharedFieldView>,
    ]),
  );
  const write = Object.fromEntries(
    (descriptor.write ?? []).map((component) => [
      component.name,
      span.mut(component) as unknown as Record<string, SharedFieldView>,
    ]),
  );
  return { length: span.length, read, write };
}

export function splitSharedSpan(
  binding: SharedSpanBinding,
  shardCount: number,
): readonly SharedSpanBinding[] {
  if (binding.length === 0 || shardCount <= 0) return [];
  const count = Math.min(binding.length, shardCount);
  const shards: SharedSpanBinding[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor((binding.length * index) / count);
    const end = Math.floor((binding.length * (index + 1)) / count);
    shards.push({
      length: end - start,
      read: Object.fromEntries(
        Object.entries(binding.read).map(([component, fields]) => [
          component,
          sliceFields(fields, start, end),
        ]),
      ),
      write: Object.fromEntries(
        Object.entries(binding.write).map(([component, fields]) => [
          component,
          sliceFields(fields, start, end),
        ]),
      ),
    });
  }
  return shards;
}

export function isSharedSpan(binding: SharedSpanBinding): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  return [...Object.values(binding.read), ...Object.values(binding.write)].every((fields) =>
    Object.values(fields).every((view) => view.buffer instanceof SharedArrayBuffer),
  );
}
