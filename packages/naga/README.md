# @forgeax/engine-naga

> **本包是 `@forgeax/engine-wgpu-wasm` 暴露的 naga raw bindings 之上的 TS-only 薄壳**，对齐三阶段 API（`parse` / `validate` / `emit_reflection`），关注点零业务逻辑。AI 用户（含 agentic AI runtime）可直接 `import { parse, validate, emit_reflection } from '@forgeax/engine-naga'` 复用 WGSL syntax check 能力——内部走 `@forgeax/engine-wgpu-wasm.ensureReady()` singleton 加载物理 wasm（plan-strategy §D-P3 / §D-P4 + research F-4 + charter 命题 1 渐进披露 + 命题 5 一致抽象）。

## 形态铁律

- **关注点单一** —— 只做 raw wasm-bindgen 出口的 TS 包装（snake_case naga upstream 原生命名延续）；reflection 字段派生 / 三件套 emit 都在上游 `@forgeax/engine-shader-compiler`。
- **TS-only 薄壳** —— 本包无 Rust crate / `Cargo.toml` / `build.sh` / `pkg/` 资产；物理 wasm 段统一由 `@forgeax/engine-wgpu-wasm` 出包，本包 deps `'@forgeax/engine-wgpu-wasm': 'workspace:*'`。
- **ShaderError 不重定义** —— `ShaderErrorCode` closed union 4 成员从 `@forgeax/engine-types` 复用（+0 破坏点，AC-09）；本包仅做 `try { ... } catch (e) { return err(wrapShaderError(...)) }` 包装层。
- **物理隔离** —— `@forgeax/engine-shader` runtime 包**禁止**直接或间接依赖本包（AC-06 三重闸门 grep 守护）。

## API 索引

| 入口 | 形态 | 说明 |
|:--|:--|:--|
| `parse(source)` | `(string) => Promise<Result<ParsedModule, ShaderError>>` | naga `parse_str` 透传；syntax error → `Result.err(ShaderError code='shader-compile-failed')`（含 lineNum / linePos） |
| `validate(parsed)` | `(ParsedModule) => Promise<Result<ValidatedModule, ShaderError>>` | naga `Validator::validate` 透传；ownership 转移（消费 parsed handle） |
| `emit_reflection(validated, optionsJson)` | `(ValidatedModule, string) => Promise<Result<string, ShaderError>>` | reflection JSON 字符串 emit；ModuleInfo 已嵌入 ValidatedModule 句柄；上层 `@forgeax/engine-shader-compiler.parseReflectionJson` 派生 `BindGroupLayoutDescriptor[]` |

签名映射 `@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm.d.ts`（wasm-pack auto-emit）；本包仅做 try/catch + ensureReady 适配层。

## 关联

- 决策 plan-strategy §D-P3（`ensureReady` SSOT）/ §D-P4（薄壳 surface byte-for-byte 等价历史上 wasm-pack 形态的 naga shim，已在 feat-20260511-naga-rhi-wgpu-merge M5 整体归档删除——保留 surface 形态延续不变）。
- 上游物理底层 `@forgeax/engine-wgpu-wasm`（合并 wgpu 29 RHI + naga 29 三段函数 raw bindings 的单 wasm 出包）。
- 下游消费 `@forgeax/engine-shader-compiler`（仅消费者）；`@forgeax/engine-shader` runtime 物理隔离（AC-06 闸门守护）。
