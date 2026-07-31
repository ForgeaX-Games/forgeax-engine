# `@forgeax/engine-animation`

> [!IMPORTANT]
> Owner: animation graphs, clip lookup, player state, and update systems. Animation reads World-local handles directly; there is no resolver wrapper to configure.

```ts
import { animationPlugin, defineAnimationGraph } from '@forgeax/engine-animation';
import { AnimationPlayer } from '@forgeax/engine-animation';
import type { AnimationClip } from '@forgeax/engine-types';

const clip: AnimationClip = {
  kind: 'animation-clip',
  duration: 1,
  channels: [{
    targetPath: ['root', 'child'],
    property: 'translation',
    sampler: {
      input: new Float32Array([0, 1]),
      output: new Float32Array([0, 0, 0, 1, 0, 0]),
      interpolation: 'LINEAR',
    },
  }],
};
const clipHandle = world.allocSharedRef('AnimationClip', clip);
const graph = defineAnimationGraph((builder) => builder.clip(clipHandle));
if (!graph.ok) throw graph.error;
const graphHandle = world.allocSharedRef('AnimationGraph', graph.value);
// targetRoot enables ordinary Name + ChildOf scene animation; omit it for Skin playback.
// `root` is a previously spawned entity carrying Name { value: 'root' }.
world.spawn({ component: AnimationPlayer, data: {
  graph: graphHandle,
  nodeSpeeds: [1],
  targetRoot: root,
} });
const plugin = animationPlugin();
await plugin.build(world);
```

| This package owns | Excluded concepts |
|:--|:--|
| Graph definition/evaluation, clip lookup, `AnimationPlayer`, Skin and named-Transform playback systems | Renderer extraction, GPU resources, scene hierarchy authoring |

`AnimationAssetError` and graph/player errors are closed unions. Branch on `error.code`; stale and wrong-kind details identify the handle that needs recovery.

Dynamic hosts load the same owner directly: `await import('@forgeax/engine-animation')`; runtime does not re-export graph or player symbols.
