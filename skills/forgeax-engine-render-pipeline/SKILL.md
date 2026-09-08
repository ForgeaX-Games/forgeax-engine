---
name: forgeax-engine-render-pipeline
description: ForgeaX render pipelines, post-processing, and typed RenderGraph ownership. Use when configuring camera effects, authoring pipelines/features, or tracing compute, raster, and graph resources.
---

# forgeax-engine-render-pipeline

> [!IMPORTANT]
> `RenderPipeline.build` 只声明 typed graph topology。Renderer 独占 compile、last-known-good 替换、execute、retire、`finish()` 与每帧一次 `queue.submit()`。

## 路由

| 目标 | 使用入口 |
|:--|:--|
| tonemap / bloom / FXAA / MSAA | `Camera` 字段 |
| 天空盒 | `SkyboxBackground` |
| 在 URP 尾部追加全屏效果 | `renderer.postProcess.register` + `URP_PIPELINE_ID` 的 `config.postEffects` |
| 替换整条 pass topology | `RenderPipeline.build` |
| feature 写 scene color/depth | `createRenderFeatureTarget` + `staging.addGraphicsPass` |
| compute 生成 vertex/index/indirect buffer，再 raster 消费 | `staging.addComputePass` + `staging.addGraphicsPass`；共享同一 prepared GPU buffer ref |
| RHI backend / capability | `forgeax-engine-rhi` |
| 帧录制/replay | `forgeax-engine-rhi-debug` |

## Camera 与内建管线

```ts
world.spawn(
  { component: Transform, data: cameraTransform },
  {
    component: Camera,
    data: {
      fov: Math.PI / 3,
      aspect: canvas.width / canvas.height,
      near: 0.1,
      far: 1000,
      tonemap: 'aces',
      exposure: 1,
      antialias: 'fxaa',
      bloom: 'on',
      bloomThreshold: 1,
      bloomIntensity: 0.35,
      bloomBlurRadius: 4,
    },
  },
);
```

内建 topology：

```mermaid
flowchart LR
  S["typed shadow passes"] --> G["scene / G-buffer"]
  C["compute producers"] --> F["feature raster passes"]
  G --> F --> O["observation"] --> P["bloom / tone / FXAA"] --> D["display surface"]
```

`renderer.perFramePassNames` 返回编译后的 pass 顺序；它是 topology 观测面，不是执行 API。

## 自定义 RenderPipeline

```ts
import {
  addTypedScenePass,
  addTypedTonemapPass,
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipeline,
} from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';

export const customPipeline: RenderPipeline = {
  build({ graph, contributeFeatures }, topology) {
    const surface = importRenderPipelineSurface(graph, topology);
    if (!surface.ok) return surface;

    const color = createRenderPipelineTarget(graph, 'scene-color', {
      format: 'rgba16float',
      size: 'surface',
    });
    if (!color.ok) return color;
    const depth = createRenderPipelineTarget(graph, 'scene-depth', {
      format: 'depth24plus-stencil8',
      size: 'surface',
    });
    if (!depth.ok) return depth;

    const scene = addTypedScenePass(graph, {
      name: 'main',
      color: color.value,
      depth: depth.value,
      selector: { LightMode: ['Forward'] },
    });
    if (!scene.ok) return scene;

    const features = contributeFeatures([
      {
        kind: 'scene-color',
        texture: color.value.texture,
        view: color.value.view,
        format: color.value.format,
        sampleCount: color.value.sampleCount,
      },
      {
        kind: 'scene-depth',
        texture: depth.value.texture,
        view: depth.value.view,
        format: depth.value.format,
        sampleCount: depth.value.sampleCount,
      },
    ]);
    if (!features.ok) return features;

    if (topology.camera.tonemap === 'none') {
      return addTypedTonemapPass(graph, color.value, surface.value.storage, true);
    }
    return addTypedTonemapPass(graph, color.value, surface.value.display);
  },
};
```

安装：

```ts
renderer.registerPipeline('game::custom', customPipeline);
const installed = renderer.installPipeline({
  kind: 'render-pipeline',
  pipelineId: 'game::custom',
});
if (!installed.ok) throw installed.error;
```

> [!CAUTION]
> 安装自定义 pipeline 是整体替换。要保留 URP 阴影、tone、bloom，只追加 `config.postEffects`。

## Typed resource ownership

`RenderGraphBuilder` 只接受本 builder 创建或导入的 opaque handle：

| 资源 | 创建/导入 | pass access |
|:--|:--|:--|
| texture | `createTexture` / `importTexture` | `sampled-read`, `storage-read`, `storage-write`, `color-attachment`, `depth-stencil-read`, `depth-stencil-write`, `copy-src`, `copy-dst` |
| texture view | `view` / `importView` | attachment 与 texture read/write access |
| buffer | `createBuffer` / `importBuffer` | `uniform-read`, `storage-read`, `storage-write`, `vertex-read`, `index-read`, `indirect-read`, `copy-src`, `copy-dst` |

`storage-write → vertex-read/index-read/indirect-read` 会建立 compute→raster 依赖并触发所需 barrier。不要另建 resource ledger、string key 或手写 pass dependency 来复制这条事实。

```ts
const compacted = graph.importBuffer(
  'visible-draws',
  { size: maxBytes, usage: STORAGE | VERTEX | INDIRECT },
  (frame) => frame.visibleDrawBuffer,
);
if (!compacted.ok) return compacted;

const cull = graph.addComputePass('cull-and-compact', {
  accesses: [{ resource: compacted.value, usage: 'storage-write' }],
  encode: ({ pass, frame }) => {
    pass.setPipeline(frame.cullPipeline);
    pass.setBindGroup(0, frame.cullBindings);
    pass.dispatchWorkgroups(frame.cullWorkgroups);
  },
});
if (!cull.ok) return cull;

return graph.addRasterPass('visible-raster', {
  accesses: [
    { resource: compacted.value, usage: 'vertex-read' },
    { resource: compacted.value, usage: 'indirect-read' },
    { resource: color.view, usage: 'color-attachment' },
  ],
  colorAttachments: [{ view: color.view, loadOp: 'load', storeOp: 'store' }],
  encode: ({ pass, resources }) => {
    const buffer = resources.buffer(compacted.value);
    if (!buffer.ok) throw buffer.error;
    pass.setVertexBuffer(0, buffer.value);
    pass.drawIndirect(buffer.value, indirectOffset);
  },
});
```

## RenderFeature compute → raster

Pipeline 拥有 attachment；feature 只声明所需的逻辑 target：

```ts
const sceneColor = createRenderFeatureTarget({
  kind: 'scene-color',
  format: 'rgba16float',
  sampleCount: 1,
});
```

feature 的 `prepare` 创建 GPU program、bindings 与 buffer refs；`contribute` 用同一 ref 先 `addComputePass`，再在 `addGraphicsPass` 的 `vertexData` / `indexData` / indirect command 中消费。Projection 会把 physical buffer 导入一次，并把 compute `storage-write` 与 raster `vertex-read` / `index-read` / `indirect-read` 投影进 renderer 的同一个 graph。

规则：

- attachment 使用 `RenderFeatureTargetHandle`，不得猜 pipeline 内部名字。
- compute 与 raster 共享 prepared buffer ref，不能复制 handle registry。
- topology 变化写入 contribution signature；下一帧编译并原子替换 last-known-good graph。
- capability 缺失返回结构化错误或选择显式 fallback lane；不得静默提交无效 compute。
- multi-World 的 `worldId` 是 renderer-local attachment identity；不得把它当作本帧 `worlds[]` 下标，detach 后重挂必须获得新 generation。

完整 VFX prepared-compute authoring 见 `forgeax-engine-vfx`；底层 builder/error contract 见 `packages/render-graph/README.md`。

## Points and Lines main-pass route

Points and Lines are a raster consumer of the existing Standard main geometry
pass. Route them as `MeshAsset` topology -> `Points` or `Lines` style ->
`Materials.unlit` -> retained extract -> prepared expansion -> recorded draw.
The renderer owner retains the expanded vertex/index resources and carries the
vertex layout into record; the main pass binds the Points/Lines view at group 0,
binding 10 and resolves the dedicated manifest-backed material pipeline.

This is not a second graph, renderer, cache, recovery ledger, or backend branch.
The normal material and legacy topology paths remain unchanged. A point draw is
non-indexed when the source has no indices; a line draw preserves indexed or
non-indexed source semantics after paired expansion. Prepare must publish the
complete resource set atomically, and stale or failed preparation keeps the
retained last-known-good state.

Evidence routing is explicit:

| Route | Evidence strength |
|:--|:--|
| direct WebGPU focused probe | pixels, source/derived bytes, bindings, draw, and validation errors |
| clustered unlit | structural material/graph contract unless a lane-specific runtime capture exists |
| WebGL2 | structural no-compute/no-storage/no-indirect contract unless a WebGL2 runtime capture exists |
| RhiNull | structural resource and command bookkeeping only; never pixel or GPU timing evidence |

For a failure, inspect the same retained/prepared/record state, repair the
source or producer, and rerun the route. Do not add application WGSL, manually
fetch a stand-in mesh, or bypass capability data with a backend-name switch.
The browser gate may be explicitly skipped by the loop authority; record that
as skipped, never as a pass. A Dawn timeout is blocked environment evidence,
not a successful smoke result.

## 后处理追加

```ts
renderer.postProcess.register('game::vignette', {
  source: vignetteWgsl,
  params: { byteSize: 16 },
});

renderer.installPipeline({
  kind: 'render-pipeline',
  pipelineId: URP_PIPELINE_ID,
  config: { postEffects: ['game::vignette'] },
});
```

## 验证

| 修改 | 最小验证 |
|:--|:--|
| pipeline topology | `pnpm --filter @forgeax/engine-render test` |
| RenderFeature projection | render + runtime integration tests |
| RHI access/barrier | render-graph unit + Dawn mixed compute→raster capture/replay |
| engine/RHI/demo | 全部 hello/learn-render Dawn 300 帧 + `pnpm test:browser` + `pnpm test:dawn` |

检查点：

- graph compile 在 swapchain acquisition 前完成；失败继续使用 last-known-good graph。
- 每帧一个 shared encoder、一个 `finish()`、一个 frame submit。
- retired graph 等待 in-flight execution 后销毁资源。
- compute-produced indirect buffer 的 physical usage 同时包含 storage 与 indirect。
- Browser/Dawn 验证是真实执行证据；rhi-null 只证明结构。

## SSOT

- Pipeline contract：`packages/render/src/render-pipeline.ts`
- Builtin topology：`packages/render/src/urp-pipeline.ts`、`packages/render/src/hdrp-pipeline.ts`
- Typed targets/primitives：`packages/render/src/render-pipeline-target.ts`、`packages/render/src/typed-render-graph-primitives.ts`
- Feature projection：`packages/render/src/features/render-graph-compute.ts`、`packages/render/src/features/render-graph-raster.ts`
- Graph builder/access validation：`packages/render-graph/src/builder.ts`
