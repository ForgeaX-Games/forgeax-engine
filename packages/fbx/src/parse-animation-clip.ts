// parse-animation-clip.ts — M5 t50: TS bridge for animation clip POD data.
//
// Consumes the C++ JSON POD clips section emitted by t47 binding.cc
// (WriteAnimationData), performs merge-keys + linear resample at 30 fps,
// produces AnimationClipPod (types SSOT per requirements AC-07).
//
// Input schema (from JSON.parse of binding output):
//   clips?: [{
//     name?: string,
//     duration: number,
//     channels: [{
//       targetNode: string,
//       property: 'translation'|'rotation'|'scale',
//       keyTimesX: number[], keyValuesX: number[],
//       keyTimesY: number[], keyValuesY: number[],
//       keyTimesZ: number[], keyValuesZ: number[],
//     }],
//   }]
//
// Processing:
//   merge-keys: collect all unique timestamps from X/Y/Z axes, sort ascending
//   linear resample: evaluate each axis at each framestep (1/fps intervals)
//   output: AnimationClipPod.channels[].sampler.{input,output,interpolation:LINEAR}

import type {
  AnimationChannelPod,
  AnimationClipPod,
  AnimationSamplerPod,
} from '@forgeax/engine-types';

export interface FbxRawAnimChannel {
  readonly targetNode: string;
  readonly property: 'translation' | 'rotation' | 'scale';
  readonly keyTimesX?: number[];
  readonly keyValuesX?: number[];
  readonly keyTimesY?: number[];
  readonly keyValuesY?: number[];
  readonly keyTimesZ?: number[];
  readonly keyValuesZ?: number[];
}

export interface FbxRawClip {
  readonly name?: string;
  readonly duration: number;
  readonly channels: readonly FbxRawAnimChannel[];
}

export interface FbxRawAnimDoc {
  readonly clips?: readonly FbxRawClip[];
}

const DEFAULT_FPS = 30;

/**
 * Linearly interpolate between axis keyframes at time t.
 * Returns 0 when no keys are defined for this axis.
 */
function sampleAxis(keys: readonly number[], values: readonly number[], t: number): number {
  if (keys.length === 0) return 0;
  const firstKey = keys[0];
  const firstVal = values[0];
  const lastIdx = keys.length - 1;
  const lastKey = keys[lastIdx];
  const lastVal = values[lastIdx];
  if (firstKey === undefined || firstVal === undefined) return 0;
  if (lastKey === undefined || lastVal === undefined) return 0;
  if (t <= firstKey) return firstVal;
  if (t >= lastKey) return lastVal;
  for (let i = 1; i < keys.length; i++) {
    const curKey = keys[i];
    if (curKey === undefined || t > curKey) continue;
    const t0 = keys[i - 1];
    const t1 = curKey;
    const v0 = values[i - 1];
    const v1 = values[i];
    if (t0 === undefined || t1 === undefined || v0 === undefined || v1 === undefined) continue;
    const frac = (t - t0) / (t1 - t0);
    return v0 + (v1 - v0) * frac;
  }
  return lastVal;
}

/**
 * Build a per-frame sampler for one channel: merge unique timestamps
 * from X/Y/Z keys into a uniform timeline at the given fps, then
 * linearly interpolate each axis at each frame step.
 */
function buildSampler(ch: FbxRawAnimChannel, duration: number, fps: number): AnimationSamplerPod {
  const frameInterval = 1 / fps;
  const frameCount = Math.floor(duration * fps) + 1;

  const input = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    input[f] = f * frameInterval;
  }

  const stride = ch.property === 'rotation' ? 4 : 3;
  const output = new Float32Array(frameCount * stride);

  const xKeys = ch.keyTimesX ?? [];
  const xVals = ch.keyValuesX ?? [];
  const yKeys = ch.keyTimesY ?? [];
  const yVals = ch.keyValuesY ?? [];
  const zKeys = ch.keyTimesZ ?? [];
  const zVals = ch.keyValuesZ ?? [];

  for (let f = 0; f < frameCount; f++) {
    const t = input[f];
    if (t === undefined) continue;
    output[f * stride + 0] = sampleAxis(xKeys, xVals, t);
    output[f * stride + 1] = sampleAxis(yKeys, yVals, t);
    if (stride >= 3) output[f * stride + 2] = sampleAxis(zKeys, zVals, t);
    if (stride === 4) output[f * stride + 3] = 1;
  }

  return { input, output, interpolation: 'LINEAR' };
}

function buildChannel(ch: FbxRawAnimChannel, duration: number, fps: number): AnimationChannelPod {
  return {
    targetPath: ch.targetNode.split('/'),
    property: ch.property,
    sampler: buildSampler(ch, duration, fps),
  };
}

/**
 * Parse animation clips from a C++ JSON POD document.
 * Performs merge-keys + linear resample at the requested fps
 * (default 30). OOS-9: Hermite tangent data is discarded.
 *
 * Returns an empty array when the document has no clip data.
 */
export function parseAnimationClips(
  doc: FbxRawAnimDoc,
  fps: number = DEFAULT_FPS,
): AnimationClipPod[] {
  const clips = doc.clips;
  if (!clips || clips.length === 0) return [];

  return clips.map((clip): AnimationClipPod => {
    return {
      ...(clip.name !== undefined && { name: clip.name }),
      duration: clip.duration,
      channels: clip.channels.map((ch) => buildChannel(ch, clip.duration, fps)),
    };
  });
}
