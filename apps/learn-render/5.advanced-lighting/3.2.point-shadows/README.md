# Point Shadows

LearnOpenGL section 5.3.2: a point light orbits inside a room and writes a
cube-map shadow through `PointLightShadow`.

## RHI-debug gates

The Dawn-node gate is the semantic witness and falsifier:

```sh
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows smoke:rhi-debug
FALSIFY=no-point-light pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows smoke:rhi-debug
FALSIFY=force-backface-cull pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows smoke:rhi-debug
```

The normal run must read a lit inner cube from the final render target. The
`no-point-light` falsifier removes both `PointLight` and `PointLightShadow` and
must reject the same witness. The `force-backface-cull` falsifier changes the
room material from `cullMode: 'none'` to `back` and preserves the room
visibility countermeasure as an explicit negative path.

The browser gate remains structural because the light orbit is time-dependent:

```sh
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows smoke:browser
```

The room uses a scale of 10 because the built-in cube is unit-sized and one
witness cube reaches `z=-3`; the earlier scale of 5 put that cube behind the
near room wall when the camera started inside the room.
