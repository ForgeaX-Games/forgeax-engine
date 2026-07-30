# Game Default

This is ForgeaX's canonical first game: a small four-view target range that teaches scene assets,
ECS behavior, physics, picking, rendering, UiAssets, and spatial audio through one coherent loop.

## Run, inspect, change

From the engine checkout:

```sh
pnpm --filter @forgeax/preview dev
```

Open `http://localhost:5173/?game=game-default` in a WebGPU browser. Start with
`assets/scene.pack.json` for persistent world content. Start with `src/scene-runtime.ts` for scene
loading, fallback, and physics attachment. `main.ts` composes those boundaries with input, camera,
and gameplay systems (top-down, fixed-radius orbit, FPS/free-flight, and bounded orthographic Map); `src/camera-orbit.ts`, `src/camera-zoom.ts`, and `src/free-camera.ts` own the
canonical spherical pose math; `src/gameplay-input.ts` owns the InputSnapshot-to-intent systems;
`src/gameplay-lifecycle.ts` owns the reset request; `src/hud.ts` and `src/settings.ts` own the
DOM-facing UiAssets; `src/gameplay-audio.ts` owns the GUID-loaded hit SFX and AudioSource edge loop;
`src/hit-flash.wgsl` plus `src/hit-flash-material.ts` demonstrate the build-time/runtime custom
material shader boundary. The authored `YellowPillar` also demonstrates the same boundary with
`src/animated-target.wgsl`: Preview registers a schema-driven `time` uniform, the Play update writes
it, and `R` restores the authored material object exactly. The canonical standalone shader gallery
remains `apps/bevy/animate-shader`; this template keeps one animated target in the existing game.
`src/change-detection.ts` composes ECS `Added`/`Changed` filters and resource change ticks with the
existing target hit/reset loop; the score resource is the single numeric source projected to the HUD,
while `apps/bevy/change-detection` remains the canonical isolated matrix. The settings panel also
demonstrates `Camera.clearColor` as a live preset (`Sky blue`/`Purple`) over the authored scene;
`apps/bevy/clear-color` remains the canonical empty-scene toggle. The authored `BlueBall` also gets
a private `MaterialAsset` clone with standard PBR clearcoat parameters in `src/clearcoat-material.ts`;
it keeps the same physics, scoring, hit-flash, and reset loop, while `apps/bevy/clearcoat` remains the
canonical coated-versus-uncoated contrast.

Depth of field is the template's first depth-aware fullscreen post-process. `src/depth-of-field.ts`
registers the authored WGSL pass through the public `Renderer.postProcess` and `PostProcessParams`
boundaries, composes it into the existing URP pipeline, and exposes a reset-safe Bokeh toggle in the
settings UiAsset. The render-evidence smoke proves that the effect changes compositor pixels and that
off/on/reset state remains owned by one gameplay settings path; `apps/bevy/depth-of-field` remains the
isolated focal-distance/aperture reference.

The authored hit loop also composes `src/chromatic-aberration.ts` and
`src/chromatic-aberration.wgsl` as a transient fullscreen material. `triggerFlash()` writes a
short-lived intensity through `PostProcessParams`, the Play system decays it, and `R` restores zero.
The effect is installed after DoF as an ordered URP post-effect, so the template demonstrates
multiple fullscreen passes without adding a second scene; `apps/bevy/fullscreen-material` remains
the standalone chromatic-shader oracle.

The Play shooting system also demonstrates the ECS `CommandBuffer` boundary: bullets are spawned and
expired through deferred commands, while `commands.isDeferred` prevents same-system Transform writes
against pending handles. The synchronous `R` reset remains the gameplay owner's cleanup boundary, and
the render-evidence smoke records the deferred spawn count after a deterministic canvas shot (manual
play still uses `F`).

Target health is the template's dense ECS example: `src/target-health.ts` attaches one
`GameDefaultTargetHealth` component to each authored target, runs its writable `current/max/Entity`
columns through `queryRunContiguous`, applies hit damage with `world.set`, and restores all rows on `R`.
The render-evidence snapshot proves the contiguous capability and row-shape invariant; the canonical
32-row health grid remains in `apps/bevy/contiguous-query`.

Structural lifecycle is paired with that health owner in `src/target-disabling.ts`: when a target
reaches zero health, the template adds the ECS `Disabled` marker. Ordinary target queries then omit
the row while an explicit `[TargetDisabling, Disabled, Entity]` query supplies the witness; reset
removes the marker from the original target identities before restoring health. This teaches the
difference between structural disabling and merely hiding a mesh, while keeping the canonical
`apps/bevy/entity-disabling` timeline as the isolated query oracle.

The authored HDR sky follows the same asset path. Preview registers the image importer, while
`src/asset-content-evidence.ts` provides an opt-in browser witness for GUID loading, skybox
application, reload/reset churn, and structured missing-asset recovery:

```sh
FORGEAX_ASSET_LOOP_DIR=<run>/artifacts \
  pnpm --filter @forgeax/preview smoke:asset-loop
```

The fired projectile is also the custom-mesh lesson. `src/custom-projectile-mesh.ts` builds a
24-vertex indexed cube with position/normal/UV/tangent attributes, uploads a procedural checker
texture, and exposes `G` to mutate the shared GPU mesh between the upper and lower atlas halves.
The projectile keeps a capsule collider so rendering and physics are separate public contracts;
`R` restores the mesh bytes and removes active projectiles. The canonical standalone correctness
matrix remains `apps/bevy/generate-custom-mesh`.

The same semantic `InputMap` accepts a standard gamepad without adding a second input owner:
left-stick axes move, South jumps, R2 fires, Y toggles the projectile UV atlas, and East requests
reset. `InputSnapshot.gamepad(0)` is frozen at the frame-start scan, so browser evidence can inspect
the exact button/trigger/axis state while normal gameplay systems consume the same actions. Run the
focused proof with `pnpm --filter @forgeax/preview smoke:gamepad`.

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
