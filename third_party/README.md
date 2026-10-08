# Third-party source

| Source | Maintenance repository | Consumer |
|:--|:--|:--|
| `wgpu/` | Private `ForgeaX-Games/wgpu`, based on `gfx-rs/wgpu` | `packages/rhi-wgpu-native` |

The Engine gitlink is the version authority. The current source retains the
upstream `v30.0.1` dependency graph and adds a macOS 26 Metal timestamp resolve
ordering repair, empty compute sampling and one-row texel-copy stride repair.
It does not include the draft Metal Ray Query fixes.
Browser `wgpu-wasm` retains its independent registry dependency and checked WASM.

## Contributor checkout

Contributors need read access to the maintenance repository. Initialize the
Engine-selected revision with:

```sh
git submodule update --init -- third_party/wgpu
```

Maintainers synchronize upstream and review changes in the maintenance repository,
then update the Engine gitlink and both native Cargo lockfiles together. Run the
native contracts and real GPU cases before accepting a changed implementation.
For a same-version source-only repair, both lockfiles can remain byte-identical
when `--locked` checks of both native manifests validate the unchanged graph.
Do not use a floating branch or `submodule update --remote` in builds.

## SDK source

The SDK builder archives the gitlink's exact commit into
`source/engine/third_party/wgpu/`, retaining upstream licenses. This is an ordinary
source directory without Git metadata. SDK users need neither repository access
nor submodule initialization; rebuilding Rust still requires its toolchain and
ordinary registry dependencies. The manifest records the source commit in
`source.gitDependencies`, and its existing artifact inventory covers every file.

An uninitialized dependency is a build error. Only the explicit SDK source
allowlist is expanded; private binary assets remain excluded. Source archival
uses the committed revision, never a dirty submodule working tree.
