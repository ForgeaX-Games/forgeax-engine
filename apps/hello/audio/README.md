# forgeax-engine -- Hello Audio

Spacebar one-shot SFX + movable 3D listener --
`createApp({ plugins: [audioPlugin()] })` declarative ECS example
(input is in the canvas-form default plugin set).

## Quickstart

```bash
pnpm --filter @forgeax/hello-audio dev
# Open http://localhost:5195
# Press spacebar to play the SFX, WASD to move the listener.
```

## What this demo exercises

| Surface | Details |
|:--|:--|
| **One-shot takeoff** | `createApp(canvas, { plugins: [audioPlugin()] })` -- `audioPlugin()` auto-attaches the WebAudioBackend; input is in the canvas-form default plugin set (parallel to `physicsPlugin('rapier-3d')`). |
| **Declarative ECS audio** | `AudioSource({ clip, playing })` drives `audioTickSystem` edge detection -- no imperative `backend.play()` bypass (AC-07). |
| **Pack-index asset loading** | SFX GUID resolved via vite-plugin-pack (`/__pack/lookup/:guid` in dev, `pack-index.json` at build time) -> `loadAudioClipByGuid` -> `registerWithGuid` -> `AudioSource.clip`. |
| **Spatial panning** | `AudioSource.spatialBlend=1.0` creates a PannerNode; `syncListenerFromWorldMatrix(l, worldMatrix)` syncs the listener position/orientation each frame from the listener entity's `Transform.world` mat4. |
| **Overlay readout** | Left/top overlay shows listener-emitter distance + L/R pan as text (charter F2: text anchors spatial audio verification). |

## Controls

| Key | Action |
|:--|:--|
| **Spacebar** | One-shot SFX (also resumes AudioContext on first press) |
| **W / S** | Move listener forward / back |
| **A / D** | Move listener left / right |

## API surface

```ts
import { audioPlugin } from '@forgeax/engine-audio-webaudio';

// 1. One-shot takeoff -- audioPlugin() auto-attaches the WebAudioBackend;
//    input is in the canvas-form default plugin set.
const app = await createApp(canvas, { plugins: [audioPlugin()] });

// 2. Load + register an audio clip via the pack-index pipeline.
//    resolveUrlFromPackIndex(guid) -> loadAudioClipByGuid(guid, url)
//    -> AssetGuid.parse(guid) -> assetRegistry.registerWithGuid(parsed, clip).
//    The GUID string must pass through AssetGuid.parse() (returns a Result)
//    before registerWithGuid -- it takes a parsed AssetGuid, not a raw string.
const guidRes = AssetGuid.parse(SFX_GUID);
if (!guidRes.ok) return; // PackError: malformed GUID string
const clipHandle = assets.registerWithGuid(guidRes.value, clip);

// 3. Declarative spawn -- AudioSource with clip handle.
const emitter = world.spawn(
  { component: Transform, data: { pos: [0, 0, 0] } },
  { component: MeshFilter,  data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: {} },
  { component: AudioSource,  data: { clip: clipHandle, playing: false, spatialBlend: 1.0, bus: 'sfx' } },
).unwrap();

// 4. Camera + AudioListener marker as the spatial listener.
const camera = world.spawn(
  { component: Transform, data: { pos: [0, 1, 5] } },
  { component: Camera, data: { fov: Math.PI/4, aspect: 16/9, near: 0.1, far: 100 } },
  { component: AudioListener, data: {} },
).unwrap();

// 5. Per-frame: listener sync via engine.listener getter (D-2). createApp
//    auto-wires propagateTransforms, so Transform.world is fresh each frame.
app.registerUpdate(() => {
  const worldMatrix = world.get(camera, Transform).unwrap().world;
  const engine = world.getResource('AudioEngine');
  if (engine instanceof WebAudioEngine) {
    const l = engine.listener; // getter triggers lazy ensureContext()
    if (l) syncListenerFromWorldMatrix(l, worldMatrix);
  }
});
```

## Caveats

### headless has no AudioContext

dawn-node (used by smoke and CI) has no Web Audio API, so audio playback is
impossible in headless. The smoke gate is structural-only (boot + 300 frames
+ no errors). Browser-based `pnpm dev` is required to hear the SFX and
experience spatial panning.

### One-shot edge mapping (AC-08)

`AudioSource.playing` is a **level semantic** (continuous true means
"playing / keep alive"), not a one-shot trigger. The audio tick system
detects `false->true` edges to start playback and `true->false` edges to
stop. There is no built-in `playOnce()` affordance.

This demo manufactures a one-shot edge per keypress via a re-arm pattern:

1. Spacebar up-edge -> write `AudioSource.playing = true`
2. Next frame -> unconditionally write `playing = false` (re-arms for next press)

This produces a real cross-frame `false->true` transition that the tick
system observes as a play-start edge. Each keypress creates a new
`AudioBufferSourceNode` (overlapping playback, per OOS-5).

This ergonomics gap is **documented honestly**, not hidden. A future engine
iteration may add an explicit `playOnce` / `trigger` affordance on
`AudioSource`.

### Submodule dependency (D-7)

The SFX audio file lives in the `forgeax-engine-assets/` git submodule
(`sfx/dragon-studio-correct-472358.mp3`). Clone without
`--recurse-submodules` and the pack-index will have no entry for the SFX
GUID -- the demo boots without errors but plays no sound. This is the
charter P3 explicit-failure contract: silent demo when assets are missing,
not a crash.