// hello-skin -- Fox.glb + AnimationPlayer demo. Three clips (Survey / Walk /
// Run) are sub-assets of the same gltf. Five keystroke paths exercise the
// full N-way SoA schema (clips/times/weights/speeds inline arrays of arity 4
// + paused/looping bool):
//
//   Hard cuts (skin-clip-toggle system) -- single-slot write:
//     [1] Survey  -> clips=[surveyH,0,0,0]  weights=[1,0,0,0]
//     [2] Walk    -> clips=[walkH,  0,0,0]  weights=[1,0,0,0]
//     [3] Run     -> clips=[runH,   0,0,0]  weights=[1,0,0,0]
//
//   Soft blends (skin-blend-driver system, feat-20260615) -- multi-slot:
//     [4] Walk -> Run 0.3s linear crossfade. weights[0..1] interpolate
//                 (1-t, t), slots 2..3 zero. Time-driven write per frame
//                 while in-flight; settles on weights=[0,1,0,0] (pure Run).
//     [5] Walk + Survey + Run 3-way steady -- one-shot write:
//                 weights=[1/3, 1/3, 1/3, 0], slots 0..2 active.
//
//   [Space] toggle paused -- bypasses dt accumulation in advanceAnimationPlayer.
//
// The two systems are kept *physically separate* (D-8) so an AI user reading
// the demo can grep `skin-clip-toggle` for the hard-cut path and
// `skin-blend-driver` for the blend path without untangling intermixed
// branches.
//
// bug-20260612 visual layered gate convergence: PR ships two engine fixes
// (clip resolver lookup + joint-name resolution) that were previously
// masking AnimationPlayer side effects, so this demo doubles as the visual
// smoke for the full skin path.

import { createApp } from '@forgeax/engine-app';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  AnimationPlayer,
  Camera,
  ChildOf,
  createDevImportTransport,
  DirectionalLight,
  EngineEnvironmentError,
  perspective,
  SceneInstance,
  Skin,
  Transform,
} from '@forgeax/engine-runtime';
import type { AnimationClip, Handle, SceneAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const PACK_INDEX_URL = '/pack-index.json';
const FOX_SCENE_GUID = '019eb2ce-6232-74a0-8da7-00be6d2f8774';

// Three clips authored in Fox.glb; emitted as separate animation-clip
// sub-assets by gltf-importer (one per glTF animations[] entry). GUID order
// matches sourceIndex order in Fox.glb.meta.json subAssets[].
const CLIPS = [
  { name: 'Survey', guid: '019eb2ce-6232-74a0-8da7-00c2414d45c4' },
  { name: 'Walk', guid: '019eb2ce-6233-74f3-a877-ebea0a513ea9' },
  { name: 'Run', guid: '019eb2ce-6233-74f3-a877-ebeb96c4f15d' },
] as const;

const CLEAR_R = 0.0;
const CLEAR_G = 0.4;
const CLEAR_B = 0.4;
const CLEAR_A = 1.0;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-skin: missing <canvas id="app"> in index.html');

resizeCanvasToDisplaySize(canvas);
window.addEventListener('resize', () => resizeCanvasToDisplaySize(canvas));

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[skin] env:', err);
  else console.error('[skin] error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[skin] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world: World = app.world;
  const renderer = app.renderer;
  console.warn(`[skin] backend=${renderer.backend}`);

  const assets = renderer.assets;
  if (assets === null) {
    console.error('[skin] AssetRegistry is null');
    return;
  }
  assets.configurePackIndex(PACK_INDEX_URL);

  // Resolve scene + every clip GUID up front so swapping is just a Handle
  // assignment in the toggle system (no async in the per-frame path).
  const sceneGuidRes = AssetGuid.parse(FOX_SCENE_GUID);
  if (!sceneGuidRes.ok) {
    console.error('[skin] AssetGuid.parse(scene) failed');
    return;
  }
  const sceneRes = await assets.loadByGuid<SceneAsset>(sceneGuidRes.value);
  if (!sceneRes.ok) {
    console.error('[skin] loadByGuid(scene) failed:', sceneRes.error);
    return;
  }
  // loadByGuid returns the payload (D-17); mint a user-tier SceneAsset column
  // handle before instantiate.
  const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);

  type ClipHandle = Handle<'AnimationClip', 'shared'>;
  const clipHandles: { name: string; clip: ClipHandle }[] = [];
  for (const def of CLIPS) {
    const guidRes = AssetGuid.parse(def.guid);
    if (!guidRes.ok) {
      console.error('[skin] AssetGuid.parse failed for', def.name);
      return;
    }
    const clipRes = await assets.loadByGuid<AnimationClip>(guidRes.value);
    if (!clipRes.ok) {
      console.error('[skin] loadByGuid failed for', def.name, clipRes.error);
      return;
    }
    // loadByGuid returns the payload (D-17); mint a user-tier column handle.
    const clip = world.allocSharedRef('AnimationClip', clipRes.value);
    clipHandles.push({ name: def.name, clip });
  }

  const instRes = assets.instantiate<SceneAsset>(sceneHandle, world);
  if (!instRes.ok) {
    console.error('[skin] instantiate failed:', (instRes.error as { code: string }).code);
    return;
  }

  // Find the Skin entity inside the spawned hierarchy. AnimationPlayer is a
  // single component on this one entity; advanceAnimationPlayer (auto-
  // registered by createApp) drives joint Transforms, render-system-extract
  // writes Transform.world * IBM into the per-frame skin palette upload.
  const root = instRes.value;

  // bug-20260615-skin-mesh-node-double-transform: parent the Fox under a
  // non-identity rig. With the shader fix (M1), the skinned mesh rigid-follows
  // the parent; without it, the parent transform doubles. posY=1 lifts the Fox
  // 1 world unit upward (~30px at 200x150 smoke resolution), producing a
  // visible pixel difference between parented and identity-parent modes.
  const parentRig = world
    .spawn({
      component: Transform,
      data: { posX: 0, posY: 1, posZ: 0, quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
    })
    .unwrap();
  world.addComponent(root, { component: ChildOf, data: { parent: parentRig } });

  const inst = world.get(root, SceneInstance);
  if (!inst.ok) {
    console.error('[skin] root has no SceneInstance');
    return;
  }
  let playerEnt: EntityHandle | undefined;
  for (let i = 0; i < inst.value.mapping.length; i++) {
    const entRaw = inst.value.mapping[i];
    if (entRaw === undefined || entRaw === 0) continue;
    const ent = entRaw as EntityHandle;
    if (!world.get(ent, Skin).ok) continue;
    world.addComponent(ent, {
      component: AnimationPlayer,
      data: {
        // Short-prefix init: writeArrayField pads slot 1..3 with zeros so the
        // engine skip-iterates them. Single-slot weights[0]=1 reproduces the
        // old single-clip blend (engine normalizes per channel by Σw).
        // speeds defaults to [1,1,1,1] from the schema; paused/looping inherit.
        clips: [clipHandles[0]!.clip],
        weights: [1],
      },
    });
    playerEnt = ent;
    break;
  }
  if (playerEnt === undefined) {
    console.error('[skin] no Skin entity in instantiated scene');
    return;
  }

  // Camera + light. Fox.glb authored in cm (joint Y up to ~60, body span
  // ~140 cm) so the frustum has to match: camera at (0, 35, 280) with far=500.
  world
    .spawn(
      { component: Transform, data: { posX: 0, posY: 35, posZ: 280 } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 1, far: 500 }),
          clearR: CLEAR_R,
          clearG: CLEAR_G,
          clearB: CLEAR_B,
          clearA: CLEAR_A,
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        directionX: -0.5,
        directionY: -1,
        directionZ: -0.3,
        colorR: 1,
        colorG: 1,
        colorB: 1,
        intensity: 1,
      },
    })
    .unwrap();

  // Press-edge keyboard systems. InputSnapshot exposes only down (held) +
  // up (release-edge); a press-edge is derived from prev-frame level. This
  // is the same pattern used by hello-bloom / hello-fxaa space toggles.
  // KeyboardEvent.key matches: spacebar = ' ', digits = '1' / '2' / '3' / '4' / '5'.
  //
  // Two systems run in parallel after input-frame-start-scan (D-8):
  //   * skin-clip-toggle    -- hard-cut path (keys 1/2/3 + Space)
  //   * skin-blend-driver   -- crossfade / 3-way blend path (keys 4/5)
  // Each tracks its own press-edge state via local closures.
  const hudEl = document.getElementById('skin-hud');
  let prevSpace = false;
  const prevDigit: Record<string, boolean> = {
    '1': false,
    '2': false,
    '3': false,
    '4': false,
    '5': false,
  };
  // Mode tracks which keystroke path drove the most recent player.set so the
  // HUD can label the active path (hardcut vs crossfade vs 3way).
  let currentMode: 'hardcut' | 'crossfade' | '3way' = 'hardcut';
  let currentPaused = false;
  // Crossfade state owned by skin-blend-driver. crossfadeStart === null means
  // the system is idle; while non-null, every frame in [start, start+0.3s]
  // re-writes the slot weights with the linear-interpolated value.
  const CROSSFADE_DURATION = 0.3;
  let crossfadeStart: number | null = null;

  // Build a stable clip-name lookup so HUD can label the active clip per slot
  // (raw handle id is not human-readable). Slot 0 holds the most recent
  // hard-cut target; blends own slots 0..2; slot 3 stays inactive in this demo.
  const clipNameById = new Map<number, string>();
  for (const c of clipHandles) clipNameById.set(Number(c.clip), c.name);

  const refreshHud = (): void => {
    if (!hudEl) return;
    const apRes = world.get(playerEnt!, AnimationPlayer);
    if (!apRes.ok) {
      hudEl.innerHTML = 'AnimationPlayer not present';
      return;
    }
    // Schema stores clips as Uint32Array (handle ids) and times/weights as
    // Float32Array. Cast through unknown because the public type sees the
    // SoA inline-array columns as readonly tuples.
    const ap = apRes.value as unknown as {
      clips: Uint32Array;
      times: Float32Array;
      weights: Float32Array;
    };
    const state = currentPaused ? 'Paused' : 'Playing';
    // 4-slot compact layout (D-4): one row per slot with all three SoA
    // columns inline. Field literals `clips[i]=` / `weights[i]=` / `times[i]=`
    // are the AC-09 grep targets. Inactive slots print `clips[i]=invalid` so
    // the snapshot string ALWAYS contains all four `clips[i]=` literals
    // regardless of mode (hardcut leaves slots 1..3 invalid).
    const slotLines: string[] = [];
    for (let i = 0; i < 4; i++) {
      const cid = Number(ap.clips[i] ?? 0);
      const cname = cid === 0 ? 'invalid' : (clipNameById.get(cid) ?? `?(${cid})`);
      const w = (ap.weights[i] ?? 0).toFixed(3);
      const t = (ap.times[i] ?? 0).toFixed(2);
      slotLines.push(`slot[${i}]: clips[${i}]=${cname}  weights[${i}]=${w}  times[${i}]=${t}`);
    }
    hudEl.innerHTML =
      `Mode: ${currentMode}  State: ${state}<br />` +
      slotLines.join('<br />') +
      '<br /><span style="color:#8a90a8;">[1] Survey  [2] Walk  [3] Run  [4] Walk-&gt;Run blend  [5] 3-way  [Space] Pause</span>';
  };

  world.addSystem({
    name: 'skin-clip-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (snap === undefined) return;

      // Digit press-edges 1..3: hard-cut to the picked clip + reset phase.
      // The animation system resolves AnimationPlayer.clips[i] every frame via
      // assetResolver, so a partial set is enough -- no component re-add,
      // no system reset.
      for (let i = 0; i < clipHandles.length; i++) {
        const key = String(i + 1);
        const cur = snap.keyboard.down(key);
        if (cur && !prevDigit[key]) {
          const target = clipHandles[i]!;
          // Hard-cut: rewrite slot 0 to the picked clip; writeArrayField pads
          // slots 1..3 with zeros so they go silent. Short-prefix arrays cover
          // both the variable demo intent and the column-store pad contract.
          // Cancel any in-flight crossfade.
          const setRes = world.set(playerEnt!, AnimationPlayer, {
            clips: [target.clip],
            times: [0],
            weights: [1],
          });
          if (setRes.ok) {
            currentMode = 'hardcut';
            crossfadeStart = null;
            refreshHud();
          } else {
            console.error('[skin] clip swap world.set failed:', setRes.error.code);
          }
        }
        prevDigit[key] = cur;
      }

      // Space press-edge: toggle paused. paused=true bypasses the
      // dt accumulation in advanceAnimationPlayer (joint Transforms
      // freeze on the last sampled pose).
      const curSpace = snap.keyboard.down(' ');
      if (curSpace && !prevSpace) {
        const target = !currentPaused;
        const setRes = world.set(playerEnt!, AnimationPlayer, { paused: target });
        if (setRes.ok) {
          currentPaused = target;
          refreshHud();
        } else {
          console.error('[skin] pause world.set failed:', setRes.error.code);
        }
      }
      prevSpace = curSpace;
    },
  });

  // Resolve clip handles by semantic name once -- the blend driver references
  // Walk / Run / Survey by role rather than CLIPS array index so re-ordering
  // CLIPS does not silently flip behaviour.
  const findClip = (name: string): Handle<'AnimationClip', 'shared'> => {
    const entry = clipHandles.find((c) => c.name === name);
    if (entry === undefined) throw new Error(`[skin] clip '${name}' missing from CLIPS`);
    return entry.clip;
  };
  const surveyHandle = findClip('Survey');
  const walkHandle = findClip('Walk');
  const runHandle = findClip('Run');

  world.addSystem({
    name: 'skin-blend-driver',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (snap === undefined) return;

      // Press-edge 4: arm a Walk -> Run linear crossfade. Slot 0 = Walk,
      // slot 1 = Run; weights[0..1] = (1-t, t) where t = (now-start)/0.3 in
      // [0,1]. We zero slots 2..3 explicitly so a prior 3-way write does not
      // leak into the blend window.
      const cur4 = snap.keyboard.down('4');
      if (cur4 && !prevDigit['4']) {
        crossfadeStart = performance.now() / 1000;
        // Slot 0 = Walk, slot 1 = Run; tail slots 2..3 silenced via writeArray
        // pad. Initial weights peg slot 0 at 1; the in-flight tick re-writes.
        const setRes = world.set(playerEnt!, AnimationPlayer, {
          clips: [walkHandle, runHandle],
          times: [0, 0],
          weights: [1, 0],
        });
        if (setRes.ok) {
          currentMode = 'crossfade';
          refreshHud();
        } else {
          console.error('[skin] crossfade arm failed:', setRes.error.code);
        }
      }
      prevDigit['4'] = cur4;

      // Press-edge 5: 3-way steady blend Survey / Walk / Run with equal
      // weights. One-shot write -- no per-frame update needed.
      const cur5 = snap.keyboard.down('5');
      if (cur5 && !prevDigit['5']) {
        const third = 1 / 3;
        // Slots 0..2 active equally; slot 3 padded to silent by writeArrayField.
        const setRes = world.set(playerEnt!, AnimationPlayer, {
          clips: [surveyHandle, walkHandle, runHandle],
          times: [0, 0, 0],
          weights: [third, third, third],
        });
        if (setRes.ok) {
          currentMode = '3way';
          crossfadeStart = null;
          refreshHud();
        } else {
          console.error('[skin] 3-way blend write failed:', setRes.error.code);
        }
      }
      prevDigit['5'] = cur5;

      // In-flight crossfade tick: re-write weights[0..1] each frame until
      // 0.3s elapses. Outside the blend window crossfadeStart is null and the
      // weights stay at whatever the press-edge wrote last.
      if (crossfadeStart !== null) {
        const elapsed = performance.now() / 1000 - crossfadeStart;
        if (elapsed >= CROSSFADE_DURATION) {
          // Settle on pure Run: weights=[0,1,0,0] keeps slot 1 (run) alone.
          crossfadeStart = null;
          const setRes = world.set(playerEnt!, AnimationPlayer, {
            weights: new Float32Array([0, 1, 0, 0]),
          });
          if (setRes.ok) refreshHud();
        } else {
          const t = Math.max(0, Math.min(1, elapsed / CROSSFADE_DURATION));
          const setRes = world.set(playerEnt!, AnimationPlayer, {
            weights: new Float32Array([1 - t, t, 0, 0]),
          });
          if (setRes.ok) refreshHud();
        }
      }
    },
  });

  refreshHud();
  app.start();
}

function resizeCanvasToDisplaySize(c: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || window.innerWidth;
  const cssH = c.clientHeight || window.innerHeight;
  const targetW = Math.max(1, Math.round(cssW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));
  if (c.width !== targetW) c.width = targetW;
  if (c.height !== targetH) c.height = targetH;
}
