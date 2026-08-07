import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const encoderSource = readFileSync(
  new URL('../../../import/src/mesh-bin.ts', import.meta.url),
  'utf8',
);
const decoderSource = readFileSync(
  new URL('../../../assets-runtime/src/mesh-bin.ts', import.meta.url),
  'utf8',
);

describe('mesh-bin consumer owner surface', () => {
  it('routes both production halves through Pack-owned facts', () => {
    for (const source of [encoderSource, decoderSource]) {
      expect(source).toContain("from '@forgeax/engine-pack'");
      expect(source).toContain('MESH_BIN_HEADER_V2_BYTES');
      expect(source).toContain('MESH_BIN_VERSION');
      expect(source).not.toContain('const HEADER_V2_BYTES = 28');
    }
  });
});
