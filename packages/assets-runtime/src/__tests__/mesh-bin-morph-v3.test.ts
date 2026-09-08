import { describe, expect, it } from 'vitest';
import { unpackMeshBinV4 } from '../loaders/mesh-bin';

describe('mesh-bin v4 morph validation', () => {
  it('rejects trailing bytes instead of silently accepting a malformed artifact', () => {
    const bytes = new Uint8Array(80 + 1);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 4, true);
    expect(unpackMeshBinV4(bytes, 'gltf://morph-trailing').ok).toBe(false);
  });

  it('rejects malformed metadata with a structured recovery error', () => {
    const bytes = new Uint8Array(80);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 4, true);
    const result = unpackMeshBinV4(bytes, 'gltf://morph-invalid');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.sourceKey).toBe('gltf://morph-invalid');
    expect(result.error.recovery).toContain('re-cook');
  });
});
