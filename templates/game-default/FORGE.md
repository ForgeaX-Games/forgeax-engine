# Game Default

This is ForgeaX's canonical first game: a small two-view target range that teaches scene assets,
ECS behavior, physics, picking, rendering, and UiAssets through one coherent loop.

## Run, inspect, change

From the engine checkout:

```sh
pnpm --filter @forgeax/preview dev
```

Open `http://localhost:5173/?game=game-default` in a WebGPU browser. Start with
`assets/scene.pack.json` for persistent world content. Start with `src/scene-runtime.ts` for scene
loading, fallback, and physics attachment. `main.ts` composes those boundaries with input, camera,
and gameplay systems; `src/gameplay-input.ts` owns the InputSnapshot-to-intent systems;
`src/gameplay-lifecycle.ts` owns the reset request; `src/hud.ts` and `src/settings.ts` own the
DOM-facing UiAssets.

After a change, run the browser smoke and the derived capability audit from the engine root:

```sh
pnpm test:browser
pnpm game-default:audit -- --output /tmp/game-default-capability-audit.json
```

During Play, press `R` to reset the player, dynamic props, bullets, score, camera, view mode, and
input intent to the authored starting state. This is the smallest complete reset path to extend
when adding another gameplay-owned resource.

The local `AGENTS.md` is the detailed contract. If a requested feature does not fit the current
engine boundary, fix the deepest owner or document the routed gap before adding a template-only
shim.
# UI consumer boundary

The default template consumes HUD and settings UiAssets from the assets submodule. Keep stable markup and style in the `.ui.html`/`.ui.css` author sources and use `src/hud.ts` or `src/settings.ts` only for dynamic values, event ownership, modal focus, and cleanup. UI screenshots are auxiliary evidence; DOM assertions and lifecycle behavior remain the acceptance source of truth.
