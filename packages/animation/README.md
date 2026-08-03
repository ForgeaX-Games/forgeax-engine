# `@forgeax/engine-animation`

> [!IMPORTANT]
> Ordinary entities and skin joints use the same `AnimationTargetId` model. A
> target needs `Transform`, but does not need `Skin` or a renderer component.

## Quick start

```ts
import {
  AnimationPlayer,
  AnimationTargetId,
  animationPlugin,
  bindAnimationTargets,
  deriveAnimationTargetId,
} from '@forgeax/engine-animation';
import { World } from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import type { AnimationClip } from '@forgeax/engine-types';

const world = new World();
await animationPlugin().build(world);

const targetId = deriveAnimationTargetId(['Root', 'Planet']);
const clip = {
  kind: 'animation-clip',
  duration: 1,
  channels: [{
    targetId,
    property: 'translation',
    sampler: {
      input: new Float32Array([0, 1]),
      output: new Float32Array([0, 0, 0, 4, 0, 0]),
      interpolation: 'LINEAR',
    },
  }],
} satisfies AnimationClip;
const clipHandle = world.allocSharedRef('AnimationClip', clip);
const slots = {
  clips: [clipHandle],
  times: [0],
  weights: [1],
  speeds: [1],
};
const player = world.spawn(
  { component: Transform, data: {} },
  { component: Name, data: { value: 'Root' } },
  { component: AnimationPlayer, data: slots },
).unwrap();
const target = world.spawn(
  { component: Transform, data: {} },
  { component: Name, data: { value: 'Planet' } },
  { component: ChildOf, data: { parent: player } },
  { component: AnimationTargetId, data: { value: targetId } },
).unwrap();

const bound = bindAnimationTargets(world, player, [target]);
if (!bound.ok) throw bound.error;
world.update(1 / 60);
```

For imported scenes, collect targets explicitly from `SceneInstance.mapping`.
Only `ENTITY_NULL_RAW` is absent from that mapping; entity handle `0` is valid.
Adding an `AnimationPlayer` does not scan the scene tree. `AnimationGraph`
playback uses the same player, target IDs, channels, and update system.

## Identity and ownership

- `AnimationTargetId` is the stable authored identity. Its wire value is exactly
  **32 lowercase hexadecimal** characters.
- `deriveAnimationTargetId(path)` length-prefixes the UTF-8 path segments under
  a fixed namespace, hashes them with BLAKE3, and writes the UUID v8 version and
  variant bits before rendering that wire value.
- `AnimatedBy` stores the target's one live player owner.
- `AnimationTargets` is the ECS-maintained reverse relationship on that player.
- `bindAnimationTargets(world, player, targets)` validates the complete explicit
  batch before assigning missing IDs or ownership. Repeating the same batch is
  idempotent.
- An existing ID survives rename or reparent. When binding creates a missing ID,
  it derives it from the complete `Name` lineage from the player through the
  target, including both endpoints.
- Importers and other authoring tools instead persist IDs derived from the source
  asset root through each target. A synthetic runtime controller above that
  asset root is not part of the authored path, so multiple instances of one
  asset reuse the same target IDs. Importers write those IDs to animated glTF/FBX
  scene entities and matching clip channels.

Animation channels contain one `targetId`. The previous `targetPath` wire was a
clean cut: there is no dual read, adapter, or fallback.

## Playback and diagnostics

Direct slots and `AnimationGraph` output both flow through `AnimationPlayer` and
the default animation schedule. Translation, rotation, and scale are blended
before one final local `Transform` write; normal scene propagation then computes
world transforms.

Development diagnostics are structured objects with `code`, `hint`, and
`detail`. They skip only the malformed channel or target and let valid sibling
players continue. They are emitted as deduplicated `console.warn` objects;
there is no public callback, queue, resource, or diagnostics bus. Production
builds silently skip malformed entries without emitting these diagnostics.

## Error recovery

Never parse `message`. Branch on `error.code`, use `error.detail` to locate the
entity, and follow `error.hint`.

| Code | Repair |
|:--|:--|
| `animation-target-player-invalid` | Keep a live player entity with `AnimationPlayer`. |
| `animation-target-invalid` | Keep a live target with `Transform`. |
| `animation-target-outside-player-root` | Parent the target below the selected player. |
| `animation-target-name-missing` | Add `Name` to every lineage entity before deriving an ID. |
| `animation-target-id-invalid` | Replace the value with a valid derived or imported wire. |
| `animation-target-id-duplicate` | Give distinct targets distinct authored IDs. |
| `animation-target-player-conflict` | Unbind the live owner or bind through that owner. |
| `animation-target-capacity-reserve-failed` | Reduce the batch or free managed-buffer capacity before retrying. |
| `animation-target-bind-failed` | Inspect the ECS failure detail and retry with live entities. |

## Example and boundaries

Run `pnpm --filter @forgeax/bevy-animated-transform dev` or inspect
`apps/bevy/animated-transform`. The demo uses `createApp` defaults, three
hierarchical entities without `Skin`, direct and graph players, controls, and
two isolated instances sharing one clip and target IDs.

This package does not animate arbitrary component properties. It does not
provide an animation FSM, masks, IK, a target registry, hidden subtree scanning,
or editor UI. Material, light, camera, and custom component field animation
require separate features.
