// parse-animation-clip.ts — M5 t50: TS bridge for animation clip POD data.
//
// Consumes the C++ JSON POD clips section emitted by binding.cc
// (WriteAnimationData), linear-resamples each channel to a fixed fps,
// produces AnimationClipPod (types SSOT per requirements AC-07).
//
// Input schema (from JSON.parse of binding output) — flat per-channel timeline:
//   clips?: [{
//     name?: string,
//     duration: number,
//     channels: [{
//       targetNode: string,
//       property: 'translation'|'rotation'|'scale',
//       keyTimes: number[],     // ascending, seconds
//       keyValues: number[],    // interleaved, stride 3 (T/S) or 4 (rotation quat xyzw)
//     }],
//   }]
//
// The binding emits rotation as a real unit quaternion sampled from
// node->EvaluateLocalTransform(t).GetQ() (NOT raw euler-degree curves), so the
// bridge only resamples + re-normalizes; it never euler-converts.
//
// Processing:
//   linear resample: evaluate the strided keyValues at each framestep (1/fps)
//   rotation: per-component lerp then normalize (nlerp); runtime slerps further
//   output: AnimationClipPod.channels[].sampler.{input,output,interpolation:LINEAR}

import type {
  AnimationChannelPod,
  AnimationClipPod,
  AnimationSamplerPod,
} from '@forgeax/engine-types';

export interface FbxRawAnimChannel {
  readonly targetNode: string;
  readonly property: 'translation' | 'rotation' | 'scale';
  /** Ascending key timestamps in seconds. */
  readonly keyTimes?: number[];
  /** Interleaved key values, stride 3 (translation/scale) or 4 (rotation quat). */
  readonly keyValues?: number[];
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
 * Linear-interpolate a strided keyValues stream at time t into `out`.
 *
 * keyTimes is ascending; keyValues holds `stride` floats per key. Clamps to
 * the first/last key outside the range. For rotation (stride 4) the result is
 * a per-component lerp; the caller normalizes it (nlerp) — runtime playback
 * slerps further, so import-time nlerp is sufficient to keep unit length.
 */
function sampleStrided(
  keyTimes: readonly number[],
  keyValues: readonly number[],
  stride: number,
  t: number,
  out: number[],
): void {
  const n = keyTimes.length;
  if (n === 0) {
    for (let c = 0; c < stride; c++) out[c] = c === 3 ? 1 : 0;
    return;
  }
  const first = keyTimes[0] as number;
  const lastIdx = n - 1;
  const last = keyTimes[lastIdx] as number;
  if (t <= first) {
    for (let c = 0; c < stride; c++) out[c] = keyValues[c] ?? 0;
    return;
  }
  if (t >= last) {
    for (let c = 0; c < stride; c++) out[c] = keyValues[lastIdx * stride + c] ?? 0;
    return;
  }
  // Find bracket [i-1, i].
  let i = 1;
  while (i < n && (keyTimes[i] as number) < t) i++;
  const t0 = keyTimes[i - 1] as number;
  const t1 = keyTimes[i] as number;
  const frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const b0 = (i - 1) * stride;
  const b1 = i * stride;
  for (let c = 0; c < stride; c++) {
    const v0 = keyValues[b0 + c] ?? 0;
    const v1 = keyValues[b1 + c] ?? 0;
    out[c] = v0 + (v1 - v0) * frac;
  }
}

/**
 * Build a per-frame sampler for one channel: resample the flat strided
 * keyValues onto a uniform timeline at the given fps. Rotation channels are
 * re-normalized per frame so the lerp output stays a unit quaternion.
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

  const keyTimes = ch.keyTimes ?? [];
  const keyValues = ch.keyValues ?? [];
  const tmp = new Array<number>(stride);

  for (let f = 0; f < frameCount; f++) {
    const t = input[f] as number;
    sampleStrided(keyTimes, keyValues, stride, t, tmp);
    const base = f * stride;
    if (stride === 4) {
      const len = Math.hypot(tmp[0] ?? 0, tmp[1] ?? 0, tmp[2] ?? 0, tmp[3] ?? 0);
      const inv = len > 0 ? 1 / len : 0;
      output[base + 0] = (tmp[0] ?? 0) * inv;
      output[base + 1] = (tmp[1] ?? 0) * inv;
      output[base + 2] = (tmp[2] ?? 0) * inv;
      output[base + 3] = len > 0 ? (tmp[3] ?? 0) * inv : 1;
    } else {
      output[base + 0] = tmp[0] ?? 0;
      output[base + 1] = tmp[1] ?? 0;
      output[base + 2] = tmp[2] ?? 0;
    }
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
