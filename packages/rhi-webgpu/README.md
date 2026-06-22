# @forgeax/engine-rhi-webgpu

> WebGPU thin shim implementation of `@forgeax/engine-rhi`; spec-aligned descriptors; `'x' in src` guard; no field renaming.

## Charter propositions (顶部命题 / AI users read AGENTS.md §RHI / WebGPU first)

| Proposition | This package's contract |
|:--|:--|
| 1 渐进披露 | Single `import { rhi } from '@forgeax/engine-rhi-webgpu'` exposes 14 opaque handles + the entire RHI surface; one read covers entry. |
| 2 业界实践 | Descriptor mirroring uses `Pick<GPUXxxDescriptor, ...>`; `tsconfig` enables `exactOptionalPropertyTypes`; ts-morph drives the R12 lint mirror (S-2). |
| 3 机读 union > 散文 | Bounds-guard hints (`'queue-write-buffer-out-of-bounds'`) carry concrete `got X` numbers, not prose; AI users parse `.hint` for self-recovery. |
| 4 显式失败 | Real-path surfaces returned `Result.err` for every D-S3 trigger (4 new codes added by `feat-20260508-rhi-surface-completion`). The escape hatch is renamed to `_internal_getRawDevice` + confined to a 4-path allow-list (D-S1). |
| 5 一致抽象 | Shim never renames descriptor fields; `BufferDescriptor.size` -> `GPUBufferDescriptor.size` byte-for-byte; descriptors travel via `'x' in src` guard preserving missing vs explicit-undefined. |
| 6 (candidate) mock vs real-GPU | `src/__tests__/dawn-real-gpu.dawn.test.ts` triggers all 4 D-S3 codes against real dawn.node GPU (plan-decisions L-P3); silent-pass blind spots monitored. |

> AI users: read [AGENTS.md §RHI / WebGPU](../../AGENTS.md) first for the形态铁律 (spec alignment / capability-gated / opaque handle / math-free); this package is the WebGPU thin shim that physically realizes the contract.

## API entries (mid-section method tables)

| Entry | Form | Purpose |
|:--|:--|:--|
| `requestDevice(opts?)` | `(RequestDeviceOptions) => Promise<Result<RhiDevice, RhiError>>` | Entry 1: navigates `navigator.gpu` (default) or an injected `gpu` provider; error paths 1/2/3 originate here |
| `createShaderModule(device, desc)` | `(RhiDevice, { code, label? }) => Promise<Result<ShaderModule, RhiError>>` | Entry 2: async shader compile; `'shader-compile-failed'` forwards every `GPUCompilationMessage` field to `RhiError.detail.compilerMessages` |
| `rhi` | `{ requestDevice, createShaderModule }` const singleton | Progressive-disclosure entry (charter proposition 1); see `Engine.create({ rhi, canvas })` and `import { rhi } from '@forgeax/engine-rhi-webgpu'` |
| `_internal_getRawDevice(device)` | `(RhiDevice) => GPUDevice \| undefined` | D-S1 single-point escape hatch (whitelist: `device.ts` def + `index.ts` createShaderModule + `apps/hello/triangle/src/main.ts:96` canvas context.configure + `dawn-real-gpu.dawn.test.ts` validation probe). `getRawDevice` (without prefix) was removed in M4 (AC-RSC-05). |
| `GpuLike` / `GpuAdapterLike` / `GpuDeviceLike` | `interface` provider seam | Mock fixture's minimal GPU subset (research §F-6) |
| `RequestDeviceOptions` | `{ gpu?, adapterOptions?, deviceDescriptor? }` | Provider seam injection arguments |
| re-export | `RhiDevice` / `Result` / `RhiError` / `_internal_getRawDevice` | Single-entry surface for downstream callers |

## D-S3 real-path error coverage

`feat-20260508-rhi-surface-completion` lands the real-path implementation for command recording + queue submit + queue.writeBuffer; the 4 D-S3 codes are observable through `Result.err`:

| Code | Wrapped at | Trigger |
|:--|:--|:--|
| `'command-encoder-finished'` | `device.ts:498-518` (`finish()` lifecycle) | Second `encoder.finish()` after a prior finish; void-recording APIs throw the structured error so AI users observe the failure |
| `'render-pass-not-ended'` | `device.ts:507-512` (`finish()` activePass guard) | `encoder.finish()` while a pass has not been `end()`-ed; the guard tracks `state.activePass` per `PASS_STATE` weakmap |
| `'queue-submit-failed'` | `device.ts:601-607` (`submit()` try/catch) | `rawQueue.submit()` throws (validation error / destroyed reference); message is forwarded into `.hint` |
| `'queue-write-buffer-out-of-bounds'` | `device.ts:548-567` (`writeBuffer()` bounds guard) | `bufferOffset % 4 !== 0` or `bufferOffset + writeSize > buffer.size`; `.hint` carries `got X` / `got Y` / `got Z` numbers for AI-user routing |

Real-GPU integration is in [`src/__tests__/dawn-real-gpu.dawn.test.ts`](./src/__tests__/dawn-real-gpu.dawn.test.ts) (4 describes, 4 codes triggered).

## Capabilities tri-layer

`device.caps` (hardware probe) / `device.features` (enabled set) / `device.limits` (numeric upper bounds) — three independent `readonly` fields (charter proposition 5); `caps.X = false` is an explicit signal, never an exception (proposition 4).

## Test infrastructure

- Hand-rolled minimal mock GPU device (decision S-2 path (b)) at `src/__tests__/__mocks__/gpu-device.ts`; zero-native dependency, pure TS.
- Provider seam injection via `gpu?: GPU` parameter (research §F-6 webgpu-utils + CTS consensus); default routes through `globalThis.navigator.gpu`.
- dawn.node real-GPU coverage: `src/__tests__/dawn-real-gpu.dawn.test.ts` (4 D-S3 triggers, candidate proposition 6 monitoring).

## Intentional differences (vs spec / wgpu)

- **`'x' in src` guard transit**: spec `?: T` vs forgeax `?: T | undefined` differ under `exactOptionalPropertyTypes:true`; the shim guards each field per F-3 anti-pattern 2.
- **`device.lost` single source**: this package only forwards the spec Promise; fan-out is the engine's job (`LostListenerRegistry`).
- **Error message keyword classification**: `requestDevice` failure routes via `feature` / `limit` keyword detection; mock and real-GPU formats may differ.
- **Real-path implementation (M4-M5)**: command recording + queue submit + queue.writeBuffer landed; the 3 placeholder methods (`executeBundles` / `beginOcclusionQuery` / `endOcclusionQuery`) still return `Result.err({ code: 'rhi-not-available', hint: 'see feat-future-rhi-resource-creation' })`.
- **Escape hatch tear-down**: `getRawDevice` (no prefix) removed in `feat-20260508-rhi-surface-completion` M4 (AC-RSC-05); the single sanctioned hatch is `_internal_getRawDevice` confined to the AC-08 (h) allow-list.
- **destroyBuffer / destroyTexture (feat-20260612)**: per-handle destroyed-state bookkeeping in shim layer (`WeakMap<Handle, { destroyed: boolean }>`) on top of the spec's idempotent-void `GPUBuffer.destroy()` / `GPUTexture.destroy()`. Dual-backend behavior is symmetric: both shims track destroyed boolean per handle, fail-fast on second destroy with `'destroy-after-destroy'` error code, and never depend on wasm panic interception (plan-strategy D-6). Implementation at `packages/rhi-webgpu/src/device.ts`.

## FAQ

**Q: Why not directly `implements GPUDevice` for the full interface?**

A: charter proposition 1 — progressive disclosure: the shim only touches descriptors actually used (`createX` + `features` / `limits` / `lost` / `queue` + command recording). Mock fixtures need not implement `wgslLanguageFeatures` / `getPreferredCanvasFormat`.

**Q: Are real `GPUDevice` and mock semantics aligned for `device.lost.reason` / `message`?**

A: No — spec and wgpu impl format are not interchangeable (research §F-4). This package forwards the Promise without classification; consumers should `switch` over `'destroyed' | 'unknown'`.

**Q: Why does `_internal_getRawDevice` exist if escape hatches are forbidden?**

A: D-S1 single-point exemption — `apps/hello/triangle/src/main.ts:96` `context.configure({device: rawDevice})` requires raw `GPUDevice` because `RhiCanvasContext` is owned by `feat-future-rhi-adapter-surface`. The hatch is renamed (no bare `getRawDevice`), confined to a 4-path allow-list (AC-08 (h)), and grep-fenced.

## Upgrade path

- `@webgpu/types ^0.1.69`: caret range tracks v0.1.x patches; v0.2.x triggers major-upgrade markers (S-4).
- After upstream spec migrates to `?: T | undefined`, the `ExplicitUndefined<>` mapped type can be removed and the mirror simplifies (L-P4 widening contract).

## Dependencies

- `@forgeax/engine-rhi` (workspace) — interface contract SSOT.
- `@forgeax/engine-types` (workspace) — POD types / union aliases SSOT.
- `@webgpu/types ^0.1.69` — spec types; lock-version policy is in repo-root [AGENTS.md](../../AGENTS.md).

## Related packages

- [`@forgeax/engine-rhi`](../rhi) — pure interface contract (14 opaque handles + 9 descriptors + 7 main interfaces + `RhiError` / `Result`).
- [`@forgeax/engine-types`](../types) — POD types / enum SSOT.
- [`@forgeax/engine-runtime`](../engine) — async factory entry (M3 injects via `rhi.requestDevice()`).
