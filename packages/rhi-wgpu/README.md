# @forgeax/engine-rhi-wgpu

> `import { rhi, ensureReady, acquireCanvasContext } from '@forgeax/engine-rhi-wgpu'` + `await ensureReady()` + `const ctx = (await rhi.acquireCanvasContext(canvas)).unwrap()` -- non-browser rendering path via wgpu-wasm.

## Overview

This package is the dual-impl partner of `@forgeax/engine-rhi-webgpu`. Both export the same `@forgeax/engine-rhi` surface; the runtime `createRenderer` auto-select facade picks one at runtime based on `navigator.gpu` availability.

AI engine users do NOT import this package directly -- `Engine.create({ canvas })` / `createRenderer(canvas)` auto-selects Channel 2 (`rhi-webgpu`, `navigator.gpu`) or Channel 3 (`rhi-wgpu`, this package) transparently.

## Channel architecture

`createRenderer` uses a three-channel selection (plan-strategy section 7):

| Channel | Trigger | Backend | Context acquisition |
|:--|:--|:--|:--|
| 1 | `options.rhi` explicit escape hatch | caller-supplied | caller-supplied |
| 2 | `navigator.gpu` present | `rhi-webgpu` (static import) | `canvas.getContext('webgpu')` |
| 3 | `navigator.gpu` absent, or Channel 2 fails | `rhi-wgpu` (dynamic import) | wasm `createSurface(canvas)` |

Channel 3 loads the `engine-wgpu-wasm` bundle lazily (via `ensureReady()`). The wasm bundle (~0.53 MB gzip) is only downloaded when neither Channel 1 nor 2 succeeds, keeping browser-only bundles lean.

## `acquireCanvasContext(canvas)`

Single-entry surface for context acquisition. Replaces the deleted `createCanvasContext`.

```
function acquireCanvasContext(
  canvas: HTMLCanvasElement
): Result<RhiCanvasContext, RhiError>
```

The wasm surface path internally:
1. Gets the `RhiWgpuInstance` from the wasm module
2. Calls `instance.createSurface(canvas)` to create a wgpu Surface handle
3. Returns a branded `RhiCanvasContext` wrapping the Surface

On failure returns `RhiError({ code: 'rhi-not-available' })` with `.hint` describing the cause.

AI users call this through `pack.rhi.acquireCanvasContext(canvas)` inside the runtime -- the runtime auto-selects between `rhi-webgpu` (which uses `canvas.getContext('webgpu')`) and `rhi-wgpu` (this path).

## `requestAdapter` and `compatibleSurface`

```
function requestAdapter(
  opts?: { compatibleSurface?: HTMLCanvasElement }
): Promise<Result<RhiAdapter, RhiError>>
```

When `compatibleSurface` is provided:
- The wasm path calls `RhiWgpuInstance.requestAdapterWithCanvas(canvas)` instead of `requestAdapter()`
- The `rhi-webgpu` fast path ignores this parameter (not needed for `navigator.gpu`)

This is needed by the wgpu GL backend, which requires a `compatible_surface` to enumerate adapters (plan-strategy D-9, requirements AC-11).

## Relationship with `@forgeax/engine-wgpu-wasm`

This package is a TS-only thin shell. It:
- Imports `@forgeax/engine-wgpu-wasm` for wasm-bindgen types + `ensureReady`
- Wraps raw wasm exports into the `@forgeax/engine-rhi` interface shape
- Does NOT contain its own wasm bundle or Rust source

See `packages/wgpu-wasm/README.md` for the full wasm-bindgen method table.

## Exports

| Export | Kind | Description |
|:--|:--|:--|
| `rhi` | `RhiInstance` singleton | requestAdapter, acquireCanvasContext (the rhi-wgpu backend pack) |
| `ensureReady()` | async function | Lazy-loads the wasm bundle; must be awaited before using `rhi` |
| `requestAdapter(opts?)` | async function | Adapter request with optional `compatibleSurface` |
| `acquireCanvasContext(canvas)` | function | Canvas context acquisition via wasm Surface path |
| `createShaderModule(device, desc)` | async function | Async shader module factory |
| `err`, `ok`, `RhiErrorClass` | re-export | From `@forgeax/engine-rhi` |
| `ensureRhiWgpuReady` | function | Legacy alias for `ensureReady` |

## Constraints

- `acquireCanvasContext` must be called BEFORE `requestAdapter` when using Channel 3 (the wasm Surface is created first; the adapter is requested with `compatibleSurface` to ensure GL context compatibility)
- The wasm bundle is lazily loaded and only downloaded when needed
- `device.caps` reports `false` for features unsupported by the wgpu GL backend

## destroyBuffer / destroyTexture (feat-20260612)

Per-handle destroyed-state bookkeeping in the TS shim layer mirrors `rhi-webgpu` behavior. Wgpu's Rust `Buffer::destroy()` / `Texture::destroy()` are idempotent void (not drop-trait panic, confirmed by research F-1 correction). The shim adds fail-fast on second destroy with `'destroy-after-destroy'` error code via a per-handle `destroyed: boolean` field -- never crossing the wasm boundary for state checking (plan-strategy D-6).

Implementation locations:
- `packages/rhi-wgpu/src/device.ts` -- `destroyBuffer` / `destroyTexture` methods
- `packages/rhi-wgpu/src/buffer.ts` -- per-handle destroyed flag in the buffer wrapper