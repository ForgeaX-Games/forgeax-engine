import { ok, type Result } from '@forgeax/engine-types';
import {
  type DistanceFieldError,
  distanceFieldFailure,
  MAX_DISTANCE_FIELD_SAMPLES,
  MAX_VISIBILITY_DISTANCE_FIELD_AXIS,
  type MeshDistanceField,
} from './distance-field';

/** Structural admission is shared by decoded artifacts and direct query snapshots. */
export function validateMeshDistanceField(
  field: MeshDistanceField,
): Result<void, DistanceFieldError> {
  const policy = field.policy;
  if (!policy || !['signed-solid', 'two-sided', 'sampled-visibility'].includes(policy.kind))
    return distanceFieldFailure('unknown distance-field policy');
  const visibility = policy.kind === 'sampled-visibility';
  if (
    !/^[a-f0-9]{64}$/.test(field.meshDigest) ||
    field.dimensions.length !== 3 ||
    field.origin.length !== 3 ||
    field.bounds.min.length !== 3 ||
    field.bounds.max.length !== 3 ||
    field.dimensions.some(
      (v) =>
        !Number.isInteger(v) || v < 3 || v > (visibility ? MAX_VISIBILITY_DISTANCE_FIELD_AXIS : 68),
    ) ||
    !(field.values instanceof Float32Array) ||
    field.values.length !== field.dimensions.reduce((a, b) => a * b) ||
    field.values.length > MAX_DISTANCE_FIELD_SAMPLES ||
    !field.values.every(Number.isFinite) ||
    !Number.isFinite(field.spacing) ||
    field.spacing <= 0 ||
    ![...field.origin, ...field.bounds.min, ...field.bounds.max].every((v) =>
      Number.isFinite(Math.fround(v)),
    ) ||
    field.bounds.min.some(
      (v, a) =>
        (policy.kind === 'signed-solid'
          ? v >= (field.bounds.max[a] ?? -Infinity)
          : v > (field.bounds.max[a] ?? -Infinity)) || v < (field.origin[a] ?? Infinity),
    ) ||
    field.bounds.max.some(
      (v, a) => v > (field.origin[a] ?? 0) + ((field.dimensions[a] ?? 0) - 1) * field.spacing,
    ) ||
    !Number.isInteger(field.quality.negativeSamples) ||
    field.quality.negativeSamples < 0 ||
    (policy.kind === 'two-sided' && field.quality.negativeSamples !== 0) ||
    (policy.kind === 'signed-solid' && field.quality.negativeSamples < 1) ||
    field.values.filter((v) => v < 0).length !== field.quality.negativeSamples ||
    !Number.isInteger(field.quality.testedTriangles) ||
    field.quality.testedTriangles < (policy.kind === 'signed-solid' ? 4 : 1) ||
    field.quality.testedTriangles >
      (visibility ? 1_048_576 : policy.kind === 'two-sided' ? 65536 : 1024)
  )
    return distanceFieldFailure('invalid, incomplete or inconsistent distance-field payload');
  if (policy.kind !== 'sampled-visibility') {
    if (
      !Number.isFinite(policy.errorBound) ||
      policy.errorBound < (Math.sqrt(3) * field.spacing) / 2
    )
      return distanceFieldFailure('invalid geometric distance bound');
  } else {
    const bounds = policy.traceBounds;
    if (
      !/^[a-f0-9]{64}$/.test(policy.sourceDigest) ||
      typeof policy.mostlyTwoSided !== 'boolean' ||
      !bounds ||
      bounds.min.length !== 3 ||
      bounds.max.length !== 3 ||
      ![...bounds.min, ...bounds.max, policy.distanceBand].every((v) =>
        Number.isFinite(Math.fround(v)),
      ) ||
      policy.distanceBand !== Math.fround(4 * Math.sqrt(3) * field.spacing) ||
      field.values.some((v) => Math.abs(v) > policy.distanceBand) ||
      bounds.min.some(
        (v, a) =>
          v >= (bounds.max[a] ?? -Infinity) ||
          v > (field.bounds.min[a] ?? -Infinity) ||
          v !== Math.fround((field.origin[a] ?? NaN) + field.spacing) ||
          v - (field.origin[a] ?? Infinity) < field.spacing * 0.99,
      ) ||
      bounds.max.some(
        (v, a) =>
          v < (field.bounds.max[a] ?? Infinity) ||
          (field.origin[a] ?? 0) + ((field.dimensions[a] ?? 0) - 1) * field.spacing - v <
            field.spacing * 0.99,
      )
    )
      return distanceFieldFailure('invalid visibility bounds, band or source policy');
    for (const axis of [0, 1, 2] as const) {
      let previous = -Infinity;
      for (let i = 0; i < field.dimensions[axis]; i++) {
        const center = Math.fround(field.origin[axis] + Math.fround(i * field.spacing));
        if (!Number.isFinite(center) || center <= previous)
          return distanceFieldFailure('visibility samples must have distinct finite f32 centers');
        previous = center;
      }
    }
  }
  return ok(undefined);
}
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
/** Little-endian f32 samples plus a small versioned metadata header; no authored asset identity. */
export async function encodeMeshDistanceField(
  field: MeshDistanceField,
): Promise<Result<Uint8Array, DistanceFieldError>> {
  const valid = validateMeshDistanceField(field);
  if (!valid.ok) return valid;
  const values = new Uint8Array(field.values.length * 4),
    v = new DataView(values.buffer);
  field.values.forEach((sample, i) => {
    v.setFloat32(i * 4, sample, true);
  });
  const { values: _, ...metadata } = field;
  const header = new TextEncoder().encode(JSON.stringify({ version: 3, ...metadata }));
  const bytes = new Uint8Array(4 + header.length + values.length + 64);
  new DataView(bytes.buffer).setUint32(0, header.length, true);
  bytes.set(header, 4);
  bytes.set(values, 4 + header.length);
  bytes.set(new TextEncoder().encode(await digest(bytes.subarray(0, -64))), bytes.length - 64);
  return ok(bytes);
}
/** Rejects stale geometry, missing/truncated samples and corrupt metadata or samples before GPU upload. */
export async function decodeMeshDistanceField(
  bytes: Uint8Array,
  expectedMeshDigest: string,
): Promise<Result<MeshDistanceField, DistanceFieldError>> {
  try {
    if (bytes.byteLength < 68 || bytes.byteLength > 4 + 4096 + MAX_DISTANCE_FIELD_SAMPLES * 4 + 64)
      return distanceFieldFailure('invalid artifact byte length');
    if ((await digest(bytes.subarray(0, -64))) !== new TextDecoder().decode(bytes.subarray(-64)))
      return distanceFieldFailure('distance-field artifact digest mismatch');
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    );
    if (headerLength > 4096 || headerLength + 4 >= bytes.length - 64)
      return distanceFieldFailure('missing artifact header or samples');
    const header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + headerLength)),
    );
    if (header.version !== 3 || header.meshDigest !== expectedMeshDigest)
      return distanceFieldFailure('unsupported or stale distance-field artifact');
    const samples = bytes.subarray(4 + headerLength, -64);
    if (samples.length % 4 !== 0) return distanceFieldFailure('truncated distance-field samples');
    const view = new DataView(samples.buffer, samples.byteOffset, samples.byteLength),
      values = new Float32Array(samples.length / 4);
    for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(i * 4, true);
    const { version: _, ...metadata } = header;
    const field: MeshDistanceField = { ...metadata, values };
    const valid = validateMeshDistanceField(field);
    return valid.ok ? ok(field) : valid;
  } catch {
    return distanceFieldFailure('malformed distance-field artifact');
  }
}
