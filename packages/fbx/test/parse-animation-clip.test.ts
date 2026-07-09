// parse-animation-clip.test.ts -- M5 t54: animation parse-bridge unit test.
//
// Schema: flat per-channel timeline (keyTimes + interleaved keyValues, stride 3
// for translation/scale, 4 for rotation quat). The binding emits real unit
// quaternions for rotation (sampled from EvaluateLocalTransform().GetQ()), so
// the bridge only resamples + re-normalizes -- it never euler-converts.

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
          // stride 3, interpolating X 0 -> 5 -> 10 with Y/Z flat at 0
          keyTimes: [0, 0.5, 1.0],
          keyValues: [0, 0, 0, 5, 0, 0, 10, 0, 0],
        },
      ],
    },
  ],
};

describe('parseAnimationClips', () => {
  it('parses single clip with 30fps resample', () => {
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

  it('rotation channel is a unit quaternion at every frame (regression: euler-as-quat)', () => {
    // Two real unit quaternions: identity -> 90deg about Y.
    const s = Math.SQRT1_2; // sin(45deg) = cos(45deg)
    const raw: FbxRawAnimDoc = {
      clips: [
        {
          name: 'Turn',
          duration: 1.0,
          channels: [
            {
              targetNode: 'root',
              property: 'rotation',
              keyTimes: [0, 1.0],
              // stride 4 (xyzw): identity, then (0, sin45, 0, cos45)
              keyValues: [0, 0, 0, 1, 0, s, 0, s],
            },
          ],
        },
      ],
    };

    const pod = parseAnimationClips(raw, 30)[0]!;
    const ch = pod.channels[0]!;
    expect(ch.property).toBe('rotation');
    const out = ch.sampler.output;
    expect(out.length).toBe(31 * 4);

    // Every frame must be a UNIT quaternion. The old euler-as-quat bug
    // produced values like quat x=62.93 (length far from 1).
    for (let f = 0; f < 31; f++) {
      const b = f * 4;
      const len = Math.hypot(out[b]!, out[b + 1]!, out[b + 2]!, out[b + 3]!);
      expect(len).toBeCloseTo(1, 4);
      // No component may exceed unit magnitude (euler degrees would).
      for (let c = 0; c < 4; c++) expect(Math.abs(out[b + c]!)).toBeLessThanOrEqual(1.0001);
    }

    // Endpoints match the authored quaternions.
    expect(out[3]).toBeCloseTo(1); // frame0 w = 1 (identity)
    const last = 30 * 4;
    expect(out[last + 1]).toBeCloseTo(s); // frameN y
    expect(out[last + 3]).toBeCloseTo(s); // frameN w
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
