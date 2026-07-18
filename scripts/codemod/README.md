# scripts/codemod — engine package family rename

Atomic codemod producing the `@forgeax/engine-*` family rename of feat-20260511-engine-package-family-rename. Idempotent, ASCII-only, single-commit.

## Files

- `rename-map.json` — SSOT dictionary (14 entries). Array order is **significant**: the bare `@forgeax/engine` entry is last so that processing happens after all `@forgeax/engine-<member>` substring collisions have been avoided by earlier rewrites or look-ahead anchoring (see below).
- `check-tools.sh` — entrance tool check (node, jq, rg). Exits 1 with install hints if anything missing.
- `rename-engine-family.sh` — main entrypoint. Runs phases A..G sequentially under `set -euo pipefail`.
- `transforms/rename-imports.cjs` — jscodeshift transform for TS/JS imports (AST literal equality).
- `phases/phase-*.sh` — sub-scripts per phase. Each is independently runnable for debugging.
- `verify-ac.sh` — runs the 13 automated AC checks (the oracle invoked in M6).

## Phase order

A package.json names + deps (jq)
E tsconfig.json references (jq) — removes `./packages/core`
F console bin rename (jq) — `forgeax` → `forgeax-engine-console`
G placeholder takeover (git mv) — moves engine src out to engine-runtime, rewrites engine/ placeholder
B TS/JS imports (jscodeshift literal equality)
C TS/JS non-import strings (node + look-ahead-aware regex)
D JSON / MD / YAML (node + look-ahead-aware regex; jq for `todos.json` schema-aware)

A precedes G (A writes the new `@forgeax/engine-runtime` name into `packages/engine/package.json`, then G moves the directory).
B/C/D follow A/E/F/G so we never rewrite already-moved content.

## Idempotency

Every phase only writes when the source content changes. Re-running the main script after a successful run yields `git diff --quiet` exit 0 (AC-16).

## Bare `@forgeax/engine` substring protection (R-3)

Three defensive layers, per plan-strategy §2:

1. **AST literal equality** (phase B / jscodeshift): import strings are matched as `node.source.value === '@forgeax/engine'`. Never substring-matches `@forgeax/engine-math`.
2. **Look-ahead regex** (phase C / D, node): the bare-engine rewrite uses `@forgeax/engine(?![-\w])`. Rust's `regex` crate (and therefore `sd`) has no look-around, so we use Node — Node's JS regex supports `(?!...)` natively. This is also the rationale for **not** using `sd` in this implementation despite the plan-strategy mentioning it; see `implement-decisions.md` D-N1.
3. **Idempotency rerun** (M6): rerun the main script, expect `git diff --quiet`. Any drift = silent substring corruption.

## Tools

Hard requirements (script will exit 1 with hint if missing):

- `node` (>=22, already in `package.json#engines`)
- `jq` (system; macOS + Ubuntu runners both ship it)
- `rg` (ripgrep; used for verification / preview)
- `jscodeshift` (npm devDep, installed into root `node_modules/.bin/` via M1)

Not used (despite the plan mentioning):

- `sd` — Rust `regex` crate does not support look-around. The bare-engine rewrite needs a negative look-ahead, so we use Node instead. The dependency was dropped; see D-N1.
