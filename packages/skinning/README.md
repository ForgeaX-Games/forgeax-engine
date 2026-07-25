# `@forgeax/engine-skinning`

> [!IMPORTANT]
> Owner: skeletal binding and joint resolution. This package is renderer-independent and is optional until a world contains a `Skin` component.

```ts
import { Skin, resolveSkinJoints } from '@forgeax/engine-skinning';

const binding = resolveSkinJoints(world, entity);
if (!binding.ok) {
  // binding.error.code is the recovery key; keep the structured detail.
}
void Skin;
```

| This package owns | Excluded concepts |
|:--|:--|
| `Skin`, joint path binding, skinning error union | Renderer lifecycle, animation playback, material or GPU policy |

`SkinError` is a closed union. Use the `code`, `expected`, `hint`, and `detail` fields from [`src/errors.ts`](src/errors.ts) to recover.

Dynamic hosts load `Skin` and `resolveSkinJoints` from `@forgeax/engine-skinning`; renderer assembly does not provide a compatibility alias.
