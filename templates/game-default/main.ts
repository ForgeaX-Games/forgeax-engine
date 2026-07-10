// Default game template -- a small lowpoly "vignette" scene + a movable character.
//
// The STATIC scene (ground, sun, props, the character's INITIAL position) is an
// engine-native scene ASSET: `assets/scene.pack.json` (one `kind:'scene'` asset +
// N `kind:'material'` siblings, GUID refs), discovered by GUID via
// `forge.json.defaultScene`. main.ts loads it the SAME canonical way every other
// app does (apps/hello/room, apps/collectathon) -- `loadByGuid<SceneAsset>` ->
// `allocSharedRef` -> `assets.instantiate`. No bespoke pack preprocessing: the
// scene is authored in the CURRENT schema (`entities`, `MeshRenderer.materials`,
// dense localIds), so instantiate resolves refs[]->GUID->handle and builds the
// localId->Entity table itself. What you arrange in ✎ Edit is exactly what loads
// here in ▶ Play. This file adds only the DYNAMIC layer: the camera, WASD/arrow
// movement on the "Player" entity, and the HDR environment.
//
// Every mesh the scene references is now an engine BUILTIN (cube / sphere /
// cylinder), each pre-catalogued by its GUID in AssetRegistry — so the scene's
// recursive ref-load resolves entirely from the builtin catalog with no runtime
// catalog step and no `__import` round-trip.
//
// No `@forgeax/scene` dependency: the pack is a plain engine pack, so the template
// stays self-contained inside the engine workspace.

import {
  Transform, Camera, perspective, quat, Materials, MeshFilter, MeshRenderer,
  SceneInstance,
  TONEMAP_REINHARD_EXTENDED,
  BLOOM_ENABLED, ANTIALIAS_FXAA, PointLight,
  type MaterialAsset, type Handle,
} from '@forgeax/engine-runtime';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { pick } from '@forgeax/engine-picking';
import { createSphereGeometry } from '@forgeax/engine-geometry';

type MatHandle = Handle<'MaterialAsset', 'shared'>;
import { Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { defineSystem, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { BootstrapContext } from '@forgeax/engine-app';
import {
  createInputSnapshot,
  INPUT_MAP_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type ActionConfig,
  type InputSnapshot,
} from '@forgeax/engine-input';
import type { SceneAsset } from '@forgeax/engine-types';
import { installHud, type ViewMode } from './src/hud';

/** Narrowed context for helper functions consuming world + optional assets/app. */
type Ctx = { world: World; assets?: import('@forgeax/engine-runtime').AssetRegistry };

// The scene's GUID (assets/scene.pack.json assets[0].guid; also forge.json
// defaultScene). loadByGuid<SceneAsset>(this) pulls the scene AND recursively
// its refs[] (the material siblings) from the pluginPack pack-index.
const SCENE_GUID = '1036f6f0-d3c2-5f31-9593-3432942d4c93';

interface PackNode { localId: number; components: Record<string, Record<string, unknown>> }

// Environment lighting is DECLARATIVE -- authored in assets/scene.pack.json, not
// installed by code. The scene carries a `Skylight` entity (equirect -> sky.hdr
// GUID via refs[]) + a `SkyboxBackground` entity (same equirect). instantiate
// resolves the equirect GUID->handle synchronously; the render-system record arm
// then projects the equirect->cubemap + IBL lazily and binds it once ready. No
// code-side sky install, no manual cubemap upload call, no WebKit UA guard:
// caps.rgba16floatRenderable is the engine's sole gate -- WebKit/WKWebView whose
// WebGPU lacks that feature falls back to the 1x1 white irradiance cube (solid
// ambient, no skybox) automatically, without poisoning the device. The Skylight
// is live on the first frame (white fallback) and upgrades to full IBL once the
// projection settles -- same behaviour every other declarative scene gets free.

// Load the authored scene the canonical way -- loadByGuid<SceneAsset> ->
// allocSharedRef -> assets.instantiate -- and return the localId->Entity mapping
// (so the caller can find the Player) + the entity nodes (for per-node physics /
// player wiring). Returns null on any failure (caller falls back to a minimal
// scene). No bespoke pack parsing: the scene is authored in the current schema
// and instantiate resolves refs[]->GUID->handle + builds the mapping itself.
async function loadScene(
  ctx: Ctx,
): Promise<{ mapping: ReadonlyMap<number, EntityHandle>; nodes: PackNode[] } | null> {
  const { world, assets } = ctx;
  if (!assets) return null;

  // All scene meshes (cube / sphere / cylinder) are engine builtins, pre-catalogued
  // by GUID in AssetRegistry -- so the scene's recursive ref-load resolves them from
  // the builtin catalog directly; no runtime catalog step is needed here.
  const sceneGuid = AssetGuid.parse(SCENE_GUID);
  if (!sceneGuid.ok) return null;

  // loadByGuid pulls the scene AND recursively its refs[] (material siblings)
  // from the pluginPack pack-index; the returned payload already has each handle
  // field resolved from a refs[] index to its GUID string.
  const loadRes = await assets.loadByGuid<SceneAsset>(sceneGuid.value);
  if (!loadRes.ok) { console.error('[game] scene loadByGuid failed:', loadRes.error); return null; }

  // assets.instantiate returns the synthetic root Entity directly; it wires the
  // World-level scene resolver, resolves GUID->handle, spawns every node, and
  // stamps the `SceneInstance` component whose `mapping` Uint32Array is indexed
  // by authored localId (sized to maxLocalId+1, so sparse localIds keep working).
  const sceneHandle = world.allocSharedRef('SceneAsset', loadRes.value);
  const instRes = assets.instantiate<SceneAsset>(sceneHandle, world);
  if (!instRes.ok) { console.error('[game] scene instantiate failed:', (instRes.error as { code?: string })?.code); return null; }
  const root = instRes.value;
  const sceneInst = world.get(root, SceneInstance);
  if (!sceneInst.ok) { console.error('[game] SceneInstance lookup failed:', sceneInst.error); return null; }
  const mappingArr = sceneInst.value.mapping;
  const nodes = loadRes.value.entities as unknown as PackNode[];
  const mapping = new Map<number, EntityHandle>();
  for (const n of nodes) {
    const e = mappingArr[n.localId];
    if (e !== undefined) mapping.set(n.localId, e as EntityHandle);
  }
  return { mapping, nodes };
}

// Minimal fallback scene (ground + cube + sun) so Play still runs if the pack is
// missing/unreadable. The editor authors the real one.
function spawnFallbackScene(ctx: Ctx): void {
  const { world } = ctx;
  const ground = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ baseColor: [0.48, 0.62, 0.35, 1], roughness: 0.95, metallic: 0 }));
  world.spawn(
    { component: Transform, data: { pos: [0, -0.1, 0], scale: [24, 0.2, 24]} },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [ground] } },
  );
}

// A THICK invisible static floor whose TOP sits at y=0 (the visual ground's top).
// Dynamic props rest + collide against this, not the thin 0.2-tall visual ground —
// so a hard knock can't push them partway THROUGH a thin slab and leave them sunk.
function spawnGroundCollider(ctx: Ctx): void {
  ctx.world.spawn(
    { component: Transform, data: { pos: [0, -5, 0]} },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [60, 5, 60], friction: 0.9, restitution: 0 } },
  );
}

// The player root's rest height (matches the authored "Player" root in the pack):
// its kinematic capsule (radius 0.3 + halfHeight 0.4) is centered here.
const PLAYER_Y = 0.75;

// Attach engine physics (RigidBody + Collider) to the instantiated scene, by entity
// Name. The pack's authored `Collider` is stripped on load (Studio metadata, a
// different schema); engine colliders are sized here from each entity's mesh +
// Transform.scale. Collider dimensions are ABSOLUTE (Rapier doesn't scale colliders
// by Transform), so halfExtents = unit-mesh-extent(1)·scale·0.5, sphere radius =
// scale·0.5 (unit sphere r=0.5).
//   Ground                        → static box (immovable floor)
//   RedBox / BlueBall / YellowPillar → dynamic (fall, get shoved + knocked flying)
//   TreeTrunk / TreeCanopy        → Collider ONLY = static obstacle, never simulated
//                                   (树有碰撞体、无物理 — dynamic props bounce off it)
//   Player / Sun                  → skipped (Player becomes the kinematic box-man root)
function attachScenePhysics(
  ctx: Ctx,
  loaded: { mapping: ReadonlyMap<number, EntityHandle>; nodes: PackNode[] },
): {
  props: Array<{ e: EntityHandle; mat: MatHandle }>;
  walkBlockers: Array<{ cx: number; cz: number; r: number }>;
  targets: Array<{ e: EntityHandle; points: number }>;
} {
  const { world } = ctx;
  const props: Array<{ e: EntityHandle; mat: MatHandle }> = [];    // dynamic → hit-flash targets
  const targets: Array<{ e: EntityHandle; points: number }> = [];  // scorable props (entity → points)
  // XZ circles the kinematic player can't enter (the tree TRUNK). The player is
  // kinematic → rapier gives it no collision response vs static bodies, so we
  // block it manually. A single forward raycast missed the thin (0.4-wide) trunk
  // from off-center angles; an XZ push-out blocks from EVERY angle. Only obstacles
  // that sit on the ground (yMin < 0.8) are walk-blockers — an elevated obstacle
  // (the canopy, yMin 1.0) is foliage you walk UNDER, not into.
  const walkBlockers: Array<{ cx: number; cz: number; r: number }> = [];
  const addBlocker = (cx: number, cz: number, r: number, yMin: number) => {
    if (yMin < 0.8) walkBlockers.push({ cx, cz, r });
  };
  const matOf = (e: EntityHandle): MatHandle => {
    const mr = world.get(e, MeshRenderer);
    return (mr.ok ? mr.value.materials[0] : 0) as MatHandle;
  };
  for (const node of loaded.nodes) {
    const name = (node.components.Name as { value?: string } | undefined)?.value;
    const e = loaded.mapping.get(node.localId);
    if (e === undefined || !name) continue;
    const t = (node.components.Transform ?? {}) as { pos?: number[]; scale?: number[] };
    // Collider sizing: the builtin CUBE is createBoxGeometry(1,1,1) → extent 1
    // (half 0.5), but the builtin SPHERE is createSphereGeometry(1,…) → radius 1.
    // So a cuboid half-extent is scale·0.5, while a sphere's radius is the FULL
    // scale (scale·1). Getting this wrong makes the collider half the visual size
    // → the mesh sinks into the floor and bodies interpenetrate before colliding.
    const hx = (t.scale?.[0] ?? 1) * 0.5, hy = (t.scale?.[1] ?? 1) * 0.5, hz = (t.scale?.[2] ?? 1) * 0.5;
    const sphereR = t.scale?.[0] ?? 1;
    const box = (restitution: number) =>
      world.addComponent(e, { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [hx, hy, hz], restitution, friction: 0.7 } });
    const sphere = (restitution: number) =>
      world.addComponent(e, { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: sphereR, restitution, friction: 0.6 } });
    const dynamic = () =>
      world.addComponent(e, { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1, linearDamping: 0.05, angularDamping: 0.1, ccdEnabled: true } });
    const staticBody = () =>
      world.addComponent(e, { component: RigidBody, data: { type: RigidBodyTypeValue.static } });
    switch (name) {
      // Ground gets NO collider here — a separate THICK floor (spawnGroundCollider)
      // handles collision. A thin 0.2-tall ground slab lets a hard knock push a
      // dynamic body partway THROUGH it (penetration that doesn't recover → the
      // prop rests sunk into the ground). A deep floor box can't be tunneled.
      case 'Ground': break;
      // Tree = STATIC body (immovable, never simulated — "no physics") so props
      // bounce off it. NOTE: this engine's physicsSyncBackend only registers
      // entities with the full (Transform, RigidBody, Collider) triplet, so a
      // Collider WITHOUT a RigidBody is silently ignored (no collision at all).
      // A static RigidBody is the right way to get an immovable obstacle.
      case 'TreeTrunk': staticBody(); box(0.2); addBlocker(t.pos?.[0] ?? 0, t.pos?.[2] ?? 0, Math.hypot(hx, hz), (t.pos?.[1] ?? 0) - hy); break;
      case 'TreeCanopy': staticBody(); sphere(0.2); addBlocker(t.pos?.[0] ?? 0, t.pos?.[2] ?? 0, sphereR, (t.pos?.[1] ?? 0) - sphereR); break;
      case 'RedBox': dynamic(); box(0.25); props.push({ e, mat: matOf(e) }); targets.push({ e, points: 10 }); break;
      case 'BlueBall': dynamic(); sphere(0.55); props.push({ e, mat: matOf(e) }); targets.push({ e, points: 15 }); break;
      case 'YellowPillar': dynamic(); box(0.2); props.push({ e, mat: matOf(e) }); targets.push({ e, points: 10 }); break;
      // showcase props — now AUTHORED in scene.pack.json (so ✎ Edit shows them
      // too); main.ts just gives them dynamics. "Crate*" = knockable pyramid,
      // "BouncyBall" = high-restitution bouncer.
      case 'BouncyBall': dynamic(); sphere(0.92); props.push({ e, mat: matOf(e) }); targets.push({ e, points: 25 }); break;
      default:
        if (name.startsWith('Crate')) { dynamic(); box(0.1); props.push({ e, mat: matOf(e) }); targets.push({ e, points: 5 }); }
        break;
    }
  }
  return { props, walkBlockers, targets };
}

// Wire up the low-poly box-man. Its cube parts ("PlayerTorso/Head/ArmL/ArmR/LegL/
// LegR") are authored in scene.pack.json as ChildOf children of the "Player" root
// with LOCAL coordinates — a single hierarchy representation that both ✎ Edit and
// ▶ Play consume verbatim (the editor viewport and Play run the same engine +
// propagateTransforms, so ChildOf resolves in both; scene-pack round-trips ChildOf
// losslessly). So the avatar already renders + moves as a unit; here we only make
// the root a kinematic body (driven by its Transform → shoves props). No runtime
// re-parenting: that split representation (flat pack + Play-time reparent) was a
// SSOT violation and the source of a stale-view bug (reading a Transform array view
// across the ChildOf archetype migration scrambled the parts).
function setupPlayerRoot(ctx: Ctx, root: EntityHandle): void {
  const { world } = ctx;
  world.addComponent(root, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } });
  world.addComponent(root, { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.4 } });
}

export async function bootstrap(world: World, ctx?: BootstrapContext) {
  const { registerUpdate, registerCleanup } = ctx ?? {};

  // No DOM listeners are registered in this template (AC-01). The engine input
  // backend (browser-backend.ts) handles all pointer/keyboard events via the
  // InputSnapshot Resource, and the backend's own detach/cleanup lifecycle
  // (via App.stop) tears down its listeners. registerCleanup is only used for
  // HUD dispose (below).

  const canvas = document.querySelector<HTMLCanvasElement>('#app')!;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  const aspect = canvas.width / canvas.height || 1;

  // ── load the authored scene (the SAME native asset ✎ Edit writes) ────────────
  let loaded: { mapping: ReadonlyMap<number, EntityHandle>; nodes: PackNode[] } | null = null;

  // Asset-first host (preview + editor ▶ Play): the host resolves + instantiates
  // forge.json.defaultScene BEFORE bootstrap runs and hands us the synthetic root
  // via ctx.defaultSceneRoot (+ the loaded SceneAsset via ctx.defaultScene). ADOPT
  // that instance — re-instantiating here would load the scene TWICE (host copy +
  // our copy). Recover the { mapping, nodes } the Player / physics wiring below
  // reads: mapping from the SceneInstance component on the host root (localId->
  // Entity), nodes from the author-side entity list (carries Name components).
  const hostRoot = ctx?.defaultSceneRoot;
  if (hostRoot !== undefined && ctx?.defaultScene !== undefined) {
    const sceneInst = world.get(hostRoot, SceneInstance);
    if (!sceneInst.ok) {
      console.error('[game] SceneInstance lookup on host root failed:', sceneInst.error);
    } else {
      // mapping is a Uint32Array sized maxLocalId+1, indexed by localId; skip
      // unspawned slots (ENTITY_NULL_RAW = 0xffffffff) and 0.
      const mappingArr = sceneInst.value.mapping as unknown as { length: number; [i: number]: number };
      const mapping = new Map<number, EntityHandle>();
      for (let localId = 0; localId < mappingArr.length; localId++) {
        const e = mappingArr[localId];
        if (e !== undefined && e !== 0xffffffff && e !== 0) mapping.set(localId, e as EntityHandle);
      }
      loaded = { mapping, nodes: ctx.defaultScene.entities as unknown as PackNode[] };
    }
  }

  // Fallback: no host-instantiated scene (standalone game module, or the host has
  // no defaultScene) — load it ourselves the canonical loadByGuid<SceneAsset> ->
  // instantiate path.
  if (!loaded) {
    try {
      loaded = await loadScene({ world, assets: ctx?.assets });
    } catch (err) {
      console.warn('[game] scene asset unavailable:', err);
    }
  }
  if (!loaded) spawnFallbackScene({ world });

  // Thick physics floor (top at y=0) so knocked props can't sink into the ground.
  spawnGroundCollider({ world });

  // HDR environment (Skylight + SkyboxBackground) is authored in the scene asset
  // (loaded above) -- no code install. tonemap (below) must be active for the
  // skybox pass; the equirect->cubemap projection happens lazily in the renderer.

  // ── physics: attach RigidBody/Collider to the scene + spawn showcase props,
  //    then make the Player a kinematic box-man root (▶ Play simulates; ✎ Edit
  //    never enables physics). ──────────────────────────────────────────────────
  let player: EntityHandle | undefined;
  let initX = 0, initZ = 0;
  // XZ circles the kinematic player is pushed out of (the tree trunk).
  const walkBlockers: Array<{ cx: number; cz: number; r: number }> = [];
  const flashables: Array<{ e: EntityHandle; mat: MatHandle }> = []; // hit-flash targets (dynamic props)
  const targets: Array<{ e: EntityHandle; points: number }> = [];    // scorable props (entity → points)
  if (loaded) {
    const phys = attachScenePhysics({ world }, loaded);
    walkBlockers.push(...phys.walkBlockers);
    flashables.push(...phys.props);
    targets.push(...phys.targets);
    const playerNode = loaded.nodes.find((n) => (n.components.Name as { value?: string } | undefined)?.value === 'Player');
    if (playerNode) {
      const t = (playerNode.components.Transform ?? {}) as { pos?: number[] };
      initX = t.pos?.[0] ?? 0; initZ = t.pos?.[2] ?? 0;
      player = loaded.mapping.get(playerNode.localId);
      if (player !== undefined) setupPlayerRoot({ world }, player);
    }
  }
  const origMatOf = new Map<EntityHandle, MatHandle>(flashables.map((f) => [f.e, f.mat] as [EntityHandle, MatHandle]));

  // ── camera: TWO switchable view modes (top-down 2.5D ⇄ first-person) ─────────
  // Top-down = a high tilted follow cam; FPS = an eye-height cam driven by
  // pointer-lock mouse-look. An on-screen UI button (HUD, below) toggles them.
  // antialias: ANTIALIAS_FXAA = post-process anti-aliasing (learn-render §4).
  const TOP_DY = 13, TOP_DZ = 9;                 // top-down offset (steeper = more 2.5D)
  const CAM_FOLLOW = 8;                          // top-down follow stiffness
  const EYE = 0.55;                              // FPS eye height above the player root (≈ box-man head, y≈1.3)
  const topPitch = -Math.atan2(TOP_DY, TOP_DZ);  // top-down look-down pitch
  const topQ = quat.create();
  quat.fromAxisAngle(topQ, [1, 0, 0], topPitch);
  let camX = initX, camZ = initZ + TOP_DZ;
  const camera = world.spawn(
    { component: Transform, data: { pos: [camX, TOP_DY, camZ], quat: [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!]} },
    // clearColor = visible sky background. WebKit/WKWebView (the desktop app)
    // can't render the cubemap SkyboxBackground (needs rgba16float render targets
    // it lacks), so without this the background clears to black. The Camera clear
    // color needs no GPU feature; a daytime blue reads as sky. Linear/pre-tonemap.
    // On Chromium the cubemap skybox draws over it (harmless).
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect, near: 0.1, far: 200 }), tonemap: TONEMAP_REINHARD_EXTENDED, bloom: BLOOM_ENABLED, antialias: ANTIALIAS_FXAA, clearColor: [0.4, 0.6, 1.0, 1] } },
  ).unwrap();

  // ── one warm accent point light (learn-render §2 multiple-lights; the scene
  //    already has the directional Sun + IBL skylight — keep ≤1 of each). ───────
  world.spawn(
    { component: Transform, data: { pos: [3, 5, 1]} },
    { component: PointLight, data: { color: [1, 0.72, 0.42], intensity: 40, range: 22 } },
  );

  // ── on-hit "+N" popup ────────────────────────────────────────────────────
  //   Score popups are a **DOM overlay**, NOT a world-space GlyphText entity.
  //
  //   Why: the engine's shadow caster pass (render-system-record.ts:2611-2630)
  //   projects every entity with a triangle-list/triangle-strip submesh into
  //   the directional shadow map — there is no per-material `castShadow:false`
  //   yet (design doc 2026-06-09 covers it; not yet landed). A world-space
  //   GlyphText popup at prop.y+0.8 with billboard-to-camera rotation lies
  //   near-horizontal in top-down view, and the sun-direction projection of
  //   that quad onto the ground produced a clearly visible circular shadow at
  //   the hit prop's feet (bug-20260610-glyph-mesh-cannot-opt-out-shadow-
  //   caster). DOM overlay sidesteps the shadow path entirely.
  //
  //   spawnPopup runs from the registerUpdate callback (after hit detection),
  //   projects (worldX, worldY, worldZ) to canvas-CSS-pixel screen coords
  //   inline using the camera's current Transform + a hardcoded perspective
  //   FOV (matches the Camera spawn above), and hands off to hud.floatScore
  //   which spawns a brief animated div.
  const targetPoints = new Map<EntityHandle, number>(targets.map((t) => [t.e, t.points] as [EntityHandle, number]));

  // Box-man body parts (PlayerTorso/Head/Arm*/Leg*): hidden in FPS so they don't
  // occlude the eye-level camera, shown in top-down. Toggled by scaling to 0 (safe
  // partial Transform set — no add/remove churn). Scales read AFTER setupPlayerRoot.
  const bodyParts: Array<{ e: EntityHandle; sx: number; sy: number; sz: number }> = [];
  if (loaded) {
    for (const n of loaded.nodes) {
      const nm = (n.components.Name as { value?: string } | undefined)?.value;
      if (nm && nm.startsWith('Player') && nm !== 'Player') {
        const pe = loaded.mapping.get(n.localId);
        if (pe === undefined) continue;
        const tr = world.get(pe, Transform);
        bodyParts.push({
          e: pe,
          sx: tr.ok ? (tr.value.scale[0] ?? 1) : 1,
          sy: tr.ok ? (tr.value.scale[1] ?? 1) : 1,
          sz: tr.ok ? (tr.value.scale[2] ?? 1) : 1,
        });
      }
    }
  }
  const setPlayerVisible = (vis: boolean) => {
    for (const p of bodyParts) {
      world.set(p.e, Transform, vis ? { scale: [p.sx, p.sy, p.sz]} : { scale: [0, 0, 0]});
    }
  };

  // ── on-screen UI + view-mode state (DOM overlay; gameplay stays ECS) ─────────
  let mode: ViewMode = 'topdown';
  let score = 0;
  // Pointer-lock is managed by engine-input's browser backend (M3 D-1/D-3):
  //   - Web:   backend onCanvasClick calls the W3C Pointer Lock API directly.
  //   - Host:  the editor play-runtime injects a lockProvider wrapping the native
  //            cursor-grab channel.
  // The template ONLY controls whether lock is allowed via ctx.setPointerLockAllowed
  // (fps = allowed, top-down = forbidden + immediate release). Lock state is read
  // from snap.mouse.pointerLocked — no dual-write locked flag (constraint 3).
  // No host-specific (editor, desktop-webview, or inter-frame messaging)
  // knowledge exists here.
  // setMode is captured inside the toggle button click; declared above the HUD
  // so installHud's onToggle can call it.
  const setMode = (m: ViewMode) => {
    mode = m;
    hud.setMode(m);
    setPlayerVisible(m !== 'fps');
    canvas.style.cursor = m === 'fps' ? 'crosshair' : '';
    // M3 D-3: gate pointer-lock through the engine backend. fps = allow lock;
    // top-down = forbid + immediate release (backend handles both W3C exit
    // and provider exitLock pathways). The template no longer touches
    // any pointer-lock escape-hatch directly (AC-06).
    ctx?.setPointerLockAllowed?.(m === 'fps');
    // Don't request lock from here: setMode is called from the toggle BUTTON's
    // click; Chromium rejects pointer-lock requests on a different element from
    // the gesture's target. The backend's onCanvasClick requests it on canvas
    // click (same-element gesture).
  };
  // Mount the HUD into the host-provided controlled UI root (`ctx.uiRoot`) — the
  // disposable container the Play host removes WHOLE on ■ Stop. This is what makes
  // "no UI remnant after Stop" structural: the HUD lives inside the one element
  // the host discards, so it cannot be stranded. The host scopes uiRoot to the
  // viewport panel (absolute; inset:0; overflow:hidden), so it also shares the
  // canvas-local coordinate space floatScore uses AND clips popups to the viewport
  // — mounting on canvas.parentElement instead bypassed the disposable boundary
  // and left the HUD behind on Stop. Falls back to canvas.parentElement only when
  // the host does not provide a uiRoot (headless / older host).
  const hudHost = ctx?.uiRoot ?? canvas.parentElement ?? undefined;
  const hud = installHud({
    initialMode: 'topdown',
    onToggle: () => setMode(mode === 'fps' ? 'topdown' : 'fps'),
    ...(hudHost ? { host: hudHost } : {}),
  });
  // Defensive teardown: even though the host removes uiRoot whole on Stop, register
  // the HUD's own dispose so any listeners/timers it owns unwind on ■ (A layer).
  ctx?.registerCleanup?.(() => hud.dispose());

  // Boot the view mode NOW so the engine input backend learns the lock policy
  // BEFORE the first canvas click. Without this, `setMode` only ran on the HUD
  // toggle, so the backend kept its default `gameGate = true` and allowed pointer
  // lock even in top-down — the 1st click locked, the 2nd click's setPointerCapture
  // then collided with the active lock and threw InvalidStateError (capture and
  // lock are mutually exclusive, W3C). Syncing the initial `mode` here forbids lock
  // in top-down from the start; toggling to fps re-allows it.
  setMode(mode);

  // World-space → canvas-CSS-pixel projection for the DOM "+N" popup. Reads
  // the camera's CURRENT Transform (the registerUpdate callback that calls
  // spawnPopup runs AFTER the camera Transform write each frame, so values
  // are fresh). FOV / near match the Camera spawn above. Returns negative
  // coords for off-screen / behind-camera; floatScore tolerates that by just
  // rendering off-canvas (clipped). HUD sx/sy are in canvas-local CSS pixels;
  // since the HUD root fills the same rect as the canvas (mounted into ctx.uiRoot
  // with `inset: 0`, or `position: fixed; inset: 0` in the document.body fallback),
  // canvas.clientWidth/Height is the right basis without an additional canvas
  // getBoundingClientRect() lookup.
  const FOV = Math.PI / 3;
  const spawnPopup = (text: string, wx: number, wy: number, wz: number): void => {
    const camTr = world.get(camera, Transform);
    if (!camTr.ok) return;
    const cpx = camTr.value.pos[0] ?? 0, cpy = camTr.value.pos[1] ?? 0, cpz = camTr.value.pos[2] ?? 0;
    // Inverse camera rotation = quaternion conjugate (negate xyz, keep w).
    const qx = -(camTr.value.quat[0] ?? 0), qy = -(camTr.value.quat[1] ?? 0), qz = -(camTr.value.quat[2] ?? 0), qw = camTr.value.quat[3] ?? 1;
    const dx = wx - cpx, dy = wy - cpy, dz = wz - cpz;
    // Quat-vector rotation: t = 2 * (q.xyz × v); v' = v + q.w * t + q.xyz × t.
    const tx = 2 * (qy * dz - qz * dy);
    const ty = 2 * (qz * dx - qx * dz);
    const tz = 2 * (qx * dy - qy * dx);
    const lx = dx + qw * tx + (qy * tz - qz * ty);
    const ly = dy + qw * ty + (qz * tx - qx * tz);
    const lz = dz + qw * tz + (qx * ty - qy * tx);
    if (lz >= -0.05) return;   // behind / on top of camera near plane
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    const f = 1 / Math.tan(FOV * 0.5);
    const ndcX = (lx * f) / (-lz * (cssW / cssH));
    const ndcY = (ly * f) / -lz;
    if (ndcX < -1.2 || ndcX > 1.2 || ndcY < -1.2 || ndcY > 1.2) return;
    const sx = (ndcX + 1) * 0.5 * cssW;
    const sy = (1 - ndcY) * 0.5 * cssH;
    hud.floatScore(text, sx, sy);
  };

  // ── input: keyboard via the engine InputSnapshot (WASD/Space/F + arrows) ─────
  // The host (apps/preview) createApp attaches the browser input backend and
  // runs InputFrameStartScan each frame; the template only DECLARES an action
  // map and READS the frozen snapshot. No hand-rolled key listeners.
  //
  // NOTE the backend records `KeyboardEvent.key` (case-sensitive, layout-
  // dependent) NOT `.code`, so letters bind BOTH cases (shift / caps-lock) and
  // the space bar binds ' '. Arrows keep their raw `key` names.
  const KEY = (key: string) => ({ type: 'key', key } as const);
  const INPUT_MAP: readonly ActionConfig[] = [
    { action: 'moveForward', bindings: [KEY('w'), KEY('W')] },
    { action: 'moveBack', bindings: [KEY('s'), KEY('S')] },
    { action: 'moveLeft', bindings: [KEY('a'), KEY('A')] },
    { action: 'moveRight', bindings: [KEY('d'), KEY('D')] },
    { action: 'jump', bindings: [KEY(' ')] },
    { action: 'shoot', bindings: [KEY('f'), KEY('F')] },
    // Arrows: context-dependent (top-down move vs FPS look), so declared as
    // their own actions and read individually below (snap.action('arrowUp')
    // etc.) — their meaning stays with the per-mode logic, not the InputMap.
    { action: 'arrowUp', bindings: [KEY('ArrowUp')] },
    { action: 'arrowDown', bindings: [KEY('ArrowDown')] },
    { action: 'arrowLeft', bindings: [KEY('ArrowLeft')] },
    { action: 'arrowRight', bindings: [KEY('ArrowRight')] },
  ];
  world.insertResource(INPUT_MAP_KEY, INPUT_MAP);
  // Frame-1 fallback: the scan system only writes the snapshot inside the first
  // world.update(), which runs AFTER this frame's registerUpdate callbacks, so
  // the resource is absent on the very first tick. createInputSnapshot() is the
  // empty snapshot (all readpoints false / zero) — read it until the real one
  // lands (charter P3: empty signal is the signal).
  const EMPTY_SNAP = createInputSnapshot();
  const readInput = (): InputSnapshot =>
    world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)
      ? world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)
      : EMPTY_SNAP;

  // FPS mouse-look: STANDARD POINTER-LOCK pattern — click locks the cursor
  // (hidden), then mousemove movementX/Y rotates the view (infinite turn). ESC
  // releases. Arrow keys remain a keyboard fallback if lock can't be granted.
  const LOOK_SENS = 0.0022;
  let lookYaw = 0;     // 0 → forward (0,-1); forward = (-sin yaw, -cos yaw)
  let lookPitch = 0;
  let wantShoot = false;
  // Top-down click sets a one-shot world-XZ aim direction here; the fire block
  // consumes it (so a click-aim is preserved even if the player is moving and
  // the movement block overwrites faceX/faceZ on the same frame).
  let shotDir: { x: number; z: number } | null = null;
  const clampPitch = (p: number) => Math.max(-1.2, Math.min(1.2, p));
  // FPS mouse-look now reads from the engine InputSnapshot (M3 D-1):
  // snap.mouse.movementDelta carries the per-frame accumulated pointer-lock
  // movement, and snap.mouse.pointerLocked gates consumption (AC-02: only
  // consume delta while locked). The look system is an ECS system registered
  // on the world schedule — no DOM mousemove listener.
  const GameLook = defineSystem({
    name: 'game-look',
    queries: [] as const,
    after: ['input-frame-start-scan'],
    fn: (world) => {
      const snap = readInput();
      if (mode !== 'fps' || !snap.mouse.pointerLocked) {
        // Update HUD lock status every frame from the SSOT (D-8).
        // The backend controls cursor hiding via browser behaviors; the
        // template only drives the HUD text line.
        if (mode === 'fps') {
          hud.setLockStatus(snap.mouse.pointerLocked
            ? '🎮 Locked · mouse look · ESC releases'
            : '👍 Click canvas to lock mouse');
        }
        return;
      }
      lookYaw -= snap.mouse.movementDelta.x * LOOK_SENS;
      lookPitch = clampPitch(lookPitch - snap.mouse.movementDelta.y * LOOK_SENS);
      hud.setLockStatus('🎮 Locked · mouse look · ESC releases');
    },
  });
  world.addSystem(GameLook);

  // Pointer-lock is now handled entirely by the engine backend's onCanvasClick
  // (browser-backend.ts). The host (apps/preview) calls ctx.setPointerLockAllowed
  // via the setMode pathway above; the backend's gate (gameGate × hostPredicate)
  // decides whether to request lock per click. Template has zero DOM listeners
  // for pointer-lock / mousedown / mousemove / click (AC-01, AC-06).

  // Click handling, per mode, now reads from the engine InputSnapshot (M3 D-5):
  //   - FPS (locked):   pointerEvents down edge → shoot forward (look direction).
  //   - FPS (unlocked):  no-op (backend onCanvasClick already requested lock).
  //   - Top-down:       pointerEvents down edge → AIM character toward the click
  //                     point via pick(), then shoot. Coordinates come from the
  //                     event (DPR-corrected canvas pixels), matching pick()'s
  //                     contract. No DOM closure — world comes from ECS params.
  const GamePickShoot = defineSystem({
    name: 'game-pick-shoot',
    queries: [] as const,
    after: ['input-frame-start-scan'],
    fn: (world) => {
      const snap = readInput();
      for (const ev of snap.pointerEvents) {
        if (ev.phase !== 'down' || ev.pointerType !== 'mouse') continue;
        if (mode === 'fps') {
          if (snap.mouse.pointerLocked) wantShoot = true;
          continue;
        }
        // top-down: screen-to-world pick + aim
        const hit = pick(world, camera, ev.x, ev.y, canvas.width, canvas.height);
        let aimX: number, aimZ: number;
        if (hit) {
          const tr = world.get(hit.entity, Transform);
          if (tr.ok) { aimX = tr.value.pos[0] ?? 0; aimZ = tr.value.pos[2] ?? 0; }
          else { aimX = px + (ev.x - canvas.width / 2); aimZ = pz + (ev.y - canvas.height / 2); }
        } else {
          aimX = px + (ev.x - canvas.width / 2); aimZ = pz + (ev.y - canvas.height / 2);
        }
        const dx = aimX - px, dz = aimZ - pz;
        const len = Math.hypot(dx, dz);
        if (len > 1e-3) {
          const nx = dx / len, nz = dz / len;
          shotDir = { x: nx, z: nz };
          faceX = nx; faceZ = nz;
          wantShoot = true;
        }
      }
    },
  });
  world.addSystem(GamePickShoot);

  // Bullet material — EMISSIVE so it glows and drives the Camera.bloom bright-pass
  // (HDR emissive > bloomThreshold 1.0 → blooms). Showcases the post-processing path.
  const bulletMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ baseColor: [1, 0.85, 0.3, 1], roughness: 0.4, metallic: 0, emissive: [1, 0.7, 0.15], emissiveIntensity: 5 }));
  // Bullet mesh — a 0.2-radius sphere baked AT the visual size (Transform.scale
  // stays 1). The default HANDLE_SPHERE is a UNIT sphere; using `scale 0.2` to
  // shrink it produced a large round ground shadow on every shot — a code path
  // somewhere along the shadow-caster pipeline reads the unit-mesh extent
  // before Transform.scale is folded in. Baking the geometry at the final
  // radius removes the scale dependency and the shadow now matches the bullet.
  const bulletMeshRes = createSphereGeometry(0.2, 12, 8);
  const bulletMesh = bulletMeshRes.ok ? world.allocSharedRef('MeshAsset', bulletMeshRes.value) : HANDLE_SPHERE;
  // Hit-flash material — a bright emissive white-yellow swapped onto a prop for a
  // few frames when a bullet strikes it (then restored to its base material).
  const flashMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ baseColor: [1, 1, 0.9, 1], roughness: 0.5, metallic: 0, emissive: [1, 1, 0.6], emissiveIntensity: 6 }));
  const flashUntil = new Map<EntityHandle, number>();    // entity → remaining flash seconds
  // squared hit radius for bullet→prop scoring (bullet_r 0.2 + avg prop_r 0.5 ≈
  // 0.7, plus frame-step slack since the bullet advances ~0.4/frame). Generous
  // overshoot is fine: the per-bullet `hits` set prevents duplicate scoring.
  const HIT2 = 0.9 * 0.9;

  // ── gameplay update (▶ Play only — ✎ Edit stays static) ─────────────────────
  const SPEED = 6;            // walk speed (units/s)
  const PLAYER_RADIUS = 0.3;  // = the kinematic capsule radius (setupPlayerRoot)
  const BOUND = 11;           // keep the character on the 24-wide ground slab
  const JUMP_V = 6.5;         // initial jump velocity
  const GRAV = 18;            // jump gravity (manual arc — the root is kinematic)
  const BULLET_SPEED = 24;    // bullet travel speed (units/s)
  const BULLET_LIFE = 1.5;    // bullet lifetime (s)
  const SHOOT_CD = 0.18;      // fire cooldown (s)

  let px = initX, pz = initZ;
  let faceX = 0, faceZ = -1;          // facing unit vector (default: into the scene)
  let jumpY = PLAYER_Y, vy = 0, grounded = true;
  let shootCd = 0;
  // Bullets fly THROUGH props rather than despawning on contact. Why: rapier's
  // kinematic-vs-dynamic push is velocity-driven (delta of setNextKinematicTranslation
  // per step → kinematic velocity → impulse to dynamic). Despawning on the hit
  // frame gives only ONE step of contact, which is (a) sometimes missed entirely
  // due to discrete-collision timing, and (b) only a small impulse → "random
  // knock" feel. Letting the bullet keep flying means ~3 physics steps of
  // contact while the bullet's collider is inside the prop's collider (step 0.4
  // / prop diameter ~1) → multiple push impulses → reliable knock-back. The
  // per-bullet `hits` set prevents double-scoring the same prop. Bullet despawns
  // on lifetime expiry (BULLET_LIFE) — no leftover ball-shadow because it never
  // sits still.
  const bullets: Array<{ e: EntityHandle; x: number; y: number; z: number; dx: number; dy: number; dz: number; age: number; hits: Set<EntityHandle> }> = [];

  if (player !== undefined) {
    const root = player;
    registerUpdate((dt: number) => {
      const snap = readInput();
      const arrowUp = snap.action('arrowUp').isPressed();
      const arrowDown = snap.action('arrowDown').isPressed();
      const arrowLeft = snap.action('arrowLeft').isPressed();
      const arrowRight = snap.action('arrowRight').isPressed();

      // — FPS look via arrow keys (keyboard fallback: mouse-look needs pointer
      //   lock, which the embedded preview iframe disallows). —
      if (mode === 'fps') {
        const TURN = 2.4;
        if (arrowLeft) lookYaw += TURN * dt;
        if (arrowRight) lookYaw -= TURN * dt;
        if (arrowUp) lookPitch = Math.min(1.2, lookPitch + TURN * 0.6 * dt);
        if (arrowDown) lookPitch = Math.max(-1.2, lookPitch - TURN * 0.6 * dt);
      }

      // — movement + facing, per view mode —
      // intent axes: f = forward(+)/back(−), s = strafe right(+)/left(−). WASD
      // come from the InputMap getVector (radial deadzone; diagonal magnitude 1).
      // Arrows alias WASD only in top-down; in FPS they steer the view (above).
      const am = mode !== 'fps';   // arrows-move (top-down only)
      const move = snap.getVector('moveLeft', 'moveRight', 'moveBack', 'moveForward');
      // getVector's Y is (posY action=moveForward) − (negY=moveBack); forward intent f
      // is +forward, so f = move.y. s = strafe right(+)/left(−) = move.x.
      const f = move.y + (am ? ((arrowUp ? 1 : 0) - (arrowDown ? 1 : 0)) : 0);
      const s = move.x + (am ? ((arrowRight ? 1 : 0) - (arrowLeft ? 1 : 0)) : 0);
      let mvx = 0, mvz = 0;
      if (mode === 'fps') {
        // look-relative; facing = look forward (front = local −Z; yaw 0 → (0,−1))
        const fwdX = -Math.sin(lookYaw), fwdZ = -Math.cos(lookYaw);
        const rgtX = -fwdZ, rgtZ = fwdX;          // +90° about Y → strafe right
        faceX = fwdX; faceZ = fwdZ;
        mvx = fwdX * f + rgtX * s; mvz = fwdZ * f + rgtZ * s;
      } else {
        // top-down: world-relative; facing = movement direction
        mvx = s; mvz = -f;                          // W → −Z, D → +X
        if (mvx !== 0 || mvz !== 0) { const l = Math.hypot(mvx, mvz); faceX = mvx / l; faceZ = mvz / l; }
      }
      if (mvx !== 0 || mvz !== 0) {
        const l = Math.hypot(mvx, mvz) || 1;
        const step = SPEED * dt;
        let nx = Math.max(-BOUND, Math.min(BOUND, px + (mvx / l) * step));
        let nz = Math.max(-BOUND, Math.min(BOUND, pz + (mvz / l) * step));
        // Kinematic bodies get no collision response vs static ones, so push the
        // player OUT of each ground obstacle's XZ circle (the tree trunk) from ANY
        // approach angle. Dynamic props are NOT walkBlockers → still get shoved.
        for (const o of walkBlockers) {
          const ox = nx - o.cx, oz = nz - o.cz;
          const d = Math.hypot(ox, oz);
          const minD = PLAYER_RADIUS + o.r;
          if (d < minD) {
            if (d > 1e-4) { nx = o.cx + (ox / d) * minD; nz = o.cz + (oz / d) * minD; }
            else { nx = o.cx + minD; }   // dead-center: shove out along +X
          }
        }
        px = nx; pz = nz;
      }

      // — jump (Space, edge-triggered; manual parabolic arc since kinematic) —
      // snap.action('jump').justPressed() is the rising edge (aggregatedPressed
      // && !prevFramePressed), replacing the manual prevSpace edge tracking.
      if (snap.action('jump').justPressed() && grounded) { vy = JUMP_V; grounded = false; }
      if (!grounded) {
        vy -= GRAV * dt;
        jumpY += vy * dt;
        if (jumpY <= PLAYER_Y) { jumpY = PLAYER_Y; vy = 0; grounded = true; }
      }

      // — drive the kinematic root: position + facing yaw (front = local −Z) —
      const yaw = Math.atan2(-faceX, -faceZ);
      const q = quat.eulerY(yaw);
      world.set(root, Transform, { pos: [px, jumpY, pz], quat: [q[0]!, q[1]!, q[2]!, q[3]!]});

      // — shoot (F, or left-click in FPS): kinematic bullet flies along `face` —
      shootCd -= dt;
      const fire = (snap.action('shoot').isPressed() || wantShoot) && shootCd <= 0;
      wantShoot = false;
      if (fire) {
        shootCd = SHOOT_CD;
        // 3D shot direction, per mode:
        //   FPS:      full look dir (yaw + pitch) — crosshair can aim DOWN.
        //   Top-down: shotDir from the click (consumed once); falls back to
        //             facing if F was pressed without a recent click.
        // Origin: FPS from the eye, top-down from chest (≈ prop height ~0.5).
        let dirX = faceX, dirY = 0, dirZ = faceZ;
        let by = jumpY + 0.15;
        if (mode === 'fps') {
          const cp = Math.cos(lookPitch);
          dirX = -Math.sin(lookYaw) * cp; dirY = Math.sin(lookPitch); dirZ = -Math.cos(lookYaw) * cp;
          by = jumpY + EYE;
        } else if (shotDir) {
          dirX = shotDir.x; dirZ = shotDir.z; dirY = 0;
        }
        shotDir = null;   // one-shot snapshot consumed
        const bx = px + dirX * 0.6, byy = by + dirY * 0.6, bz = pz + dirZ * 0.6;
        const e = world.spawn(
          { component: Transform, data: { pos: [bx, byy, bz]} },
          { component: MeshFilter, data: { assetHandle: bulletMesh } },
          { component: MeshRenderer, data: { materials: [bulletMat] } },
          // ccdEnabled sweeps the fast kinematic bullet's collider along each
          // step so it reliably contacts props instead of tunneling through.
          { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic, ccdEnabled: true } },
          { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.2, friction: 0, restitution: 0.6 } },
        ).unwrap();
        bullets.push({ e, x: bx, y: byy, z: bz, dx: dirX, dy: dirY, dz: dirZ, age: 0, hits: new Set<EntityHandle>() });
      }
      // Advance + cull bullets (3D travel). Bullets fly THROUGH props (not
      // despawned on hit) so each prop gets several frames of kinematic-vs-
      // dynamic contact → reliable push. They despawn only on lifetime expiry.
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i]!;
        b.age += dt;
        if (b.age > BULLET_LIFE) { world.despawn(b.e); bullets.splice(i, 1); continue; }
        b.x += b.dx * BULLET_SPEED * dt;
        b.y += b.dy * BULLET_SPEED * dt;
        b.z += b.dz * BULLET_SPEED * dt;
        world.set(b.e, Transform, { pos: [b.x, b.y, b.z]});
      }

      // — bullet↔target hit (rapier3d doesn't populate CollidingEntities →
      //   proximity-test for score/flash). Each (bullet, prop) pair scores at
      //   most ONCE — the per-bullet `hits` set prevents repeat scoring during
      //   the bullet's multi-frame pass-through. PHYSICS push is handled by
      //   the engine separately (bullet collider sweep contacting prop collider
      //   each step). Score is NOT gated by the flash window — every distinct
      //   prop hit counts. Flash visual is per-0.2s/prop to avoid thrashing.
      for (const b of bullets) {
        for (const fl of flashables) {
          if (b.hits.has(fl.e)) continue;
          const tr = world.get(fl.e, Transform);
          if (!tr.ok) continue;
          const fxp = tr.value.pos[0] ?? 0, fyp = tr.value.pos[1] ?? 0, fzp = tr.value.pos[2] ?? 0;
          const ex = b.x - fxp, ey = b.y - fyp, ez = b.z - fzp;
          if (ex * ex + ey * ey + ez * ez < HIT2) {
            b.hits.add(fl.e);
            const pts = targetPoints.get(fl.e);
            if (pts !== undefined) {
              score += pts;
              hud.setScore(score);
              spawnPopup('+' + pts, fxp, fyp + 0.8, fzp);
            }
            if (!flashUntil.has(fl.e)) {
              world.set(fl.e, MeshRenderer, { materials: [flashMat] });
              flashUntil.set(fl.e, 0.2);
            }
          }
        }
      }
      for (const [e, t] of flashUntil) {
        const nt = t - dt;
        if (nt <= 0) {
          world.set(e, MeshRenderer, { materials: [origMatOf.get(e)!] });
          flashUntil.delete(e);
        } else flashUntil.set(e, nt);
      }

      // — "+N" hit popups: handled by hud.floatScore (DOM overlay) at hit
      //   time, NOT a per-frame world-space billboard. See spawnPopup above
      //   for why (engine shadow-caster path projects every triangle mesh).

      // — camera, per view mode —
      if (mode === 'fps') {
        const qy = quat.create(); quat.fromAxisAngle(qy, [0, 1, 0], lookYaw);
        const qx = quat.create(); quat.fromAxisAngle(qx, [1, 0, 0], lookPitch);
        const cq = quat.create(); quat.multiply(cq, qy, qx);
        world.set(camera, Transform, { pos: [px, jumpY + EYE, pz], quat: [cq[0]!, cq[1]!, cq[2]!, cq[3]!]});
      } else {
        const a = 1 - Math.exp(-CAM_FOLLOW * dt);
        camX += (px - camX) * a;
        camZ += (pz + TOP_DZ - camZ) * a;
        world.set(camera, Transform, { pos: [camX, TOP_DY, camZ], quat: [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!]});
      }
    });
  }
}
