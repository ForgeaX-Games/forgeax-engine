// Animation clip and graph contracts.
import type { AnimationTargetIdValue } from './animation-target.js';

// === Skeleton / Skin / AnimationClip asset POD shapes (feat-20260523-skin-skeleton-animation M0) ===
//
// Decision anchors:
//   - requirements AC-01 (SkeletonAsset shape: kind, guid, inverseBindMatrices Float32Array, jointCount)
//   - requirements AC-04 (Skin sub-asset shape: kind, guid, skeletonGuid, jointPaths)
//   - requirements AC-07 (AnimationClip shape: kind, guid, duration, channels)
//   - plan-strategy D-1 (3-asset separation: IBM/Skin bindings/AnimationClip curves physically independent)
//   - charter P3 (explicit failure: all shape carry typed fields, no loose Record<string,unknown> payloads)
//
// AnimationChannel / AnimationSampler sub-types are inline here since they are
// exclusively consumed by AnimationClip; no other asset or component references them.

/** Stable target identity linking a sampler to a scene entity. */
export interface AnimationChannel {
  /** Stable animation target identity. */
  readonly targetId: AnimationTargetIdValue;
  /** Target transform property: 'translation' | 'rotation' | 'scale' | 'weights'. */
  readonly property: 'translation' | 'rotation' | 'scale' | 'weights';
  /** Sampler driving this channel. */
  readonly sampler: AnimationSampler;
}

/**
 * Animation sampler — keyframe curve for a single animation-target-property pair.
 *
 * `input` and `output` are Float32Arrays of equal length
 * (`output.length = input.length * elementCount`) where elementCount is:
 *   - 3 for 'translation' / 'scale' (vec3)
 *   - 4 for 'rotation' (quat)
 *   - targetCount for 'weights' (morph weights)
 *
 * `interpolation` is restricted to LINEAR and STEP per D-1 scope;
 * CUBICSPLINE is deferred to OOS-skin-cubicspline (fail-fast at importer).
 */
export interface AnimationSampler {
  readonly input: Float32Array;
  readonly output: Float32Array;
  readonly interpolation: 'LINEAR' | 'STEP';
}

/**
 * Animation clip asset POD shape.
 *
 * `duration` is max(sampler.input[last]) across all channels — the
 * longest channel defines the clip length. Each channel targets one
 * animation-target property, resolved during playback by `targetId`.
 */
export interface AnimationClip {
  readonly kind: 'animation-clip';
  readonly duration: number;
  readonly channels: readonly AnimationChannel[];
}

// === AnimationGraph asset POD + node union (feat-20260713 M2 / w13) ==============
//
// Decision anchors:
//   - requirements AC-02 (declarative Clip/Blend/Add + nesting graph carried as
//     a shared<AnimationGraph> asset handle, multi-entity shared).
//   - requirements AC-14 (AnimationGraph joins the closed `Asset` union, owns a
//     GUID, and serializes into pack/scene round-trip — foundation landed here,
//     the serialize/deserialize mechanism itself is M4).
//   - requirements OOS-1/OOS-2/OOS-3/OOS-4 (node union is CLOSED at three
//     variants — clip / blend / add. No FSM state/transition, no bone Mask, no
//     built-in transition layer, no BlendSpace fields are reserved; deferred
//     features add nodes in a future closed loop, not speculative fields now —
//     charter F4 "no unvalidated abstraction").
//   - requirements OOS-7 (POD carries only the topology of an engine-authored
//     defineAnimationGraph graph; no DCC import metadata).
//   - plan-strategy D-4 (POD + node union land in types/index.ts, the single-file
//     SSOT for every Asset POD, alongside AnimationClip).
//
// The POD mirrors AnimationClip: no inline `guid` field — the GUID is assigned by
// the AssetRegistry / shared-handle system when the graph is registered (like
// AnimationClip / MaterialAsset / VideoAsset). Nodes are stored flat in `nodes[]`
// and referenced by index; `root` is the index of the output node. Clip leaves
// carry a durable GUID string; the runtime consumer resolves that GUID to a
// World-local transient shared handle only at evaluation time.

/**
 * Clip leaf node — samples a single `shared<AnimationClip>` at the node's
 * runtime seek-time (M3 evaluation). `weight` is the node's STATIC weight; the
 * effective weight is `runtime weight x static weight` (requirements AC-07
 * orthogonal product).
 */
export interface AnimationGraphClipNode {
  readonly type: 'clip';
  readonly clip: string;
  readonly weight: number;
}

/**
 * Blend node — normalizing lerp over its children (requirements AC-04). Child
 * effective weights are normalized so they sum to 1 at evaluation. `children`
 * are indices into the parent {@link AnimationGraph.nodes} array.
 */
export interface AnimationGraphBlendNode {
  readonly type: 'blend';
  readonly children: readonly number[];
  readonly weight: number;
}

/**
 * Add node — non-normalizing additive stack (requirements AC-05). The `base`
 * child contributes its effective weight unchanged; each `additive` layer is
 * added on top WITHOUT normalization (total may exceed 1). `base` and
 * `additive` are indices into {@link AnimationGraph.nodes}.
 */
export interface AnimationGraphAddNode {
  readonly type: 'add';
  readonly base: number;
  readonly additive: readonly number[];
  readonly weight: number;
}

/**
 * Closed node union — exactly three variants (clip / blend / add). AI users
 * exhaustive `switch (node.type)` without default; TS guards completeness
 * (charter P3). No FSM / Mask / transition / BlendSpace variants are reserved
 * (OOS-1..4).
 */
export type AnimationGraphNode =
  | AnimationGraphClipNode
  | AnimationGraphBlendNode
  | AnimationGraphAddNode;

/**
 * AnimationGraph asset POD — a Clip/Blend/Add DAG with per-node static weights.
 *
 * Joins the closed `Asset` union with `kind: 'animation-graph'` (AC-14); minted
 * into a `Handle<'AnimationGraph', 'shared'>` via `world.allocSharedRef` /
 * `AssetRegistry`, shared across multiple entities. Constructed via
 * `defineAnimationGraph` (runtime), which validates topology (no out-of-range
 * refs / cycles / invalid weights / empty graph) before a handle is minted.
 */
export interface AnimationGraph {
  readonly kind: 'animation-graph';
  readonly nodes: readonly AnimationGraphNode[];
  readonly root: number;
}
