# @forgeax/engine-audio

> **Realm-neutral declarative audio subsystem.** Owns `AudioSource`, `AudioListener`, the ECS tick/plugin, the `AudioBackend` protocol, POD clip bytes, and the closed intent vocabulary. Browser playback lives in `@forgeax/engine-audio-webaudio` and always remains Host-owned.

## Core surface

```ts
import { AudioSource, AudioListener, audioPlugin, type AudioClipAsset } from '@forgeax/engine-audio';
```

Layer 1 (play now): spawn `AudioSource` with `playing: true`. Layer 2 (mix): bus volume/mute via `AudioEngine` Resource. Layer 3 (3D): `spatialBlend: 1` + `AudioListener`.

## Minimal BGM playback

```ts
import { AudioSource, AudioListener, audioPlugin, type AudioClipAsset, type AudioBackend } from '@forgeax/engine-audio';
const created = await createApp(canvas, { plugins: [audioPlugin()] });
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

`AudioClipAsset` is `{ kind: 'audio', sourceKey, bytes }`. The first play intent for a `sourceKey` carries bytes; later plays reuse the Host decode cache. Intents cover play, stop, per-source volume, bus volume/mute, listener pose, and destroy. Stale async decode completion is fenced by the entity play epoch, so it cannot resurrect a stopped or replaced source.

## ECS component schema

### AudioSource (6 fields)

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `clip` | `Handle<'AudioClipAsset', 'shared'>` | required | World shared-ref handle for the loaded POD clip |
| `playing` | `boolean` | `false` | Edge-detected: false->true starts playback, true->false stops |
| `loop` | `boolean` | `false` | When true, AudioBufferSourceNode.loop is set; one-shot otherwise |
| `volume` | `number` | `1.0` | Per-source GainNode gain.value; range 0..+Inf (amplification allowed) |
| `spatialBlend` | `number` | `0` | 0 = 2D (direct to bus), 1 = 3D (PannerNode with equalpower model) |
| `bus` | `'sfx' \| 'music'` | `'sfx'` | Target bus in the fixed two-bus topology (SFX + Music -> Master) |

### AudioListener (marker component)

| Field | Type | Description |
|:--|:--|:--|
| _(none)_ | -- | Marker component. Attach to the entity whose `Transform.world` (16-float column-major mat4, written by propagateTransforms) drives Web Audio listener position/orientation. Only the first `AudioListener` entity in the World is synced per frame (E-3). |

## Bus control via AudioEngine Resource

```ts
const audio = world.getResource<AudioBackend>('AudioEngine');
audio.setBusVolume('music', 0.3);
audio.setBusMute('sfx', true);
audio.setBusMute('sfx', false); // restores previous volume
const { contextState, activeSourceCount } = audio.getState();
```

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

- **gain.value direct assignment produces audible click** -- `setBusVolume` and `setVolume` directly assign `GainNode.gain.value`, which may produce an audible pop. Smooth ramp (e.g. `setTargetAtTime`) is deferred to a future feat (OOS-8).
- **No nested bus routing** -- fixed two-bus topology only (OOS-2).
- **No playback speed control** -- deferred (OOS-7).
- **No audio-specific Inspector method** -- use `app.execution.report().audio` or the existing Remote execution root.

## Related packages

- [`@forgeax/engine-audio-webaudio`](../audio-webaudio) -- Host implementation (`createWebAudioBackend`, `createHostAudioConsumer`)
- [`@forgeax/engine-ecs`](../ecs) -- `defineComponent`, World, Entity, System, Resource
- [`@forgeax/engine-app`](../app) -- `createApp({ plugins: [audioPlugin()] })` injection
- [`@forgeax/engine-types`](../types) -- `AudioErrorCode`, `AudioError`, `AudioClipAsset` type definitions SSOT
