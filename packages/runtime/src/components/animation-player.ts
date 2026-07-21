// @forgeax/engine-runtime - AnimationPlayer component (variable N-way SoA slots).
//
// Schema (10 fields, SoA variable arrays):
//   clips:   'array<shared<AnimationClip>>'   (layer-3 zero — empty, no slot active)
//   times:   'array<f32>'                      (layer-3 zero — empty Float32Array)
//   weights: 'array<f32>'                      (layer-3 zero — empty Float32Array)
//   speeds:  'array<f32>'                      (layer-3 zero — empty Float32Array)
//   graph:       'shared<AnimationGraph>'      (layer-3 zero — 0, no graph)
//   nodeWeights: 'array<f32>'                  (layer-3 zero — empty Float32Array)
//   nodeTimes:   'array<f32>'                  (layer-3 zero — empty Float32Array)
//   nodeSpeeds:  'array<f32>'                  (layer-3 zero — empty Float32Array)
//   paused:  'bool'                                (layer-2 false)
//   looping: 'bool'                                (layer-2 true)
//
// The four parallel columns support up to N concurrent clips for crossfade
// blending — the fixed 4-slot cap is retired (feat-20260713 M1 / w4). Slot i is
// active when clips[i] != 0 (invalid handle = id=0). advanceAnimationPlayer
// skips slot i when clips[i]=0.
//
// Graph mode (feat-20260713 M3 / w24, plan D-3): a SINGLE component surface hosts
// both direct-write and graph-driven playback — no second peer component (the
// requirements forbid a parallel component that splits the evaluation path). The
// `graph` scalar carries a `shared<AnimationGraph>` handle; the three node-*
// columns carry per-node runtime knobs (weight / seek-time / speed), indexed by
// graph node index:
//   - graph == 0 (no handle): clips[] / times[] / weights[] / speeds[] are the
//     DIRECT-WRITE SSOT (the pre-M3 behaviour; consumers own the slots).
//   - graph != 0: evaluateAnimationGraph (a before-advance system) is the SOLE
//     writer of clips[] / times[] / weights[] / speeds[] — they become DERIVED
//     output of the post-order graph evaluation, and any caller-written slot
//     values are overwritten each frame. The effective weight of a node is its
//     runtime weight (nodeWeights, default 1 per node) x its graph static weight
//     (AC-07 orthogonal product); eval owns the seek-time via nodeTimes/nodeSpeeds
//     and parks speeds[]=0 so advance does not re-advance it (D-7).
//
// Parallel-length contract (D-5): clips / times / weights / speeds are variable
// `array<T>` columns set field-by-field (release-then-alloc per field), so the
// ECS layer cannot cross-check their lengths. Consumers MUST write all four
// columns at the SAME length every time; advanceAnimationPlayer's evaluation
// entry validates this once per row and rejects a mismatch with the structured
// `animation-player-slot-length-mismatch` error (errors/animation-player.ts).
//
// Default-fallback contract (engine-ecs three-layer SSOT):
//   layer 1 (caller) — explicit raw, e.g. `data: { clips: [h], weights: [1] }`
//   layer 2 (this file) — `default:` on the field descriptor (paused / looping)
//   layer 3 (engine-ecs) — typeDefault(fieldType): bool->false, array<T>->[]
//
// Unlike the retired fixed schema, a variable column does not tail-pad a short
// write: `clips: [h]` stores length 1, NOT [h, 0, 0, 0]. The minimal call to
// play one clip on slot 0 writes all four columns length-synced:
//   data: { clips: [h], times: [0], weights: [1], speeds: [1] }
//
// Naming: single-semantic component drops the 'Component' suffix
// (AGENTS.md §Component naming rule #1). Field names mirror common game
// engine convention (Unity Animator / Godot AnimationPlayer speed/paused
// /looping idioms).
//
// Decision anchors:
//   - requirements IS-1 (SoA arrays) + AC-01 (variable N-slot, 6 field set)
//   - requirements OOS-6 (no ECS-layer change; reuse the existing variable
//     array<T> / array<shared<T>> vocab, mirroring MeshRenderer.materials)
//   - feat-20260713 M1 plan D-1 (variable columns) / D-6 (speeds default [])
//   - feat-20260713 M3 plan D-3 (graph handle + per-node runtime knobs extend
//     the existing component; no second peer component) / D-7 (eval owns time)
//   - charter P4 (consistent abstraction: single component surface)

import { defineComponent } from '@forgeax/engine-ecs';

export const AnimationPlayer = defineComponent('AnimationPlayer', {
  clips: { type: 'array<shared<AnimationClip>>' },
  times: { type: 'array<f32>' },
  weights: { type: 'array<f32>' },
  speeds: { type: 'array<f32>' },
  graph: { type: 'shared<AnimationGraph>' },
  nodeWeights: { type: 'array<f32>' },
  nodeTimes: { type: 'array<f32>' },
  nodeSpeeds: { type: 'array<f32>' },
  paused: { type: 'bool', default: false },
  looping: { type: 'bool', default: true },
});
