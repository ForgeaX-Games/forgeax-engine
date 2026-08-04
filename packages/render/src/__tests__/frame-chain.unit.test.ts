import { describe, expect, it } from 'vitest';
import { buildFrameChain, prepareFrame, recordFrame } from '../frame-chain';

describe('render frame chain', () => {
  it('accepts an empty world and produces a recordable frame', () => {
    const frame = buildFrameChain([]);
    const prepared = prepareFrame(frame, { resources: new Map() });
    expect(recordFrame(prepared).ok).toBe(true);
  });
});
