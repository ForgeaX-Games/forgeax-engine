# Asset, project, and CI troubleshooting

Use the symptom table in `../SKILL.md` to select one recipe. Verify the signal before changing the owning package.

## 贴图纯白

**信号**：textured demo（learn-render 贴图章节 / hello-room 类）渲染成均匀白方块，无纹理细节、无光照明暗。材质注册成功、无报错。

**根因**：demo 把 `.pack.json` 的 `paramValues` 原样塞进 `register<MaterialAsset>`，其中 `baseColorTexture` / `metallicRoughnessTexture` 是 **GUID 字符串**。但 render-system 的 extract 阶段只在槽值 `typeof === 'number'`（已解析的 numeric `Handle`）时才绑定贴图——字符串落到 1×1 白色占位视图。

**判定**：grep extract 阶段的类型守卫确认契约。
```bash
grep -n "typeof pv.baseColorTexture === 'number'" packages/runtime/src/render-system-extract.ts
```

**修法**：demo 用 `loadByGuid<TextureAsset>` 取回的 **handle**（`res.value`）替换 paramValues 里的字符串 GUID；贴图加载失败时**丢弃该槽**（回退占位，而非塞字符串）。

```ts
for (const [k, v] of Object.entries(paramValuesIn)) {
  if (k === 'baseColorTexture') {
    if (!diffuseRes.ok) continue;       // drop slot -> 1x1 placeholder
    filteredValues[k] = diffuseRes.value; // resolved numeric Handle
    continue;
  }
  // ... 同理 metallicRoughnessTexture
  filteredValues[k] = v;
}
```

> [!CAUTION]
> `Handle<T>` 是 branded `number`（`packages/types/src/handle.ts`）。pack JSON 只能存字符串 GUID，所以"pack → 运行时"之间**必须**有一次 `loadByGuid` 解析。注释写"GUID 在 extract 时解析"是**错的**——extract 不解析字符串，只认 number。

---

## spawn-data 字段名拼写错

**信号**：`world.spawn(...).unwrap()` 抛 `Error: <Component>: spawn data carries unknown field. code: spawn-data-unknown-field`，或 `commands.spawn` 在系统里同步 throw。bug-20260615 之前同样的 typo 是**静默丢弃**——实体生成出来但渲染隐形/灰白，看着像图形 bug。

**根因**：`fillComponentDefaults` 走的是 `Object.keys(schema)`，从来不看调用者传的 `raw` 键，所以未声明字段直接落进默认值路径。最常见踩中的是单复数重命名残留（典型 `MeshRenderer { material: h }` 旧名单数 → schema 已改 `materials: array<...>` → 槽是空数组 → extract 走 `defaultMaterialSnapshot` mid-grey）。

**判定**：报错信息里 `.detail.knownFields` 已列出该组件的合法字段白名单，比对 `data` 字面量。
```bash
# 反查 schema 字段
grep -n "defineComponent('<ComponentName>'" packages/runtime/src/components/*.ts
```

**修法**：把 `data` 里的 typo 字段改成 schema 名字；如果是真的"组件改名了"，沿调用链所有 spawn 点一起改（搜 `component: <Name>, data: {`）。`commands.spawn` 路径 throw 在 system body，stack frame 直接指向调用站。

**适用范围**：`world.spawn` / `world.addComponent` / `SceneAsset.instantiate`（含 `.pack.json` SceneEntity components）/ `Commands.spawn` / `Commands.addComponent`。`fillComponentDefaults` 公共 helper **不**校验（保持 pure，校验集中在 spawn 边界）。

---

## shader 标识符残留

**信号**：控制台 `register<MaterialAsset> failed: asset-invalid-value pass[0] references shader 'forgeax::X' which is not registered`。材质注册失败 → 走无材质回退（常表现为黑 / 白）。

**根因**：引擎重命名了内置 shader 标识符（如 `forgeax::default-pbr-forward` → `forgeax::default-standard-pbr`），但散落在各 demo `assets/*.pack.json` 的 `passes[].shader` 字段是**手写常量**，改名时漏改。读 pack `shader` 字段的 demo 才会触发；硬编码正确标识符的 demo（如 hello-room main.ts）即使 pack 残留也无感——是潜伏雷。

**判定**：列出全仓引用 vs 实际注册的标识符，找差集。
```bash
# 谁注册了 material shader（manifest 入口）
grep -rn "reservedIdentifier:" packages/vite-plugin-shader/src/index.ts
# 谁还在引用某个标识符
grep -rln "forgeax::<旧名>" apps/ packages/ | grep -v node_modules | grep -v dist
```

**修法**：把所有 `.pack.json`（含看似无感的 hello-room）的残留标识符一次性改到当前注册名。改完再 grep 一遍确认零残留。

---

## 断言全过却 exit 1

**信号**：CI job 红，但日志里 `Test Files N passed`、`Tests M passed`，**无 `failed`**。常见尾部：`Vitest caught K unhandled errors` + `Unhandled Rejection`。

**根因**：测试断言全绿,但某处 **Promise 在 teardown 期 reject 且无人 catch** → vitest 计为 unhandled error → 进程退出码 1。本仓实战例：`rhi-webgpu` 的 `createShaderModule` 里 `await getCompilationInfo()` 未防护「device 在 await 期间被销毁」——headless swiftshader 上 reject 成 `OperationError: Instance dropped`，从测试文件间的 GPU teardown 逃逸。

> [!IMPORTANT]
> **永远看退出码,不要只数测试行**。`grep "Tests.*passed"` 看到全过就放行是这次最大教训——`echo $?` / 末尾的 `exit code 1` 才是 gate 真相。本地 chrome-beta 常**不复现** headless 环境的 teardown 竞态,所以本地全绿 ≠ CI 会绿。

**判定**：
```bash
CI=1 pnpm test:browser; echo "EXIT: $?"          # 退出码是真相
grep -aE "Unhandled|Instance dropped|OperationError" <log>  # 逃逸源
```

**修法**：在引擎层把"teardown 期可能 reject 的 await"包 try/catch,走既有 graceful-degradation 路径返回 ok（charter proposition 9）。修异步逃逸点时同步加回归测试——用 mock 让该 Promise reject,断言外层 resolve 而非 reject,并**先还原 fix 确认测试变红**再定稿。

```ts
let info: GPUCompilationInfo;
try {
  info = await handleWithInfo.getCompilationInfo();
} catch {
  return ok(handle as unknown as ShaderModule); // instance dropped mid-await
}
```

---

## worktree 本地假失败

**信号**：在新建 worktree 里跑测试,出现下列任一,但 main 主工作树正常：
- `ENOENT: ... forgeax-engine-assets/.../X.meta.json`（fixture 缺失）
- `Failed to resolve entry for package "@forgeax/engine-vite-plugin-shader"`（包未构建）

**根因**：worktree 是**干净 checkout**——submodule 未初始化、`dist/` 未生成。与代码改动无关。

**判定 + 修复**：
```bash
git submodule status forgeax-engine-assets   # 前缀 '-' = 未初始化
git submodule update --init forgeax-engine-assets
pnpm install && pnpm build                    # 生成所有 dist/（.mjs + .d.ts）
```

> [!TIP]
> 判断"失败是我引入的还是环境的"：`git diff --name-only main...HEAD` 看失败包是否在你的 diff 里。不在 → 几乎必是环境(submodule / build / 缓存),先修环境再下结论。

---

## skin browser producer positive probe

**信号**：`hello-skin` 的 Dawn smoke 通过，但浏览器 dev 路径仍报
`asset-not-imported`，或页面没有拿到场景 Pack。

**判定**：运行 `pnpm -F @forgeax/hello-skin smoke:browser`，确认
`importProbeHits >= 3` 且 `kindUnion` 包含 `scene`。这个 probe 验证配置的
`pluginPack` producer path 实际准备了场景 GUID；清空 `vite-plugin-pack` 的
`roots` 或删除 sidecar 后应当失败。Dawn smoke 直接走
`gltfDocToSceneAsset -> register(handle)`，绕过 dev producer/package fetch，
因此不能替代这个浏览器闸门。

---

## vite-plugin-pack DDC 热更新

**信号**：`pnpm dev` 后在浏览器刷新页面,某些贴图消失（白色/黑色）。或者源目录里莫名出现大量 `.bin` 文件,不被 git 追踪。

**根因**：三项按时间线递进：

| 问题 | 提交 | 表现 |
|:--|:--|:--|
| `sourcePath` 被覆盖 | `5b032fd0` | dev cook 把 cooked row 的 `sourcePath` 写成了 `.bin` 路径,warm-refresh 时丢失原始源路径 → 贴图查找失败 |
| `.bin` 写入源树 | `48ba705b` | dev DDC 写入源文件旁边（`${sourcePath}.<guid>.bin`）,源在 `forgeax-engine-assets` submodule 时每次 `pnpm dev` 往 submodule 工作树灌 ~70 `.bin`（~317 MB） |
| 命名不一致 | `e42b1541` | "bin cache" 重命名为 DDC（Derived Data Cache）,路径统一到 `node_modules/.cache/forgeax-ddc/` |

**判定**：
```bash
# 源树里不该有任何 co-located .bin 文件
find packages/ apps/ -name "*.bin" -not -path "*/node_modules/*" -not -path "*/dist/*"
# DDC 应全部在 node_modules/.cache/forgeax-ddc/
ls node_modules/.cache/forgeax-ddc/
```

**修法**：用当前最新。DDC 已迁移到 `node_modules/.cache/forgeax-ddc/`,`sourcePath` 在 warm-refresh 时保持原始路径。如遇热更新贴图丢失,先检查 `node_modules/.cache/forgeax-ddc/` 是否存在旧版 artifact——清空后重启 `pnpm dev`。

---

## Windows 兼容性

**信号**：测试在 Windows 上失败（`≠` 断言值 / `ENOENT: no such file or directory` / grep gate 找不到应命中行）,但 macOS / CI Linux 全过。

**根因**：三项叠加：
- **CRLF 行尾** — `core.autocrlf=true` 使 checkout 时 `\n` → `\r\n`,biome 再 normalize 回 LF 产生全量 diff（由 `449515d6` 的 `.gitattributes` `* text=auto eol=lf` 根除）
- **路径分隔符** — grep/glob 脚本使用 Unix `paths.join()` 在多处,Windows `\` 不匹配 `/`（由 `3da96cbb` 修复 12 处 test + 6 处 grep/glob/路径解析）
- **路径空格/大小写** — 部分脚本假设路径无空格、盘符大小写一致

**判定**：
```bash
# 检查是否强制 LF（git clone 后）
git config core.autocrlf          # 应为 false 或不输出
file <source.ts>                   # ASCII text / UTF-8, 无 "CRLF"
# Windows 上的测试失败
pnpm test:unit 2>&1 | grep -E "FAIL|≠|no such file"
```

**修法**：
1. 确保 `.gitattributes` 存在且首行为 `* text=auto eol=lf`
2. 在 Windows 新工作树：`git config core.autocrlf false && git checkout .`
3. 如仍有路径分隔符问题,bump 到当前（`3da96cbb` 已修复所有已知路径相关 crash）

---
