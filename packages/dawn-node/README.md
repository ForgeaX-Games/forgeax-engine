# Engine Dawn Node carrier

Node consumers import `@forgeax/engine-dawn-node` directly. This physical package retains the official
`webgpu@0.4.0` `create`, `globals`, and `isMac` exports. Browser WebGPU remains owned
by the browser and does not use this Node carrier.

| Host | Provider | Native preparation |
| --- | --- | --- |
| macOS arm64 | Pinned Dawn with the Metal empty-compute timestamp patch | Host arm64 source build |
| macOS x64 | Same pinned source and patch | Host x86_64 source build; validation pending |
| Linux / Windows | Exact upstream `webgpu@0.4.0` | Upstream installation contract |

## Build and installation

The public JavaScript and declaration exports point to checked-in `src` files, so
`--ignore-scripts` installations can resolve the carrier before a package build.
`pnpm build` also copies those files into `dist`, then runs
`scripts/prepare-native.mjs`. The same native producer runs on package installation.
macOS import requires its prepared host native library in `dist/native`; Linux and
Windows use the exact upstream provider without a local facade build.
It uses official node-webgpu commit `2f5fb632d9d9db9bcb3705bd868de69a6a2ae4e2`
and Dawn commit `c5d549e250b9225744929ae860b369cb4304a767`, verifies the checked-in
patch and all three changed source files, and builds the current host architecture.
Native binaries and build caches are generated and must not be committed.

macOS preparation requires Git, Python 3, CMake, Go, Xcode's compiler and SDK, and
network access for official pinned dependencies. Official depot_tools supplies Ninja.
SwiftShader is excluded from the macOS source preparation through official gclient
`custom_deps`; the Metal implementation and original test budgets are unchanged.

`FORGEAX_DAWN_NATIVE_SOURCE_DIR` selects an existing official source checkout for
local preparation; both pinned Git revisions and every patched source byte are
validated. `FORGEAX_DAWN_NATIVE_BUILD_DIR` selects its own CMake output directory.
Neither option substitutes another native library. The producer records a derived
input key and binary digest beside the host native output for cache admission.

## Verification boundary

- [ ] Ordinary canonical provider import bound to this package's native library.
- [ ] Original timestamp regressions and relevant completed 60-frame smoke.
- [ ] Complete Engine hello/learn-render, browser, and Dawn gates.
- [ ] Supported-platform release and SDK consumer closure.

The earlier patched 0.6.2 diagnostic passed four timestamp cases. It does not
establish acceptance of this default 0.4 carrier, image quality, or frame rate.
