# ForgeaX Empty Game

这是 SDK 的默认最小工程：一个带可回收运行时相机的游戏插件、一个资产目录，以及一个真正进入资产构建链的零实体 `SceneAsset`。相机不写入资产，因此空场景仍可作为纯净 author 起点，同时 dev/preview 不产生无相机错误。

```bash
pnpm exec forgeax doctor --json
pnpm test
pnpm build
pnpm dev
pnpm preview
pnpm package
```

`pnpm package` 生成 `release/forgeax-empty-game-web.zip` 和 SHA-256；Engine runtime、WASM、
shader 与 cooked assets 已在 ZIP 内。上传 ZIP 到 HTTPS 静态/HTML 游戏托管后分享 URL，不能
让玩家通过 `file://` 双击其中的 `index.html`。

## 从哪里开始

| 文件 | 职责 |
|:--|:--|
| `forge.json` | 工程身份、入口、插件、默认场景和资产根目录的权威配置。 |
| `src/main.ts` | 游戏插件入口；系统、服务和生命周期贡献从这里组合。 |
| `src/__tests__/` | 属于游戏源码边界的 Vitest 单元测试；不在工程根制造框架目录。 |
| `assets/lib.ts` | 可复用的纯资产构造函数。不要在这里登记 GUID。 |
| `assets/empty-scene.pack.ts` | ScriptablePack author source；登记稳定 GUID 并产出空场景。 |
| `skills/` | SDK Engine skills 的普通文件副本；各 Agent 发现目录只链接到这里。 |
| `AGENTS.md` | AI 和开发者的完整工程手册；先读它再扩展工程。 |

`*.pack.ts` 适合程序化或多个相关资产；`*.pack.json` 适合直接写最终 POD；外部图片、模型、字体、音视频用同名 `*.meta.json` 保存 GUID 与导入策略。`dist/pack-index.json` 和构建生成的包是投影，不是 author source。

常用资产命令：

```bash
pnpm exec forgeax asset list --json
pnpm exec forgeax asset verify --json
pnpm exec forgeax asset inspect 019fb7ce-1000-7000-8000-000000000001 --json
pnpm exec forgeax skill verify --json
```

> [!TIP]
> 新资产优先在 `lib.ts` 写可复用构造逻辑，再由一个或多个 `*.pack.ts` 负责身份、依赖和输出声明。
