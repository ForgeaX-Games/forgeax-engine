import { describe, expect, it, vi } from 'vitest';
import { createAudioIntentBackend, listenerPoseFromWorldMatrix } from '../index';

const PLAY_OPTIONS = {
  loop: false,
  volume: 0.75,
  spatialBlend: 0.5,
  bus: 'sfx' as const,
};

describe('AudioIntent producer', () => {
  it('publishes source bytes once and reuses sourceKey afterwards', () => {
    const emit = vi.fn();
    const backend = createAudioIntentBackend({ emit });
    const clip = {
      kind: 'audio' as const,
      sourceKey: 'laser',
      bytes: new Uint8Array([1, 2, 3]),
    };

    backend.play(1, clip, PLAY_OPTIONS);
    backend.play(2, clip, PLAY_OPTIONS);

    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      kind: 'play',
      entityId: 1,
      sourceKey: 'laser',
      bytes: clip.bytes,
    });
    expect(emit.mock.calls[1]?.[0]).toEqual({
      kind: 'play',
      entityId: 2,
      sourceKey: 'laser',
      options: PLAY_OPTIONS,
    });
  });

  it('projects a scaled world matrix into normalized host listener pose', () => {
    const world = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
    expect(listenerPoseFromWorldMatrix(world)).toEqual({
      positionX: 5,
      positionY: 6,
      positionZ: 7,
      forwardX: -0,
      forwardY: -0,
      forwardZ: -1,
      upX: 0,
      upY: 1,
      upZ: 0,
    });
  });
});
