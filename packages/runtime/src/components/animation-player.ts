// @forgeax/engine-runtime - AnimationPlayer component (N-way animation SoA slots).
//
// Schema (6 fields, SoA inline arrays):
//   clips:   'array<shared<AnimationClip>, 4>'   (layer-3 zero — all-NULL handles, no slot active)
//   times:   'array<f32, 4>'                      (layer-3 zero — all-zero Float32Array(4))
//   weights: 'array<f32, 4>'                      (layer-3 zero — all-zero Float32Array(4))
//   speeds:  'array<f32, 4>'                      (layer-2 [1,1,1,1] — every active slot plays at 1x)
//   paused:  'bool'                                (layer-2 false)
//   looping: 'bool'                                (layer-2 true)
//
// Four slots support up to 4 concurrent clips for crossfade blending.
// Slot i is active when clips[i] != 0 (invalid handle = id=0).
// advanceAnimationPlayer skips slot i when clips[i]=0.
//
// Default-fallback contract (engine-ecs three-layer SSOT):
//   layer 1 (caller) — explicit raw, e.g. `data: { clips: [h], weights: [1] }`
//   layer 2 (this file) — `default:` on the field descriptor (speeds / paused / looping)
//   layer 3 (engine-ecs) — typeDefault(fieldType): bool->false, array<T,N>->[0,0,...]
//
// Short-prefix accepted: `clips: [h]` writes [h, 0, 0, 0] (writeArrayField pads
// the row tail with zero). The minimal call to play one clip on slot 0 is:
//   data: { clips: [h], weights: [1] }
//
// Naming: single-semantic component drops the 'Component' suffix
// (AGENTS.md §Component naming rule #1). Field names mirror common game
// engine convention (Unity Animator / Godot AnimationPlayer speed/paused
// /looping idioms).
//
// Decision anchors:
//   - requirements IS-1 (SoA inline arrays, N=4 slots)
//   - requirements AC-01 (6 field name set)
//   - tweak-20260616: speeds layer-2 default = [1,1,1,1] (was all-zero, plan
//     D-6 retired — "play at 1x" is the only sensible default for a slot
//     whose clip is set; user can still override per-slot when needed)
//   - charter P4 (consistent abstraction: single component surface)

import { defineComponent } from '@forgeax/engine-ecs';

export const AnimationPlayer = defineComponent('AnimationPlayer', {
  clips: { type: 'array<shared<AnimationClip>, 4>' },
  times: { type: 'array<f32, 4>' },
  weights: { type: 'array<f32, 4>' },
  speeds: { type: 'array<f32, 4>', default: new Float32Array([1, 1, 1, 1]) },
  paused: { type: 'bool', default: false },
  looping: { type: 'bool', default: true },
});
