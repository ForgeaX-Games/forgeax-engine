# Contributing to forgeax-engine

Thanks for your interest! This monorepo runs **two package managers in parallel**: every PR must be green under both `pnpm` and `bun`. This document spells out the local SOPs that keep the dual pipeline healthy.

## Prerequisites

- **Node.js ≥ 22.13.0** (active LTS; `.nvmrc` is checked into the repo)
- **pnpm ≥ 11.1.3** (`package.json#packageManager` pins the corepack-managed version)
- **Bun ≥ 1.2.0** (`.bun-version` is checked into the repo)

If you use `corepack enable`, pnpm comes bundled with the right version automatically.

## Rust toolchain (only when modifying `packages/naga-wasm-shim/`)

`@forgeax/engine-naga-wasm-shim` is the only Rust crate in the monorepo — a thin wasm-bindgen wrap around [`naga`](https://crates.io/crates/naga) that feeds `@forgeax/engine-shader-compiler` from JavaScript. **You only need the Rust toolchain if you are editing `packages/naga-wasm-shim/src/*.rs` or `Cargo.toml`.** Most contributors never touch Rust because the prebuilt `pkg/` output (`*.wasm` + `*.d.ts` + `*.js` glue) is committed to git and consumed by `pnpm install` directly.

### One-time install

```bash
rustup install stable                       # Rust ≥ 1.87 (naga MSRV; 1.95+ recommended)
rustup target add wasm32-unknown-unknown
cargo install wasm-pack                     # wasm-pack 0.14+
```

### Rebuild after Rust changes

```bash
bash packages/naga-wasm-shim/build.sh       # → wasm-pack build --target web --out-dir pkg
```

Stage **both** `packages/naga-wasm-shim/src/...` and the regenerated `packages/naga-wasm-shim/pkg/...` artifacts in the same commit so non-Rust contributors stay unblocked.

### When the toolchain is unavailable

- CI builds the wasm crate from scratch via the steps in `.github/workflows/ci.yml` (`dtolnay/rust-toolchain@stable` + `jetli/wasm-pack-action@v0.4.0`), so a fork PR without Rust locally still verifies cleanly.
- Locally, if you need to run `pnpm test` on a machine without Rust, the committed `pkg/` output is already wired into the workspace — `pnpm install` does **not** invoke `cargo` / `wasm-pack`, and `@forgeax/engine-shader-compiler` resolves the prebuilt `naga_wasm_shim_bg.wasm` via its package.json `exports` map.

`Cargo.lock` is committed (per plan-strategy §S-3, applications-tier crate convention) and is **not** part of the dual-lockfile sync — `pnpm-lock.yaml` and `bun.lock` describe the npm side; `Cargo.lock` is owned by `cargo` alone. The pre-commit `check-staged-lockfiles.mjs` guard does not touch it.

## Rust toolchain (only when modifying `packages/rhi-wgpu/`)

`@forgeax/engine-rhi-wgpu` is the second Rust crate in the monorepo (feat-20260511-rhi-wgpu-impl 兑现) — a thin wasm-bindgen wrap around `wgpu 29` exposing the `@forgeax/engine-rhi` surface as a wasm bundle. **You only need the Rust toolchain if you are editing `packages/rhi-wgpu/crate/src/*.rs` or `Cargo.toml`.** Most contributors never touch Rust because the prebuilt `pkg/` output (`*.wasm` + `*.d.ts` + `*.js` glue) is committed to git and consumed by `pnpm install` directly — same convention as `packages/naga-wasm-shim/` above.

### One-time install

```bash
rustup install 1.93                         # Rust >= 1.93 (wgpu 29 MSRV per research R-NEW-03 / F-1; the rust-toolchain.toml pin scopes this bump to packages/rhi-wgpu only, leaving naga-wasm-shim on >= 1.87)
rustup target add wasm32-unknown-unknown    # required for wasm-pack build --target web
cargo install wasm-pack                     # wasm-pack 0.14+ (same version as naga-wasm-shim)
```

Note: `packages/rhi-wgpu/rust-toolchain.toml` already pins `channel = "1.93"` + `targets = ["wasm32-unknown-unknown"]`, so once `rustup` is installed it will auto-fetch the right toolchain on first `cargo` invocation inside the crate. The pin is **scoped** to `packages/rhi-wgpu/crate/` — the rest of the monorepo (including `packages/naga-wasm-shim`, Rust >= 1.87) is untouched.

### Rebuild after Rust changes

```bash
bash packages/rhi-wgpu/build.sh             # -> wasm-pack build --target web --out-dir pkg
# or equivalently via pnpm workspace script:
pnpm -F @forgeax/engine-rhi-wgpu build             # tsc -b + tsup (rebuilds JS shim around prebuilt pkg/)
```

The `build.sh` entry asserts `rustc >= 1.93` explicitly with a structured error message (charter proposition 4 explicit failure) so a missing toolchain pin surfaces at the `.sh` entry rather than as an opaque `cargo` error. Stage **both** `packages/rhi-wgpu/crate/src/...` and the regenerated `packages/rhi-wgpu/pkg/...` artifacts in the same commit so non-Rust contributors stay unblocked (same SOP as naga-wasm-shim above).

### When the toolchain is unavailable

- CI builds the wasm crate from scratch via the same `dtolnay/rust-toolchain@stable` + `jetli/wasm-pack-action@v0.4.0` steps as `naga-wasm-shim`, so a fork PR without Rust locally still verifies cleanly.
- Locally, if you need to run `pnpm test` on a machine without Rust, the committed `pkg/` output is already wired into the workspace — `pnpm install` does **not** invoke `cargo` / `wasm-pack`, and `@forgeax/engine-runtime` resolves the prebuilt `rhi_wgpu_bg.wasm` via dynamic `import('@forgeax/engine-rhi-wgpu')` inside the auto-select facade.

`packages/rhi-wgpu/crate/Cargo.lock` is committed (same applications-tier crate convention as `naga-wasm-shim`) and is **not** part of the dual-lockfile sync. See AGENTS.md `## RHI / WebGPU` -> dual-impl 立場 for the architectural rationale (auto-select facade + escape hatch).

## FBX SDK 2020.3.7 toolchain (only when modifying `packages/fbx/`)

`@forgeax/engine-fbx` is a native Node.js addon (via `node-addon-api`) that wraps the Autodesk FBX SDK to import `.fbx` assets at build time. **You only need the FBX SDK if you are editing `packages/fbx/src/native/binding.cc` or `packages/fbx/binding.gyp`.** Most contributors never need the SDK because `.fbx` import runs at asset cook time (CI/dev sidecar generation), not at runtime.

### Get the SDK

Download FBX SDK 2020.3.7 from the [Autodesk APS FBX SDK portal](https://aps.autodesk.com/developer/overview/fbx-sdk). The macOS build uses the clang variant: `fbx202037_fbxsdk_clang_mac.pkg.tgz`.

### One-time install (macOS)

```bash
curl -L -o /tmp/fbxsdk.tgz "https://damassets.autodesk.net/content/dam/autodesk/www/files/fbx202037_fbxsdk_clang_mac.pkg.tgz"
mkdir -p /tmp/fbxsdk && tar -xzf /tmp/fbxsdk.tgz -C /tmp/fbxsdk
pkgutil --expand /tmp/fbxsdk/fbx202037_fbxsdk_clang_macos.pkg /tmp/fbxsdk/expanded
mkdir -p $HOME/.local/fbxsdk && cd $HOME/.local/fbxsdk
cat /tmp/fbxsdk/expanded/Root.pkg/Payload | gunzip -dc | cpio -i
```

### Symlink workaround (macOS arm64)

The SDK installs under `Applications/Autodesk/FBX SDK/2020.3.7/` (paths with spaces). `node-gyp` and `make` can choke on space-in-path. Create a symlink to avoid this:

```bash
ln -s "$HOME/.local/fbxsdk/Applications/Autodesk/FBX SDK/2020.3.7" "$HOME/.local/fbxsdk/current"
```

### Required header patch

FBX SDK 2020.3.7 ships a typo in `fbxredblacktree.h` that breaks clang compilation:

```bash
sed -i.bak 's/mLefttChild/mLeftChild/g' "$HOME/.local/fbxsdk/current/include/fbxsdk/core/base/fbxredblacktree.h"
```

### Set environment and build

```bash
export FBX_SDK_ROOT="$HOME/.local/fbxsdk/current"
pnpm rebuild @forgeax/engine-fbx
```

The postinstall script of `@forgeax/engine-fbx` auto-detects `FBX_SDK_ROOT`. When it is unset or points to a missing directory, `pnpm install` prints a warning and exits 0 (graceful degrade) — the workspace installs cleanly without the SDK.

### CI

An opt-in `smoke-fbx-macos-arm64` job in `.github/workflows/ci.yml` runs on `macos-latest` when a PR has the `fbx` label. The job installs FBX SDK via cache then runs `hello-fbx-cube` and `hello-fbx-skin` dawn smokes. It is `continue-on-error: true` — failure does not block PR merge.

### When the toolchain is unavailable

- CI runs the FBX smoke job only when the `fbx` label is present on the PR; all other jobs run without the SDK.
- Locally, `pnpm install` exits 0 even without the SDK — `@forgeax/engine-fbx` gracefully degrades and all non-FBX workspaces are unaffected.

## Local development workflow

```bash
# fresh clone setup
pnpm install           # generates / updates pnpm-lock.yaml
pnpm exec simple-git-hooks   # registers the pre-commit hook (idempotent)

# day-to-day
pnpm test               # runs vitest (single-shot)
pnpm test:watch         # vitest in watch mode (TTY)
pnpm typecheck          # tsc -b across composite project graph (also (re)emits .d.ts SSOT)
pnpm lint               # biome ci .
pnpm format             # biome check --write . (local fixup; CI never writes)
pnpm build              # pnpm -r build (.mjs via tsup) + tsc -b (.d.ts) — chained

# Hello Triangle demo
pnpm dev                # vite dev server at localhost:5173
```

When you switch branches or merge, run `pnpm run sync` to keep `pnpm-lock.yaml` and `bun.lock` in lockstep. The pre-commit hook will reject commits that stage only one of them.

## Dual-lockfile sync SOP

If you encounter a merge conflict in **either** `pnpm-lock.yaml` **or** `bun.lock`:

```bash
# 1. accept whichever lockfile is upstream's, then re-derive both:
git checkout --theirs pnpm-lock.yaml bun.lock

# 2. let the workspace resolver write fresh lockfiles atop:
pnpm run sync           # = pnpm install && bun install (non-frozen)

# 3. stage BOTH lockfiles together (pre-commit guards this invariant):
git add pnpm-lock.yaml bun.lock
git commit -m "chore: sync lockfiles"
```

`.gitattributes` already marks both lockfiles as `merge=ours linguist-generated=true`, which (a) makes git auto-pick "ours" during merge so you don't have to hand-edit, (b) collapses lockfile diffs in GitHub PR view.

## ⚠️ Use `bun run test` — never `bun test`

> [!CAUTION]
> **Always invoke the test script through `bun run test`**, which delegates to `vitest run` via `package.json#scripts.test`. Bun's built-in `bun test` is a Jest-subset runner: it does **not** read `vitest.config.ts`, does **not** recognize `vi.mock` / `vi.fn` / `expectTypeOf`, and silently ignores type-test files (`*.test-d.ts`).
>
> If you run `bun test`, you'll see a green output that has not actually exercised the forgeax-engine test suite. CI's `bun` job specifically calls `bun run test`, never `bun test`, for this reason.

The same warning lives in [README.md](./README.md). If you ever wonder "why are CI and my local results different?" — check whether you typed `bun run test` or `bun test`.

## Commit conventions

Each task in our planning system maps to one commit; commit messages take the form:

```
<type>(<scope>): <title> [<taskId>]
```

`<type>` is one of `test / integration / bench / impl / refactor / fix / migration / docs / config / spike / chore`. `<scope>` is the affected package or subsystem (`math`, `core`, `engine`, `ci`, `tsup`, `tsconfig`, `biome`, `hooks`, `scripts`, `apps/hello/triangle`, …). The `[<taskId>]` suffix is mandatory and is what links commit to the plan in `.forgeax-harness/forgeax-loop/<feat>/tasks.json`.

## Pull requests

- The CI workflow runs **two independent jobs** (`pnpm` and `bun`) plus a `report` job that posts a sticky comment on the PR with bundle size and fps medians (both **non-blocking**).
- Both `pnpm` and `bun` jobs must pass; the `report` job runs `if: always()` and surfaces metrics regardless.
- Your branch must be rebased on `main` before merge (squash or merge commit, decided per PR).

## Architecture invariants

- The three packages have a strict descending dependency chain: `engine → core → math`. Cross-level imports break the build.
- `tsup` emits `.mjs` only (`format: ['esm']`); declarations come from `tsc -b` composite mode (`dts: false` in tsup, `emitDeclarationOnly: true` in tsconfig).
- All runtime diagnostics use `console.warn` / `console.error` (Biome's `noConsole` rule allows only these levels in source). No debug panel, no in-engine property panel, no REST explorer.

Refer to `.forgeax-harness/forgeax-loop/feat-20260505-typescript-game-engine/plan-strategy.md` for the full architectural rationale (K-1 through K-11 decisions, R-1 through R-12 risk treatments).
