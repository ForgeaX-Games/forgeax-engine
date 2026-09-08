---
name: forgeax-engine-sdk
description: >-
  ForgeaX SDK onboarding, capability discovery, production, and acceptance. Use when
  receiving the SDK, choosing Engine features for a game, building or releasing a
  ZIP, checking reproducibility, or diagnosing bootstrap.
---

# ForgeaX Engine SDK

## First five minutes: understand before authoring

SDK `init` and project `new` print three local files under `onboarding.read`. Read them in order: root `AGENTS.md` for workflow constraints, this skill for selection, then [the scanned capability catalog](references/feature-catalog.md) when the task needs a broader inventory. Start that catalog at its `sdk-v0.1.4 → sdk-v0.1.6` version-delta section before using the current snapshot: it records the Engine commits, consumer-visible changes, and migration boundaries that a flat feature list would hide. The catalog records the exact Engine commit and scan time; it is the public, versioned replacement for the former Harness-only feature list.

> [!IMPORTANT]
> Available is not enabled. A package in the SDK means the capability can be selected; a game enables it only through its `forge.json`, plugin composition, ECS components, assets, renderer features, or build configuration. Do not install or register every capability.

Translate the requested game into a small capability adoption plan before editing:

```text
Need: <player-visible or production requirement>
Use: <one ForgeaX capability and its owner>
Entry: <focused skill, CLI operation, or package README>
Proof: <test, asset verification, browser evidence, or package output>
Defer: <available capabilities not needed now>
```

| Need | Start with | Proof before claiming it works |
|:--|:--|:--|
| Frame loop, execution tier, input, plugin assembly | `forgeax-engine-app`, then `forgeax-engine-ecs` or `forgeax-engine-state` | Unit/system test plus real browser interaction |
| Scene, imported files, code-first packs, GUID loading | `forgeax-engine-assets`; discover operations through `forgeax-engine-cli` | `asset verify`, build catalog, runtime load by GUID |
| PBR, textures, custom WGSL | `forgeax-engine-material`, then `forgeax-engine-shader` | Shader check, material readiness, browser pixels |
| Lighting, shadows, sky, fog, AA, post effects, custom passes | `forgeax-engine-render-pipeline` | Requested pipeline active and real GPU/browser evidence |
| GPU particles, trails, ribbons, beams | `forgeax-engine-vfx` | Cooked effect, runtime playback, browser pixels |
| Bodies, colliders, character motion | `forgeax-engine-physics` | Fixed-step/collision test plus playable behavior |
| BGM, SFX, spatial audio | `forgeax-engine-audio` | Host playback, intent/cleanup evidence, user gesture handling |
| Black frame, wrong binding, GPU divergence | `forgeax-engine-rhi-debug`; use `forgeax-engine-debug` for symptom routing | One capture artifact, inspect/replay or paired differential |
| Create, inspect, develop, build, preview, package | `forgeax-engine-cli` | Structured command result and final HTTP-served package |

Use [the full capability catalog](references/feature-catalog.md) for less common areas such as animation/skinning, UI/font/video, picking, networking, intelligence, profiler, Remote, custom RenderGraph/RHI work, and source-mode Engine development. Then read only the focused skill and owning package README. The catalog is a discovery index, not a substitute for those precise contracts.

For browser-compositor screenshots, software/hardware backend selection, Engine frame readiness, repeated play-test checkpoints, and local Engine binding, use [the browser capture and local-Engine guide](references/browser-capture-and-local-engine.md).

The normal consumer route is:

```mermaid
flowchart LR
  A[SDK init] --> B[Read onboarding paths]
  B --> C[Create external game]
  C --> D[Choose smallest capability set]
  D --> E[Author code and assets]
  E --> F[Test and asset verify]
  F --> G[Browser dev and visual proof]
  G --> H[Build, preview, package]
```

Run `forgeax list --json`, then `forgeax describe <operation-id> --json`, before guessing authoring-operation inputs. Use the CLI skill for the command boundary. Start the seven-stage ForgeaX closed loop only when the user explicitly authorizes it for the current task.

Successful `new` also performs a two-second, best-effort check of the configured npm registry's `@forgeax/engine-sdk` `latest` tag. Only a strictly newer semantic version produces a text warning; JSON always records `sdkUpdate` as `available`, `current`, `skipped`, or `unavailable`. Offline mode and `FORGEAX_DISABLE_UPDATE_CHECK=1` skip the query, and registry failure never rolls back a created game. Treat the warning as information, not migration authority: install the newer SDK in another directory, read its release notes, then migrate and test each existing game explicitly. Games remain pinned and are never rewritten by SDK discovery.

> [!IMPORTANT]
> A successful build is not acceptance. Verify the exact ZIP that will be distributed; the verifier creates a project, installs from the bundled pnpm store with networking disabled, and runs `new`, `skill verify`, `doctor`, `test`, `build`, `dev`, and `preview`.

## Preflight

Run from the Engine repository root:

```bash
git status --short
node --version
pnpm --version
command -v zip
command -v unzip
```

| Check | Required state | Recovery |
|:--|:--|:--|
| Git | Clean checkout for a distributable archive | Commit the intended Engine state; do not use `--allow-dirty` for Release assets |
| Node | `>=22.13.0` | Select a supported Node installation |
| pnpm | Available to the SDK builder | Enable the repository-declared package manager with Corepack |
| ZIP tools | `zip` and `unzip` on `PATH` | Install the platform ZIP tools |

## Build and verify

```bash
pnpm sdk:build -- --version 1.2.3
pnpm sdk:verify -- --archive artifacts/sdk/forgeax-sdk-v1.2.3.zip
```

Read `artifacts/sdk/sdk-build-result.json` and `artifacts/sdk/sdk-verify-result.json`. Both must contain `"ok": true`; the `engineCommit` values must equal `git rev-parse HEAD`, and the verify result must list all seven commands: `new`, `skill.verify`, `doctor`, `test`, `build`, `dev`, and `preview`.

## Archive surfaces

Every SDK archive contains both of these surfaces:

| Surface | Archive path | Contract |
|:--|:--|:--|
| Built use (full ZIP) | `bin/`, bare `packages/`, `templates/`, `skills/`, `store/pnpm/` | The CLI defaults to the empty template, installs project-local Engine skills, can select game-3d, and creates games without registry access. |
| Built use (npm carrier) | `bin/`, bare `packages/`, `templates/`, `skills/` | The carrier deliberately omits `store/pnpm/` to stay publishable; `new` and `init` use the exact lockfile against the npm registry. |
| Source development | `source/engine/` | A public source snapshot containing the tracked Engine project, `AGENTS.md`, `CLAUDE.md`, README files, `rules/`, and `skills/`, with private submodule inputs removed. |
| Prebuilt WASM | `source/engine/packages/{wgpu-wasm,fbx,codec}/pkg/` and `toolchain/wasm/` | Checked glue and binary outputs remove the default Rust/Emscripten hydration prerequisite. |

The source snapshot is not a nested Git checkout and intentionally excludes
`node_modules`, `.git`, `.gitmodules`, `.forgeax-harness`, and
`forgeax-engine-assets`. It carries `.forgeax-public-distribution`, which makes
`pnpm install`, `pnpm build:engine`, and `bun fx setup` avoid internal repository
hydration. The non-code resource closure is the preview package's explicit
`assets/canonical-kit/{sky.hdr,sky.hdr.meta.json,cook-receipt.json}` allowlist in
`scripts/forgeax/sdk-lib.mjs`. The `game-3d` template needs no copied binary
closure because its analytic sky, materials, meshes, and scene are generated by
tracked `*.pack.ts` sources. The builder copies only the package allowlist into
the source snapshot, and the verifier checks exact equality. The source
project may still install ordinary JavaScript dependencies from its configured
registry; the bundled WASM outputs only remove the separate WASM fetch/compile
step. `sdk-manifest.json` records both resource allowlists, every root skill's
file/byte closure, source file/byte counts, explicit exclusions, and checked WASM paths, while `artifacts` remains
the single per-file inventory.

The verifier exercises both product surfaces: it creates the default
`templates/game-empty` project through `new`, `skill verify`, `doctor`, `test`,
`build`, `dev`, and `preview`, creates `game-3d` through explicit template selection,
then checks the source snapshot's public resource
closure and real Preview-host template smoke separately. The standalone host
consumes project-owned build-time importers declared in
`package.json#forgeax.assets.importers`, while `forgeaxShader` owns WGSL
compilation and the game plugin owns the matching runtime loader.

The full ZIP treats pnpm package payloads under `store/pnpm/` as immutable distribution content. The verifier recomputes those payloads after creating and exercising both templates; `sdk-consumer-mutated-store` blocks content drift. pnpm 11 may hydrate its SQLite `index.db` runtime cache during the first install, so that cache is the only post-extraction digest exception and carries no package authority. The npm carrier intentionally has no store: `findSdkContext()` detects that absence and the bootstrap path runs a frozen, registry-backed install.

Release these sibling files together:

```text
forgeax-sdk-v{version}.zip
SHA256SUMS
forgeax-sdk-v{version}.spdx.json
forgeax-sdk-v{version}.provenance.json
sdk-verify-result.json
```

The build also emits `npm/packages/*.tgz` and
`npm/forgeax-engine-sdk-{version}.tgz`. Run the local contract gate before any
network publication:

```bash
pnpm sdk:publish:npm -- --version 1.2.3 --check-only
```

The check-only gate serves the exact staged tarballs from a local registry and
proves umbrella `dlx` → carrier install → SDK init → both template
new/doctor/test/build/dev paths without publishing.

The release workflow publishes the exact tarballs with `NPM_TOKEN`. Focused
Engine packages are physical dependencies, `@forgeax/engine` is the user-facing
runtime/CLI umbrella, and `@forgeax/engine-sdk` is its on-demand SDK carrier.
Because the source repository and its Releases are private, no public install
path may require a GitHub token.

## Reproducibility check

Build twice from the same clean commit into separate output directories:

```bash
pnpm sdk:build -- --version 1.2.3 --output artifacts/sdk-a
pnpm sdk:build -- --version 1.2.3 --output artifacts/sdk-b
shasum -a 256 artifacts/sdk-a/forgeax-sdk-v1.2.3.zip artifacts/sdk-b/forgeax-sdk-v1.2.3.zip
```

The ZIP digests must match, and the release workflow also compares a sorted
SHA-256 inventory of both `npm/` trees. A mismatch in the ZIP, any physical
package tarball, or the SDK carrier blocks publication.

## Failure routing

| Signal | Owning input | Action |
|:--|:--|:--|
| `sdk-dirty-checkout` | Git source identity | Commit or remove unintended changes |
| `sdk-package-*` | Bare public package directories | Repair package visibility, exports, wrapper removal, or file closure; rebuild |
| `npm-*` | Exact-version npm package set or SDK carrier | Repair version projection, umbrella closure, or carrier bytes; never publish a partial mismatched version |
| `sdk-artifact-mismatch` / `sdk-unmanifested-artifact` | Archive manifest generation | Repair the SDK builder; do not edit the staged archive |
| `sdk-manifest-schema` | `sdk-manifest.schema.json` contract | Repair the producer or schema in one change |
| `sdk-source-file-count` / `sdk-source-byte-count` / `sdk-source-unportable-tree` | Source snapshot materialization | Repair source archival or exclusion rules; rebuild |
| `sdk-source-private-dependency` / `sdk-source-exclusions` | Public source sanitization | Remove submodule metadata or private asset paths from the staged source; rebuild |
| `sdk-resource-allowlist-missing` / `sdk-resource-allowlist-drift` / `sdk-resource-package-drift` | SDK resource closure | Repair the allowlist or the package-owned resource; rebuild and rerun the verifier |
| `sdk-template-resource-missing` / `sdk-template-resource-allowlist-drift` | Full template resource closure | Repair the template allowlist or its package-owned inputs; rebuild and rerun the verifier |
| `sdk-skill-*` / `skill-verify-failed` | SDK root `skills/` or project-local mount projection | Repair the skill source/manifest or rerun `forgeax skill install`; never patch mount copies |
| `sdk-consumer-mutated-store` | SDK-backed pnpm package payloads | Repair package-content mutation; SQLite `index.db` hydration is the only cache exception |
| `npm-sdk-carrier-store-*` | npm carrier surface | Remove `store/pnpm/` from the carrier; keep it in the full ZIP and rebuild |
| `sdk-source-wasm-path` / `sdk-source-wasm-unmanifested` | Prebuilt source WASM closure | Restore the owning package `pkg/` outputs and rebuild |
| `project-target-inside-sdk` | SDK and game ownership boundary | Choose a sibling directory or an absolute path outside the SDK; never turn the distribution into a game workspace |
| `sdkUpdate.status=available` | Public npm `latest` tag | Consider a separate newer SDK install; review release notes and explicitly migrate/test each pinned game before changing Engine versions |
| `project-create-failed` | Offline store/template closure | Repair lockfile/store generation and rerun the verifier |
| `doctor`, `test`, `build`, or `preview` failure | External consumer path | Fix the owning Engine/DevKit layer, rebuild a new ZIP, verify that ZIP |

Do not publish an archive verified before its final bytes were produced. Do not substitute a workspace-linked project for the verifier's extracted offline project.
