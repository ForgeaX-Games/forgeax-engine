# Contributing to forgeax-engine

Thanks for your interest! This monorepo runs **two package managers in parallel**: every PR must be green under both `pnpm` and `bun`. This document spells out the local SOPs that keep the dual pipeline healthy.

## Prerequisites

- **Node.js ≥ 22.13.0** (active LTS; `.nvmrc` pins the exact patch — currently `22.22.3`)
- **pnpm** — `package.json#packageManager` pins the corepack-managed version (currently `11.7.0`)
- **Bun ≥ 1.2.0** (`.bun-version` is checked into the repo)

If you use `corepack enable`, pnpm comes bundled with the right version automatically.

## Rust toolchain (only when modifying `packages/wgpu-wasm/`)

`@forgeax/engine-wgpu-wasm` is the **only** Rust crate in the monorepo — a single wasm-bindgen crate merging `wgpu 29` (RHI raw bindings) and `naga 29` (three-phase shader pipeline), produced by `feat-20260511-naga-rhi-wgpu-merge`. It replaced the two earlier crates (`naga-wasm-shim` + `rhi-wgpu/crate`), which are archived. Two TS-only thin shells consume its raw bindings: `@forgeax/engine-rhi-wgpu` (RHI) and `@forgeax/engine-naga` (shader tooling) — neither contains Rust anymore.

**You only need the Rust toolchain if you are editing `packages/wgpu-wasm/src/*.rs` or `Cargo.toml`.** Most contributors never touch Rust: the prebuilt `pkg/` bundle (`*.wasm` + `*.d.ts` + `*.js` glue) is **not** committed to git (ufbx-style release, mirroring `packages/fbx/`), and `pnpm install`'s `postinstall` hydrates it automatically by downloading the content-keyed bundle from the `wasm-artifacts` GitHub Release (`scripts/ensure-wgpu-wasm-pkg.mjs` → `fetch-wasm`). The fetch is non-fatal: offline or unauthenticated, `install` still succeeds and you build `pkg/` locally when you next need it.

### One-time install

```bash
rustup install 1.93                         # Rust >= 1.93 (wgpu 29 MSRV)
rustup target add wasm32-unknown-unknown    # required for wasm-pack build --target web
cargo install wasm-pack                     # wasm-pack 0.14+
```

`packages/wgpu-wasm/rust-toolchain.toml` already pins `channel = "1.93"` + `targets = ["wasm32-unknown-unknown"]`, so once `rustup` is installed it auto-fetches the right toolchain on the first `cargo` invocation inside the crate.

### Rebuild after Rust changes

```bash
bash packages/wgpu-wasm/build.sh            # -> wasm-pack build --target web --out-dir pkg
# or equivalently via the pnpm workspace script:
pnpm -F @forgeax/engine-wgpu-wasm build     # tsc -b + tsup (rebuilds the JS shim around prebuilt pkg/)
```

`build.sh` asserts `rustc >= 1.93` explicitly with a structured error message (charter proposition 4 explicit failure) so a missing toolchain pin surfaces at the `.sh` entry rather than as an opaque `cargo` error. Commit **only** `packages/wgpu-wasm/src/...` (+ `Cargo.toml` / `Cargo.lock` if changed) — `pkg/` is gitignored and never committed. On the next main push, the `publish-wgpu-wasm-release` CI job rebuilds `pkg/` and publishes the content-keyed bundle so non-Rust contributors' `fetch-wasm` picks it up. The content key (`scripts/content-key.mjs`) hashes `src/**/*.rs` + `Cargo.{toml,lock}` + `rust-toolchain.toml` + `build.sh`, so any source change yields a fresh bundle name and stale `pkg/` can no longer be served.

> [!NOTE]
> wasm-pack's bundled binaryen is too old to parse wgpu 29's multi-table WASM, so `Cargo.toml` sets `wasm-opt = false`. CI installs a system `binaryen` (>= 116) and `build.sh` runs an extra `wasm-opt -Oz` pass when one is on `PATH`; local builds without binaryen skip that pass silently (dev-only size penalty).

### When the toolchain is unavailable

- CI builds the wasm crate from scratch via `dtolnay/rust-toolchain@stable` + `taiki-e/install-action` (`wasm-pack@0.14.0`) in `.github/workflows/ci.yml`, so a fork PR without Rust locally still verifies cleanly.
- Locally, if you need to run `pnpm test` on a machine without Rust, `pnpm install` does **not** invoke `cargo` / `wasm-pack` — its `postinstall` fetches the prebuilt `pkg/` bundle from the `wasm-artifacts` release instead. The `@forgeax/engine-rhi-wgpu` and `@forgeax/engine-naga` shells then resolve the hydrated `wgpu_wasm_bg.wasm` directly. If the fetch could not run (offline / private repo without `GITHUB_TOKEN` / bundle not yet published), run `pnpm -F @forgeax/engine-wgpu-wasm fetch-wasm` once connectivity returns, or `build:wasm` if you have the Rust toolchain.

`packages/wgpu-wasm/Cargo.lock` is committed (applications-tier crate convention) and is **not** part of the dual-lockfile sync — `pnpm-lock.yaml` and `bun.lock` describe the npm side; `Cargo.lock` is owned by `cargo` alone. The pre-commit `check-staged-lockfiles.mjs` guard does not touch it. See `packages/rhi-wgpu/README.md` and AGENTS.md §Packages for the dual-impl / auto-select-facade rationale.

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

## ⚠ Use `bun run test` — never `bun test`

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

- The monorepo is a layered graph of `@forgeax/engine-*` packages (`packages/<pkg>/` ↔ `@forgeax/engine-<pkg>`; bare `@forgeax/engine` in `packages/engine/` is a README-only placeholder). Each `packages/<pkg>/README.md` is the SSOT for that package's API, error codes, and capability gates — see AGENTS.md §Packages. Cross-level imports that violate the dependency direction break the build.
- `tsup` emits `.mjs` only (`format: ['esm']`); declarations come from `tsc -b` composite mode (`dts: false` in tsup, `emitDeclarationOnly: true` in tsconfig). `pnpm -r build` alone leaves `.d.ts` stale — run `pnpm build` (chains `tsc -b`).
- All runtime diagnostics use `console.warn` / `console.error` (Biome's `noConsole` rule allows only these levels in source).
- Source and entry docs are **English-only** (ASCII + math/Greek), enforced by `scripts/forgeax/check_english_only.py`.

Refer to `.forgeax-harness/forgeax-loop/feat-20260505-typescript-game-engine/plan-strategy.md` for the original architectural rationale (K-1 through K-11 decisions, R-1 through R-12 risk treatments).
