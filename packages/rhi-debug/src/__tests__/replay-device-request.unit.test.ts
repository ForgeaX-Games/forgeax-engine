import { describe, expect, it } from 'vitest';
import type { Tape } from '../protocol/types';
import { replayDeviceRequest } from '../replay/device-request';

describe('replay device descriptor features', () => {
  const empty: Tape = {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  };
  for (const phase of ['bootstrap', 'frame'] as const) {
    it(`requests float depth/stencil from ${phase} resources, even on an unsupported adapter`, () => {
      const create = {
        kind: 'createTexture' as const,
        handleId: 'texture:1',
        desc: {
          size: [64, 64] as [number, number],
          format: 'depth32float-stencil8' as const,
          usage: 16,
        },
      };
      const tape: Tape =
        phase === 'bootstrap'
          ? {
              ...empty,
              bootstrap: [{ handleId: create.handleId, kind: 'texture', create, initialData: [] }],
            }
          : { ...empty, events: [create] };
      expect(replayDeviceRequest(tape, new Set(), {}).requiredFeatures).toEqual([
        'depth32float-stencil8',
      ]);
    });
  }
  it('does not impose a renderer depth format on generic tapes', () => {
    expect(replayDeviceRequest(empty, new Set(['depth32float-stencil8']), {})).toEqual({});
  });
  for (const phase of ['bootstrap', 'frame'] as const) {
    it(`requests WGSL device features from ${phase}, regardless of adapter support`, () => {
      const create = {
        kind: 'createShaderModule' as const,
        handleId: 'shader-module:1',
        wgslCode: 'enable primitive_index, f16; enable subgroups; enable primitive_index;',
      };
      const tape: Tape =
        phase === 'bootstrap'
          ? {
              ...empty,
              bootstrap: [
                { handleId: create.handleId, kind: 'shader-module', create, initialData: [] },
              ],
            }
          : { ...empty, events: [create] };
      expect(replayDeviceRequest(tape, new Set(), {}).requiredFeatures).toEqual([
        'primitive-index',
        'shader-f16',
        'subgroups',
      ]);
    });
  }
  it('ignores nested comments and accepts comments between enable tokens', () => {
    const tape: Tape = {
      ...empty,
      events: [
        {
          kind: 'createShaderModule',
          handleId: 'shader-module:1',
          wgslCode: `// enable f16;
          /* outer /* inner */ enable subgroups; // this is still a block comment */
          enable/* separator */primitive_index;
          // enable subgroups;`,
        },
      ],
    };
    expect(replayDeviceRequest(tape, new Set(), {}).requiredFeatures).toEqual(['primitive-index']);
  });
});
