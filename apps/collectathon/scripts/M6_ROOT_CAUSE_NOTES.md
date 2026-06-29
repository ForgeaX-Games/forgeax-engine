# M6 Root-Cause Notes (spike m6-1)

> systematic-debugging spike output. Reproduced the three startup symptoms a human
> hit with `pnpm dev`, against the REAL Vite dev server in headed Chrome+WebGPU
> (the dawn-node smoke and the old wipe-everything browser smoke both miss them).
> No production code is changed by this spike; this file is a hand-off so the
> fix tasks (m6-2 / m6-3 / m6-4) do not have to re-diagnose.

## Reproduction environment

- **App**: `apps/collectathon`, real `vite dev` server (the same `JSON.stringify ->
  fetch -> JSON.parse` pack path + WebGPU validation the dawn smoke skips).
- **Browser**: headed Chrome (channel `chrome`) + WebGPU (`--enable-unsafe-webgpu
  --enable-features=Vulkan ...`), driven by Playwright.
- **Harness**: a throwaway repro script that boots the dev server, navigates with
  `?debug=0` / `?debug=1`, and captures EVERY `console` line + `pageerror` WITHOUT
  any wipe (so the boot-window errors are visible). Run lengths 4s / 8s / 12s / 15s.
- **Builds**: FBX native addon present (`packages/fbx/build/Release/fbx_binding.node`),
  `wgpu_wasm_bg.wasm` present, `forgeax-engine-assets` materialized.

Signature tally over an 8s default (`?debug=1`) boot:

```
render-system-no-camera : 3        (boot window only; finite)
channel-leaf-mismatch   : 3        (warn-once, NOT per-frame)
Resizing vertex buffer  : 10       (1024 -> 1000000, monotone)
MAX_VERTEX_CAPACITY     : 0 @ 8s, 9111 @ 15s  (per-frame flood once cap is hit)
pageerror (uncaught)    : 0
```

Decisive `?debug=0` vs `?debug=1` comparison (8s):

```
?debug=0 : Resizing=0, MAX_VERTEX=0   (no debug-draw, no growth at all)
?debug=1 : Resizing=10, grows to 1e6  (debug-draw is the sole source of growth)
```

---

## Symptom 1 — `render-system-no-camera` (R-12)

### Reproduction
- `?debug=0` or `?debug=1`, fresh boot. Three `[error] RhiError [render-system-no-camera]`
  lines fire at roughly `+2506ms / +2512ms / +2532ms`, then never again
  (`cameraCount` settles at 1, `entityCount` 112).

### Confirmed behavior (vs the plan's inference)
- **It is NOT a hard crash / throw.** Read `recordFrame` in
  `packages/runtime/dist/index.mjs` (`render-system-no-camera`): when
  `activeCameras.length === 0` it FIRES the error to `errorRegistry` and then
  **falls back to `makeZeroCameraFallbackSnapshot()` and keeps rendering** — the
  rAF loop does not unwind. So the engine already degrades gracefully; what the
  human saw as "it crashes on launch" is (a) the loud red console error plus
  (b) the garbled first frames before the camera + scene exist.
- The error is still **surfaced as a browser console error** even though main.ts
  wires `renderer.onError(() => {})`. (`onError` only suppresses the demo's own
  re-log; the errorRegistry path still prints.)

### Root cause (confirmed)
Boot-window draw-before-camera, exactly the D-11 timing window:
1. `main.ts` boots into Title via `setNextStateForce(world, GameState, 'Title')`.
2. Title `OnEnter` calls `setNextState(world, GameState, 'Play')` — a **deferred**
   transition (applied next `transitionStatesSystem` tick).
3. Play `OnEnter` runs `spawnCamera`. So the camera does not exist until ~2-3
   frames after `app.start()`.
4. Meanwhile the frame loop draws every frame. The first ~3 draws run with no
   Camera entity -> three `render-system-no-camera` fires.

**Aggravating factor (also confirmed and a real demo bug):** `main.ts:188`
registers `app.registerUpdate(() => { renderer.draw(world); })`. But the app
frame-loop (`packages/app/src/internal/frame-loop.ts` `tick`) ALREADY calls
`renderer.draw(world)` itself every frame. So the collectathon draws **twice per
frame** — a redundant duplicate draw. Experiment: commenting out the
`registerUpdate(draw)` line dropped the boot-window error count from **3 -> 1**
(one draw per frame instead of two). The `createApp` demos (`hello/cube`,
`hello/character`, `hello/fbx-skin`) never call `renderer.draw` manually; only the
escape-hatch `createRenderer` demos (`hello/gltf`) own their rAF loop and draw.
The collectathon mixes both -> double draw.

### Fix direction for m6-2 (demo-side, OOS-1 clean)
Two complementary changes in `apps/collectathon/src/main.ts`:
1. **Remove the redundant `app.registerUpdate(() => renderer.draw(world))`** — the
   frame loop's built-in draw is the canonical one (matches every other `createApp`
   demo). This halves boot-window errors and removes a per-frame duplicate draw.
2. **Eliminate the no-camera draw window entirely** so the gate sees zero
   `render-system-no-camera`. Cleanest option matching D-11: guard so a camera
   exists before the first draw — e.g. spawn the camera (and the rest of Play) on
   the very first frame instead of after two deferred transitions. The simplest
   robust form: keep the built-in draw but ensure the Play scene (camera included)
   is wired before `app.start()`, OR make the demo's boot enter Play without the
   double-deferral. (Spawning a throwaway Title camera also works but adds a
   concept; prefer collapsing the boot so Play's camera is up on frame 1.)

A unit regression (m6-6) should assert: after the boot sequence a Camera entity
exists before any draw, and the no-camera path is not exercised.

---

## Symptom 2 — `channel-leaf-mismatch joint=Camera / Light 1`

### Reproduction
- Any boot (`?debug=0` is cleanest). Exactly **three** lines at ~`+2532ms`:
  ```
  [advanceAnimationPlayer] entity=27 channel=1025:0 reason=channel-leaf-mismatch joint=Camera ...
  [advanceAnimationPlayer] entity=27 channel=1025:1 reason=channel-leaf-mismatch joint=Light 1 ...
  [advanceAnimationPlayer] entity=27 channel=1025:2 reason=channel-leaf-mismatch joint=Light 1 ...
  ```

### Confirmed behavior (vs the plan's inference)
- **It is NOT "刷屏" / per-frame spam.** Over a 12s run there are still exactly
  **3** lines — `advanceAnimationPlayer` warns **once per offending channel**, not
  every frame. The plan described this as console flood; the real shape is three
  one-time warnings. (The actual per-frame flood the human saw is Symptom 3.)
- The three mismatched channels target nodes `Camera`, `Light 1`, `Light 1` — the
  humanoid.fbx run clip carries animation channels for a Camera and a Light node
  from its authoring scene, which are absent from the player Skin's joint set
  (D-3 derived risk, confirmed). They are harmless (the engine skips them) but the
  D-10 zero-tolerance gate forbids the signature.

### Fix direction for m6-3 (demo-side, OOS-1 clean)
Strip the non-skeleton channels so the warning never fires. The clip is shared
(`HUMANOID_SCENE_GUID` / `RUN_CLIP_GUID`), so do it at load/spawn time in the demo,
not in the engine animation system:
- Preferred: after loading the AnimationClip (or when wiring the AnimationPlayer in
  `spawn-player.ts` / `player-anim.ts`), filter the clip's channels down to the
  ones whose target leaf exists in the player Skin's joint set (drop `Camera` /
  `Light 1`). This keeps the locomotion/idle crossfade (AC-05) fully intact — those
  channels animate human joints, not Camera/Light.
- If the loaded clip is immutable / channel filtering is not exposed, the fallback
  is to clone the clip's channel list minus the non-skeleton leaves before minting
  the handle. Stay in `apps/collectathon` (OOS-1); do not touch
  `advanceAnimationPlayer`.

Verify AC-05 crossfade still reads as a 0.3s ease, not a hard cut, after the strip.

---

## Symptom 3 — debug-draw vertex buffer growth + `MAX_VERTEX_CAPACITY` flood (R-13)

### Reproduction
- `?debug=1` (dev default): the DebugDraw vertex buffer doubles 1024 -> 2048 -> ...
  -> 1000000 over ~7s (10 `Resizing vertex buffer` lines), then once it pins at the
  cap it logs `Vertex count would exceed MAX_VERTEX_CAPACITY=1000000` **every frame**
  (9111 lines in a 15s run). This per-frame flood IS the "刷屏 / 画面乱七八糟" the
  human reported.
- `?debug=0`: **zero** growth, zero resize, zero cap warning. So debug-draw is the
  sole source (R-13 is real, isolated to the debug overlay).

### This is a TRUE leak, not "normal per-frame量 + 日志误读" (R-13 decision settled)
The demo's `debug-overlay` ECS system (`apps/collectathon/src/systems/debug-overlay.ts`)
draws a **constant** number of primitives per frame: 1 player sphere (96 verts) + 12
Core spheres (1152) + 3 Guardian spheres (288) + 3 chase lines (6) + 1 bounds AABB
(24) ~= **1566 verts/frame**. If the buffer were flushed each frame it would plateau
at one frame's worth (~2048). It instead grows without bound -> staging is never
reset -> **`DebugDraw.flush()` is never being called.**

Instrumentation proof: I added a `console.log` at the top of `DebugDraw.flush()` in
`packages/debug-draw/dist/index.mjs` (cleared the Vite dep cache first). Over a full
boot **zero** flush lines printed. flush() is never invoked.

### ROOT CAUSE IS IN THE ENGINE (`packages/runtime`) — OOS-1 boundary, needs authorization

The wiring contract (correct in source): `createApp` calls
`createDebugDrawOnReady` (imported from `@forgeax/engine-runtime/debug-draw-glue`),
which sets a module-level `registeredDebugDraw`. The URP/HDRP pipelines
(`urp-pipeline.ts` / `hdrp-pipeline.ts`) call `attachDebugOverlayPass(graph, getViewProj)`
which, in source (`packages/runtime/src/debug-draw-glue.ts`), reads
`registeredDebugDraw` and calls `dd.flush(...)` from the render-graph
`debug-overlay` pass each frame.

**The built dist breaks this contract via a tsup multi-entry split.**
`packages/runtime/tsup.config.ts` declares THREE entries:
`['src/index.ts', 'src/geometry/index.ts', 'src/debug-draw-glue.ts']`.
Result after build:
- `dist/debug-draw-glue.mjs` (the `./debug-draw-glue` subpath, imported by
  create-app) contains the REAL `attachDebugOverlayPass` + `createDebugDrawOnReady`
  + its own `registeredDebugDraw`. create-app sets `registeredDebugDraw` HERE.
- `dist/index.mjs` (where URP/HDRP pipelines are bundled) contains a SECOND,
  **stubbed** copy:
  ```js
  function attachDebugOverlayPass(graph, getViewProj) {
    graph.addPass("debug-overlay", { reads: [], writes: [],
      execute: (ctx) => { return; } });   // <-- empty: never flushes
  }
  ```
  and the call sites pass only `attachDebugOverlayPass(graph)` (the `getViewProj`
  thunk is gone). tsup dead-code-eliminated the `registeredDebugDraw`-reading body
  because, within index.mjs's module copy, `registeredDebugDraw` is a separate
  variable that is never assigned (create-app writes the glue-entry copy, not this
  one). So there are **two module instances of `registeredDebugDraw`**, and the one
  the pipelines see is always null — and the body was stubbed away entirely.

Net effect: in any consumer that loads `@forgeax/engine-runtime` main entry (i.e.
the browser/dev-server build, and the dawn path too), the render-graph
`debug-overlay` pass is a no-op. flush() never runs. ANY `app.debugDraw.*` push
accumulates forever. This is independent of the collectathon — it affects the
engine's debug-draw browser path generally (e.g. `apps/hello/debug-draw` runtime
mode would leak the same way; it only ships a dawn smoke that does not assert
buffer growth, so it was never caught).

Why nothing caught it before: (1) the collectathon dawn smoke is a bespoke
re-spawn script that never enables debug-draw at all; (2) the old browser smoke
wiped all boot errors; (3) there is no browser smoke for `hello/debug-draw`.

### Fix direction for m6-4 — TWO honest options, both need a human decision

1. **(Correct root-cause fix — ENGINE, OOS-1, NEEDS HUMAN AUTHORIZATION)**
   Fix the runtime build so `index.mjs` uses the real `attachDebugOverlayPass`
   sharing the SAME `registeredDebugDraw` instance create-app sets. Candidate
   approaches (any one, smallest first):
   - Drop `src/debug-draw-glue.ts` from the tsup `entry` array and instead
     re-export `createDebugDrawOnReady` from `src/index.ts`, then point the
     `./debug-draw-glue` package export at the main chunk (or have create-app
     import from the main entry). One module copy -> one `registeredDebugDraw` ->
     pipelines and create-app share it. This is a `packages/runtime` change
     (tsup.config.ts + index.ts + package.json exports), so OOS-1 applies.
   - Or hold the registry in a tiny dedicated leaf module both entries import, so
     tsup cannot duplicate the mutable state.
   This is the AGENTS.md "demo failures route to engine fixes, not workarounds"
   path: debug-draw is genuinely broken in the browser; a demo cannot make the
   engine flush.

2. **(Demo-side fallback only — NOT recommended, hides AC-14)**
   Default debug-draw OFF in dev (`?debug=1` to opt in). This stops the leak
   because the demo stops pushing, but it makes the debug overlay invisible by
   default — which the plan explicitly calls out as "hiding AC-14's showcase
   value" (D-4). It also leaves the engine bug frozen into the demo (the very
   anti-pattern AGENTS.md / charter warn against). Only acceptable as a temporary
   stopgap if the engine fix is declined.

**Recommendation:** authorize the engine fix (option 1). It is small, it is the
real root cause, and without it the m6-5 zero-tolerance e2e gate cannot go green
(it must assert zero `MAX_VERTEX_CAPACITY`) and the debug overlay does not render
at all in the browser.

---

## Cross-symptom summary

| Symptom | Real shape | Root cause | Fix home | OOS-1 |
|:--|:--|:--|:--|:--|
| 1 render-system-no-camera | 3 finite errors, graceful fallback (not a throw) | boot draw-before-camera + redundant double draw | `main.ts` | demo-side OK |
| 2 channel-leaf-mismatch | 3 warn-once (not spam) | humanoid.fbx clip Camera/Light channels | clip channel strip in demo | demo-side OK |
| 3 debug-draw MAX_VERTEX flood | true unbounded leak -> per-frame flood | engine tsup glue-split: `attachDebugOverlayPass` stubbed in `index.mjs`, flush never runs | `packages/runtime` build | **ENGINE — needs human authorization** |

The biggest single contributor to the human's "启动就崩 / 乱七八糟" experience is
Symptom 3 (the per-frame flood + a debug overlay that silently never renders),
whose root cause is in the engine, not the demo.
