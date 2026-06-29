// apps/hello/sprite -- 2D sprite + Layer + transparent-sort double-scene
// demo (feat-20260520-2d-sprite-layer-mvp / M-4 / w29; AC-12).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - sprite material via pass-based MaterialAsset (feat-20260524 OOS-7
//     in-main migration) -- `passes: [{ shader: 'forgeax::sprite' }]`
//     + `paramValues: { texture, sampler, baseColor, region?, pivot?,
//     flipX?, flipY?, slices?, sliceMode? }`. No sibling type.
//   - HANDLE_QUAD (M-1 / w06) -- the 3rd builtin mesh handle (12-float
//     interleaved layout, same as HANDLE_CUBE / HANDLE_TRIANGLE).
//   - Layer + SortKey components (M-2 / w11 + w12) -- i32 layer order +
//     optional f32 per-entity sort override.
//   - TransparentSortConfig KV resource (M-2 / w14) -- mode + yzAlpha
//     selector for the 3 sort formulas (layer-z / layer-y / layer-yz).
//   - sprite.wgsl (M-3 / w19) + alpha-blend pipeline (M-3 / w24) +
//     RenderSystem three-bucket dispatch (M-3 / w22) + transparent CPU
//     sort (M-3 / w23).
//   - createApp(canvas, opts) (feat-20260518-app-shell-game-loop) --
//     second consumer of the canvas thin-wrapper that lands rAF +
//     auto input-attach + Time resource on a one-screen takeoff.
//   - Renderer.input.snapshot(world) (feat-20260519 V-2) -- first-class
//     frozen-snapshot facade for keyboard / mouse-wheel switching.
//   - loadByGuid<TextureAsset> + AssetRegistry.configurePackIndex
//     (feat-20260517-vite-plugin-image-build-time-cook) -- the
//     wood-container.jpg imports at build time, runtime side never
//     touches an image decoder.
//
// Two scenes (charter F1 sub-example index, mirrored in README.md):
//
//   | Scene | mode | pivot       | Visual                         |
//   |:------|:----:|:------------|:-------------------------------|
//   | A     |  0   | [0.5, 0.5]  | horizontal layer-z; 3 sprites  |
//   |       |      |             | crossed by Layer {-100,0,100}   |
//   |       |      |             | (background / mid / foreground) |
//   | B     |  1   | [0.5, 1.0]  | JRPG foot-pivot Y-sort; 3       |
//   |       |      |             | sprites whose draw order        |
//   |       |      |             | follows world-Y                 |
//
// Switching (charter F2 wheel/key as text-equivalent secondary signal):
//   keyboard '1' -> scene-A           keyboard '2' -> scene-B
//   mouse-wheel up  -> scene-B (JRPG) mouse-wheel down -> scene-A (layer-z)
//
// D-5 (plan-strategy): the 3 sprites share a single texture
// (wood-container.jpg analogue) and are visually disambiguated through
// 3 colorTints (warm red / fresh green / cool blue). Zero new asset
// vendor cost (the JPG + sidecar copy under ./assets/ mirrors the
// learn-render-1.4-textures pinned-asset carve-out so the demo stays
// self-contained when the forgeax-engine-assets submodule is not
// initialised in the worktree).
//
// charter mapping:
//   F1 -- AGENTS-style 4-step recipe lives at the top of bootstrap();
//         README sub-example index table mirrors the JSDoc table above.
//   P3 -- every Result.err path logs `.code` + `.hint` via console.error
//         (never .message string parsing); `setTransparentSortConfig`
//         returns Result<void, ResourceInvalidValueError> and is
//         consumed via the structured property path.
//   P4 -- sprite + 3D PBR share the same `MeshFilter + MeshRenderer`
//         entry (zero new component); the demo never imports a
//         SpriteRenderer / 2D-only surface (charter P4 consistent
//         abstraction; Bevy 0.19 SpriteBundle retracement is avoided).

import type { App, CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app';
import type { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createDevImportTransport,
  EngineEnvironmentError,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  Layer,
  MeshFilter,
  MeshRenderer,
  orthographic,
  setTransparentSortConfig,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_Z,
  Transform,
} from '@forgeax/engine-runtime';

import type {
  Handle,
  MaterialAsset,
  SamplerAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// D-5 SSOT: the wood-container disk-schema GUID is the same identifier
// learn-render-1.4-textures uses (the build-time importer stamps it
// into wood-container.meta.json subAssets[0].guid). Reusing the
// same GUID across demos is "zero new vendor cost" cashed out (the
// sidecar JSON is identical to the upstream submodule copy, just stored
// locally under ./assets/ so the demo loads with or without
// --recurse-submodules).
const WOOD_TEXTURE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const PACK_INDEX_URL = '/pack-index.json';

// 3 colorTints disambiguate the 3 sprites in either scene. The values
// are mid-saturation so the wood-container texture remains visible
// under multiplicative tinting (charter F2 visual signals stay
// secondary to text; the colors are mnemonic not semantic).
const SPRITE_COLOR_TINTS = [
  [1.0, 0.4, 0.4, 1.0], // sprite-0: warm red
  [0.4, 1.0, 0.4, 1.0], // sprite-1: fresh green
  [0.4, 0.4, 1.0, 1.0], // sprite-2: cool blue
] as const;

// scene-A: 3 sprites at distinct Layer values along Z; pivot=[0.5, 0.5]
// (geometric centre). The Layer values { -100, 0, 100 } cross zero so a
// negative-Layer regression in the sort code (charter P3 explicit
// failure: a sign flip on Layer would invert background / foreground)
// is caught visually in one frame.
const SCENE_A: ReadonlyArray<{
  layer: number;
  pos: readonly [number, number, number];
}> = [
  { layer: -100, pos: [-0.4, -0.1, -0.5] }, // background
  { layer: 0, pos: [0.0, 0.0, 0.0] }, // mid
  { layer: 100, pos: [0.4, 0.1, 0.5] }, // foreground
];

// scene-B: 3 sprites at the same Layer (0) but staggered along Y;
// pivot=[0.5, 1.0] (foot pivot, JRPG Y-sort convention -- the sprite's
// "depth" is measured at the bottom edge so a character "behind" stands
// further up the screen and draws first).
const SCENE_B: ReadonlyArray<{
  layer: number;
  pos: readonly [number, number, number];
}> = [
  { layer: 0, pos: [-0.4, 0.3, 0.0] }, // far / top of screen
  { layer: 0, pos: [0.0, 0.0, 0.0] }, // mid
  { layer: 0, pos: [0.4, -0.3, 0.0] }, // near / bottom of screen
];

type SceneId = 'A' | 'B';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[sprite] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[sprite] no usable WebGPU backend:', err);
  } else {
    console.error('[sprite] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createApp(canvas, opts) -- one-screen takeoff (feat-20260518
  // shell); the app owns the rAF frame-loop + Time resource + auto
  // input-attach. clearColor is a neutral dark slate so the sprite
  // alpha-blend (premultiplied) reads cleanly against the background.
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app: App = appRes.value;
  console.warn(`[sprite] backend=${app.renderer.backend}`);

  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[sprite] renderer.ready failed:', ready.error.code, ready.error.hint);
    return;
  }

  const assets = app.renderer.assets;
  if (assets === null) {
    console.error(
      '[sprite] AssetRegistry is null (renderer construction did not complete successfully)',
    );
    return;
  }
  assets.configurePackIndex(PACK_INDEX_URL);
  const world = app.world;

  // Step 2: resolve the wood-container texture through the production
  // loadByGuid fetch chain (returns the payload, D-17), then mint a
  // user-tier column handle. The vite-plugin-pack build-time import step
  // emits the decoded RGBA bytes, and the runtime side here just consumes
  // the GUID.
  const woodGuidRes = AssetGuid.parse(WOOD_TEXTURE_GUID);
  if (!woodGuidRes.ok) {
    console.error('[sprite] WOOD_TEXTURE_GUID parse failed:', woodGuidRes.error.code);
    return;
  }
  const texHandleRes = await assets.loadByGuid<TextureAsset>(woodGuidRes.value);
  let textureHandle: Handle<'TextureAsset', 'shared'> | undefined;
  if (texHandleRes.ok) {
    textureHandle = world.allocSharedRef('TextureAsset', texHandleRes.value);
  } else {
    // charter P3 explicit failure: the sprite bucket warn-once
    // path (render-system-record.ts AC-18 path 4) will fire when the
    // material binds an unresolved handle. We log the loadByGuid
    // failure once at boot so the AI user reading the console can
    // distinguish the bootstrap miss from the per-frame warn.
    console.warn(
      '[sprite] wood-container texture loadByGuid failed (continuing with debug-pink fallback):',
      texHandleRes.error.code,
    );
  }

  // Step 3: mint the default linear-filter sampler. The sprite
  // material's `sampler` slot is non-optional (AC-01); minting one
  // shared sampler is the minimum-surface route. addressMode='repeat'
  // mirrors wood-container.meta.json importSettings (linear /
  // repeat / mipmap=auto SSOT).
  const samplerHandle: Handle<'SamplerAsset', 'shared'> = world.allocSharedRef<
    'SamplerAsset',
    SamplerAsset
  >('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });

  // The 3 sprite materials per scene share the same texture + sampler
  // but differ in `pivot`. We pre-mint 6 handles (3 colors x 2
  // pivots) at boot so scene switching does not re-mint material
  // assets every frame. If textureHandle is undefined the material
  // still mints cleanly -- the sprite bucket missing-texture
  // warn-once path takes over at the record stage (charter P3).
  const materialHandles: Record<SceneId, Handle<'MaterialAsset', 'shared'>[]> = {
    A: [],
    B: [],
  };
  const PIVOT_BY_SCENE: Record<SceneId, readonly [number, number]> = {
    A: [0.5, 0.5],
    B: [0.5, 1.0],
  };
  for (const sceneId of ['A', 'B'] as const) {
    for (let i = 0; i < 3; i++) {
      const tint = SPRITE_COLOR_TINTS[i] ?? SPRITE_COLOR_TINTS[0];
      const material = buildSpriteMaterial({
        texture: textureHandle,
        sampler: samplerHandle,
        colorTint: tint,
        pivot: PIVOT_BY_SCENE[sceneId],
      });
      materialHandles[sceneId].push(world.allocSharedRef('MaterialAsset', material));
    }
  }


  // Step 4: orthographic camera with tonemap='none' (zero-overhead
  // path). The HDR (reinhard-extended) crossings are gated by the
  // dawn smoke matrix (w30) rather than a runtime toggle on this demo
  // -- adding a third axis (scene x tonemap) on top of the keyboard
  // switch would crowd the AI-user discovery surface (charter F1
  // limited context).
  world.spawn(
    {
      component: Transform,
      data: { posZ: 5 },
    },
    {
      component: Camera,
      data: orthographic({
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
        near: 0.1,
        far: 100,
      }),
    },
  ).unwrap();

  // Track the entities of the currently-spawned scene so a switch can
  // despawn them cleanly before respawning. Single Array (not a Set)
  // because the order matches scene definitions for grep-friendly
  // debug logging.
  let activeEntities: Array<ReturnType<World['spawn']>> = [];
  let currentScene: SceneId = 'A';

  // feat-20260527-sprite-nineslice / M5 / w19 (AC-11): the 9-slice
  // section coexists with the region+quad scenes above in a visually
  // disjoint screen band so the AI user reading this demo sees both
  // sprite idioms side by side without one mode masking the other.
  // The 9-slice entities are spawned once at boot and persist across
  // applyScene() switches (they sit at world-Y = +0.7 / -0.7 which
  // never overlaps the scene-A/B sprites at world-Y in [-0.3, 0.3]).
  setupNineSliceSection(world, textureHandle, samplerHandle);

  // Apply scene-A as the initial configuration (mode=0 layer-z).
  applyScene('A');

  // Step 5: scene-switch system. Reads InputSnapshot every frame and
  // toggles the active scene on '1' / '2' edges or mouse-wheel notches.
  // The system runs after the engine-input frame-start scan so the
  // edges are fresh; charter P4 consistent abstraction -- same
  // `renderer.input.snapshot(world)` facade learn-render 1.7 consumes.
  world.addSystem({
    name: 'hello-sprite-scene-switcher',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (snap === undefined) return;
      // up-edge ('1' / '2') is one-frame-deep so a sustained key press
      // does not flicker. mouse-wheel notch is sign-discrete (D-5):
      // positive = scroll down = scene-A (layer-z), negative = scroll
      // up = scene-B (JRPG). The ladder evaluates in deterministic
      // priority order so simultaneous '1' + wheel-up still picks the
      // most-recent key.
      if (snap.keyboard.up('1')) {
        applyScene('A');
        return;
      }
      if (snap.keyboard.up('2')) {
        applyScene('B');
        return;
      }
      if (snap.mouse.wheelDelta > 0) {
        applyScene('A');
      } else if (snap.mouse.wheelDelta < 0) {
        applyScene('B');
      }
    },
  });

  // Final wire: arm the rAF loop. createApp's frame-loop tracks the
  // World update cadence via Time + dispatches to RenderSystem each
  // tick.
  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[sprite] running. Press 1 / 2 to switch scenes.');

  // --------------- helpers ---------------------------------------------

  function applyScene(target: SceneId): void {
    // Despawn the entire previous scene before reinstalling the new
    // sort config. The order matters because transparentSortEntries
    // reads the world resource at extract time; flipping the mode
    // mid-frame would otherwise sort the previous scene's entries
    // against the new formula for one tick.
    for (const r of activeEntities) {
      if (r.ok) world.despawn(r.value);
    }
    activeEntities = [];

    const newMode = target === 'A' ? TRANSPARENT_SORT_MODE_LAYER_Z : TRANSPARENT_SORT_MODE_LAYER_Y;
    const cfgRes = setTransparentSortConfig(world, { mode: newMode, yzAlpha: 1.0 });
    if (!cfgRes.ok) {
      // charter P3 structured failure: read .code / .expected / .hint
      // properties; never parse .message. Should be unreachable -- the
      // two constants live in the valid {0, 1, 2} set by construction.
      console.error(
        '[sprite] setTransparentSortConfig rejected:',
        cfgRes.error.code,
        cfgRes.error.expected,
        cfgRes.error.hint,
      );
      return;
    }

    const def = target === 'A' ? SCENE_A : SCENE_B;
    for (let i = 0; i < def.length; i++) {
      const slot = def[i];
      const matHandle = materialHandles[target][i];
      if (slot === undefined || matHandle === undefined) continue;
      const r = world.spawn(
        {
          component: Transform,
          data: {
            posX: slot.pos[0],
            posY: slot.pos[1],
            posZ: slot.pos[2],
            scaleX: 0.4,
            scaleY: 0.4,
            scaleZ: 1,
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
        { component: Layer, data: { value: slot.layer } },
      );
      activeEntities.push(r);
    }
    currentScene = target;
    console.warn(
      `[sprite] scene=${currentScene} mode=${
        newMode === TRANSPARENT_SORT_MODE_LAYER_Z ? 'layer-z' : 'layer-y'
      }`,
    );
  }
}

function buildSpriteMaterial(args: {
  texture: Handle<'TextureAsset', 'shared'> | undefined;
  sampler: Handle<'SamplerAsset', 'shared'>;
  colorTint: readonly [number, number, number, number];
  pivot: readonly [number, number];
}): MaterialAsset {
  const texture = args.texture ?? (0 as unknown as Handle<'TextureAsset', 'shared'>);
  // feat-20260527 M3 / w10: pass-based sprite material (plan-strategy D-3).
  // The extract stage recognizes 'forgeax::sprite' shader and produces
  // shadingModel='sprite' + spriteFields for the record stage pipeline.
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::sprite',
        tags: { LightMode: 'Forward' },
        queue: 3000,
      },
    ],
    paramValues: {
      baseColor: args.colorTint,
      texture,
      sampler: args.sampler,
    },
  };
}

// feat-20260527-sprite-nineslice / M5 / w19 — 9-slice section helper.
//
// Spawns 3 entities into `world` exercising the two 9-slice sliceMode
// values on the same MaterialAsset shader id (`forgeax::sprite`,
// charter P4 consistent abstraction; D-1 plan-strategy: no
// sibling sprite-only asset type — the unified pass-based MaterialAsset
// surface carries the 9-slice fields directly, no parallel asset
// kind).
//
//   panel-stretch (sliceMode=0): 2 entities with the same material
//     handle but different Transform.scale[xy] so the AI user reading
//     the demo verifies AC-06 (one material, many sizes, four corners
//     stay pixel-fixed). Top band of the screen (y=+0.7).
//   panel-tile    (sliceMode=1): 1 entity at scale[xy] = N x cell-size
//     so the centre region tiles >=2 times (AC-07). Bottom band of
//     the screen (y=-0.7). The shared sampler in bootstrap() is
//     already configured with addressModeU/V='repeat' (D-4 plan
//     strategy) so the shader vs_main uv > 1 outputs wrap; the AI
//     user reading apps/hello/sprite/README.md FAQ row 3 also has the
//     same warning surface.
//
// D-6: no new PNG; the same wood-container texture handle from the
// region+quad scenes is reused as the 9-slice atlas region. The
// "circle corners do not stretch" expectation lives on the slice
// math + Transform.scale, not on the texture's visual identity
// (AC-15 panel-corners-preserved).
//
// D-1: paramValues literal carries `slices` + `sliceMode` directly;
// the demo never imports a sprite-specific asset variant (a grep gate
// in w19 acceptanceCheck enforces zero hits in this file).
function setupNineSliceSection(
  world: World,
  textureHandle: Handle<'TextureAsset', 'shared'> | undefined,
  samplerHandle: Handle<'SamplerAsset', 'shared'>,
): void {
  const texture = textureHandle ?? (0 as unknown as Handle<'TextureAsset', 'shared'>);

  // Stretch UI panel material: 4-corner anchors at 0.25 of region UV,
  // sliceMode=0 (stretch). Corners stay pixel-fixed at any scale; the
  // 4 edges stretch along their major axis only; centre stretches
  // bilinearly. Shared by both stretch entities below.
  const panelMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::sprite',
        tags: { LightMode: 'Forward' },
        queue: 3000,
      },
    ],
    paramValues: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      texture,
      sampler: samplerHandle,
      region: [0, 0, 1, 1],
      pivot: [0.5, 0.5],
      slices: [0.25, 0.25, 0.25, 0.25],
      sliceMode: 0,
    },
  });

  // Tile material: corners 0.30 of region UV, sliceMode=1 (tile). The
  // centre cell repeats N times along each axis when the entity's
  // Transform.scale[xy] is N x cell-size; the sampler.addressMode
  // 'repeat' lets the vs_main uv > 1 outputs wrap to multiple atlas
  // copies (D-4). Different `slices` value from the panel material
  // so the AI user can grep on these literal numbers and see the two
  // configurations side by side.
  const tileMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::sprite',
        tags: { LightMode: 'Forward' },
        queue: 3000,
      },
    ],
    paramValues: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      texture,
      sampler: samplerHandle,
      region: [0, 0, 1, 1],
      pivot: [0.5, 0.5],
      slices: [0.3, 0.3, 0.3, 0.3],
      sliceMode: 1,
    },
  });

  // 2 stretch panels: same material, different scale. AC-06 falsifier
  // is "the four corners stretch with scale" — visible in one frame.
  const STRETCH_PANELS: ReadonlyArray<{
    pos: readonly [number, number, number];
    scale: readonly [number, number];
  }> = [
    { pos: [-0.5, 0.7, 0], scale: [0.3, 0.18] }, // wide thin panel
    { pos: [0.5, 0.7, 0], scale: [0.18, 0.3] }, // tall narrow panel
  ];
  for (const slot of STRETCH_PANELS) {
    world
      .spawn(
        {
          component: Transform,
          data: {
            posX: slot.pos[0],
            posY: slot.pos[1],
            posZ: slot.pos[2],
            scaleX: slot.scale[0],
            scaleY: slot.scale[1],
            scaleZ: 1,
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_NINESLICE_QUAD } },
        { component: MeshRenderer, data: { materials: [panelMat] } },
        { component: Layer, data: { value: 200 } },
      )
      .unwrap();
  }

  // 1 tile entity: scale chosen so centre-cell repeats >= 2 times.
  // With slices=[0.3,0.3,0.3,0.3] the centre cell occupies the inner
  // 0.4 of the UV region; setting scaleX/Y to 0.6 (vs the panel
  // baseline 0.3) gives the inner band ~0.4 world units to fill,
  // which the wrap-around sampler tiles >=2 times.
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: 0.0,
          posY: -0.7,
          posZ: 0,
          scaleX: 0.6,
          scaleY: 0.4,
          scaleZ: 1,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_NINESLICE_QUAD } },
      { component: MeshRenderer, data: { materials: [tileMat] } },
      { component: Layer, data: { value: 200 } },
    )
    .unwrap();
}

function reportAppError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[sprite] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[sprite] ${err.code}: ${err.hint}`);
}