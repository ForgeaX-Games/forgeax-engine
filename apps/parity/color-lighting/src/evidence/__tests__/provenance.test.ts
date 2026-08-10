import { describe, expect, it } from 'vitest';
import { validateAttachmentEvidence, type AttachmentEvidence } from '../../capture/attachment-readback';
import { validateProvenance } from '../../capture/named-capture';

const evidence: AttachmentEvidence = {
  linearHdr: {
    kind: 'linearHdr',
    status: 'ready',
    bytes: new Uint8Array([1]),
    format: 'rgba16float',
    size: { width: 1, height: 1 },
    rawHash: 'linear',
    frameId: 1,
    pipelineId: 'forgeax::hdrp',
    backendId: 'dawn',
  },
  finalDisplay: {
    kind: 'finalDisplay',
    status: 'ready',
    bytes: new Uint8Array([2]),
    format: 'rgba8unorm',
    size: { width: 1, height: 1 },
    rawHash: 'display',
    frameId: 1,
    pipelineId: 'forgeax::hdrp',
    backendId: 'dawn',
  },
};

describe('capture provenance contract', () => {
  it('rejects identical implementation identities', () => {
    const result = validateProvenance({
      forgeax: { implementation: 'forgeax', version: 'dev' },
      three: { implementation: 'forgeax', version: 'dev' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected provenance conflict');
    expect(result.error.code).toBe('provenance-conflict');
  });

  it('requires the fixed Three WebGPU primary identity', () => {
    const result = validateProvenance({
      forgeax: { implementation: 'forgeax', version: 'dev' },
      three: { implementation: 'three', version: 'r184', renderer: 'webgl' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected missing primary');
    expect(result.error.code).toBe('primary-capture-missing');
  });

  it('requires explicit frame, pipeline, and backend provenance', () => {
    const { frameId: _frameId, ...linearWithoutFrame } = evidence.linearHdr;
    const result = validateAttachmentEvidence({
      ...evidence,
      linearHdr: linearWithoutFrame,
    });
    expect(result.ok).toBe(false);
  });

  it('does not accept a URP producer as an HDRP observation', () => {
    const result = validateAttachmentEvidence(
      {
        ...evidence,
        linearHdr: { ...evidence.linearHdr, pipelineId: 'forgeax::urp' },
      },
      'forgeax::hdrp',
    );
    expect(result.ok).toBe(false);
  });
});
