# ForgeaX Engine SDK

> [!IMPORTANT]
> 归档同时包含可立即使用的 built SDK 与可修改的 Engine source snapshot。`sdk-manifest.json` 是逐文件完整性权威。

联网用户可先通过唯一 npm 入口安装可发布的 SDK carrier；无需访问私有 GitHub Release：

```bash
pnpm dlx @forgeax/engine sdk install ~/ForgeaX/1.2.3
```

## 最短路径

```bash
node ./bin/forgeax.mjs init          # 每个下载的 SDK / 平台只做一次
# 按输出读取 AGENTS.md、五分钟能力导览和正式能力目录
node ./bin/forgeax.mjs new ../my-game
cd ../my-game
pnpm exec forgeax doctor --json && pnpm test && pnpm build
pnpm dev
```

`init` 是下载后的 SDK 预检：它在 SDK 自己的临时工程中安装并运行一次
esbuild、Rapier 和 Engine WASM 等 native postinstall，并把当前 SDK、Node、平台和
pnpm 元组写入 `.forgeax/sdk-init.json`。之后 `new` 默认使用 `empty`，只复制模板、
安装 skills，并以 `--ignore-scripts` 创建外部游戏；多个游戏共享这次预检，不会在每次
`new` 时重复触发 native 安装。用 `--template game-3d` 创建干净的 3D 光照示例。

SDK 统一锁定仓库声明的 pnpm 11.7.0。完整 ZIP 使用随包 `store/pnpm/` 离线安装，
不需要 npm registry；生成的游戏 `.npmrc` 会固定这个 SDK store，所以后续 `pnpm
dev/test/build` 不会再次触发依赖重装。从 npm carrier 安装的 SDK 不带这个缓存，会按锁文件
从 npm registry 安装同一版本的 Engine 依赖。ZIP 和 npm carrier 都使用同一份 pnpm 11 锁文件与
`pnpm-workspace.yaml#allowBuilds` native 策略。

> [!TIP]
> macOS 如果下载的 ZIP 被 Gatekeeper 标记为 quarantine，优先使用 `node
> ./bin/forgeax.mjs init` 以获得结构化错误。只有在确认 SDK 来自可信来源且系统明确
> 报告 quarantine 阻止时，才执行 `xattr -dr com.apple.quarantine /path/to/forgeax-sdk`；
> SDK 不会自动清除这个安全标记。

> [!IMPORTANT]
> 游戏目标必须位于 SDK 根目录之外。`forgeax new` 拒绝 SDK 根及其子目录；多个游戏使用兄弟目录或其他外部绝对路径。

## 浏览器合成截图迭代（高级）

> [!IMPORTANT]
> 这条路径用于开发态视觉证据，不限定为无 GPU 机器。默认使用可用浏览器适配器；没有显示器
> 或物理 GPU 时显式选择 software。普通用户、玩家和 release acceptance 不走这条链路。

Ubuntu 主机一次性准备浏览器和软件驱动：

```bash
sudo apt-get update
sudo apt-get install -y mesa-vulkan-drivers vulkan-tools xvfb xauth
pnpm dlx playwright@1.60.0 install-deps chromium
pnpm dlx playwright@1.60.0 install chrome-beta
```

然后在游戏根执行：

```bash
pnpm exec forgeax capture --backend auto --require-ui \
  --output artifacts/capture/game-ui.png --json
```

CLI 会启动开发态资产服务；Linux 缺少 `$DISPLAY` 时自动创建 Xvfb；最后用真实浏览器的整页
截图合成 Canvas 与 HTML/Shadow DOM UI。PNG 旁边的同名 JSON
记录实际 adapter、浏览器、分辨率、UI witness 和 browser errors。Mesa lavapipe 是 Dawn/Node
离屏 readback 的后端，不负责浏览器 DOM 合成。

backend auto 在 WebGPU adapter 不可用时回退到 software；backend hardware 要求非软件 adapter；
backend software 固定 SwiftShader/lavapipe 兼容参数。旧 `--software` 仍是 software 别名。
CPU 首帧可能远慢于本机。CLI 会轮询 canvas crop，出现非平坦像素后才追加
`--wait-ms` settle；uniform 黑帧不能只凭 canvas 尺寸通过，`--require-ui` 也只接受
`#game-ui` 下真实挂载的游戏 UI，页面其他 ShadowRoot 不能通过该门禁。sidecar 的
`pixels` 是临时隐藏所有非 canvas 元素后的视觉 liveness 证据，因此 HTML HUD 不能掩盖
黑色 3D 帧；最终 PNG 仍是完整页面合成结果。

CLI 固定 viewport/screen、DPR 1、sRGB、light color scheme、`en-US`、UTC，并等待 Web 字体
ready；项目必须携带相同的 Web font 文件，不能依赖两台机器恰好具有同一套 system fonts。

需要跨机器色彩回归时加 `--deterministic`。页面会收到 `?forgeaxCapture=1`；游戏必须固定随机
种子和逻辑帧、使用项目内 Web 字体，并在 Canvas 与 UI 都稳定后设置
`document.documentElement.dataset.forgeaxCaptureReady = 'true'`。Engine App 同时在真实 Renderer
`frame-submitted` 后发布 `document.documentElement.dataset.forgeaxFrameSubmitted`，并派发
`forgeax:frame-submitted`；CLI 先等引擎信号与非平坦 Canvas，再等游戏检查点。普通 `--wait-ms`
只允许在这些明确握手之后额外 settle，不是确定帧。

自动游玩中连续截图时不要重复启动 `capture`。把检查点名字写入同一个 ready 字段，并通过
`forgeax exec` 保持一份 Vite/Xvfb/Chrome/Page/World：

```js
export default async function playthrough({ browser }) {
  const session = await browser.open({
    backend: 'auto',
    deterministic: true,
    requireUi: true,
    outputDir: 'artifacts/playthrough/boss-flow',
  });
  try {
    await session.page.getByRole('button', { name: '开始' }).click();
    const spawn = await session.capture('spawn');
    await session.page.keyboard.press('KeyW');
    const arena = await session.capture('arena');
    return { report: session.reportPath, captures: [spawn, arena] };
  } finally {
    await session.close();
  }
}
```

```bash
pnpm exec forgeax exec tests/playthrough.mjs --json
```

Playwright 原生 `page` 负责输入和 UI 断言；`capture(name)` 只负责等待同名游戏检查点、截完整
compositor、拒绝平坦画面并追加同一个 schema-v2 `run.json`。program 不能返回活 Page/session。

> [!CAUTION]
> 软件截图用于日常视觉迭代和回归定位，不替代真实 GPU 性能、厂商驱动、HDR 显示器或发布画面验收。

## Engine 源码绑定

SDK 创建的游戏默认解析发布的 @forgeax/engine。需要修改 Engine 源码时，可在不改项目
package.json 的情况下绑定本地 checkout：

```bash
forgeax engine status --json
forgeax engine use-local ../forgeax-engine --json
forgeax engine doctor --json
forgeax engine unlink --json
```

只有本地覆盖存在时才写入游戏目录的 .forgeax/engine-binding.json；文件不存在就是唯一的默认
registry/SDK 状态。项目 manifest 仍是依赖 authority。doctor 会检查本地 workspace 是否已构建、
SDK 包是否存在，以及当前项目是否误用了 npm 无法解析的 workspace:* 依赖；status 的 digest
来自真实 built entry 字节，并报告最近构建时间。unlink 删除覆盖并恢复默认路径。

## 两个使用面

| 使用面 | 路径 | 是否先构建 Engine | 用途 |
|:--|:--|:--:|:--|
| 完整 ZIP Built SDK | `bin/`、`packages/`、`templates/`、`skills/`、`store/pnpm/` | 否 | 离线创建、测试、运行、构建和发布游戏 |
| npm carrier Built SDK | `bin/`、`packages/`、`templates/`、`skills/` | 否 | 体积可发布；创建工程时联网安装锁定的 Engine 依赖 |
| Engine source | `source/engine/` | 修改源码后需要 | 阅读或扩展 Engine packages、CLI、rules 与 skills |

`packages/<name>/` 是裸的已构建 npm package surface：`package.json`、README、dist 与资源直接位于包目录根，不含 `.tgz`，也不含额外 `package/` 层。

```text
forgeax-sdk/
├── bin/forgeax
├── packages/<package>/
├── templates/game-empty/
├── templates/game-3d/
├── store/pnpm/                 # 仅完整 ZIP 提供
├── skills/<forgeax-engine-skill>/
├── source/engine/
├── schemas/
├── toolchain/wasm/
├── sdk-manifest.json
└── AGENTS.md
```

先读 [`AGENTS.md`](AGENTS.md)，再读 [`skills/forgeax-engine-sdk/SKILL.md`](skills/forgeax-engine-sdk/SKILL.md) 的五分钟能力导览；完整的、带 Engine commit 和扫描时间的能力目录位于 [`skills/forgeax-engine-sdk/references/feature-catalog.md`](skills/forgeax-engine-sdk/references/feature-catalog.md)。目录开头的“版本增量导览”还记录了 `sdk-v0.1.4` → `sdk-v0.1.6` 的关键 Engine 改动、迁移影响和可复现 commit，不要只把当前快照当作 changelog。每个新建游戏也会获得普通文件形式的 `AGENTS.md` 与 `skills/`；各 Agent 发现目录的链接由 `forgeax skill install` 生成并由 `forgeax skill verify` 校验。

## Source snapshot

`source/engine/` 不含 `.git`、`.gitmodules`、`.forgeax-harness` 或私有 `forgeax-engine-assets`。它保留公开源码、README、rules/skills，以及 wgpu/FBX/Basis 所需的预构建 WASM：

```bash
cd source/engine
pnpm install
pnpm build:engine
```

## 完整性

发布时让 ZIP 与同目录的 `SHA256SUMS`、SPDX、provenance 和 `sdk-verify-result.json` 一起交付。验证结果必须来自最终 ZIP，并证明默认 empty 与可选 game-3d 的离线创建，以及 `doctor`、`test`、`build`、`dev`、`preview` 和 source template smoke。
