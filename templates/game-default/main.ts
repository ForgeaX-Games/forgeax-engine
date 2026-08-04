import { Transform } from '@forgeax/engine-scene';
import { AudioListener } from '@forgeax/engine-audio';
import {
  ANTIALIAS_FXAA, ANTIALIAS_MSAA, ANTIALIAS_NONE, BLOOM_DISABLED, BLOOM_ENABLED, Camera, MeshFilter, MeshRenderer, perspective,
  PointLight, TONEMAP_REINHARD_EXTENDED, Materials,
} from '@forgeax/engine-render';
import { quat, type Handle, type MaterialAsset, type MeshAsset } from '@forgeax/engine-runtime';
import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { createCapsuleGeometry } from '@forgeax/engine-geometry';
import { CharacterController, Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue, type PhysicsWorld } from '@forgeax/engine-physics';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { defineSystem, FixedUpdate, Time, Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { inState } from '@forgeax/engine-state';
import { vec3 } from '@forgeax/engine-math';
import type { BootstrapContext, GameProjectionValue } from '@forgeax/engine-app';
import {
  createInputSnapshot, INPUT_MAP_KEY, INPUT_SNAPSHOT_RESOURCE_KEY,
  type ActionConfig, type InputSnapshot,
} from '@forgeax/engine-input';
import type { UiAsset, UiError, UiResult } from '@forgeax/engine-ui';
import { installHud, HUD_UI_GUID, type ViewMode } from './src/hud';
import { createGameSettingsState, mountSettings, SETTINGS_UI_GUID, type AntialiasMode } from './src/settings';
import { applyClearColor } from './src/clear-color';
import { installGameplayInput } from './src/gameplay-input';
import { installGameplayLifecycle } from './src/gameplay-lifecycle';
import { installGameplayAudio } from './src/gameplay-audio';
import { installAudioEvidence } from './src/audio-evidence';
import { GameState, installGameplayState } from './src/gameplay-state';
import { installAssetContentEvidence } from './src/asset-content-evidence';
import { createHitFlashMaterial, HIT_FLASH_SHADER_ID, HIT_FLASH_SHADER_SOURCE } from './src/hit-flash-material';
import { stepRotatingTargets } from './src/rotating-target';
import { ANIMATED_TARGET_SHADER_ID, ANIMATED_TARGET_SHADER_SOURCE, createAnimatedMaterialTarget, resetAnimatedMaterial, stepAnimatedMaterial, type AnimatedMaterialTarget } from './src/animated-target-material';
import { resetScoringTargets, scoringPoints } from './src/scoring-target';
import { installRenderEvidence } from './src/render-evidence';
import { installDebugAxes } from './src/debug-axes';
import { ORBIT_INITIAL_PITCH, ORBIT_INITIAL_YAW, ORBIT_RADIUS, orbitPose } from './src/camera-orbit';
import { PERSPECTIVE_FOV_INITIAL, zoomPerspectiveFov } from './src/camera-zoom';
import { installGameplayChangeDetection, type GameplayChangeDetectionHandle } from './src/change-detection';
import { createWorldScoreText, type WorldScoreTextHandle } from './src/world-score-text';
import { installTargetHealth, TargetHealth, type TargetHealthHandle } from './src/target-health';
import { installTargetDisabling, type TargetDisablingHandle } from './src/target-disabling';
import { installDepthOfField, DEPTH_OF_FIELD_ID, type DepthOfFieldHandle } from './src/depth-of-field';
import { installChromaticAberration, CHROMATIC_ABERRATION_ID, type ChromaticAberrationHandle } from './src/chromatic-aberration';
import { createCustomProjectileMesh, resetCustomProjectileMesh, toggleCustomProjectileMesh, type CustomProjectileMesh } from './src/custom-projectile-mesh';
import { createMeshHandleSwap, resetMeshHandleSwap, toggleMeshHandleSwap, type MeshHandleSwap } from './src/mesh-handle-swap';
import { createFbxMeshSwap, resetFbxMeshSwap, toggleFbxMeshSwap, type FbxMeshSwap } from './src/fbx-mesh-swap';
import { createFbxSkinnedTarget, type FbxSkinnedTarget } from './src/fbx-skinned-target';
import { createFreeCameraState, resetFreeCamera, stepFreeCamera } from './src/free-camera';
import { installMultiWorldOverlay, type MultiWorldOverlay } from './src/multi-world-overlay';
import {
  attachScenePhysics, expandLoadedScene, loadedFromHost, loadScene, PLAYER_Y, setupPlayerRoot,
  spawnFallbackScene, spawnGroundCollider, type LoadedScene, type MatHandle,
} from './src/scene-runtime';

async function loadUiAsset(ctx: BootstrapContext | undefined, guidText: string): Promise<UiResult<UiAsset>> {
  const fail = (message: string): UiResult<UiAsset> => ({
    ok: false,
    error: {
      code: 'invalid-asset',
      expected: 'a loadable UiAsset from the configured pack',
      hint: 'Check the UI GUID and dev pack transport.',
      detail: { message, asset: guidText },
    },
  });
  if (!ctx?.assets) return fail('Asset registry is unavailable');
  const guid = AssetGuid.parse(guidText);
  if (!guid.ok) return fail(`Invalid UI GUID: ${guidText}`);
  const loaded = await ctx.assets.loadByGuid<UiAsset>(guid.value);
  if (loaded.ok) return loaded;
  const runtimeError = loaded.error;
  return fail(`${runtimeError.code}: ${runtimeError.hint}`);
}

export async function bootstrap(world: World, ctx?: BootstrapContext) {
  const { registerCleanup } = ctx ?? {};
  resetScoringTargets();
  registerCleanup?.(() => resetScoringTargets());

  // No DOM listeners are registered in this template (AC-01). The engine input
  // backend (browser-backend.ts) handles all pointer/keyboard events via the
  // InputSnapshot Resource, and the backend's own detach/cleanup lifecycle
  // (via App.stop) tears down its listeners. registerCleanup is only used for
  // HUD dispose (below).

  const canvas = document.querySelector<HTMLCanvasElement>('#app')!;
  // Asset-loop screenshots compare the same scene across load/reload/reset
  // operations. Freeze unrelated authored motion in that explicit evidence
  // mode so the pixel oracle measures the HDR change rather than a rotating
  // target advancing between captures; normal gameplay keeps both animations.
  const assetEvidenceMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('asset-evidence');
  if (ctx?.renderer !== undefined) {
    const shaders = [
      { id: HIT_FLASH_SHADER_ID, source: HIT_FLASH_SHADER_SOURCE, paramSchema: [{ name: 'baseColor', type: 'color' }, { name: 'intensity', type: 'f32' }] },
      { id: ANIMATED_TARGET_SHADER_ID, source: ANIMATED_TARGET_SHADER_SOURCE, paramSchema: [{ name: 'baseColor', type: 'color' }, { name: 'time', type: 'f32', default: 0 }] },
    ] as const;
    for (const shader of shaders) {
      if (!ctx.renderer.shader.findMaterialArtifact(shader.id).ok) {
        ctx.renderer.shader.installMaterialArtifact(shader.id, { source: shader.source, paramSchema: shader.paramSchema });
      }
    }
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  const aspect = canvas.width / canvas.height || 1;

  // The host normally hands us its already-instantiated default scene. Standalone
  // runs use the same GUID load path, while fallback keeps the learning loop visible.
  let loaded: LoadedScene | null = ctx ? loadedFromHost(world, ctx) : null;
  if (loaded && ctx?.assets && ctx.defaultScene) {
    loaded = await expandLoadedScene(ctx.assets, ctx.defaultScene, loaded);
  }
  if (!loaded) {
    try { loaded = await loadScene({ world, assets: ctx?.assets }); }
    catch (err) { console.warn('[game] scene asset unavailable:', err); }
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
  const flashables: Array<{ e: EntityHandle; materials: readonly MatHandle[]; clearcoat?: boolean }> = []; // hit-flash targets (dynamic props)
  let animatedMaterial: AnimatedMaterialTarget | undefined;
  // Time.elapsed is the engine-owned absolute clock. Keep only a reset origin
  // so the authored animation returns to phase zero without another accumulator.
  let materialElapsedOrigin = 0;
  if (loaded) {
    const phys = attachScenePhysics({ world }, loaded);
    flashables.push(...phys.props);
    if (phys.animatedMaterial) animatedMaterial = createAnimatedMaterialTarget(world, phys.animatedMaterial, 52);
    const playerNode = loaded.nodes.find((n) => (n.components.Name as { value?: string } | undefined)?.value === 'Player');
    if (playerNode) {
      const t = (playerNode.components.Transform ?? {}) as { pos?: number[] };
      initX = t.pos?.[0] ?? 0; initZ = t.pos?.[2] ?? 0;
      player = loaded.mapping.get(playerNode.localId);
      if (player !== undefined) setupPlayerRoot({ world }, player);
    }
  }
  const origMaterialsOf = new Map<EntityHandle, readonly MatHandle[]>(flashables.map((f) => [f.e, f.materials] as [EntityHandle, readonly MatHandle[]]));
  const targetHealth: TargetHealthHandle = installTargetHealth(world, flashables.map((target) => target.e));
  const targetDisabling: TargetDisablingHandle = installTargetDisabling(world, flashables.map((target) => target.e));
  const meshHandleSwap: MeshHandleSwap | undefined = createMeshHandleSwap(world, flashables[0]?.e);
  const fbxMeshSwap: FbxMeshSwap | undefined = await createFbxMeshSwap(world, ctx?.assets, flashables[0]?.e);
  const fbxSkinnedTarget: FbxSkinnedTarget | undefined = await createFbxSkinnedTarget({ world, assets: ctx?.assets });
  registerCleanup?.(() => fbxSkinnedTarget?.dispose());
  const damageTarget = (entity: EntityHandle, points: number): void => {
    targetHealth.damage(entity, points);
    const health = world.get(entity, TargetHealth);
    if (health.ok && health.value.current <= 0) targetDisabling.disable(entity);
  };

  const skylightEntity = loaded?.nodes
    .find((node) => (node.components.Name as { value?: string } | undefined)?.value === 'Skylight')
    ?.localId;
  installAssetContentEvidence({
    assets: ctx?.assets,
    renderer: ctx?.renderer,
    world,
    skylight: skylightEntity === undefined ? undefined : loaded?.mapping.get(skylightEntity),
    registerCleanup,
  });

  // ── camera: THREE switchable view modes (top-down ⇄ orbit ⇄ first-person) ───
  // Top-down = a high tilted follow cam; FPS = an eye-height cam driven by
  // pointer-lock mouse-look. Orbit keeps a fixed radius around the player. An
  // on-screen UI button (HUD, below) cycles through the three views.
  // antialias: ANTIALIAS_FXAA = post-process anti-aliasing (learn-render §4).
  const TOP_DY = 13, TOP_DZ = 9;                 // top-down offset (steeper = more 2.5D)
  const CAM_FOLLOW = 8;                          // top-down follow stiffness
  const PAN_HALF_HEIGHT_INITIAL = 8;
  const PAN_HALF_HEIGHT_MIN = 3;
  const PAN_HALF_HEIGHT_MAX = 14;
  const PAN_SPEED = 8;
  const EYE = 0.55;                              // FPS eye height above the player root (≈ box-man head, y≈1.3)
  const topPitch = -Math.atan2(TOP_DY, TOP_DZ);  // top-down look-down pitch
  const topQ = quat.create();
  quat.fromAxisAngle(topQ, [1, 0, 0], topPitch);
  let camX = initX, camZ = initZ + TOP_DZ;
  let panX = initX, panZ = initZ + TOP_DZ, panHalfHeight = PAN_HALF_HEIGHT_INITIAL;
  let perspectiveFov = PERSPECTIVE_FOV_INITIAL;
  const camera = world.spawn(
    { component: Transform, data: { pos: [camX, TOP_DY, camZ], quat: [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!]} },
    // clearColor = visible sky background. WebKit/WKWebView (the desktop app)
    // can't render the cubemap SkyboxBackground (needs rgba16float render targets
    // it lacks), so without this the background clears to black. The Camera clear
    // color needs no GPU feature; a daytime blue reads as sky. Linear/pre-tonemap.
    // On Chromium the cubemap skybox draws over it (harmless).
    { component: Camera, data: { ...perspective({ fov: PERSPECTIVE_FOV_INITIAL, aspect, near: 0.1, far: 200 }), tonemap: TONEMAP_REINHARD_EXTENDED, bloom: BLOOM_ENABLED, antialias: ANTIALIAS_FXAA, clearColor: [0.4, 0.6, 1.0, 1] } },
    { component: AudioListener, data: {} },
  ).unwrap();
  const multiWorldOverlay: MultiWorldOverlay | undefined = ctx?.app === undefined
    ? undefined
    : installMultiWorldOverlay(ctx.app, ctx.registerCleanup);

  // Keep the existing DOM popup as the screen-space UI contract, and add one
  // pooled world-space label to demonstrate FontAsset -> GlyphText in the same
  // gameplay loop. The asset is optional for headless hosts; Preview includes
  // the shared DejaVu font root so this path is exercised by the template.
  const worldScoreText: WorldScoreTextHandle | undefined = await createWorldScoreText(world, ctx?.assets);
  registerCleanup?.(() => worldScoreText?.dispose());

  // ── one warm accent point light (learn-render §2 multiple-lights; the scene
  //    already has the directional Sun + IBL skylight — keep ≤1 of each). ───────
  world.spawn(
    { component: Transform, data: { pos: [3, 5, 1]} },
    { component: PointLight, data: { color: [1, 0.72, 0.42], intensity: 40, range: 22 } },
  );

  // ── on-hit "+N" popup ────────────────────────────────────────────────────
  //   The DOM overlay remains the stable screen-space popup. The pooled
  //   world-space GlyphText label is a second, camera-facing feedback layer;
  //   its generated material is Forward-only (no ShadowCaster pass), so it
  //   does not add text geometry to the directional shadow map.
  //
  //   spawnPopup runs from the Update system (after hit detection),
  //   projects (worldX, worldY, worldZ) to canvas-CSS-pixel screen coords
  //   inline using the camera's current Transform + a hardcoded perspective
  //   FOV (matches the Camera spawn above), and hands off to hud.floatScore
  //   which spawns a brief animated div.
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
  let gameplayInput!: ReturnType<typeof installGameplayInput>;
  let changeDetection!: GameplayChangeDetectionHandle;
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
  const applyPanCamera = () => {
    const halfWidth = panHalfHeight * aspect;
    world.set(camera, Camera, {
      projection: 1,
      left: -halfWidth,
      right: halfWidth,
      bottom: -panHalfHeight,
      top: panHalfHeight,
      near: 0.1,
      far: 200,
    });
    world.set(camera, Transform, { pos: [panX, TOP_DY, panZ], quat: [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!] });
  };
  const restorePerspectiveCamera = () => {
    world.set(camera, Camera, { projection: 0, fov: perspectiveFov, aspect, near: 0.1, far: 200 });
  };
  const setMode = (m: ViewMode) => {
    if (m !== mode && gameplayInput) {
      gameplayInput.lookYaw = 0;
      gameplayInput.lookPitch = 0;
    }
    mode = m;
    if (m === 'pan') {
      panX = initX;
      panZ = initZ + TOP_DZ;
      panHalfHeight = PAN_HALF_HEIGHT_INITIAL;
      applyPanCamera();
    } else if (mode !== 'pan') {
      restorePerspectiveCamera();
    }
    hud.setMode(m);
    setPlayerVisible(m !== 'fps');
    canvas.style.cursor = m === 'fps' ? 'crosshair' : '';
    // M3 D-3: gate pointer-lock through the engine backend. Orbit and fps allow
    // lock; top-down forbids it and immediately releases any existing lock.
    // and provider exitLock pathways). The template no longer touches
    // any pointer-lock escape-hatch directly (AC-06).
    ctx?.setPointerLockAllowed?.(m === 'fps' || m === 'orbit');
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
  let settings: ReturnType<typeof mountSettings> = null;
  const [hudLoad, settingsLoad] = await Promise.all([
    loadUiAsset(ctx, HUD_UI_GUID),
    loadUiAsset(ctx, SETTINGS_UI_GUID),
  ]);
  const hudAsset = hudLoad.ok ? hudLoad.value : null;
  const settingsAsset = settingsLoad.ok ? settingsLoad.value : null;
  if (!hudLoad.ok) console.error(`[game] HUD UI load failed (${hudLoad.error.code}): ${hudLoad.error.detail.message}`);
  if (!settingsLoad.ok) console.error(`[game] settings UI load failed (${settingsLoad.error.code}): ${settingsLoad.error.detail.message}`);
  const hud = installHud({
    asset: hudAsset,
    initialMode: 'topdown',
    onToggle: () => setMode(mode === 'topdown' ? 'orbit' : mode === 'orbit' ? 'fps' : mode === 'fps' ? 'pan' : 'topdown'),
    onSettings: () => settings?.open(),
    ...(hudHost ? { host: hudHost } : {}),
    ...(hudLoad.ok ? {} : { error: hudLoad.error }),
  });
  // Defensive teardown: even though the host removes uiRoot whole on Stop, register
  // the HUD's own dispose so any listeners/timers it owns unwind on ■ (A layer).
  ctx?.registerCleanup?.(() => hud.dispose());
  const settingsState = createGameSettingsState();
  settings = hudHost ? mountSettings(settingsAsset, hudHost, settingsState, canvas, settingsLoad.ok ? undefined : settingsLoad.error) : null;
  const depthOfField: DepthOfFieldHandle = installDepthOfField(world, ctx?.renderer, settingsState.depthOfField);
  if (!depthOfField.installed && depthOfField.error) console.warn(`[game] depth-of-field unavailable: ${depthOfField.error}`);
  const chromaticAberration: ChromaticAberrationHandle = installChromaticAberration(
    world,
    ctx?.renderer,
    [DEPTH_OF_FIELD_ID, CHROMATIC_ABERRATION_ID],
  );
  if (!chromaticAberration.installed && chromaticAberration.error) console.warn(`[game] chromatic aberration unavailable: ${chromaticAberration.error}`);
  let appliedDepthOfField = settingsState.depthOfField;
  world.addSystem(Update, {
    name: 'game-depth-of-field-settings',
    queries: [],
    fn: () => {
      if (settingsState.depthOfField === appliedDepthOfField) return;
      appliedDepthOfField = settingsState.depthOfField;
      depthOfField.setEnabled(appliedDepthOfField);
    },
  }).unwrap();
  ctx?.registerCleanup?.(() => settings?.dispose());
  let appliedAntialias: AntialiasMode = settingsState.antialias;
  const antialiasValue = (mode: AntialiasMode): number => {
    if (mode === 'none') return ANTIALIAS_NONE;
    if (mode === 'msaa') return ANTIALIAS_MSAA;
    return ANTIALIAS_FXAA;
  };
  world.addSystem(Update, {
    name: 'game-antialias-settings',
    queries: [],
    fn: () => {
      if (settingsState.antialias === appliedAntialias) return;
      appliedAntialias = settingsState.antialias;
      world.set(camera, Camera, { antialias: antialiasValue(appliedAntialias) });
    },
  }).unwrap();
  let appliedBloom = settingsState.bloom;
  world.addSystem(Update, {
    name: 'game-bloom-settings',
    queries: [],
    fn: () => {
      if (settingsState.bloom === appliedBloom) return;
      appliedBloom = settingsState.bloom;
      world.set(camera, Camera, { bloom: appliedBloom ? BLOOM_ENABLED : BLOOM_DISABLED });
    },
  }).unwrap();
  let appliedClearColor = settingsState.clearColor;
  world.addSystem(Update, {
    name: 'game-clear-color-settings',
    queries: [],
    fn: () => {
      if (settingsState.clearColor === appliedClearColor) return;
      appliedClearColor = settingsState.clearColor;
      applyClearColor(world, camera, appliedClearColor);
    },
  }).unwrap();

  // Boot the view mode NOW so the engine input backend learns the lock policy
  // BEFORE the first canvas click. Without this, `setMode` only ran on the HUD
  // toggle, so the backend kept its default `gameGate = true` and allowed pointer
  // lock even in top-down — the 1st click locked, the 2nd click's setPointerCapture
  // then collided with the active lock and threw InvalidStateError (capture and
  // lock are mutually exclusive, W3C). Syncing the initial `mode` here forbids lock
  // in top-down from the start; toggling to fps re-allows it.
  setMode(mode);

  // World-space → canvas-CSS-pixel projection for the DOM "+N" popup. Reads
  // the camera's CURRENT Transform (the Update system that calls
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
    // Lift the world label above tall showcase props (the DOM popup keeps the
    // exact hit projection while GlyphText needs a depth-safe anchor).
    worldScoreText?.show(text, [wx, wy + 0.9, wz]);
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
  const PAD_BUTTON = (button: 0 | 1 | 2 | 3 | 7) => ({ type: 'gamepadButton', button } as const);
  const PAD_AXIS = (axis: 0 | 1, sign: 1 | -1) => ({ type: 'gamepadAxis', axis, sign } as const);
  const INPUT_MAP: readonly ActionConfig[] = [
    { action: 'moveForward', bindings: [KEY('w'), KEY('W'), PAD_AXIS(1, -1)] },
    { action: 'moveBack', bindings: [KEY('s'), KEY('S'), PAD_AXIS(1, 1)] },
    { action: 'moveLeft', bindings: [KEY('a'), KEY('A'), PAD_AXIS(0, -1)] },
    { action: 'moveRight', bindings: [KEY('d'), KEY('D'), PAD_AXIS(0, 1)] },
    { action: 'jump', bindings: [KEY(' '), PAD_BUTTON(0)] },
    { action: 'shoot', bindings: [KEY('f'), KEY('F'), PAD_BUTTON(7)] },
    { action: 'meshUv', bindings: [KEY('g'), KEY('G'), PAD_BUTTON(3)] },
    { action: 'meshHandle', bindings: [KEY('h'), KEY('H'), PAD_BUTTON(2)] },
    { action: 'fbxMesh', bindings: [KEY('j'), KEY('J')] },
    { action: 'freeUp', bindings: [KEY('e')] },
    { action: 'freeDown', bindings: [KEY('q')] },
    { action: 'freeRun', bindings: [KEY('Shift')] },
    { action: 'reset', bindings: [KEY('r'), KEY('R'), PAD_BUTTON(1)] },
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
  // world.update(1 / 60).unwrap(), which runs AFTER this frame's Update systems, so
  // the resource is absent on the very first tick. createInputSnapshot() is the
  // empty snapshot (all readpoints false / zero) — read it until the real one
  // lands (charter P3: empty signal is the signal).
  const EMPTY_SNAP = createInputSnapshot();
  const readInput = (): InputSnapshot =>
    world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)
      ? world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)
      : EMPTY_SNAP;

  // Input-to-intent systems own pointer-lock look and pointer-to-world aim.
  // Main keeps only the mutable state it consumes when steering the player and bullets.
  let px = initX, pz = initZ;
  let faceX = 0, faceZ = -1;
  gameplayInput = installGameplayInput({
    world,
    camera,
    canvas,
    hud,
    readInput,
    getMode: () => mode,
    getPlayerPosition: () => ({ x: px, z: pz }),
    setFacing: (x, z) => { faceX = x; faceZ = z; },
  });

  // Bullet material — EMISSIVE so it glows and drives the Camera.bloom bright-pass
  // (HDR emissive > bloomThreshold 1.0 → blooms). Showcases the post-processing path.
  const bulletMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ baseColor: [1, 0.85, 0.3, 1], roughness: 0.4, metallic: 0, emissive: [1, 0.7, 0.15], emissiveIntensity: 5 }));
  // Bullet mesh — a procedural capsule baked at its final size. The capsule is
  // oriented from +Y onto the shot direction below, so the geometry and physics
  // shape share one public primitive instead of hiding a second renderer-only
  // projectile representation.
  const BULLET_RADIUS = 0.12;
  const BULLET_HALF_HEIGHT = 0.16;
  const bulletMeshRes = createCapsuleGeometry(BULLET_RADIUS, BULLET_HALF_HEIGHT * 2, 6, 12);
  const bulletMesh = bulletMeshRes.ok ? world.allocSharedRef('MeshAsset', bulletMeshRes.value) : HANDLE_SPHERE;
  // The projectile is the template's runtime custom-mesh story: its visual
  // MeshAsset is hand-authored (12F position/normal/uv/tangent), its checker
  // texture is uploaded through the public GPU store, and G mutates the UV
  // buffer in place. The collider remains a capsule so visual mesh and physics
  // shape stay explicit rather than silently sharing an implementation detail.
  const customProjectile: CustomProjectileMesh | undefined = ctx?.renderer === undefined
    ? undefined
    : await createCustomProjectileMesh(world, ctx.renderer, ctx.assets);
  const projectileMesh = customProjectile?.meshHandle ?? bulletMesh;
  const projectileMaterial = customProjectile?.materialHandle ?? bulletMat;
  // Hit-flash material — a bright emissive white-yellow swapped onto a prop for a
  // few frames when a bullet strikes it (then restored to its base material).
  const flashMat = createHitFlashMaterial(world);
  const flashUntil = new Map<EntityHandle, number>();    // entity → remaining flash seconds
  const triggerFlash = (entity?: EntityHandle): void => {
    const target = entity === undefined ? flashables[0]?.e : entity;
    if (target === undefined || flashUntil.has(target)) return;
    world.set(target, MeshRenderer, { materials: [flashMat, ...(origMaterialsOf.get(target)?.slice(1) ?? [])] });
    flashUntil.set(target, 0.2);
    chromaticAberration.setIntensity(Math.max(chromaticAberration.snapshot().intensity, 0.035));
  };
  const multiMaterial = () => {
    const target = flashables.find((candidate) => candidate.materials.length > 1);
    if (target === undefined) return { available: false, materialCount: 0, submeshCount: 0, topologies: [], slotsAligned: false };
    const renderer = world.get(target.e, MeshRenderer);
    const filter = world.get(target.e, MeshFilter);
    const mesh = filter.ok
      ? world.sharedRefs.resolve<'MeshAsset', MeshAsset>(filter.value.assetHandle)
      : undefined;
    const materials = renderer.ok ? renderer.value.materials.length : 0;
    const submeshes = mesh?.ok === true ? mesh.value.submeshes : [];
    return {
      available: materials > 1 && materials === submeshes.length,
      materialCount: materials,
      submeshCount: submeshes.length,
      topologies: submeshes.map((submesh) => submesh.topology),
      slotsAligned: materials === submeshes.length && materials > 1,
    };
  };
  // squared hit radius for bullet→prop scoring (bullet_r 0.12 + avg prop_r 0.5 ≈
  // 0.7, plus frame-step slack since the bullet advances ~0.4/frame). Generous
  // overshoot is fine: the per-bullet `hits` set prevents duplicate scoring.
  const HIT2 = 0.9 * 0.9;

  // ── gameplay update (▶ Play only — ✎ Edit stays static) ─────────────────────
  const SPEED = 6;            // top-down/orbit walk speed (units/s)
  const BOUND = 11;           // keep the character on the 24-wide ground slab
  const JUMP_V = 6.5;         // initial jump velocity
  const GRAV = 18;            // jump gravity fed into CharacterController.moveAndSlide
  const BULLET_SPEED = 24;    // bullet travel speed (units/s)
  const BULLET_LIFE = 1.5;    // bullet lifetime (s)
  const SHOOT_CD = 0.18;      // fire cooldown (s)

  let jumpY = PLAYER_Y, freeY = PLAYER_Y, vy = 0, grounded = true;
  const freeCamera = createFreeCameraState();
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
  const bullets: Array<{ e: EntityHandle; x: number; y: number; z: number; dx: number; dy: number; dz: number; quat: [number, number, number, number]; age: number; hits: Set<EntityHandle> }> = [];
  let deferredBulletSpawns = 0;
  let deferredBulletDespawns = 0;

  type TransformSnapshot = {
    pos: [number, number, number];
    quat: [number, number, number, number];
    scale: [number, number, number];
  };
  const initialTransforms = new Map<EntityHandle, TransformSnapshot>();
  for (const prop of flashables) {
    const tr = world.get(prop.e, Transform);
    if (!tr.ok) continue;
    initialTransforms.set(prop.e, {
      pos: [tr.value.pos[0] ?? 0, tr.value.pos[1] ?? 0, tr.value.pos[2] ?? 0],
      quat: [tr.value.quat[0] ?? 0, tr.value.quat[1] ?? 0, tr.value.quat[2] ?? 0, tr.value.quat[3] ?? 1],
      scale: [tr.value.scale[0] ?? 1, tr.value.scale[1] ?? 1, tr.value.scale[2] ?? 1],
    });
  }
  const physics = world.hasResource('PhysicsWorld')
    ? world.getResource<PhysicsWorld>('PhysicsWorld')
    : undefined;
  const debugAxes = installDebugAxes({
    world,
    targets: flashables.map((target) => target.e),
    debugDraw: ctx?.app.debugDraw,
    registerCleanup,
  });
  const gameplayAudio = player === undefined
    ? undefined
    : await installGameplayAudio(world, player, ctx?.assets);
  installAudioEvidence({ world, gameplayAudio, registerCleanup });
  let appliedMusicVolume = -1;
  let appliedMusicMuted = false;
  world.addSystem(Update, {
    name: 'game-music-settings',
    queries: [],
    fn: () => {
      const volume = settingsState.music / 100;
      if (volume === appliedMusicVolume && settingsState.musicMuted === appliedMusicMuted) return;
      appliedMusicVolume = volume;
      appliedMusicMuted = settingsState.musicMuted;
      gameplayAudio?.setMusicSettings(volume, settingsState.musicMuted);
    },
  }).unwrap();

  const resetGameplay = () => {
    debugAxes.reset();
    for (const bullet of bullets) world.despawn(bullet.e);
    bullets.length = 0;
    for (const [entity, timer] of flashUntil) {
      if (timer > 0) world.set(entity, MeshRenderer, { materials: [...(origMaterialsOf.get(entity) ?? [])] });
    }
    flashUntil.clear();
    for (const [entity, snapshot] of initialTransforms) {
      world.set(entity, Transform, snapshot);
      if (physics?.hasBody(entity)) physics.teleport(entity, snapshot.pos);
    }
    px = initX;
    pz = initZ;
    faceX = 0;
    faceZ = -1;
    jumpY = PLAYER_Y;
    freeY = PLAYER_Y;
    resetFreeCamera(freeCamera);
    vy = 0;
    grounded = true;
    shootCd = 0;
    gameplayInput.lookYaw = 0;
    gameplayInput.lookPitch = 0;
    gameplayInput.wantShoot = false;
    gameplayInput.shotDir = null;
    camX = initX;
    camZ = initZ + TOP_DZ;
    panX = initX;
    panZ = initZ + TOP_DZ;
    panHalfHeight = PAN_HALF_HEIGHT_INITIAL;
    perspectiveFov = PERSPECTIVE_FOV_INITIAL;
    world.set(camera, Camera, { fov: perspectiveFov });
    changeDetection.reset();
    targetDisabling.reset();
    targetHealth.reset();
    depthOfField.reset();
    chromaticAberration.reset();
    worldScoreText?.reset();
    if (customProjectile !== undefined) resetCustomProjectileMesh(customProjectile);
    resetMeshHandleSwap(world, meshHandleSwap);
    resetFbxMeshSwap(world, fbxMeshSwap);
    fbxSkinnedTarget?.reset();
    settingsState.depthOfField = false;
    appliedDepthOfField = false;
    setMode('topdown');
    multiWorldOverlay?.setEnabled(true);
    if (player !== undefined) {
      world.set(player, Transform, { pos: [px, jumpY, pz], quat: [0, 0, 0, 1] });
      if (physics?.hasBody(player)) physics.teleport(player, [px, jumpY, pz]);
    }
    gameplayAudio?.reset();
    materialElapsedOrigin = world.getResource(Time).elapsed;
    if (animatedMaterial) resetAnimatedMaterial(world, animatedMaterial);
  };
  const gameplayState = installGameplayState({ world, reset: resetGameplay });
  installGameplayLifecycle({ world, readInput, requestReset: gameplayState.requestReset });

  // Preview's inspection host owns transport and lifecycle; the game owns the
  // meaning of each projection. These are deliberately small, JSON-shaped
  // front doors instead of a second raw World/evidence global. They are absent
  // in hosts that do not provide BootstrapContext.gameProjection.
  if (ctx?.gameProjection) {
    const projectionDisposers = [
      ctx.gameProjection.registerRead({
        id: 'game-default.snapshot',
        title: 'Read gameplay snapshot',
        description: 'Read phase, camera mode, fixed-step witness, and target lifecycle counts.',
        read: (): GameProjectionValue => {
          const cameraData = world.get(camera, Camera);
          return {
            state: gameplayState.snapshot(),
            viewMode: mode,
            cameraProjection: cameraData.ok && cameraData.value.projection === 1 ? 'orthographic' : 'perspective',
            targetHealth: targetHealth.snapshot(),
            targetDisabling: targetDisabling.snapshot(),
            multiWorld: multiWorldOverlay?.snapshot() ?? { enabled: false, worldCount: 1, entityCount: 0, cameraOwner: 0, resourceOwner: 0 },
            worldScoreText: worldScoreText?.snapshot() ?? { available: false, baked: false, active: false, text: '', age: 0, position: [0, 0, 0] },
            fbxSkinnedTarget: fbxSkinnedTarget?.snapshot() ?? { available: false, root: null, skinEntity: null, clipGuid: null, jointCount: 0, position: [0, 0, 0], scale: [1, 1, 1], worldMatrix: [], animationTime: 0, hitPulses: 0 },
          };
        },
      }),
      ctx.gameProjection.registerRead({
        id: 'game-default.renderer-contract',
        title: 'Read renderer contract',
        description: 'Read the public renderer health and registered material shader ids.',
        read: (): GameProjectionValue => ({
          health: ctx.renderer?.health() ?? { reason: 'unavailable', recoverable: false },
          materialShaderIdentifiers: ctx.renderer?.shader.materialShaderIdentifiers() ?? [],
        }),
      }),
      ctx.gameProjection.registerAction({
        id: 'game-default.reset',
        title: 'Request gameplay reset',
        description: 'Request the typed Reset state; cleanup runs through the normal lifecycle owner.',
        run: () => {
          gameplayState.requestReset();
          return { requested: true };
        },
      }),
      ctx.gameProjection.registerAction({
        id: 'game-default.invalid-state',
        title: 'Exercise invalid state recovery',
        description: 'Send an adjacent invalid state through the public state API and return its error code.',
        run: () => ({ errorCode: gameplayState.requestInvalid() ?? null }),
      }),
      ctx.gameProjection.registerAction({
        id: 'game-default.trigger-hit',
        title: 'Trigger hit feedback',
        description: 'Use the same hit-flash/material/audio feedback owner as a real projectile hit.',
        run: () => {
          triggerFlash();
          fbxSkinnedTarget?.triggerHit();
          return { triggered: true };
        },
      }),
      ctx.gameProjection.registerAction({
        id: 'game-default.toggle-multi-world',
        title: 'Toggle secondary world',
        description: 'Enable or disable two beacon entities rendered from a secondary World using the primary camera and lights.',
        run: () => {
          if (multiWorldOverlay === undefined) return { enabled: false, available: false };
          const nextEnabled = !multiWorldOverlay.snapshot().enabled;
          multiWorldOverlay.setEnabled(nextEnabled);
          return { enabled: nextEnabled, available: true };
        },
      }),
      ctx.gameProjection.registerAction({
        id: 'game-default.set-view',
        title: 'Set camera view',
        description: 'Switch the existing camera owner without creating a second camera.',
        argsSchema: {
          type: 'object',
          required: ['mode'],
          properties: { mode: { type: 'string', enum: ['topdown', 'orbit', 'fps', 'pan'] } },
        },
        run: (args) => {
          const modeValue = typeof args === 'object' && args !== null && !Array.isArray(args)
            ? args.mode
            : undefined;
          if (modeValue !== 'topdown' && modeValue !== 'orbit' && modeValue !== 'fps' && modeValue !== 'pan') {
            throw new Error('mode must be one of topdown, orbit, fps, pan');
          }
          setMode(modeValue);
          return { viewMode: modeValue };
        },
      }),
    ];
    ctx.registerCleanup?.(() => {
      for (const dispose of projectionDisposers.reverse()) dispose();
    });
  }

  if (player !== undefined) {
    const root = player;
    world
      .addSystem(Update, {
        name: 'game-update',
        runIf: inState(GameState, 'Play'),
        queries: [],
        fn: (_world, _queryResults, commands) => {
          const dt = world.getResource(Time).delta;
          const snap = readInput();
          gameplayAudio?.setMusicPlaying(true);
          gameplayAudio?.rearm();
          if (customProjectile !== undefined && snap.action('meshUv').justPressed()) {
            toggleCustomProjectileMesh(customProjectile);
          }
          if (meshHandleSwap !== undefined && snap.action('meshHandle').justPressed()) {
            toggleMeshHandleSwap(world, meshHandleSwap);
          }
          if (fbxMeshSwap !== undefined && snap.action('fbxMesh').justPressed()) {
            toggleFbxMeshSwap(world, fbxMeshSwap);
          }
      const arrowUp = snap.action('arrowUp').isPressed();
      const arrowDown = snap.action('arrowDown').isPressed();
      const arrowLeft = snap.action('arrowLeft').isPressed();
      const arrowRight = snap.action('arrowRight').isPressed();

      if (mode === 'pan') {
        const panXInput = (arrowRight ? 1 : 0) - (arrowLeft ? 1 : 0);
        const panZInput = (arrowDown ? 1 : 0) - (arrowUp ? 1 : 0);
        if (panXInput !== 0 || panZInput !== 0) {
          const length = Math.hypot(panXInput, panZInput) || 1;
          panX = Math.max(-BOUND, Math.min(BOUND, panX + (panXInput / length) * PAN_SPEED * dt));
          panZ = Math.max(-BOUND + TOP_DZ, Math.min(BOUND + TOP_DZ, panZ + (panZInput / length) * PAN_SPEED * dt));
        }
        if (snap.mouse.wheelDelta !== 0) {
          panHalfHeight = Math.max(PAN_HALF_HEIGHT_MIN, Math.min(PAN_HALF_HEIGHT_MAX, panHalfHeight + snap.mouse.wheelDelta * 0.5));
        }
      }
      if ((mode === 'fps' || mode === 'orbit') && snap.mouse.wheelDelta !== 0) {
        perspectiveFov = zoomPerspectiveFov(perspectiveFov, snap.mouse.wheelDelta);
        world.set(camera, Camera, { fov: perspectiveFov });
      }

      // — Orbit/FPS look via arrow keys (keyboard fallback: mouse-look needs
      //   pointer lock, which the embedded preview iframe disallows). —
      if (mode === 'fps' || mode === 'orbit') {
        const TURN = 2.4;
        if (arrowLeft) gameplayInput.lookYaw += TURN * dt;
        if (arrowRight) gameplayInput.lookYaw -= TURN * dt;
        if (arrowUp) gameplayInput.lookPitch = Math.min(1.2, gameplayInput.lookPitch + TURN * 0.6 * dt);
        if (arrowDown) gameplayInput.lookPitch = Math.max(-1.2, gameplayInput.lookPitch - TURN * 0.6 * dt);
      }

      // — movement + facing, per view mode —
      // intent axes: f = forward(+)/back(−), s = strafe right(+)/left(−). WASD
      // come from the InputMap getVector (radial deadzone; diagonal magnitude 1).
      // Arrows alias WASD only in top-down; in FPS they steer the view (above).
      const am = mode === 'topdown';   // arrows-move (top-down only)
      const move = snap.getVector('moveLeft', 'moveRight', 'moveBack', 'moveForward');
      // getVector's Y is (posY action=moveForward) − (negY=moveBack); forward intent f
      // is +forward, so f = move.y. s = strafe right(+)/left(−) = move.x.
      const f = move.y + (am ? ((arrowUp ? 1 : 0) - (arrowDown ? 1 : 0)) : 0);
      const s = move.x + (am ? ((arrowRight ? 1 : 0) - (arrowLeft ? 1 : 0)) : 0);
      let mvx = 0, mvz = 0;
      if (mode !== 'fps') {
        freeY = jumpY;
        resetFreeCamera(freeCamera);
      }
      if (mode === 'fps') {
        // look-relative; facing = look forward (front = local −Z; yaw 0 → (0,−1))
        const fwdX = -Math.sin(gameplayInput.lookYaw), fwdZ = -Math.cos(gameplayInput.lookYaw);
        const rgtX = -fwdZ, rgtZ = fwdX;          // +90° about Y → strafe right
        faceX = fwdX; faceZ = fwdZ;
        const vertical = Number(snap.action('freeUp').isPressed()) - Number(snap.action('freeDown').isPressed());
        const dx = fwdX * f + rgtX * s;
        const dz = fwdZ * f + rgtZ * s;
        const delta = stepFreeCamera(freeCamera, dt, [dx, vertical, dz], snap.action('freeRun').isPressed(), snap.mouse.wheelDelta);
        px = Math.max(-BOUND, Math.min(BOUND, px + (delta[0] ?? 0)));
        pz = Math.max(-BOUND, Math.min(BOUND, pz + (delta[2] ?? 0)));
        freeY = Math.max(0.2, freeY + (delta[1] ?? 0));
        mvx = 0; mvz = 0;
      } else {
        // top-down: world-relative; facing = movement direction
        mvx = s; mvz = -f;                          // W → −Z, D → +X
        if (mvx !== 0 || mvz !== 0) { const l = Math.hypot(mvx, mvz); faceX = mvx / l; faceZ = mvz / l; }
      }
      // — collision-aware movement (top-down/orbit) —
      // Input, gravity, and jump remain game policy; the physics backend owns
      // slope handling, auto-step, ground snap, collision response, and the
      // transient grounded result. This keeps one movement owner for the game.
      if (mode !== 'fps' && physics?.hasBody(root)) {
        const before = world.get(root, CharacterController);
        grounded = before.ok && before.value.grounded === true;
        if (snap.action('jump').justPressed() && grounded) { vy = JUMP_V; grounded = false; }
        vy -= GRAV * dt;
        if (grounded && vy < 0) vy = -GRAV * dt;
        const l = Math.hypot(mvx, mvz) || 1;
        const step = SPEED * dt;
        physics.moveAndSlide(root, vec3.create((mvx / l) * step, vy * dt, (mvz / l) * step));
        const tr = world.get(root, Transform);
        if (tr.ok) {
          px = Math.max(-BOUND, Math.min(BOUND, tr.value.pos[0] ?? px));
          pz = Math.max(-BOUND, Math.min(BOUND, tr.value.pos[2] ?? pz));
          jumpY = tr.value.pos[1] ?? jumpY;
        }
        const after = world.get(root, CharacterController);
        grounded = after.ok && after.value.grounded === true;
        if (grounded) vy = 0;
      } else if (mode !== 'fps') {
        // The normal host builds physics before bootstrap. A deliberately
        // physics-free host keeps its first frame harmless instead of throwing.
        jumpY = PLAYER_Y;
      } else if (physics?.hasBody(root)) {
        // A CharacterController disables authored kinematic mirroring. FPS is
        // free-flight by design, so explicitly keep the collider body in sync.
        physics.teleport(root, [px, freeY, pz]);
      }

      // — drive the kinematic root: position + facing yaw (front = local −Z) —
      const yaw = Math.atan2(-faceX, -faceZ);
      const q = quat.eulerY(yaw);
      if (mode === 'fps') {
        world.set(root, Transform, { pos: [px, freeY, pz], quat: [q[0]!, q[1]!, q[2]!, q[3]!]});
      } else {
        world.set(root, Transform, { quat: [q[0]!, q[1]!, q[2]!, q[3]!]});
      }
      const playerY = mode === 'fps' ? freeY : jumpY;

      // — shoot (F, or left-click in FPS): kinematic bullet flies along `face` —
      shootCd -= dt;
      const fire = (snap.action('shoot').isPressed() || gameplayInput.wantShoot) && shootCd <= 0;
      gameplayInput.wantShoot = false;
      if (fire) {
        shootCd = SHOOT_CD;
        // 3D shot direction, per mode:
        //   FPS:      full look dir (yaw + pitch) — crosshair can aim DOWN.
        //   Top-down: shotDir from the click (consumed once); falls back to
        //             facing if F was pressed without a recent click.
        // Origin: FPS from the eye, top-down from chest (≈ prop height ~0.5).
        let dirX = faceX, dirY = 0, dirZ = faceZ;
        let by = playerY + 0.15;
        if (mode === 'fps') {
          const cp = Math.cos(gameplayInput.lookPitch);
          dirX = -Math.sin(gameplayInput.lookYaw) * cp; dirY = Math.sin(gameplayInput.lookPitch); dirZ = -Math.cos(gameplayInput.lookYaw) * cp;
          by = freeY + EYE;
        } else if (gameplayInput.shotDir) {
          dirX = gameplayInput.shotDir.x; dirZ = gameplayInput.shotDir.z; dirY = 0;
        }
        gameplayInput.shotDir = null;   // one-shot snapshot consumed
        const bx = px + dirX * 0.6, byy = by + dirY * 0.6, bz = pz + dirZ * 0.6;
        const bulletQuat = quat.fromUnitVectors(quat.create(), [0, 1, 0], [dirX, dirY, dirZ]);
        const e = commands.spawn(
          { component: Transform, data: { pos: [bx, byy, bz], quat: [bulletQuat[0]!, bulletQuat[1]!, bulletQuat[2]!, bulletQuat[3]!]} },
          { component: MeshFilter, data: { assetHandle: projectileMesh } },
          { component: MeshRenderer, data: { materials: [projectileMaterial] } },
          // ccdEnabled sweeps the fast kinematic bullet's collider along each
          // step so it reliably contacts props instead of tunneling through.
          { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic, ccdEnabled: true } },
          { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: BULLET_RADIUS, halfHeight: BULLET_HALF_HEIGHT, friction: 0, restitution: 0.6 } },
        );
        deferredBulletSpawns += 1;
        bullets.push({ e, x: bx, y: byy, z: bz, dx: dirX, dy: dirY, dz: dirZ, quat: [bulletQuat[0]!, bulletQuat[1]!, bulletQuat[2]!, bulletQuat[3]!], age: 0, hits: new Set<EntityHandle>() });
      }
      // Advance + cull bullets (3D travel). Bullets fly THROUGH props (not
      // despawned on hit) so each prop gets several frames of kinematic-vs-
      // dynamic contact → reliable push. They despawn only on lifetime expiry.
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i]!;
        b.age += dt;
        if (b.age > BULLET_LIFE) { commands.despawn(b.e); deferredBulletDespawns += 1; bullets.splice(i, 1); continue; }
        b.x += b.dx * BULLET_SPEED * dt;
        b.y += b.dy * BULLET_SPEED * dt;
        b.z += b.dz * BULLET_SPEED * dt;
        if (!commands.isDeferred(b.e)) world.set(b.e, Transform, { pos: [b.x, b.y, b.z], quat: b.quat });
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
            const pts = scoringPoints(fl.e);
            if (pts !== undefined) {
              changeDetection.recordHit(fl.e, pts);
              damageTarget(fl.e, pts);
              spawnPopup('+' + pts, fxp, fyp + 0.8, fzp);
              gameplayAudio?.triggerHit();
            }
            if (!flashUntil.has(fl.e)) triggerFlash(fl.e);
          }
        }
      }
      for (const [e, t] of flashUntil) {
        const nt = t - dt;
        if (nt <= 0) {
          world.set(e, MeshRenderer, { materials: [...(origMaterialsOf.get(e) ?? [])] });
          flashUntil.delete(e);
        } else flashUntil.set(e, nt);
      }
      const chromaticIntensity = chromaticAberration.snapshot().intensity;
      if (chromaticIntensity > 0) chromaticAberration.setIntensity(Math.max(0, chromaticIntensity - dt * 0.14));

      // — camera, per view mode —
      if (mode === 'fps') {
        const qy = quat.create(); quat.fromAxisAngle(qy, [0, 1, 0], gameplayInput.lookYaw);
        const qx = quat.create(); quat.fromAxisAngle(qx, [1, 0, 0], gameplayInput.lookPitch);
        const cq = quat.create(); quat.multiply(cq, qy, qx);
        world.set(camera, Transform, { pos: [px, freeY + EYE, pz], quat: [cq[0]!, cq[1]!, cq[2]!, cq[3]!]});
      } else if (mode === 'orbit') {
        const pose = orbitPose([px, jumpY + 0.8, pz], ORBIT_INITIAL_YAW + gameplayInput.lookYaw, ORBIT_INITIAL_PITCH + gameplayInput.lookPitch, ORBIT_RADIUS);
        world.set(camera, Transform, { pos: pose.pos, quat: pose.quat });
      } else if (mode === 'pan') {
        applyPanCamera();
      } else {
        const a = 1 - Math.exp(-CAM_FOLLOW * dt);
        camX += (px - camX) * a;
        camZ += (pz + TOP_DZ - camZ) * a;
        world.set(camera, Transform, { pos: [camX, TOP_DY, camZ], quat: [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!]});
      }
      worldScoreText?.step(dt, camera);
        },
      })
      .unwrap();

    changeDetection = installGameplayChangeDetection({ world, targets: flashables.map((target) => target.e), hud });
    installRenderEvidence({
      renderer: ctx?.renderer,
      flashables,
      triggerFlash: () => triggerFlash(),
      triggerScore: () => {
        const target = flashables[0];
        const points = target === undefined ? undefined : scoringPoints(target.e);
        if (target !== undefined && points !== undefined) {
          changeDetection.recordHit(target.e, points);
          damageTarget(target.e, points);
          const transform = world.get(target.e, Transform);
          if (transform.ok) {
            worldScoreText?.show('+' + points, [
              transform.value.pos[0] ?? 0,
              (transform.value.pos[1] ?? 0) + 1.7,
              transform.value.pos[2] ?? 0,
            ]);
          }
        }
      },
      hitFlashBlendEnabled: () => {
        const material = world.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(flashMat);
        return material.ok && material.value.passes?.[0]?.renderState?.blend !== undefined;
      },
      bloomEnabled: () => settingsState.bloom,
      toggleBloom: () => { settingsState.bloom = !settingsState.bloom; },
      depthOfField,
      chromaticAberration,
      viewMode: () => mode,
      setViewMode: setMode,
      cameraRadius: () => {
        const tr = world.get(camera, Transform);
        if (!tr.ok || mode !== 'orbit') return Number.NaN;
        return Math.hypot(tr.value.pos[0] - px, tr.value.pos[1] - (jumpY + 0.8), tr.value.pos[2] - pz);
      },
      cameraPosition: () => {
        const tr = world.get(camera, Transform);
        return tr.ok ? [tr.value.pos[0] ?? 0, tr.value.pos[1] ?? 0, tr.value.pos[2] ?? 0] : null;
      },
      cameraProjection: () => {
        const data = world.get(camera, Camera);
        return data.ok && data.value.projection === 1 ? 'orthographic' : 'perspective';
      },
      cameraPerspectiveFov: () => {
        const data = world.get(camera, Camera);
        return data.ok && data.value.projection === 0 ? data.value.fov : Number.NaN;
      },
      cameraOrthoHalfHeight: () => {
        const data = world.get(camera, Camera);
        return data.ok && data.value.projection === 1 ? data.value.top : Number.NaN;
      },
      animatedMaterial,
      clearcoatMaterial: () => {
        const target = flashables.find((candidate) => candidate.clearcoat === true);
        if (target === undefined) return null;
        const material = world.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(target.materials[0] ?? (0 as MatHandle));
        if (!material.ok) return null;
        const values = material.value.values as Record<string, unknown> | undefined;
        const strength = Number(values?.clearcoat ?? 0);
        const roughness = Number(values?.clearcoatRoughness ?? 0);
        return { enabled: strength > 0, strength, roughness };
      },
      deferredCommands: () => ({ spawned: deferredBulletSpawns, despawned: deferredBulletDespawns }),
      multiMaterial,
      multiWorld: multiWorldOverlay?.snapshot,
      customProjectileMesh: customProjectile === undefined ? undefined : () => ({
        available: true,
        uvMode: customProjectile.uvMode,
        toggles: customProjectile.toggles,
        textureSource: customProjectile.textureSource,
        textureFormat: customProjectile.textureFormat,
      }),
      toggleCustomProjectileMesh: customProjectile === undefined ? undefined : () => toggleCustomProjectileMesh(customProjectile),
      meshHandleSwap: meshHandleSwap === undefined ? undefined : () => ({ active: meshHandleSwap.active, swaps: meshHandleSwap.swaps }),
      toggleMeshHandleSwap: meshHandleSwap === undefined ? undefined : () => toggleMeshHandleSwap(world, meshHandleSwap),
      fbxMeshSwap: fbxMeshSwap === undefined ? undefined : () => ({ active: fbxMeshSwap.active, swaps: fbxMeshSwap.swaps }),
      toggleFbxMeshSwap: fbxMeshSwap === undefined ? undefined : () => toggleFbxMeshSwap(world, fbxMeshSwap),
      fbxSkinnedTarget: fbxSkinnedTarget?.snapshot,
      characterController: () => {
        const controller = world.get(root, CharacterController);
        const transform = world.get(root, Transform);
        return {
          grounded: controller.ok && controller.value.grounded === true,
          position: [transform.ok ? (transform.value.pos[0] ?? 0) : 0, transform.ok ? (transform.value.pos[1] ?? 0) : 0, transform.ok ? (transform.value.pos[2] ?? 0) : 0],
        };
      },
      targetHealth: () => targetHealth.snapshot(),
      targetDisabling: () => targetDisabling.snapshot(),
      worldScoreText: worldScoreText?.snapshot,
      isFlashed: (entity) => flashUntil.has(entity),
      reset: resetGameplay,
      state: gameplayState,
      changeDetection,
      input: readInput,
      registerCleanup,
    });

    world
      .addSystem(Update, {
        name: 'game-rotating-targets',
        runIf: inState(GameState, 'Play'),
        after: [FixedUpdate],
        queries: [],
        fn: () => {
          // Run after physics writeback so the authored motion survives the
          // dynamic target's pose sync and is visible in the next frame.
          if (!assetEvidenceMode) stepRotatingTargets(world, world.getResource(Time).delta);
          if (animatedMaterial && !assetEvidenceMode) {
            const elapsed = world.getResource(Time).elapsed - materialElapsedOrigin;
            stepAnimatedMaterial(world, animatedMaterial, elapsed);
          }
        },
      })
      .unwrap();

    world
      .addSystem(Update, {
        name: 'game-debug-axes',
        runIf: inState(GameState, 'Play'),
        after: ['game-rotating-targets'],
        queries: [],
        fn: () => debugAxes.draw(),
      })
      .unwrap();

    world
      .addSystem(Update, {
        name: 'game-reset-camera',
        runIf: inState(GameState, 'Reset'),
        queries: [],
        after: ['transitionStates'],
        before: [FixedUpdate],
        fn: () => {
          // Reset owns the gameplay coordinates synchronously; mirror them to
          // the camera while the simulation waits for the deferred Play entry.
          world.set(camera, Transform, {
            pos: [camX, TOP_DY, camZ],
            quat: [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!],
          });
        },
      })
      .unwrap();
  }

  // A host may provide a scene without the optional Player name while still
  // wanting to inspect the template camera. Keep orbit discoverable in that
  // case by driving its player-relative target from the deterministic fallback
  // coordinates already used by the gameplay state.
  if (player === undefined) {
    world.addSystem(Update, {
      name: 'game-camera-fallback',
      runIf: inState(GameState, 'Play'),
      queries: [],
      fn: () => {
        if (mode !== 'orbit') return;
        const pose = orbitPose([px, jumpY + 0.8, pz], ORBIT_INITIAL_YAW + gameplayInput.lookYaw, ORBIT_INITIAL_PITCH + gameplayInput.lookPitch, ORBIT_RADIUS);
        world.set(camera, Transform, { pos: pose.pos, quat: pose.quat });
      },
    }).unwrap();
    world.addSystem(Update, {
      name: 'game-world-score-text-fallback',
      runIf: inState(GameState, 'Play'),
      queries: [],
      after: ['game-camera-fallback'],
      fn: () => worldScoreText?.step(world.getResource(Time).delta, camera),
    }).unwrap();
  }
}
