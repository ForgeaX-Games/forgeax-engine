import { describe, expect, it } from 'vitest';
import { validateVertexColorReadback } from '../../capture/attachment-readback';

describe('vertex-color Dawn visual lane', () => {
  it('fails closed when Dawn has not completed the 300-frame producer readback', () => {
    const result = validateVertexColorReadback({
      backend: 'dawn',
      frameCount: 299,
      colorDomain: 'linearHdr',
      source: 'live-producer',
      readback: 'copyTextureToBuffer',
      finalBytes: new Uint8Array([1]),
      linearBytes: new Uint8Array([1]),
      frameId: 298,
      rawHash: 'not-enough-evidence',
    });
    expect(result.ok).toBe(false);
  });
});
