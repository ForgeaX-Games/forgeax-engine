import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildFrameChain, prepareFrame, recordFrame } from '../frame-chain';

describe('render frame chain', () => {
  it('accepts an empty world and produces a recordable frame', () => {
    const frame = buildFrameChain([]);
    const prepared = prepareFrame(frame, { resources: new Map() });
    expect(recordFrame(prepared).ok).toBe(true);
  });

  it('keeps one light snapshot identity across extract and record stages', () => {
    const snapshot = { kind: 'spot', direction: [0, 1, 0] };
    const extracted = buildFrameChain([snapshot]);
    const prepared = prepareFrame(extracted, { resources: new Map() });

    expect(prepared.extracted.worlds[0]).toBe(snapshot);
    expect(recordFrame(prepared).ok).toBe(true);
  });

  it('keeps the light extract query owner singular', async () => {
    const source = await readFile(new URL('../render-system-extract.ts', import.meta.url), 'utf8');
    expect(source.match(/const spotLightQuery =/g)).toHaveLength(1);
    expect(source.match(/const pointLightQuery =/g)).toHaveLength(1);
  });
});
