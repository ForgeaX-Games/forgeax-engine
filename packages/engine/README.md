# @forgeax/engine

`@forgeax/engine` is the one package a game author installs. Its root is the
runtime entry, its focused subpaths expose every Engine capability, and its
`forgeax` binary owns project creation, validation, development, build, preview,
and SDK installation.

```bash
pnpm add @forgeax/engine
pnpm exec forgeax doctor
```

pnpm projects that use Vite should keep
`public-hoist-pattern[]=@forgeax/engine-*` in `.npmrc`. Generated ForgeaX games
already include it; the focused hoist lets package-owned dynamic imports resolve
from Vite's project-level optimization cache without exposing extra declared
dependencies.

```ts
import { Engine } from '@forgeax/engine';
import { World } from '@forgeax/engine/ecs';
import { Transform } from '@forgeax/engine/scene';
```

## Import model

| Import | Meaning |
|:--|:--|
| `@forgeax/engine` | Runtime renderer assembly and the usual game entry |
| `@forgeax/engine/app` | App and frame-loop assembly |
| `@forgeax/engine/ecs` | ECS world, components, queries, and systems |
| `@forgeax/engine/<package-directory>` | The matching focused Engine package |

The focused `@forgeax/engine-*` packages remain the physical ownership and
release units inside the Engine repository. They are published automatically at
the same version because the umbrella depends on them, but game authors do not
need to discover or install them individually.

## SDK

The ordinary npm package is the connected, incremental development path. The
full SDK adds offline templates, Engine skills, a pnpm store, and the complete
public Engine source snapshot:

```bash
pnpm dlx @forgeax/engine sdk install ~/ForgeaX/1.2.3
node ~/ForgeaX/1.2.3/bin/forgeax.mjs init
node ~/ForgeaX/1.2.3/bin/forgeax.mjs new ~/Games/my-game
```

The SDK is fetched on demand from the public npm registry at the exact same
version. A private GitHub Release is an internal archive, not a user download
dependency.
