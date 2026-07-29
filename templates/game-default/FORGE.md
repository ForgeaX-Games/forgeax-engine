# Game Default

This is ForgeaX's canonical first game: a small three-view target range that teaches scene assets,
ECS behavior, physics, picking, rendering, UiAssets, and spatial audio through one coherent loop.

## Run, inspect, change

From the engine checkout:

```sh
pnpm --filter @forgeax/preview dev
```

Open `http://localhost:5173/?game=game-default` in a WebGPU browser. Start with
`assets/scene.pack.json` for persistent world content. Start with `src/scene-runtime.ts` for scene
loading, fallback, and physics attachment. `main.ts` composes those boundaries with input, camera,
and gameplay systems (top-down, fixed-radius orbit, and FPS); `src/camera-orbit.ts` owns the
canonical spherical pose math; `src/gameplay-input.ts` owns the InputSnapshot-to-intent systems;
`src/gameplay-lifecycle.ts` owns the reset request; `src/hud.ts` and `src/settings.ts` own the
DOM-facing UiAssets; `src/gameplay-audio.ts` owns the GUID-loaded hit SFX and AudioSource edge loop;
`src/hit-flash.wgsl` plus `src/hit-flash-material.ts` demonstrate the build-time/runtime custom
material shader boundary.

The authored HDR sky follows the same asset path. Preview registers the image importer, while
`src/asset-content-evidence.ts` provides an opt-in browser witness for GUID loading, skybox
application, reload/reset churn, and structured missing-asset recovery:

```sh
FORGEAX_ASSET_LOOP_DIR=<run>/artifacts \
  pnpm --filter @forgeax/preview smoke:asset-loop
```

After a change, run the browser smoke and the derived capability audit from the engine root:

```sh
pnpm test:browser
pnpm game-default:audit -- --output /tmp/game-default-capability-audit.json
```

During Play, press `R` to reset the player, dynamic props, bullets, score, camera, view mode, input
intent, and the player-owned hit AudioSource to the authored starting state. Shoot a target to see
the same hit event drive score, flash, popup, physics, and a spatial `sfx` bus one-shot.

The local `AGENTS.md` is the detailed contract. If a requested feature does not fit the current
engine boundary, fix the deepest owner or document the routed gap before adding a template-only
shim.
# UI consumer boundary

The default template consumes HUD and settings UiAssets from `assets/ui/*.pack.json`. Their stable markup and style live directly in the pack payloads; use `src/hud.ts` or `src/settings.ts` only for dynamic values, event ownership, modal focus, and cleanup. UI screenshots are auxiliary evidence; DOM assertions and lifecycle behavior remain the acceptance source of truth.
