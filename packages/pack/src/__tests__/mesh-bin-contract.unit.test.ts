import { describe, expect, it } from 'vitest';
import { MESH_BIN_HEADER_V2_BYTES, MESH_BIN_VERSION } from '../mesh-bin-contract';

describe('mesh-bin wire contract', () => {
  it('owns the v2 header facts', () => {
    expect(MESH_BIN_VERSION).toBe(2);
    expect(MESH_BIN_HEADER_V2_BYTES).toBe(28);
  });
});
