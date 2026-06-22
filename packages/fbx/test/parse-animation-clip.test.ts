// parse-animation-clip.test.ts -- M5 t54: animation parse-bridge unit test.
//
// R1 fixup: tests now import the real parseAnimationClips from
// src/parse-animation-clip.ts (instead of an inline stub), closing
// the AC-07 coverage gap.

import { describe, expect, it } from 'vitest';
import type { AnimationClipPod } from '@forgeax/engine-types';
import { parseAnimationClips } from '../src/parse-animation-clip.js';
import type { FbxRawAnimDoc } from '../src/parse-animation-clip.js';

const MOCK_ANIM_RAW: FbxRawAnimDoc = {
  clips: [
    {
      name: 'Walk',
      duration: 1.0,
      channels: [
        {
          targetNode: 'root/hip',
          property: 'translation',
          keyTimesX: [0, 0.5, 1.0],
          keyValuesX: [0, 5, 10],
          keyTimesY: [0, 1.0],
          keyValuesY: [0, 0],
          keyTimesZ: [0, 1.0],
          keyValuesZ: [0, 0],
        },
      ],
    },
  ],
};

describe('parseAnimationClips', () => {
  it('parses single clip with merge-keys and 30fps resample', () => {
    const pods: AnimationClipPod[] = parseAnimationClips(MOCK_ANIM_RAW, 30);

    expect(pods.length).toBe(1);
    const pod = pods[0]!;
    expect(pod.name).toBe('Walk');
    expect(pod.duration).toBeCloseTo(1.0);
    expect(pod.channels.length).toBe(1);

    const ch = pod.channels[0]!;
    expect(ch.property).toBe('translation');
    expect(ch.targetPath).toEqual(['root', 'hip']);

    // 30 fps resample: 0..1.0 at 1/30 increments = 31 frames
    const sampler = ch.sampler;
    expect(sampler.input.length).toBe(31);
    expect(sampler.input[0]).toBeCloseTo(0);
    expect(sampler.input[30]).toBeCloseTo(1.0);
    expect(sampler.interpolation).toBe('LINEAR');

    // Output stride = 3 for translation
    expect(sampler.output.length).toBe(31 * 3);

    // Frame 0: X=0, Y=0, Z=0
    expect(sampler.output[0]).toBeCloseTo(0);
    expect(sampler.output[1]).toBeCloseTo(0);
    expect(sampler.output[2]).toBeCloseTo(0);

    // Frame 15 (t=0.5): X is linear between 0->10 (key 0.5 = value 5)
    const midIdx = 15 * 3;
    expect(sampler.output[midIdx + 0]).toBeCloseTo(5); // X at t=0.5
    expect(sampler.output[midIdx + 1]).toBeCloseTo(0);
    expect(sampler.output[midIdx + 2]).toBeCloseTo(0);

    // Frame 30 (t=1.0): X=10, Y=0, Z=0
    const lastIdx = 30 * 3;
    expect(sampler.output[lastIdx + 0]).toBeCloseTo(10);
  });

  it('returns empty array for missing clips', () => {
    const pods = parseAnimationClips({});
    expect(pods.length).toBe(0);
  });

  it('handles clip with no channels', () => {
    const raw: FbxRawAnimDoc = {
      clips: [{ name: 'Empty', duration: 1.0, channels: [] }],
    };
    const pods = parseAnimationClips(raw);
    expect(pods.length).toBe(1);
    expect(pods[0]!.channels.length).toBe(0);
  });

  it('defaults to 30 fps', () => {
    const pods = parseAnimationClips(MOCK_ANIM_RAW);
    expect(pods.length).toBe(1);
    expect(pods[0]!.channels[0]!.sampler.input.length).toBe(31);
  });
});