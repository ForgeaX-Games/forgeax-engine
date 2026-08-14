---
name: forgeax-engine-sdk
description: >-
  Build and verify the portable ForgeaX browser-game SDK ZIP from an Engine checkout.
  Use when producing a local SDK, preparing GitHub Release assets, checking archive
  reproducibility, or diagnosing offline consumer bootstrap failures.
---

# ForgeaX Engine SDK

> [!IMPORTANT]
> A successful build is not acceptance. Verify the exact ZIP that will be distributed; the verifier creates a project, installs from the bundled pnpm store with networking disabled, and runs `doctor`, `test`, `build`, and `preview`.

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

Read `artifacts/sdk/sdk-build-result.json` and `artifacts/sdk/sdk-verify-result.json`. Both must contain `"ok": true`; the `engineCommit` values must equal `git rev-parse HEAD`, and the verify result must list all five commands.

Release these sibling files together:

```text
forgeax-sdk-v{version}.zip
SHA256SUMS
forgeax-sdk-v{version}.spdx.json
forgeax-sdk-v{version}.provenance.json
sdk-verify-result.json
```

## Reproducibility check

Build twice from the same clean commit into separate output directories:

```bash
pnpm sdk:build -- --version 1.2.3 --output artifacts/sdk-a
pnpm sdk:build -- --version 1.2.3 --output artifacts/sdk-b
shasum -a 256 artifacts/sdk-a/forgeax-sdk-v1.2.3.zip artifacts/sdk-b/forgeax-sdk-v1.2.3.zip
```

The digests must match. A mismatch blocks publication.

## Failure routing

| Signal | Owning input | Action |
|:--|:--|:--|
| `sdk-dirty-checkout` | Git source identity | Commit or remove unintended changes |
| `sdk-package-closure` | Public package manifests and tarballs | Repair package visibility, exports, or dependency closure; rebuild |
| `sdk-artifact-mismatch` / `sdk-unmanifested-artifact` | Archive manifest generation | Repair the SDK builder; do not edit the staged archive |
| `sdk-manifest-schema` | `sdk-manifest.schema.json` contract | Repair the producer or schema in one change |
| `project-create-failed` | Offline store/template closure | Repair lockfile/store generation and rerun the verifier |
| `doctor`, `test`, `build`, or `preview` failure | External consumer path | Fix the owning Engine/DevKit layer, rebuild a new ZIP, verify that ZIP |

Do not publish an archive verified before its final bytes were produced. Do not substitute a workspace-linked project for the verifier's extracted offline project.
