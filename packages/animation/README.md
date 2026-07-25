# `@forgeax/engine-animation`

> [!IMPORTANT]
> Owner: animation graphs, clip lookup, player state, and update systems. Animation reads World-local handles directly; there is no resolver wrapper to configure.

```ts
import { animationPlugin, defineAnimationGraph } from '@forgeax/engine-animation';

const graph = defineAnimationGraph({ nodes: [] });
const plugin = animationPlugin();
await plugin.build(world);
void graph;
```

| This package owns | Excluded concepts |
|:--|:--|
| Graph definition/evaluation, `AnimationPlayer`, clip lookup, playback systems | Renderer extraction, GPU resources, scene hierarchy authoring |

`AnimationAssetError` and graph/player errors are closed unions. Branch on `error.code`; stale and wrong-kind details identify the handle that needs recovery.

Dynamic hosts load the same owner directly: `await import('@forgeax/engine-animation')`; runtime does not re-export graph or player symbols.
