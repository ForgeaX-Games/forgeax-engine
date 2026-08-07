# Game Default

This is ForgeaX's canonical first game: a small target-range mission that teaches scene assets,
ECS behavior, physics, picking, rendering, UiAssets, spatial audio, and a host-defined asset plugin
through one coherent loop. Real projectile hits must earn Score 50 before the collapsed Asset Lab
unlocks `Target profile`; applying the profile turns the RedBox into a moving precision target, and
one real projectile hit on that target finishes the third mission step. The same panel names four optional
asset outcomes—JPEG target, WebM panel, PNG projectile, and TTF score text—without making the player
memorize a hotkey wall; their legacy keys (`P`, `L`, `M`, `N`, `Y`) remain available for keyboard play.
Every variation changes the existing target-range world and the `R` key visibly restores the authored
RedBox baseline. The default HUD also teaches two gameplay decisions: `F`/click fires immediately,
while holding `C` starts the authored charge VFX and releasing it fires a larger, higher-impact shot;
consecutive real hits inside the visible Combo window raise the multiplier, and waiting lets it expire.

## Run, inspect, change

From the engine checkout:

```sh
pnpm --filter @forgeax/preview dev
```

Open `http://localhost:5173/?game=game-default` in a WebGPU browser. Start with
`assets/scene.pack.json` and `assets/multi-material-target.pack.json` for persistent world content.
The `RedBox` mesh uses two positional material slots, so its triangle-list body and line-list accent
are the first multi-primitive asset recipe in the template. Start with `assets/plugins/scene-runtime.ts` for scene
loading, fallback, and physics attachment. `main.ts` is only the stable entry; `assets/plugins/bootstrap.ts`
assembles the asset-resident plugin bundle, while `assets/plugins/systems/gameplay.ts` wires the named
input, camera, movement, projectile, feedback, and camera-follow systems (top-down, fixed-radius orbit,
FPS/free-flight, and bounded orthographic Map).
`assets/plugins/bootstrap.ts` is intentionally only an 18-line host phase coordinator. Its three
neighbors make the assembly map explicit: `gameplay-targets.ts` owns the target roster and GUID-backed
asset plugins, `gameplay-session.ts` owns the one-shot runtime capabilities and reset transaction, and
`gameplay-wiring.ts` registers projections and systems. The guided profile/JPEG/WebM paths are part of
the normal game, while the built-in mesh, FBX, glTF, and imported-skin comparisons are created only by
`?asset-evidence=1` or `?render-evidence=1`. This keeps a copied game teachable without making a
canonical-only gallery pay for cold-start setup or turning the entrypoint into a second gameplay system.
The cold-start HUD also names the authored primary `RedBox`, projects its ECS-owned health and
points (`assets/plugins/target-status.ts`). That cue is part of the playable target encounter, not an
inspection witness: after a hit the same card changes to the target's damaged health while the existing
world-space score, audio, VFX, and mission progress provide the consequence.
`assets/plugins/camera-orbit.ts`, `assets/plugins/camera-zoom.ts`, and `assets/plugins/free-camera.ts` own the
canonical spherical pose math; `assets/plugins/systems/camera-input.ts`, `assets/plugins/systems/camera-follow.ts`,
and `assets/plugins/systems/player-movement.ts` own the named ECS systems; `assets/plugins/components/gameplay.ts`
is the runtime state contract, so camera/player/projectile/flash/reset data is discoverable through the World;
`assets/plugins/gameplay-input.ts` owns the InputSnapshot-to-intent systems;
`assets/plugins/gameplay-lifecycle.ts` owns the reset request; `assets/plugins/hud.ts` and `assets/plugins/settings.ts` own the
DOM-facing UiAssets; `assets/plugins/gameplay-audio.ts` owns the GUID-loaded hit SFX and AudioSource edge loop;
`assets/shaders/hit-flash.wgsl` plus `assets/plugins/hit-flash-material.ts` demonstrate the build-time/runtime custom
material shader boundary. The authored `YellowPillar` also demonstrates the same boundary with
`assets/shaders/animated-target.wgsl`: Preview registers a schema-driven `time` uniform, the Play update writes
it, and `R` restores the authored material object exactly. The canonical standalone shader gallery
remains `apps/bevy/animate-shader`; this template keeps one animated target in the existing game.
`assets/plugins/change-detection.ts` composes ECS `Added`/`Changed` filters and resource change ticks with the
existing target hit/reset loop; the score resource is the single numeric source projected to the HUD,
while `apps/bevy/change-detection` remains the canonical isolated matrix. The settings panel also
demonstrates `Camera.clearColor` as a live preset (`Sky blue`/`Purple`) over the authored scene;
`apps/bevy/clear-color` remains the canonical empty-scene toggle. The authored `BlueBall` also gets
a private `MaterialAsset` clone with standard PBR clearcoat parameters in `assets/plugins/clearcoat-material.ts`;
it keeps the same physics, scoring, hit-flash, and reset loop, while `apps/bevy/clearcoat` remains the
canonical coated-versus-uncoated contrast.

Depth of field is the template's first depth-aware fullscreen post-process. `assets/plugins/depth-of-field.ts`
registers the authored WGSL pass through the public `Renderer.postProcess` and `PostProcessParams`
boundaries, composes it into the existing URP pipeline, and exposes a reset-safe Bokeh toggle in the
settings UiAsset. The render-evidence smoke proves that the effect changes compositor pixels and that
off/on/reset state remains owned by one gameplay settings path; `apps/bevy/depth-of-field` remains the
isolated focal-distance/aperture reference.

The authored hit loop also composes `assets/plugins/chromatic-aberration.ts` and
`assets/shaders/chromatic-aberration.wgsl` as a transient fullscreen material. `triggerFlash()` writes a
short-lived intensity through `PostProcessParams`, the Play system decays it, and `R` restores zero.
The effect is installed after DoF as an ordered URP post-effect, so the template demonstrates
multiple fullscreen passes without adding a second scene; `apps/bevy/fullscreen-material` remains
the standalone chromatic-shader oracle.

Hit feedback also demonstrates world-space MSDF text. `assets/plugins/world-score-text.ts` keeps one pooled
`GlyphText`, loads the legacy baked DejaVu `FontAsset` by GUID, and can switch that same entity with
`Y` (or the `TTF score text` button) to a second stable GUID produced from the licensed `DejaVuSansMono.ttf` by the public `font`
importer/plugin. Preview registers `fontImporter`, delivers the TTF source through the Pack-v2
catalog, and keeps the legacy pack as the comparison baseline. The named guided action changes the
same hit consequence: the imported TTF handle uses its own GlyphText metrics plus a larger cyan
presentation, and the next real score reports `imported glyph metrics on scored hit`; `R` restores
the yellow legacy label. This teaches source TTF → declared sub-asset GUIDs → MSDF bake/importer →
runtime FontAsset without copying the hello-text gallery or adding another scene. The DOM score popup
remains the screen-space UI example, so the two text contracts are visible together without creating
a second score owner. `apps/hello/text` remains the pre-baked MSDF renderer oracle, while
`apps/hello/m2-content-pipeline` remains the source-reimport/Worker recovery oracle.

The Play shooting system also demonstrates the ECS `CommandBuffer` boundary: bullets are spawned and
expired through deferred commands, while `commands.isDeferred` prevents same-system Transform writes
against pending handles. The synchronous `R` reset remains the gameplay owner's cleanup boundary, and
the render-evidence smoke records the deferred spawn count after a deterministic canvas shot. `F` (or
click) fires immediately; holding `C` builds the ECS-owned `ChargeShot` component, updates the
authored HUD charge meter, and starts the authored Pack charge effect, then releasing fires the same
projectile owner with a larger mesh and scaled score/health consequence. `R` clears the charge state,
meter, and VFX through the existing reset transaction.

The same projectile path now has a compact player-facing scoring loop. `assets/plugins/hit-streak.ts`
stores `HitStreak` on the player, records consecutive target-feedback hits for 1.65 seconds, and
caps the multiplier at `x2.75`. The awarded points are used by the existing change-detection score,
target-health, world-text, popup, VFX, and spatial-audio owners, so the second hit is visibly worth
more without adding a second score or damage authority. Its `Update` system owns expiry and the HUD
shows `ready`, `active`, and `expired`; `R` resets the same component through the normal lifecycle.

The gameplay state is deliberately ECS-shaped. `GameplayInput`, `PlayerMotion`, `FreeCameraMotion`,
`CameraRig`, `Projectile`, `HitFlash`, `ProjectilePolicy`, `ResetPose`, and `TargetPresentation` are
the named component contracts; `gameDefaultGameplayConfig`, `gameDefaultSettings`, and
`gameDefaultCommandCounters` are named World resources. Health, disabling, change-detection, and state
witnesses use the same resource boundary. The system files under `assets/plugins/systems/` consume and
write those contracts. A query result array is only a frame-local traversal view, never a second owner
for pose, bullets, flash timers, camera mode, authored material slots, or reset state.

For the shipped path, run `pnpm --filter @forgeax/preview smoke:render-evidence-production`. It builds
Preview and runs the same render-evidence owner from `dist/`/`vite preview`, covering the authored
FBX/compressed-texture/material/post-process/camera/hit-reset/recovery composition without a second
gameplay owner.

For shipped GPU recovery, run `pnpm --filter @forgeax/preview smoke:device-loss-reentry-production`.
It builds `dist/`, crashes Chrome's GPU process, calls public `Renderer.recover()`, and checks the
same `Play` projection, advancing fixed ticks, visible frame, and zero unexpected errors after
`alive → device-lost → alive`.

The companion also starts the charge VFX through the inspection action before the crash, so this one run proves the
late-installed particle RenderFeature's shader prewarm, Pack GUID continuity, ready billboard + mesh
buckets, and `R` reset cleanup across recovery in the production host.

Target health is the template's dense ECS example: `assets/plugins/target-health.ts` attaches one
`GameDefaultTargetHealth` component to each authored target, runs its writable `current/max/Entity`
columns through `queryRunContiguous`, applies hit damage with `world.set`, and restores all rows on `R`.
The render-evidence snapshot proves the contiguous capability and row-shape invariant; the canonical
32-row health grid remains in `apps/bevy/contiguous-query`.

The target roster is ECS-owned as well. `assets/plugins/scoring-target.ts` keeps one active query and
one explicit `Disabled` query, exposing only derived entity traversals to systems that need the full
reset set. No bootstrap-local target array survives a disable/re-enable transition.

Structural lifecycle is paired with that health owner in `assets/plugins/target-disabling.ts`: when a target
reaches zero health, the template adds the ECS `Disabled` marker. Ordinary target queries then omit
the row while an explicit `[TargetDisabling, Disabled, Entity]` query supplies the witness; reset
removes the marker from the original target identities before restoring health. This teaches the
difference between structural disabling and merely hiding a mesh, while keeping the canonical
`apps/bevy/entity-disabling` timeline as the isolated query oracle.

The same target also demonstrates the render-owned `Visibility` component through
`assets/plugins/visibility-loop.ts`. The focused inspection action toggles explicit `hidden`/`visible` intent; the target
remains a physics body, pick candidate, scored target, and possible `Disabled` row, so this is
not a second lifecycle path. `R` restores `inherited`, while the render-evidence and Preview
snapshot report the author intent, resolved effective state, resolution source, and renderer's
explicit-hidden count. `apps/hello/entity-visibility` remains the canonical hierarchy and
shadow-participation oracle; game-default keeps only the gameplay-sized composition.

The authored HDR sky follows the same asset path. Preview registers the image importer, while
`assets/plugins/asset-content-evidence.ts` provides an opt-in browser witness for GUID loading, skybox
application, reload/reset churn, and structured missing-asset recovery:

```sh
FORGEAX_ASSET_LOOP_DIR=<run>/artifacts \
pnpm --filter @forgeax/preview smoke:asset-loop
```

The Asset Lab is the guided content front door. `assets/plugins/asset-lab-actions.ts` is the single
action router used by both the named HUD buttons and the legacy keyboard bindings; `assets/plugins/hud.ts`
owns only presentation and the status slot. The five controls therefore teach real plugin paths without
creating a second asset registry, format gallery, or reset owner. Each result is reported as `active`
or `restored` in the same panel, and the shared `R` transaction returns all five paths to the authored
RedBox baseline. The PNG projectile entry is outcome-oriented: enable it, fire once, and the status
confirms the animated projectile reached the normal hit/score/VFX/audio path. The TTF entry is also
outcome-oriented: enable it, land one real score, and the world-space label visibly switches to the
imported font presentation before `R` restores the authored label.

`L` (or the `JPEG target` button) is the guided JPEG image lesson. Preview includes the exact `wood-container.jpg.meta.json`
sidecar from `forgeax-engine-assets/demo-assets/hello-sprite`; `assets/plugins/jpeg-texture-swap.ts` loads
the cooked `TextureAsset` by GUID, clones the existing RedBox `MaterialAsset` slots with
`baseColorTexture`, and keeps the authored mesh, line-list accent, collider, hit, score, and
Visibility owners intact. The render-evidence and `game-default.snapshot` projections expose the
source name, dimensions, format, color space, and swap count. `R` restores the authored material
array, so the JPEG path teaches source → sidecar → image importer → pack-index → runtime material
delivery without adding a second scene or a decoder in game code. `apps/hello/sprite` remains the
deeper 2D texture/sort oracle.

`M` (or the `WebM panel` button) is the guided runtime-video lesson. Preview serves the licensed
`forgeax-engine-assets/demo-assets/hello-video-cutscene/cutscene.webm` from Vite's `publicDir`;
`assets/plugins/video-texture-panel.ts` catalogs a runtime-only `VideoAsset { kind: 'video', url }`, loads it
through the default video loader, creates a `VideoPlayer` quad with a video-backed MaterialAsset,
and registers a host-owned `VideoElementProvider`. The panel follows the existing scored target and
faces the active camera. After the panel is enabled, a real scored hit calls the same `VideoPlayer`
owner to seek the WebM to the authored `0.35s` hit playhead, replay it, and report the hit context in
the Asset Lab status; the snapshot exposes the reaction count and playhead. This is intentionally not
a new WebM importer or Pack sidecar: the engine's video contract keeps bytes and DOM lifecycle at the
host boundary. `game-default.toggle-video-texture` and `M` toggle the panel; `R` pauses, hides,
rewinds, and clears the hit context, while Stop removes the provider and disposes the `<video>` element.
The focused canonical upload and cutscene oracles remain
`apps/hello/video-texture` and `apps/hello/video-cutscene`.

`P` (or the `Target profile` button after Score 50) is the host-plugin lesson. Before the threshold,
the authored button is disabled and the shared action adapter returns `unavailable`; keyboard, HUD,
and inspection callers therefore cannot bypass the player-facing mission. `assets/target-profile.json` and its sidecar declare a
`game-default-target-profile` GUID; `apps/preview/vite.config.ts` injects the matching importer,
while `main.ts` registers the runtime loader and loads the profile through `AssetRegistry`. The
profile applies a visible target tint, doubles the existing score value, and supplies the RedBox's
precision rotation speed through the existing `GameDefaultRotatable` ECS component;
`game-default.toggle-target-profile` and `R` provide the reversible action/reset path. The
`smoke:mission-progression` dev/production pair proves real hits → unlock → profile → precision hit → reset. This is the
complete custom source → sidecar/GUID → pluginPack importer → Pack v2 → loader → gameplay chain,
adapted from `apps/hello/custom-importer` without importing its unrelated reel-machine scene.

`N` (or the `PNG projectile` button) is the first atlas-animation asset lesson. Preview adds the `hello-sprite-atlas` directory to
the existing `pluginPack` roots, so `walk.atlas.png.meta.json` is handled by the standard image
importer and its GUID resolves to a cooked `TextureAsset`. `assets/plugins/sprite-atlas-loop.ts` projects the
four regions from the companion `walk.atlas.json` build-time text channel into the public
`SpriteAnimation` + `SpriteRegionOverride` components on the same fired projectile. The engine's
`spriteAnimationTickSystem` advances frames; `game-default.toggle-sprite-atlas` (or `N`) turns the
representation on for newly spawned shots, while `game-default.snapshot.spriteAtlas` proves the
GUID, payload format, current frame, tracked entity count, animated-shot count, and animated-hit
count. The status slot confirms a real atlas projectile hit, while hit/score, physics, audio, and
`R` reset remain the existing owners. `apps/hello/sprite-atlas` stays the
10,000-entity fold/performance oracle; this template intentionally composes one animated shot
instead of copying its gallery. If named atlas metadata becomes a runtime requirement, add a
narrow host importer/plugin rather than parsing source JSON in the player.

The fired projectile is also the custom-mesh lesson. `assets/plugins/custom-projectile-mesh.ts` builds a
24-vertex indexed cube with position/normal/UV/tangent attributes and uploads a deterministic
procedural checker texture. `G` mutates the shared GPU mesh between the upper and lower atlas halves
and `R` restores the mesh bytes and removes active projectiles. The projectile keeps a capsule
collider so rendering and physics are separate public contracts. Authored image import and texture
compression remain owned by their focused canonical apps rather than making every copied game
depend on a generated, gitignored source asset. Render evidence can compare that PBR mesh with an
unlit `forgeax::sprite` quad and `forgeax::sprite-lit` using the existing authored
DirectionalLight and PointLight; the same input, physics, scoring, audio, inspection, and reset owners
remain in play. The canonical standalone custom-mesh correctness matrix remains
`apps/bevy/generate-custom-mesh`.

The authored `RedBox` is the multi-material/submesh lesson. Its separate
`assets/multi-material-target.pack.json` carries one GUID-addressed 12F mesh with a filled
triangle-list submesh and a line-list accent, plus red/cyan `MaterialAsset` rows. The scene binds
`materials[0..1]` to `submeshes[0..1]`; `triggerFlash()` changes only slot 0 so the cyan accent remains
visible, and the same `R` owner restores the complete material array. The browser render-evidence
snapshot reports the material/submesh counts and topologies before, during, and after reset. The
isolated positional/mixed-topology oracle remains `apps/hello/multi-material`.

The template also composes a secondary ECS World without creating a second
renderer or requestAnimationFrame loop. `assets/plugins/multi-world-overlay.ts` creates
two small beacons with their own material handles; `App.setDrawSource` routes
`[primaryWorld, overlayWorld]` through the existing camera and lights. The
inspection action `game-default.toggle-multi-world` is a safe falsifier: turning
it off must remove both beacons while leaving the primary gameplay scene alive,
`R` restores the documented two-world baseline, and Stop removes the routing.

```mermaid
flowchart LR
  P["Primary World: camera + lights + gameplay"] --> A["App frame loop"]
  O["Secondary World: two beacons"] --> A
  A --> R["renderer.draw worlds, owners 0/0"]
  R --> F["One composited frame"]
```

This is the classic host-composition pattern: each World keeps its own ECS
state and time policy, while the App owns one measured delta and one lifecycle.
Do not add a template-local `requestAnimationFrame`; change the App seam if a
future composition needs another routing policy.

Real projectile hits own the transient VFX asset lesson. `assets/hit-vfx-effect.pack.json` is a
source Pack v2 particle effect with one local billboard emitter and one world-space
mesh emitter; Preview registers the shared VFX native cooker, so the build produces
the canonical runtime program and artifact rather than making the game parse source.
The authored `assets/charge-vfx-effect.pack.json` now participates in the player path: the charge
system starts and stops the same `ParticleEffectPlayer` while the player holds `C`. It keeps the same
materials and mesh but adds continuous-rate scheduling and a box-spawn emitter. Both GUIDs are
loaded by `assets/plugins/vfx-hit-loop.ts` and switched on the same player attached to the existing
scored target. The loop builds one CPU FixedUpdate simulation with the scene-space resolver and
installs one `particleRenderFeature` through the renderer's late `installRenderFeature` seam. A real
projectile hit and `game-default.trigger-vfx-hit` select the finite hit burst; the inspection action
`game-default.trigger-vfx-charge` remains recovery/evidence for that same charge mode. All paths
increment the seed and share the same billboard/mesh output buckets. `R` selects the hit asset, sets
`playing=false`, seed zero, and clears the trigger count. `game-default.snapshot.vfxHit` reports the active
mode/GUID, emitter/alive telemetry, RenderFeature readiness, and structured errors,
making source → cooker → GUID switch → ECS player → simulation → render-feature → reset
inspectable without a second scene or renderer. The focused
`apps/hello/boss-lightning` demo remains the deeper standalone multi-emitter oracle.

The focused browser proof for this composition is:

```sh
FORGEAX_VFX_CHARGE_DIR=<run>/artifacts/vfx-charge \
  pnpm --filter @forgeax/preview smoke:vfx-charge
FORGEAX_VFX_CHARGE_DIR=<run>/artifacts/vfx-charge-production \
  pnpm --filter @forgeax/preview smoke:vfx-charge-production
```

It checks both Pack index rows, positive charge output, charge-to-hit switching,
reset cleanup, and page/console/HTTP diagnostics in dev and production hosts.

The player-loop proof covers the authored Combo path in both hosts:

```sh
FORGEAX_HIT_STREAK_DIR=<run>/artifacts/hit-streak-dev \
  pnpm --filter @forgeax/preview smoke:hit-streak
FORGEAX_HIT_STREAK_DIR=<run>/artifacts/hit-streak-production \
  pnpm --filter @forgeax/preview smoke:hit-streak-production
```

It fires at the isolated authored BouncyBall, observes `x1.00 → x1.25`, waits for ECS expiry,
replays one hit, and verifies the HUD, health reset, score reset, and browser diagnostics.

The focused mesh-swap smoke is the FBX asset-format delivery proof. It explicitly starts Preview with
`?render-evidence=1`, which opts into the comparison-only asset owners. Preview registers the FBX importer and scans the hydrated
`forgeax-engine-assets/vendor/fbx-test/cube.fbx` sidecar; `assets/plugins/fbx-mesh-swap.ts` loads the emitted mesh
sub-asset by GUID and swaps it onto the same authored scoring target. Because `cube.fbx` has one
submesh while `RedBox` teaches two authored material slots, the swap owner derives a one-slot view
while FBX is active and restores the complete authored mesh/material pair on `R`. The existing
collider, hit/score, input, render-evidence, and reset owners stay in place, so this is a format
delivery change rather than a second scene. Built-in sphere and FBX cube comparisons are inspection-only;
normal play keeps the authored target mesh; the imported humanoid is intentionally absent until an
evidence run requests its canonical comparison owner.

The imported `humanoid.fbx` is the canonical skeletal-animation lesson. `assets/plugins/fbx-skinned-target.ts`
loads the scene and its `run` clip by stable GUID, instantiates the `Skin`/`AnimationPlayer` payload,
and joins the existing Play, hit, and reset lifecycle when the evidence query is present. The authored placement is written to the
imported scene root (`scale: [0.03, 0.03, 0.03]`) rather than only to the mesh node: skin palettes
are derived from the joint hierarchy, so root placement keeps the rendered mesh and its joints in
the same coordinate space. `game-default.snapshot` reports the root, skin entity, clip, joint count,
placement, animation time, and hit pulses; the inspection smoke also requires a 72-byte skinned
vertex layout and an indexed FBX draw.

The focused mesh-swap smoke also owns the glTF asset-format comparisons. Preview scans the license-safe Khronos
`khronos-gltf-samples/BoxTextured/BoxTextured.glb` and
`khronos-gltf-samples/BoxTextured/glTF/BoxTextured.gltf` sidecars with `gltfImporter`;
`assets/plugins/gltf-mesh-swap.ts` loads both mesh/material pairs by GUID. The evidence distinguishes the binary GLB
container and embedded Cesium texture from textual glTF source closure with the
external `BoxTextured0.bin` buffer. Both variants replace the same scored RedBox target, while its
explicit physics, hit, score, inspection, and reset owners remain unchanged. The variants are
mutually exclusive with each other, the built-in sphere, and the FBX swap; `R` restores the authored
RedBox mesh and its complete two-slot material array. The public render-evidence snapshot exposes
`glbMeshSwap` and `gltfMeshSwap` independently so browser probes can falsify either delivery path.

The same semantic `InputMap` accepts a standard gamepad without adding a second input owner:
left-stick axes move, South jumps, R2 fires, Y toggles the projectile UV atlas, and East requests
reset. `InputSnapshot.gamepad(0)` is frozen at the frame-start scan, so browser evidence can inspect
the exact button/trigger/axis state while normal gameplay systems consume the same actions. Run the
focused proof with `pnpm --filter @forgeax/preview smoke:gamepad`.

The authored `Player` is also the guided CharacterController example. `assets/plugins/scene-runtime.ts`
attaches a kinematic capsule and `CharacterController`; `main.ts` computes movement intent and jump
gravity, calls `PhysicsWorld.moveAndSlide`, and reads back the resolved `Transform` plus
`grounded`. The scene's static colliders own obstacle behavior, so the template has no duplicate
manual blocker list. FPS free-flight explicitly teleports the same body because KCC owns kinematic
movement in the other views.

Run the focused semantic proof with `pnpm --filter @forgeax/preview smoke:character-controller`.

After a change, run the browser smoke and the derived capability audit from the engine root:

```sh
pnpm test:browser
pnpm game-default:audit -- --output /tmp/game-default-capability-audit.json
```

During Play, press `R` to reset the player, mission progress, target profile, dynamic props, bullets, score, camera, view mode, input
intent, and the player-owned hit AudioSource to the authored starting state. Shoot a target to see
the same hit event drive score, flash, popup, physics, and a spatial `sfx` bus one-shot.

The local `AGENTS.md` is the detailed contract. If a requested feature does not fit the current
engine boundary, fix the deepest owner or document the routed gap before adding a template-only
shim.
# UI consumer boundary

The default template consumes HUD and settings UiAssets from `assets/ui/*.pack.json`. Their stable markup and style live directly in the pack payloads; use `assets/plugins/hud.ts` or `assets/plugins/settings.ts` only for dynamic values, event ownership, modal focus, and cleanup. UI screenshots are auxiliary evidence; DOM assertions and lifecycle behavior remain the acceptance source of truth.

For a shipped-path check, run `pnpm --filter @forgeax/preview smoke:ui-production`. This builds
Preview and proves the two GUID rows, Pack v2 payloads, ShadowRoot interaction, and three clean
Stop/boot cycles from the production `dist/`; `smoke:ui-authoring` is the separate authoring-host
contract.

For an authored HUD change, run `pnpm --filter @forgeax/preview smoke:production-ui-edit`. It edits
the source pack, proves a new production package URL and live score text, and restores the pack after
the baseline/changed/restored cache legs.
