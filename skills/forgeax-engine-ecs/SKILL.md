---
name: forgeax-engine-ecs
description: >-
  forgeax-engine 的 archetype ECS：defineComponent 定义 SoA 列、defineSystem token 直传激活系统、
  getRegisteredSystems/getRegisteredComponents 枚举注册表、
  runIf 运行条件、labels 分组标签、
  queryRun + addSystem 跑系统、Commands 延迟结构改动、Resource 存全局态、relationship 建层级、三层反射自省。
  Use when defining components, writing queries/systems, building entity hierarchies, or reflecting on component schemas.
---

# forgeax-engine-ecs

> archetype ECS：组件是 SoA 列、系统按 query 拿列、结构改动走 Commands。聚合 `@forgeax/engine-ecs`（World / Entity / Component / Query / System / Schedule / Commands / Resource / Relationship / Reflection）。

## 心智模型

组件不是对象，是**列**：`defineComponent` 一次定义一个 schema（字段 → 类型），引擎把每个字段存成一条紧凑 TypedArray（Struct-of-Arrays）。系统拿到的不是实例数组，而是 `bundle.ComponentName.fieldName`（一条 `Float32Array`），按 `bundle.entityCount` 索引。`defineComponent` **本身**就让组件全局可用——没有 per-World 注册步骤。`Entity` 是 id=0 的内建组件（实体身份本身就是一列）；它的存在被引擎在 barrel 里强制初始化，你不用手动定义。结构性改动（spawn / despawn / add / remove component）在系统里要走 `Commands` 延迟到帧末，避免迭代中改 archetype。

系统定义也走"定义即注册"路径：`defineSystem({ name, queries, fn, ... })` 返回 `SystemHandle` token，`world.addSystem(token)` 直接激活——不经按名取回。`getRegisteredSystems()` 返回 `ReadonlyMap<string, SystemHandle>` 供辅路枚举；`getRegisteredComponents()` 同理，返回 `ReadonlyMap<string, Component>`。两组注册表独立、不互相污染。

`SystemDescriptor.runIf?: (world) => boolean` 是运行条件：每帧 ParamValidation 通过后、queryRun 前求值，`false` → 静默跳过（不跑 query、不调 fn、不增状态）。`labels?: readonly string[]` 是自由分组标签（如 `'physics'`、`'input'`），供过滤/分组使用。

## 核心 API 速查

| 入口 | 形态 | 用途 |
|:--|:--|:--|
| `defineComponent(name, fields, options?)` | `=> Component` | 定义组件 schema；单 field-descriptor 签名，定义即全局可用 |
| `defineSystem({ name, queries, fn, ... })` | `=> SystemHandle<Qs>` | 定义系统 token；返回冻结 descriptor，`world.addSystem(token)` 直接激活 |
| `getRegisteredSystems()` | `=> ReadonlyMap<string, SystemHandle>` | 枚举全部 defineSystem 注册的系统（按名取回） |
| `getRegisteredComponents()` | `=> ReadonlyMap<string, Component>` | 枚举全部 defineComponent 注册的组件（按名取回） |
| `new World()` | 构造 | 实体 / 组件 / 系统 / 资源容器 |
| `world.spawn(...componentDatas)` | `=> Result<EntityHandle, EcsError>` | 创建实体 + 初始组件 |
| `world.get(e, C)` | `=> Result<bundle, EcsError>` | 读单实体某组件（也是 liveness 探针，despawned 回 `err('stale-entity')`） |
| `world.addComponent(e, C, data) / removeComponent(e, C)` | `=> Result<...>` | 增删组件（即时路径） |
| `world.addSystem(systemHandle)` | 注册系统 token | `fn(world, queryResults, commands)`；DAG 拓扑序跑 |
| `world.update()` | 跑一帧 schedule | 按依赖拓扑序执行全部系统 + flush commands |
| `createQueryState(...) + queryRun(state, world, cb)` | 临时查询 | 系统外的一次性遍历 |
| `world.getResource<T>(key) / insertResource<T>(key, value)` | 全局态 | 单例资源（如 InputSnapshot） |
| `world.addChild(parent, child, ChildOf) / reparent(...) / removeChild(...)` | 层级 | relationship 同步维护反向 mirror 列 |
| `C.id / C.fields[f] / C.meta / TYPE_METADATA` | 反射 | 三层只读自省 |

> [!CAUTION]
> 这些 API 在近期已被删除/重塑——**别用**：`world.registerComponent` / `world.registerComponentChecked`（删，`defineComponent` 即可用）、`world.isAlive`（删，用 `world.get(e, Entity)` 探活）、`world.getComponentId(C)`（删，用 `C.id`）、独立的 `GlobalTransform` 组件（删，`Transform.world` 是 SSOT 世界矩阵）、`createFrameStartScanSystem` 工厂（删，改 `world.insertResource('InputBackend', backend) + world.addSystem(InputFrameStartScan)` 资源化接线）、`register` 函数内 addSystem 闭包/spread-覆盖-fn 形态（删，改模块顶层 `const S = defineSystem({...}) → world.addSystem(S)`）。

## 系统 / 查询：SoA 列读法

```mermaid
flowchart LR
  DEF["defineComponent 定义列 schema"] --> SYS["defineSystem + world.addSystem(token) 注册系统"]
  SYS --> RUN["world.update() 拓扑序跑 fn"]
  RUN --> COL["fn 拿 queryResults[i]：遍历 bundle"]
  COL --> READ["bundle.C.field 是 TypedArray，按 entityCount 索引"]
  COL --> CMD["结构改动 -> commands（延迟到帧末 flush）"]
```

## idiom 代码骨架

```ts
import { defineComponent, defineSystem, World } from '@forgeax/engine-ecs';

const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
const Velocity = defineComponent('Velocity', {
  dx: { type: 'f32', default: 0 },
  dy: { type: 'f32', default: 0 },
});

// 模块顶层 const S = defineSystem({...}) — fn 首参为 world
const Integrate = defineSystem({
  name: 'integrate',
  queries: [{ with: [Position, Velocity] }],
  fn: (world, queryResults, commands) => {
    for (const bundle of queryResults[0]) {
      const xs = bundle.Position.x;
      const dxs = bundle.Velocity.dx;
      for (let i = 0; i < bundle.entityCount; i++) xs[i] = (xs[i] ?? 0) + (dxs[i] ?? 0);
    }
    // commands.spawn(...) / commands.despawn(e) — deferred, flushed at frame end
  },
});

const world = new World();
world.spawn(
  { component: Position, data: { x: 0, y: 0 } },
  { component: Velocity, data: { dx: 1, dy: 0 } },
);
world.addSystem(Integrate);   // token 直传激活
world.update();
```

### 系统描述符完整字段

`defineSystem` 接受的 `SystemDescriptor` 全字段如下（全部可选，除 `name` / `queries` / `fn`）：

| 字段 | 类型 | 必填 | 说明 |
|:--|:--|:--|:--|
| `name` | `string` | 是 | 系统唯一名（供 `before`/`after` 引用 + 全局注册表 key） |
| `queries` | `ReadonlyArray<QueryDescriptor>` | 是 | 查询声明；`[]` = 零查询系统（纯 command/resource 操作） |
| `fn` | `(world: World, queryResults, commands) => void` | 是 | 系统函数。**首参为 World**（旧签名 `(queryResults, commands)` 已废弃；迁移：形参加 `world`，体内原闭包用的 `world` 改用参数） |
| `after` | `ReadonlyArray<string>` | 否 | 在此系统名前运行 |
| `before` | `ReadonlyArray<string>` | 否 | 在此系统名后运行 |
| `resources` | `ReadonlyArray<string>` | 否 | 所需 resource key 列表；缺失 → ParamValidation `'invalid'`（走 ErrorHandler，不裸 throw） |
| `runIf` | `(world: World) => boolean` | 否 | 运行条件：每帧 ParamValidation 通过后、queryRun 前求值；`false` → 静默跳过（不跑 query、不调 fn、不增状态）。缺省(=undefined) 每帧照跑 |
| `labels` | `ReadonlyArray<string>` | 否 | 自由分组标签（如 `'physics'`、`'input'`）；用于过滤/分组，不参与调度 |

### runIf 运行条件

```ts
import { defineSystem, World } from '@forgeax/engine-ecs';

// 系统仅在「场景有活实体」时跑
const MySystem = defineSystem({
  name: 'cleanup',
  queries: [{ with: [Transform] }],
  runIf: (world: World) => {
    // 每帧求值；ParamValidation 已通过、fn 尚未调
    return world.hasResource('SceneRoot');
  },
  fn: (world, queryResults, commands) => {
    // ...
  },
});
```

> [!IMPORTANT]
> `runIf` 求值在 ParamValidation `tag==='ok'` 之后、queryRun 之前（requirements AC-07）。`tag==='invalid'` 时走 ErrorHandler 不触发 runIf。跳过是静默的——不暴露 skip 计数/诊断（OOS-6）。

### labels 分组标签

```ts
const SystemA = defineSystem({
  name: 'phys-sync',
  queries: [],
  labels: ['physics'],
  fn: (world) => { ... },
});
// 按 label 过滤：getRegisteredSystems() 遍历 key，按 handle.labels 匹配
```

关系（层级）用 `relationship` 元数据声明，反向 mirror 列由引擎自动维护：

```ts
const ChildOf = defineComponent('ChildOf', { parent: { type: 'entity' } }, {
  relationship: { mirror: 'Children', field: 'entities', exclusive: true, linkedSpawn: false },
});
world.addChild(parent, child, ChildOf); // child gains ChildOf; parent.Children.entities auto-updated
```

## 踩坑

- **系统 fn 首参必须是 `world`**：`defineSystem({ fn: (world, queryResults, commands) => {...} })`——旧签名 `(queryResults, commands)` 已废弃。typecheck 不足以兜底此陷阱（TS 参数前插后 `arity-narrowed assignment` 合法，见 memory `overload-arg-shape-dispatch-hides-p0`）。迁移：形参加 `world`，体内原闭包捕获的 `world` 改用参数 `world`。
- **query 字段名拼写错 / 漏 column**：组件被链式 `addComponent` 加进 archetype 时曾有列错位 bug（已修），但若 `bundle.C.field` 为 `undefined`，先确认 query 的 `with` 真包含该组件、字段名与 schema 完全一致。
- **spawn-data 字段名拼写错 → fail-fast**（bug-20260615）：`world.spawn` / `world.addComponent` / `commands.spawn` 对 `data` 里出现的未声明字段仍返回 `err({ code: 'spawn-data-unknown-field', detail: { component, field, knownFields } })`——typo 是编程错误，应 fatal。但 **scene instantiate 路径已改为诊断通道**：`world.instantiateScene` 对 unknown-field 跳过该字段 + 记录 `SceneInstantiateDiagnostic` 条目（不 abort 整场景），见上节。
- **系统里直接结构改动会破迭代**：在 `fn` 里 spawn/despawn/add/remove 要走 `commands`，引擎帧末统一 flush；即时路径（`world.spawn`）留给系统外。
- **Result 不 unwrap 就静默丢错**：`world.get` 等返回 `Result`；系统体内显式 `if (!r.ok) return r;` 或 `.unwrap()`（TS 无 `?` 运算符）。其余渲染/测试症状见 [`forgeax-engine-debug`](../forgeax-engine-debug/SKILL.md)。
- **`defineSystem` 同名静默覆盖**：第二次 `defineSystem({ name: 'X', ... })` 用同名会 `SYSTEM_REGISTRY.set` 覆盖旧 token，不抛错（对齐 `defineComponent` 行为）。`getRegisteredSystems()` 反映最新 token。
- **`resources` 声明后缺失 → ParamValidation `'invalid'`**：`resources: ['SomeKey']` 但 `SomeKey` 未 insertResource → 系统不跑、ErrorHandler 被调用。不走 runIf 求值（runIf 只在 `tag==='ok'` 后触发）。

## Bool 列

`defineComponent` 支持 `type: 'bool'` 列（既存基础设施，`AnimationPlayer.paused` / `AudioSource.playing` / `Camera.autoAspect` 生产在用）。

```ts
const MyComp = defineComponent('MyComp', {
  enabled: { type: 'bool', default: false },
});

// world.get path: readRow 窄化为 JS boolean
const r = world.get(entity, MyComp);
if (r.ok) {
  const flag = r.value.enabled;         // true | false（JS boolean）
  world.set(entity, MyComp, { enabled: false }); // 写入 boolean 或 0/1，引擎自动归一化
}
```

> [!CAUTION]
> **`world.get` 与 query-bundle 两条路径不可混用**：`world.get(entity, C)` 通过 readRow 窄化返回 JS `boolean`；但 query-bundle 直接暴露底层 TypedArray（`Uint8Array`），bool 列以 raw `0` / `1` number 形态出现——**不是 JS boolean**。
>
> ```ts
> // ❌ 陷阱：query-bundle 路径的 `!== 0` 对 bool 列恒为 true
> for (const bundle of queryResults[0]) {
>   for (let i = 0; i < bundle.entityCount; i++) {
>     if (bundle.MyComp.enabled[i] !== 0) {  // ✅ 正确：比较 number
>       // ...
>     }
>   }
> }
> // ❌ 错误：bundle 值 0/1 number !== true/false boolean
> //    if (bundle.MyComp.enabled[i])     // 0 → falsy ✓, 1 → truthy ✓（但语义模糊）
> //    if (bundle.MyComp.enabled[i] === true)  // 1 === true → false ❌
> //    if (bundle.MyComp.enabled[i] !== 0) // 0 !== 0=no-op, 1 !== 0=true ✓（唯一正确的判定）
> ```
>
> 在 query 里需要用 bool 判定时，**优先走 `world.get` 路径**（如 `Camera.autoAspect` 的 aspect-sync sidecar 设计）。若必须走 bundle，判定式用 `=== 1` 或 `!== 0`，绝不混用 JS truthy 或 `=== true`。
>
> 参考记忆：`bool-field-compared-with-not-equal-zero-always-true`——`rapler.charCtrlData.grounded !== 0` 恒 true 的踩坑记录。

## SceneInstance（feat-20260608 ECS-fication）

`SceneAsset` 不再走单独的 container，而是 ECS 化：`world.instantiateScene(handle)` 返回 `{ root, diagnostics }` 信封——`root` 是合成根 Entity（挂 `SceneInstance{source, mapping, state}` + 单位 `Transform`），`diagnostics` 是未知字段的结构化诊断数组（`readonly SceneInstantiateDiagnostic[]`）。diagnostics 属性访问消费（`d.component` / `d.field` / `d.localId`），非 NODE_ENV-gated——生产环境同样可观测。`SceneAsset.mounts[]` 让一个 SceneAsset 嵌入另一个；mount entity 也自动挂 Transform（R2/B-1）。

### 8 个 World 方法（全在 `world.<TAB>` 自动补全）

| 方法 | 作用 |
|:--|:--|
| `instantiateScene(handle, parent?)` | 物化 SceneAsset，返回 `{ root: EntityHandle, diagnostics: readonly SceneInstantiateDiagnostic[] }`——`root` 为合成根 Entity，`diagnostics` 经属性访问消费未知字段信息 |
| `despawnScene(root, opts?)` | `despawnDescendants(root) + world.despawn(root)`；返回销毁数 `Result<number>` |
| `despawnDescendants(root, opts?)` | 沿 ChildOf 销毁子树，根保留；返回销毁数 `Result<number>` |
| `setSceneOverride<S>(root, member, component, field, value)` | Layer-0 override（写入 + 记录 diff）；`member` 是活 Entity，`component`/`field` 走 schema 类型 |
| `removeSceneOverride<S>(root, member, component, field)` | 撤销 diff，重放 Layer 1->2->3 |
| `detachSceneMember(root, member)` | 软 tombstone（不 despawn） |
| `reattachSceneMember(root, member)` | 清 tombstone |
| `getSceneAssetForInstance(root)` | 读源 SceneAsset 句柄 |

读路径：`world.queryRun([SceneInstance], ...)` 扫活实例 / `world.get(root, SceneInstance)` 单实例 / `world.getSceneInstanceState(root)` 拿完整 state ref（overrides / detachedLocalIds / rootEntities）。

### 4 个 mount-* fail-fast 错误码（SSOT 在 `packages/types/src/index.ts` PackErrorCode）

| code | 触发 |
|:--|:--|
| `pack-mount-localid-overlap` | `entities[].localId` 与 mount 槽位重叠 |
| `pack-mount-count-mismatch` | `mount.memberCount !== child SceneAsset totalSlots` |
| `pack-mount-override-localid-out-of-range` | `override.localId` 不在 `[memberFirst, memberFirst+memberCount)`（**parent namespace** 寻址） |
| `pack-mount-override-unknown-field` | `override.field` 不在已注册组件 schema |

> [!NOTE]
> mount.overrides[].localId 在**父 SceneAsset 的命名空间**里（即 `memberFirst + offset`，不是子 SceneAsset 的局部 id）。R2/F-8 cement。

### SceneInstantiateDiagnostic — 结构化诊断通道

`instantiateScene` 成功值随 `root` 附带 `diagnostics: readonly SceneInstantiateDiagnostic[]`——未知字段不再 abort 整场景，而是跳过该字段 + 记录诊断条目。属性访问消费（`d.component` / `d.field` / `d.localId`），不做字符串解析，非 NODE_ENV-gated（生产环境同样可观测）。

```ts
import type { SceneInstantiateDiagnostic } from '@forgeax/engine-ecs';

const r = world.instantiateScene(handle);
if (r.ok) {
  const { root, diagnostics } = r.value;
  for (const d of diagnostics) {
    // d.component = 'DirectionalLightShadow'
    // d.field     = 'orthoHalfExtent'
    // d.localId   = 21
    console.warn(`Unknown field: ${d.component}.${d.field} on entity #${d.localId}`);
  }
  // All entities spawned normally; known fields written correctly.
}
```

**分层**：`assets.instantiate()`（runtime）保留 `Result<EntityHandle>` 契约——内部 unwrap `.root`，不对 AI 用户暴露 diagnostics。需诊断面时直调 `world.instantiateScene`。

### 踩坑

- **resolver 挂错地方**：`engine.assets.instantiate(...)` 自动 wire 内部 SceneAsset resolver；只有 unit test 才走 `world._setSceneAssetResolver`（`@internal`，前缀 `_`）。demo 不要写 `if (world.setSceneAssetResolver)` 防御逻辑——这教坏下个 AI。

## SpriteInstances / TileLayer.sortScope (feat-20260625)

2D 批绘 + tilemap terrain 折叠：把 779+ per-cell render entity 折叠为 $\leq 16N$ 个 per-(layer, chunk, atlas) 桶 entity（$N$ = terrain layer 数）。ECS 一等公民两条：(1) `SpriteInstances` 组件（runtime 包导出），(2) `TileLayer.sortScope: 'layer' | 'per-cell'` 字面量联合。

### SpriteInstances 组件（2D peer of `Instances`）

```ts
import { SpriteInstances, type SpriteInstancesData } from '@forgeax/engine-runtime';

world.spawn(
  { component: MeshFilter,      data: { assetHandle: HANDLE_QUAD } },
  { component: MeshRenderer,    data: { materials: [spriteMatHandle] } },
  { component: SpriteInstances, data: { transforms, regions } },
);
```

| field | schema | stride / instance |
|:--|:--|:--|
| `transforms` | `array<f32>` | 16 f32（column-major mat4，translation 在 m03/m13/m23） |
| `regions` | `array<f32>` | 4 f32（`[uMin, vMin, uW, vH]` atlas-normalized UV rect） |

不变量：`transforms.length / 16 === regions.length / 4`（per-instance 计数一致）。RenderSystem extract entry 做防御性校验，违规走 Layer-3 ErrorHandler，三条新 `EcsErrorCode` 字面量收敛于 ECS 闭合联合：

| code | 触发 | `detail` 关键字段 |
|:--|:--|:--|
| `sprite-instances-count-mismatch` | `transforms.length/16 !== regions.length/4` | `transformsLength` / `regionsLength` / `expectedStride: { transforms: 16, regions: 4 }` |
| `sprite-instances-requires-sprite-shader` | MaterialAsset 首 pass shader 非 `'forgeax::sprite'` | `entityId` / `observedMaterialShaderId` |
| `sprite-instances-mutually-exclusive-with-instances` | 同 entity 同时挂 `Instances` + `SpriteInstances` | `entityId` |

charter P4 一致抽象：`Instances`（3D, 16 f32 / instance）↔ `SpriteInstances`（2D, 16+4 f32 / instance interleaved 80B）—AI 用户按"per-instance 是否带 UV"挑组件，不按 API 形态挑。两条均走 array-vocab + Layer-3 error envelope，**不**新增 ECS 概念。

### `TileLayer.sortScope` 字面量联合（取代 `ySort: 0 | 1`）

```ts
type TileLayer = {
  readonly sortScope: 'layer' | 'per-cell';
  // ... 其它 tilemap 字段
};
```

| 字面量 | 语义 | 渲染路径 |
|:--|:--|:--|
| `'layer'` | 整层 y-sort（terrain 默认） | `tilemap-chunk-extract` 聚合为 per-(layer,chunk,atlas) 桶 → `SpriteInstances` 单 drawcall |
| `'per-cell'` | per-cell y-sort（object 层、Y-sort interleave） | 保留 per-cell 派生 entity，走 `render-system-extract` 主路径 |

迁移：旧字段 `ySort: 0 | 1` 一刀切（Optimal > compatible）；TS exhaustive switch 在所有 sortScope 消费方守门。grep `sortScope` 命中点是迁移单一锚点（charter F1）。


## skinned animation (feat-20260612)

挂三件套即可让 glTF skinned mesh 真动起来：

```ts
import { Skin, AnimationPlayer, Transform, MeshFilter, MeshRenderer } from '@forgeax/engine-runtime';

world.spawn(
  { component: Transform, data: {} },
  { component: MeshFilter, data: { assetHandle: foxMesh } },
  { component: MeshRenderer, data: { materials: [foxMat] } },
  { component: Skin, data: { skeleton: foxSkeleton } },                          // joints 由 sceneInstances.instantiate auto-resolve
  { component: AnimationPlayer, data: { clip: walkClip, speed: 1, looping: true } },
).unwrap();
```

零 setup —— `createApp` 自动注册 `advanceAnimationPlayer`（`createRenderer` 直用方手动调 `registerAdvanceAnimationPlayer(world, animResolver)`）；`propagateTransforms` 把 joint TRS 烘成 `Transform.world`；`extractFrame` 的 `hasSkin` 段读 joint `Transform.world` × `SkeletonAsset.inverseBindMatrices` 上传到 per-frame palette UBO（feat-20260612 兑付，详见 [`forgeax-engine-render-pipeline`](../forgeax-engine-render-pipeline/SKILL.md) §skin palette per-frame upload）。

**3 个 closed-union errorCode** 反查模式（exhaustive `switch` 无 default，TS 守完整性 / charter P3 显式失败）：

| code | 触发 | 修法 |
|:--|:--|:--|
| `skeleton-resolve-failed` | `assets.get<SkeletonAsset>(skin.skeleton)` 返回 null/undefined | 检查 `registerWithGuid` 顺序、`SceneAsset` mount 是否带上 SkeletonAsset |
| `joint-count-mismatch` | `Skin.joints.length !== SkeletonAsset.jointCount` | 检查 `SkinAsset.jointPaths` 与 `SkeletonAsset.jointCount` 是否同源、`sceneInstances.instantiate` 的 Name lookup 是否全命中 |
| `joint-entity-dangling` | `Skin.joints[i]` Entity 已 despawn → `Transform.world` view 拿不到 | 检查 joint entity 生命周期（不要在播放时 despawn skeleton 子树） |

SSOT：`SkinExtractErrorCode` 在 `packages/runtime/src/errors.ts`；与 `SkinPaletteOverflowError`（buffer 容量超限）共享同一 `RhiError` discriminated-union surface。

## Schema vocab → brand → store 三层一致（feat-20260614 后）

| schema vocab | Handle brand | Store | 语义 | 写屏障行为 |
|:--|:--|:--|:--|:--|
| `'unique<T>'` | `Handle<T,'unique'>` | `UniqueRefStore` | 1-holder 独占 | spawn/set→直接 alloc；despawn/overwrite→直接 release |
| `'shared<T>'` | `Handle<T,'shared'>` | `SharedRefStore` | N-holder 共享（rc-tracked） | spawn/set→`retain` rc++；despawn/overwrite→`release` rc--；rc=0 → per-handle deleter 触发 |

> [!CAUTION]
> **2026-06-14 删除项**：vocab keyword `'ref<T>'` → `'unique<T>'`；vocab keyword `'handle<T>'` 物理删除（写入触发 `SchemaUnsupportedFieldError` + 迁移 hint）；brand `'managed'` → `'unique'`、`'unmanaged'` → `'shared'`；类 `ManagedRefStore` → `UniqueRefStore`，错误 `ManagedRef*Error` → `UniqueRef*Error`。无 deprecation alias，1 PR cut。

`SharedRefStore` API（barrel export `@forgeax/engine-ecs`）：release 信号是 **per-handle deleter**——`allocSharedRef` 第三参，rc `1→0` 时对该 handle 触发一次。无全局 listener（`store.onLastRelease(cb)` / `lastReleaseListeners` 已删，由 `scripts/grep/check-ecs-brand-grep-gate.mjs` 把守）。

```ts
// 第三参 = per-handle deleter（D-10）：rc 1→0 时对此 handle 触发一次
const handle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
  'MaterialAsset',
  materialPayload,
  (payload) => {
    // 信号——观察 rc 归零；不拥有生命周期（如可在此 lazy drop GPU 资源）
  },
);
// allocSharedRef 返回裸 Handle（无 .ok）；rc=1 (alloc-grant)
// spawn 含 'shared<MaterialAsset>' 字段的 entity 后 rc=2

world.sharedRefs.retain(handle);    // rc++（write-barrier 自动调，手动罕见）
world.sharedRefs.release(handle);   // rc--；rc=0 → 该 handle 的 deleter 触发一次
const result = world.sharedRefs.resolve(handle);   // Result<T, SharedRefReleasedError | BuiltinSlotNotOwnedError>
world.sharedRefs.refcount(handle);  // number，0 == released（debug/tests）
```

> [!NOTE]
> Phase 1 暂未注册 deleter 消费者——`AssetRegistry` / `GpuResourceStore` / 物理 / 音频后端 各自未来 loop 决定如何消费。本 phase 信号已对外暴露，行为不变。

### D-15 两层资产解析（builtin 进程静态 vs user-tier RC）

`SharedRefStore` **只管 user-tier**（slot `>= BUILTIN_BASE`，`BUILTIN_BASE = 1024`，定义在 `@forgeax/engine-types`）。builtin 资产（5 个内建 mesh：`HANDLE_CUBE`..`HANDLE_NINESLICE_QUAD` = slot `1..5`）是**进程静态 frozen const**，活在 `BuiltinAssetRegistry`（`@forgeax/engine-runtime`），从不 ref-count、跨任意 World / renderer 透明。

| tier | slot range | owner | resolve |
|:--|:--|:--|:--|
| builtin | `[1, BUILTIN_BASE)` | `BuiltinAssetRegistry`（进程静态） | `BuiltinAssetRegistry.resolve(handle)`，无需 World |
| user | `[BUILTIN_BASE, +∞)` | per-`World` `SharedRefStore` | `world.sharedRefs.resolve(handle)` |

ECS/render 侧单入口 `resolveAssetHandle<T>(world, handle): Result<T, AssetError>`（`packages/runtime/src/resolve-asset-handle.ts`）按 slot range 派发。`SharedRefStore` 拿到 builtin slot 时 `alloc`/`retain`/`release`/`resolve` 全部 fail-fast `BuiltinSlotNotOwnedError`（charter P3）。

资产从 GUID 到 column handle 的标准路径（`AssetRegistry` 无 handle 概念，`loadByGuid` 返回 payload）：

```ts
const payload = (await assets.loadByGuid<MeshAsset>(guid)).value;   // 返回 payload，非 handle
const handle = world.allocSharedRef('MeshAsset', payload);          // 在使用点铸 column handle
```

## 深入

- 组件 schema vocab / `array<T,N>` / `buffer<N>` 字段 / `world.push|pop|capacity`：见 `packages/ecs/README.md` §Schema vocabulary quick-ref · §Array / buffer field access；源码 `packages/ecs/src/component.ts`
- query `optional` 逐 archetype 列暴露：见 `packages/ecs/README.md` §Query；源码 `packages/ecs/src/query.ts`
- relationship 双向 mirror / 环检测 / `iterDescendants`：见 `packages/ecs/README.md` §Relationship；源码 `packages/ecs/src/world.ts`
- 三层反射（`component.meta` / `component.fields[f]` / `TYPE_METADATA`）：见 `packages/ecs/README.md` §Component reflection；源码 `packages/ecs/src/component.ts`
- SceneInstance 完整 surface（4-layer fallback / despawn destroy set / runtime-facing reference）：`packages/ecs/README.md` §SceneInstance lifecycle + `packages/runtime/README.md` §SceneInstance；源码 `packages/ecs/src/world.ts` `_instantiateSceneAsset`
- `EcsErrorCode` 全集（SSOT 在源码，勿抄）：`packages/ecs/src/errors.ts`；反向锚点 `packages/ecs/README.md` §Error code reverse anchors
- `PackErrorCode` 4 个 mount-* 全集：`packages/types/src/index.ts`；hint 字符串 SSOT 同文件 PACK_ERROR_HINTS

## 内置系统全表 + label 映射

以下 10 个内置系统经 `defineSystem` 定义为模块顶层 token（零闭包、零占位 fn），各自挂 label 锚定。`getRegisteredSystems()` 可按名枚举全部 10 个。

| 系统名 | 包 | label | 依赖资源 | before/after |
|:--|:--|:--|:--|:--|
| `propagateTransforms` | `runtime` | `transform` | -- | -- |
| `advanceAnimationPlayer` | `runtime` | `animation` | `'AnimationAssetResolver'` | `before: ['propagateTransforms']` |
| `input-frame-start-scan` | `input` | `input` | `'InputBackend'` | -- |
| `transitionStates` | `state` | `state` | -- | -- |
| `physicsSyncBackend` | `physics-rapier3d` | `physics` | `'PhysicsWorld'` | `before: ['physicsStepSimulation']` |
| `physicsStepSimulation` | `physics-rapier3d` | `physics` | `'PhysicsWorld'` | `after: ['physicsSyncBackend']` |
| `physicsWriteback` | `physics-rapier3d` | `physics` | `'PhysicsWorld'` | `after: ['physicsStepSimulation']` |
| `physicsSyncBackend2D` | `physics-rapier2d` | `physics` | `'PhysicsWorld'` | `before: ['physicsStepSimulation2D']` |
| `physicsStepSimulation2D` | `physics-rapier2d` | `physics` | `'PhysicsWorld'` | `after: ['physicsSyncBackend2D']` |
| `physicsWriteback2D` | `physics-rapier2d` | `physics` | `'PhysicsWorld'` | `after: ['physicsStepSimulation2D']` |

> [!IMPORTANT]
> 2D 物理三系统以 `2D` 后缀命名——与 3D 六系统共享全局 `SYSTEM_REGISTRY`，后缀避免同名碰撞（plan-strategy D-5）。`resolveComponent('Transform')` 在 fn 内直接取组件 token，不通过闭包捕获。

## State-machine integration (zero-intrusion)

> `@forgeax/engine-state` is built entirely on ECS primitives -- it defines no custom queries, no new archetype storage, no schedule sub-graph. See [`forgeax-engine-state`](../forgeax-engine-state/SKILL.md).

| State primitive | ECS primitive consumed |
|:--|:--|
| `__scopedTo__<tokenName>` component | `defineComponent` with two `'enum'` fields (`value`, `mode`) |
| `State` / `NextState` / `PreviousState` per-token Resources | `world.insertResource` / `world.getResource` / `world.hasResource` |
| `transitionStates` system | `world.addSystem` with `after`/`before` anchors |
| Scoped entity collection | `createQueryState` + `queryRun` + `resolveComponent` |
| Scoped entity teardown | `world.despawn` (idempotent) |
| `OnEnter`/`OnExit` callbacks | Module-private callback registry, dispatched synchronously inside `transitionStatesSystem` |
