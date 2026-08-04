// parse-animation.ts - glTF animation parser (feat-20260523-skin-skeleton-animation M0).
//
// Implements parseAnimation(): parses glTF `animations[]` array into
// GltfAnimationClipRecord[] with duration, channels, and sampler data.
// Used by parseGltfWithBin to populate GltfDoc.
//
// Decision anchors:
//   - plan-strategy D-1 (AnimationClip independent asset)
//   - requirements AC-07 (AnimationClip shape), AC-09 (CUBICSPLINE/morph fail-fast)
//   - requirements AC-10 (IR extension)
//   - charter P3 (fail-fast on unsupported interpolation/morph targets)

import { deriveAnimationTargetId } from '@forgeax/engine-animation/target-id';
import type { AnimationTargetIdValue } from '@forgeax/engine-types';
import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';
import { buildNodeParentMap, resolveNamedNodePath } from './node-path.js';

/** Supported interpolation modes (CUBICSPLINE is deferred to OOS-skin-cubicspline). */
type Interpolation = 'LINEAR' | 'STEP';

interface ChannelJson {
  readonly sampler: number;
  readonly target: {
    readonly node?: number;
    readonly path: string;
  };
}

interface SamplerJson {
  readonly input: number;
  readonly output: number;
  readonly interpolation?: string;
}

interface AnimationJson {
  readonly name?: string;
  readonly channels: readonly ChannelJson[];
  readonly samplers: readonly SamplerJson[];
}

interface AccessorJson {
  readonly bufferView?: number;
  readonly componentType: number;
  readonly type: string;
  readonly count: number;
  readonly byteOffset?: number;
}

interface BufferViewJson {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
}

/**
 * Decode a F32 SCALAR or VEC accessor into a Float32Array.
 */
function decodeFloatAccessor(
  accessorIndex: number,
  accessor: AccessorJson,
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<Float32Array, GltfError> {
  if (accessor.componentType !== 5126) {
    return err(
      gltfErr('gltf-accessor-type-mismatch', { accessorIndex, reason: 'unknownComponentType' }),
    );
  }
  const bvIndex = accessor.bufferView;
  if (bvIndex === undefined) {
    return err(
      gltfErr('gltf-buffer-out-of-bounds', {
        accessor: accessorIndex,
        byteOffset: 0,
        byteLength: 0,
        bufferIndex: 0,
      }),
    );
  }
  const bv = bufferViews[bvIndex];
  if (bv === undefined) {
    return err(
      gltfErr('gltf-buffer-out-of-bounds', {
        accessor: accessorIndex,
        byteOffset: 0,
        byteLength: 0,
        bufferIndex: bvIndex,
      }),
    );
  }
  const buf = buffers[bv.buffer];
  if (buf === undefined) {
    return err(
      gltfErr('gltf-buffer-out-of-bounds', {
        accessor: accessorIndex,
        byteOffset: bv.byteOffset ?? 0,
        byteLength: bv.byteLength,
        bufferIndex: bv.buffer,
      }),
    );
  }
  const typeCounts: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const componentCount = typeCounts[accessor.type];
  if (componentCount === undefined) {
    return err(
      gltfErr('gltf-accessor-type-mismatch', { accessorIndex, reason: 'unknownComponentType' }),
    );
  }
  const elementSize = 4 * componentCount;
  const totalBytes = elementSize * accessor.count;
  const absoluteOffset = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (absoluteOffset + totalBytes > buf.byteLength) {
    return err(
      gltfErr('gltf-buffer-out-of-bounds', {
        accessor: accessorIndex,
        byteOffset: absoluteOffset,
        byteLength: totalBytes,
        bufferIndex: bv.buffer,
      }),
    );
  }
  const out = new Float32Array(accessor.count * componentCount);
  const src = new Float32Array(buf.buffer, buf.byteOffset + absoluteOffset, out.length);
  out.set(src);
  return ok(out);
}

export interface GltfAnimationChannelRecord {
  readonly targetId: AnimationTargetIdValue;
  readonly targetNodeIndex: number;
  /** 'translation' | 'rotation' | 'scale'. */
  readonly property: string;
  /** Sampler driving this channel. */
  readonly sampler: GltfAnimationSamplerRecord;
}

export interface GltfAnimationSamplerRecord {
  /** Keyframe timestamp array (ascending). */
  readonly input: Float32Array;
  /** Keyframe value array per element size. */
  readonly output: Float32Array;
  /** 'LINEAR' | 'STEP'. */
  readonly interpolation: Interpolation;
}

export interface GltfAnimationClipRecord {
  /** Producer-authored animation name, when the source provides one. */
  readonly name?: string;
  /** Clip duration = max(sampler.input[last]). */
  readonly duration: number;
  /** Per-joint-property channels. */
  readonly channels: readonly GltfAnimationChannelRecord[];
}

/**
 * Parse glTF animations[] array into GltfAnimationClipRecord[].
 *
 * Only LINEAR and STEP interpolation are supported. CUBICSPLINE triggers
 * fail-fast with 'gltf-animation-cubicspline-unsupported'. Channels
 * targeting morph weights (path === 'weights') trigger fail-fast with
 * 'gltf-morph-unsupported'.
 */
export function parseAnimation(
  animationsJson: readonly AnimationJson[] | undefined,
  nodesJson: readonly { readonly name?: string; readonly children?: readonly number[] }[],
  accessors: readonly AccessorJson[],
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<readonly GltfAnimationClipRecord[], GltfError> {
  if (animationsJson === undefined || animationsJson.length === 0) {
    return ok([]);
  }

  const clips: GltfAnimationClipRecord[] = [];
  const parentOf = buildNodeParentMap(nodesJson);
  const nodeByPath = new Map<string, number>();
  const pathById = new Map<AnimationTargetIdValue, string>();

  for (let animIdx = 0; animIdx < animationsJson.length; animIdx++) {
    const anim = animationsJson[animIdx];
    if (anim === undefined) continue;

    // Decode samplers first (shared across channels).
    const decodedSamplers: GltfAnimationSamplerRecord[] = [];
    for (let sampIdx = 0; sampIdx < anim.samplers.length; sampIdx++) {
      const sampler = anim.samplers[sampIdx];
      if (sampler === undefined) continue;

      const interpolation = (sampler.interpolation ?? 'LINEAR') as string;
      if (interpolation === 'CUBICSPLINE') {
        return err(
          gltfErr('gltf-animation-cubicspline-unsupported', {
            animationIndex: animIdx,
            samplerIndex: sampIdx,
          }),
        );
      }
      if (interpolation !== 'LINEAR' && interpolation !== 'STEP') {
        return err(
          gltfErr('gltf-animation-cubicspline-unsupported', {
            animationIndex: animIdx,
            samplerIndex: sampIdx,
          }),
        );
      }

      const inputAcc = accessors[sampler.input];
      if (inputAcc === undefined) {
        return err(
          gltfErr('gltf-buffer-out-of-bounds', {
            accessor: sampler.input,
            byteOffset: 0,
            byteLength: 0,
            bufferIndex: 0,
          }),
        );
      }
      const inputResult = decodeFloatAccessor(sampler.input, inputAcc, bufferViews, buffers);
      if (!inputResult.ok) return err(inputResult.error);

      const outputAcc = accessors[sampler.output];
      if (outputAcc === undefined) {
        return err(
          gltfErr('gltf-buffer-out-of-bounds', {
            accessor: sampler.output,
            byteOffset: 0,
            byteLength: 0,
            bufferIndex: 0,
          }),
        );
      }
      const outputResult = decodeFloatAccessor(sampler.output, outputAcc, bufferViews, buffers);
      if (!outputResult.ok) return err(outputResult.error);

      decodedSamplers.push({
        input: inputResult.value,
        output: outputResult.value,
        interpolation: interpolation as Interpolation,
      });
    }

    // Decode channels.
    const channels: GltfAnimationChannelRecord[] = [];
    for (let chIdx = 0; chIdx < anim.channels.length; chIdx++) {
      const ch = anim.channels[chIdx];
      if (ch === undefined) continue;

      if (ch.target.path === 'weights') {
        return err(
          gltfErr('gltf-morph-unsupported', {
            animationIndex: animIdx,
            channelIndex: chIdx,
            nodeIndex: ch.target.node ?? -1,
          }),
        );
      }

      const samplerRecord = decodedSamplers[ch.sampler];
      if (samplerRecord === undefined) {
        return err(
          gltfErr('gltf-buffer-out-of-bounds', {
            accessor: ch.sampler,
            byteOffset: 0,
            byteLength: 0,
            bufferIndex: 0,
          }),
        );
      }

      const targetNodeIdx = ch.target.node;
      const path =
        targetNodeIdx === undefined
          ? { ok: false as const, reason: 'name-missing' as const, nodeIndex: -1 }
          : resolveNamedNodePath(nodesJson, parentOf, targetNodeIdx);
      if (!path.ok) {
        return err(
          gltfErr('gltf-animation-target-invalid', {
            reason: path.reason,
            animationIndex: animIdx,
            channelIndex: chIdx,
            nodeIndex: path.nodeIndex,
          }),
        );
      }
      const pathKey = JSON.stringify(path.value);
      const previousNode = nodeByPath.get(pathKey);
      if (previousNode !== undefined && previousNode !== targetNodeIdx) {
        return err(
          gltfErr('gltf-animation-target-invalid', {
            reason: 'path-duplicate',
            animationIndex: animIdx,
            channelIndex: chIdx,
            nodeIndex: targetNodeIdx as number,
          }),
        );
      }
      nodeByPath.set(pathKey, targetNodeIdx as number);
      const targetId = deriveAnimationTargetId(path.value);
      const previousPath = pathById.get(targetId);
      if (previousPath !== undefined && previousPath !== pathKey) {
        return err(
          gltfErr('gltf-animation-target-invalid', {
            reason: 'id-collision',
            animationIndex: animIdx,
            channelIndex: chIdx,
            nodeIndex: targetNodeIdx as number,
          }),
        );
      }
      pathById.set(targetId, pathKey);

      channels.push({
        targetId,
        targetNodeIndex: targetNodeIdx as number,
        property: ch.target.path,
        sampler: samplerRecord,
      });
    }

    // Compute duration = max(sampler.input[last]) across all channels.
    let duration = 0;
    for (const ch of channels) {
      const input = ch.sampler.input;
      if (input.length > 0) {
        const last = input[input.length - 1];
        if (last !== undefined && last > duration) {
          duration = last;
        }
      }
    }

    const name = anim.name?.trim();
    clips.push({
      ...(name === undefined || name.length === 0 ? {} : { name }),
      duration,
      channels,
    });
  }

  return ok(clips);
}
