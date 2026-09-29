import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  applyParamSchemaDefaultsToUbo,
  applyParamSnapshotToUbo,
} from '../record/main-pass-material';

describe('material numeric upload', () => {
  it.each([
    'buffer',
    'bytes',
    'floats',
  ] as const)('preserves WGSL integer bits in a %s payload', (kind) => {
    const storage = new ArrayBuffer(48);
    new Uint8Array(storage).fill(0xcd);
    const payload =
      kind === 'buffer'
        ? storage
        : kind === 'bytes'
          ? new Uint8Array(storage, 16, 16)
          : new Float32Array(storage, 16, 4);
    const offset = kind === 'buffer' ? 0 : 16;
    const schema: readonly ParamSchemaEntry[] = [
      { name: 'signed', type: 'i32' },
      { name: 'unsigned', type: 'u32' },
      { name: 'gain', type: 'f32' },
    ];
    applyParamSnapshotToUbo(payload, schema, { signed: -7, unsigned: 0xfedcba98, gain: 0.25 });
    const view = new DataView(storage, offset, 16);
    expect(view.getInt32(0, true)).toBe(-7);
    expect(view.getUint32(4, true)).toBe(0xfedcba98);
    expect(view.getFloat32(8, true)).toBe(0.25);
    expect(view.getUint32(12, true)).toBe(0xcdcdcdcd);
    if (kind !== 'buffer')
      expect(new Uint8Array(storage).slice(0, 16)).toEqual(new Uint8Array(16).fill(0xcd));
  });

  it('seeds prepared payloads from numeric schema defaults before authored overlays', () => {
    const payload = new Uint8Array(64);
    const schema: readonly ParamSchemaEntry[] = [
      { name: 'roughness', type: 'f32', default: 0.5 },
      { name: 'tint', type: 'vec3', default: [1, 0.5, 0.25] },
      { name: 'ignoredTexture', type: 'texture2d' },
    ];
    applyParamSchemaDefaultsToUbo(payload, schema);
    const seeded = new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4);
    expect(seeded[0]).toBe(0.5);
    expect([...seeded.slice(4, 7)]).toEqual([1, 0.5, 0.25]);
    applyParamSnapshotToUbo(payload, schema, { roughness: 0.25 });
    expect(seeded[0]).toBe(0.25);
    expect([...seeded.slice(4, 7)]).toEqual([1, 0.5, 0.25]);
  });
});
