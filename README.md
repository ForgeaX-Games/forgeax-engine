# ForgeaX Studio — forgeax-engine

[English](./README.md) · [简体中文](./README.zh-CN.md) · [↑ studio](https://github.com/ForgeaX-Games/forgeax-studio)

> **An AI-first TypeScript game engine, built from scratch on WebGPU — designed to surpass Three.js.**

`forgeax-engine` is the real engine that runs your game inside the ForgeaX Studio
preview — not a wrapper around an existing renderer. It is a ground-up **Entity-Component-System
(ECS) + WebGPU** engine written in strict TypeScript, with its hottest paths (the GPU
abstraction and the shader pipeline) compiled from **Rust → WebAssembly**. Its primary user is
not a human reading a tutorial; it is an **AI agent** writing game code, so every API is shaped
to be called correctly from structured knowledge alone.

## Why it's different

Most web engines are built for humans first and bolt on tooling later. ForgeaX inverts that.
Its design creed makes the engine *legible to a machine*, which — not coincidentally — also
makes it predictable for humans:

| Principle | What it buys you |
|---|---|
| **Machine-readable > prose** | Every API self-describes via schema / manifest / typed surface. You (or an agent) can call it correctly from the types — the types *are* the documentation. |
| **Explicit failure > silent behavior** | Fallible calls return `Result<T, E>` carrying `.code` / `.expected` / `.hint`. No thrown surprises, no string-encoded semantics, no swallowed errors. |
| **Uniform abstraction > leaked internals** | One clean interface up front; performance knobs are opt-in, not mandatory ceremony. |
| **Context economy** | Small API surface, self-explanatory names — the whole engine family is discoverable by IDE autocomplete on the `@forgeax/engine-` prefix. |

The guiding axiom is **"compression == intelligence"**: the smaller and more uniform the
surface needed to express a capability, the better — for the agent that writes against it and
for the human who reads it.

## Architecture

The engine ships as a family of focused packages under two independent dependency chains —
a **runtime chain** rooted at `@forgeax/engine-runtime` and a **build-time chain** rooted at
`@forgeax/engine-vite-plugin-shader`. Highlights:

**Rendering & GPU**
- [`packages/rhi`](packages/rhi) — the **RHI** (Render Hardware Interface): a pure, math-free
  interface shape-aligned with `@webgpu/types`, with opaque handles and a capability-gated
  op-set (a wgpu superset). It ships **two interchangeable implementations** side by side:
  `rhi-webgpu` (a thin shim over the browser's native WebGPU) and `rhi-wgpu` (a TS shell over
  the Rust `wgpu` bindings).
- `packages/wgpu-wasm` — a **merged wgpu 29 + naga 29 `wasm-bindgen` crate**: the Rust→wasm
  hot path that backs `rhi-wgpu` and the shader toolchain.
- [`packages/render-graph`](packages/render-graph) — a declarative render graph
  (resource/pass declaration → `compile()` → `execute()`), depending only on RHI + math.
- `packages/rhi-debug` — a RenderDoc-inspired frame recorder with **deterministic replay** and
  offline inspection (first user: an AI subagent debugging a frame).

**Shaders** — a build-time triple (`shader-compiler` WGSL → wgsl/glsl/bindings + reflection,
`naga` parse/validate, `wgpu-wasm`) feeds a runtime, content-addressable `shader` registry,
wired into Vite by `vite-plugin-shader`.

**Simulation core**
- [`packages/ecs`](packages/ecs) — an **archetype ECS** (`World` / `Entity` / `Component` /
  `Query` / `System` / `Schedule`) with managed component buffers and a kubectl-style inspector
  plugin (entities / components / systems / resources / world).
- `packages/math` — SoA-friendly `Vec` / `Mat` / `Quat`. `packages/types` — the project-wide
  `Result<T, E>` SSOT. `packages/state` — a zero-intrusion typed state machine with
  state-scoped entity lifecycle.

**Asset pipeline** — an explicit **import (build-time) / load (runtime) split** governed by a
GUID "import-stable iron law":
- [`packages/pack`](packages/pack) — the on-disk asset-package schema, GUID tools, and scanner;
  `vite-plugin-pack` serves it with dev HMR.
- `packages/import` — the build-time runner + `ImporterRegistry` that turns a `*.meta.json`
  sidecar into a compiled DDC (`.pack.json` / `.bin`). Importers: [`gltf`](packages/gltf)
  (runtime glTF 2.0), `fbx` (Autodesk FBX SDK), `image`, and `font` (MSDF atlas baking).
  At runtime you `loadByGuid` a payload and `allocSharedRef` it into the world.

**Gameplay services** — [`physics`](packages/physics) (interface) with Rapier 2D/3D WASM
backends (SIMD-detected, three-phase `syncBackend` / `stepSimulation` / `writeback` tick,
raycast, collision events); `audio` (interface) + a Web Audio backend; `input` (a frozen,
frame-start `InputSnapshot` resource + PointerLock); `debug-draw` (immediate-mode lines /
spheres / AABBs / frustums).

**Project contract** — `packages/engine-project` is the SSOT for **`forge.json`**, the
authoritative game manifest (a zod schema + injectable loader). `packages/app` provides the app
shell + game loop (rAF, start/stop/pause, auto input).

## What you actually get

- **WebGPU-native rendering with a WebGL2 fallback path** — `@forgeax/engine-runtime` is a
  `Renderer + Backend (WebGPU / WebGL2)` async factory.
- **Rust-grade hot paths** without leaving the web — the GPU and shader cores are real wgpu/naga
  compiled to wasm.
- **Errors you can act on** — `Result<T, E>` with codes and hints instead of stack traces.
- **A held quality bar** — every engine change must pass headless dawn-node smokes (300 frames),
  browser tests, and a **pixel-parity bench against Three.js** (ε ≤ 0.05). The `apps/learn-render`
  suite tracks rendering features against the LearnOpenGL curriculum; `apps/parity` holds the
  three.js comparison; `apps/hello/*` are minimal runnable demos.

## Key concepts

`World` / `Component` / `Query` (ECS) · `Handle` / `allocSharedRef` (shared GPU/asset resources)
· `createApp` / `createRenderer` (entry points) · `loadByGuid` → payload → `instantiate`
(assets) · `pack` / `catalog` (asset packages) · `forge.json` via `@forgeax/engine-project`
(the game manifest) · `Result<T, E>` (the universal error model).

## How it fits the studio

Studio embeds the engine in a live preview iframe: the server writes your game's source, the
engine hot-reloads it, and you see the result instantly. Games are consumed through
`createApp` + `loadByGuid`/`instantiate` against the same `forge.json` contract the editor and
build pipeline read — one engine, identical behavior in Play and Edit.

## Build & run (standalone)

Requires **Node ≥ 22.13**, **pnpm ≥ 11.1.3**, **Bun ≥ 1.2** (and a Rust toolchain to rebuild
the wasm crate). Clone with `--recurse-submodules`.

```bash
pnpm install && pnpm build      # tsup (.mjs) + tsc -b (.d.ts)
pnpm test
pnpm dev                        # demos at http://localhost:5173
pnpm -F @forgeax/engine-wgpu-wasm build   # rebuild the Rust → wasm crate
```

Each `packages/<pkg>/README.md` is the SSOT for that package's API, error codes, and
capability gates.

---

Part of the **ForgeaX Studio** monorepo. This repo is a submodule of
[`ForgeaX-Games/forgeax-studio`](https://github.com/ForgeaX-Games/forgeax-studio) — clone that
with `--recurse-submodules` to run the full studio. License: Apache-2.0.
