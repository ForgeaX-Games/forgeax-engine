# @forgeax/engine

Placeholder for the `@forgeax/engine-*` family of packages. This package
publishes nothing on its own. To use the engine, install the runtime entry
`@forgeax/engine-runtime` and the family members you need.

```ts
import { Engine, World } from '@forgeax/engine-runtime'
```

## Family members

| Package | Role |
|---------|------|
| `@forgeax/engine-runtime` | Renderer + Backend (WebGPU) async factory entry |
| `@forgeax/engine-math` | Pure-function Vec/Mat/Quat/Color, branded ABI |
| `@forgeax/engine-ecs` | Archetype ECS: World / Entity / Component / Query / System / Schedule / Commands / Resource |
| `@forgeax/engine-types` | POD types + union aliases SSOT (math-free) |
| `@forgeax/engine-rhi` | Pure-interface RHI (spec-aligned with `@webgpu/types`) |
| `@forgeax/engine-rhi-webgpu` | WebGPU thin shim |
| `@forgeax/engine-rhi-wgpu` | wgpu native thin shell |
| `@forgeax/engine-wgpu-wasm` | Single wasm artefact (wgpu + naga bindings); private |
| `@forgeax/engine-naga` | TS shell over naga bindings; private (build-time only) |
| `@forgeax/engine-shader` | Runtime shader registry |
| `@forgeax/engine-shader-compiler` | Build-time shader compiler |
| `@forgeax/engine-vite-plugin-shader` | Vite plugin forwarding to shader-compiler |
| `@forgeax/engine-remote` | Remote eval server + CLI (`forgeax-engine-remote`) |

## Family rules

- All public packages share the `@forgeax/engine-` prefix. IDE autocomplete
  on `@forgeax/engine-` lists every family member.
- The bare `@forgeax/engine` name (this package) is a placeholder and not
  intended to be installed by users directly.

## Why this rename?

See `.forgeax-harness/forgeax-loop/feat-20260511-engine-package-family-rename/`
for the closed-loop history and decisions.
