# @forgeax/engine-audio

> **Realm-neutral declarative audio subsystem.** Owns `AudioSource`, `AudioListener`, the ECS tick/plugin, the `AudioBackend` protocol, POD clip publications, and the closed intent vocabulary. Browser playback lives in `@forgeax/engine-audio-webaudio` and always remains Host-owned.

## Core surface

```ts
import { AudioSource, AudioListener, audioPlugin, type AudioClipAsset } from '@forgeax/engine-audio';
```

Layer 1 (play now): spawn `AudioSource` with `playing: true`. Layer 2 (mix): bus volume/mute via `AudioEngine` Resource. Layer 3 (3D): `spatialBlend: 1` + `AudioListener`.

## Minimal BGM playback

```ts
import { AudioSource, AudioListener, audioPlugin, type AudioClipAsset, type AudioBackend } from '@forgeax/engine-audio';
const created = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()] });
if (!created.ok) throw created.error;
const app = created.value;

// Load clip via asset system
const loaded = await app.renderer.assets.loadByGuid<AudioClipAsset>(bgmGuid);
if (!loaded.ok) throw loaded.error;
const clip = app.world.allocSharedRef('AudioClipAsset', loaded.value);

// Spawn BGM source
app.world.spawn({
  component: AudioSource,
  data: { clip, playing: true, loop: true, volume: 0.8, spatialBlend: 0, bus: 'music' },
}).unwrap();

// Spawn listener on camera entity
app.world.spawn(
  { component: Transform, data: {} },
  { component: Camera, data: {} },
  { component: AudioListener, data: {} },
).unwrap();
```

## Realm boundary

| Tier | Engine-side backend | Host-side owner |
|:--|:--|:--|
| `main-serial` | Direct intent adapter | `WebAudioEngine` in the Host realm |
| `engine-worker` | `createAudioIntentBackend` batches POD intents with frame completion | `createHostAudioConsumer` owns decode, cache, nodes, and `AudioContext` |
| `shared` | Same Engine Worker intent path | Same Host consumer; Kernel Workers never receive audio state |

`AudioClipAsset` carries either encoded `bytes` or a Cook-validated PCM16 `stream` manifest and HTTP locator. The latter publishes only its bounded index across Workers. The first play intent for a `sourceKey` carries bytes; identical later plays reuse the Host decode cache, while changed bytes under the stable key are republished. Intents cover play, stop, per-source volume, playback rate, pause and seek, bus volume/mute, source pose, listener pose, and destroy. Stale async decode completion is fenced by both the entity play epoch and the current source-key content, so it cannot resurrect a stopped, replaced, or superseded source.

## ECS component schema

### AudioSource

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `clip` | `Handle<'AudioClipAsset', 'shared'>` | required | World shared-ref handle for the loaded POD clip |
| `playing` | `boolean` | `false` | Edge-detected: false->true starts playback, true->false stops |
| `paused` | `boolean` | `false` | Pauses an admitted source while `playing` remains true; false resumes its retained clip position |
| `playbackRate` | `number` | `1` | Positive sample advance multiplier; speed and pitch change together |
| `fromPosition` | `number` | `0` | Initial decoded clip seconds; edits while `playing` seek once, including while paused; this is a request, not live playback progress |
| `loop` | `boolean` | `false` | When true, AudioBufferSourceNode.loop is set; one-shot otherwise |
| `volume` | `number` | `1.0` | Per-source GainNode gain.value; range 0..+Inf (amplification allowed) |
| `spatialBlend` | `number` | `0` | 0 = 2D (direct to bus), 1 = 3D (PannerNode with equalpower model) |
| `coneInnerAngle` / `coneOuterAngle` | `number` | `360` | Full cone angles in degrees; omnidirectional by default |
| `coneOuterGain` | `number` | `0` | Gain outside the outer cone, in 0..1 |
| `bus` | `string` | `'sfx'` | Accepted bus ID; edits reroute an admitted or pending source |

### AudioListener (marker component)

| Field | Type | Description |
|:--|:--|:--|
| _(none)_ | -- | Marker component. Attach to the entity whose `GlobalTransform.world` (16-float column-major mat4, written by propagateTransforms) drives Web Audio listener position/orientation. Only the first `AudioListener` entity in the World is synced per frame (E-3). |

## Bus control via AudioEngine Resource

```ts
const audio = world.getResource<AudioBackend>('AudioEngine');
audio.setBusVolume('music', 0.3);
audio.setBusMute('sfx', true);
audio.setBusMute('sfx', false); // restores previous volume
const { contextState, activeSourceCount } = audio.getState();
```

## Configurable routing

`AudioBackend.configureBuses()` publishes one closed POD graph. IDs are unique strings; exactly one bus has `parent: null`. Parent and send references must exist and the combined graph must be acyclic. Defaults are `sfx/music -> master`.

```ts
audio.configureBuses([
  { id: 'master', parent: null },
  { id: 'voice', parent: 'master', volume: 0.8,
    sends: [{ bus: 'room', gain: 0.2, tap: 'pre-fader' }] },
  { id: 'room', parent: 'master' },
]);
audio.setBus(entityId, 'voice');
```

Read [the Host routing and streaming contract](../audio-webaudio/README.md#configurable-buses-and-shared-effects) for effect ownership, publication limits and actual playback status. Configuration/control intents express requests; `getState().lastError` reports Host refusal. `validateAudioBuses()` can validate a declaration before publication. Worker publication retention defaults to 64 MiB and 256 source keys; identical content sends no repeat bytes/index, while replacement republishes it.

## Error model (charter P3 explicit failure)

All public-facing failure paths return `Result<T, AudioError>`. AI users consume via exhaustive `switch (err.code)` -- no `default` branch needed (TypeScript strict enforces completeness).

| code | trigger | hint |
|:--|:--|:--|
| `context-creation-failed` | `new AudioContext()` threw or returned null | check browser supports AudioContext; verify no privacy extension blocks audio |
| `decode-failed` | `decodeAudioData(arrayBuffer)` rejected | ensure audio file is a valid wav/mp3/ogg/flac at the GUID path |
| `context-suspended` | play() called while AudioContext is suspended and gesture listener failed | call play after user gesture (click/tap/keydown) to trigger resume() |
| `invalid-clip-handle` | AudioSource.clip handle is dangling | verify clip was registered via AssetRegistry.register() before spawning |
| `bus-not-found` | AudioSource.bus is outside `'sfx' \| 'music'` | use 'sfx' or 'music' bus literal; custom bus names not supported in v1 |

Each error carries 4-field structured surface: `.code` / `.expected` / `.hint` / `.detail`. `.detail` is narrowed per-code via discriminated union (e.g. `decode-failed` carries `reason: string`).

## Known limitations

- **bounded live gain transitions** -- WebAudioEngine `setVolume`, `setBusVolume`, and `setBusMute` cancel prior automation at `AudioContext.currentTime` and schedule one 10 ms linear transition to each finite, non-negative target. Initial pre-start gain setup remains immediate.
- **Long source formats** -- streaming currently accepts PCM16 RIFF/WAV; compressed sources retain explicit buffered playback.
- Speed changes also change pitch; independent time stretching is outside this contract.
- **No audio-specific Inspector method** -- use `app.execution.report().audio` or the existing Remote execution root.

## Related packages

- [`@forgeax/engine-audio-webaudio`](../audio-webaudio) -- Host implementation (`createWebAudioBackend`, `createHostAudioConsumer`)
- [`@forgeax/engine-ecs`](../ecs) -- `defineComponent`, World, Entity, System, Resource
- [`@forgeax/engine-app`](../app) -- `createApp({ plugins: [audioPlugin()] })` injection
- [`@forgeax/engine-types`](../types) -- `AudioErrorCode`, `AudioError`, `AudioClipAsset` type definitions SSOT

## Simulation participant boundary

The realm-neutral audio package may contribute a ready participant whose state
is portable data. ECS remains the single owner of `record`, `restore`, `trace`,
comparison `report`, numeric `tolerance`, and closed `error` values.

Use the minimum path with a source World and a fresh target. Compare semantic
audio intent counts and cleanup invariants; never serialize `AudioContext`,
`AudioBuffer`, source nodes, or a host consumer. The Web Audio package remains
Host-owned and consumes intents after the simulation boundary.

When restore or comparison fails, switch on the returned code and follow its
`expected`, `hint`, and `detail`; do not parse messages or silently drop audio.
This seam is not RHI tape replay and does not define a game replay format.

## Spatial source pose

Attach `Transform` to a spatial `AudioSource`. After Scene propagation, audio
reads the optional `GlobalTransform.world`: translation becomes the emitter
position and normalized local **-Z** becomes its forward direction. Parenting
and scale therefore use the same Scene authority as rendering. A spatial source
without a transform uses the origin and -Z; removing its transform resets to
that pose. No separate audio transform is authored.

The first play carries `sourcePose`; later `set-source-pose` intents carry only
changed poses, including during decode and pause. Stationary and 2D sources emit
no pose updates. The Host owns retained panners and applies the latest pending
pose before starting a decoded source. Stop/despawn/replacement/disposal keep
the existing async fencing and cleanup.

```ts
world.spawn(
  { component: Transform, data: { pos: [4, 0, -2] } },
  { component: AudioSource, data: {
    clip, playing: true, loop: true, spatialBlend: 1,
    coneInnerAngle: 60, coneOuterAngle: 120, coneOuterGain: 0.1,
  } },
).unwrap();
```

`spatialBlend > 0` selects spatial routing; fractional values do not crossfade.
Routing, loop, bus and cone settings are sampled on the playing edge; stop and
restart to change them. Live pose, volume, rate, pause and seek controls remain live.
The native inverse-distance model uses reference distance 1 and rolloff 1.
Directional cones affect gain, not obstruction, diffraction, Doppler or room
acoustics. [Native measurements and reproduction](../audio-webaudio/bench/spatial-results.md).
