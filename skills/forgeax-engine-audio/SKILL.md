---
name: forgeax-engine-audio
description: >-
  ForgeaX realm-neutral ECS audio with Host-owned Web Audio playback. Use when
  playing BGM/SFX, wiring 3D listener pose, controlling sfx/music buses,
  transporting audio from an Engine Worker, or diagnosing decode and cleanup state.
---

# forgeax-engine-audio

> **Gameplay owns `AudioSource`; the Host owns `AudioContext`.** `@forgeax/engine-audio` produces the same closed audio intents in every execution tier. `@forgeax/engine-audio-webaudio` consumes them in the Host realm.

## Takeoff

```ts
import { createApp } from '@forgeax/engine-app';
import {
  AUDIO_ENGINE_RESOURCE_KEY,
  AudioListener,
  AudioSource,
  audioPlugin,
  type AudioBackend,
  type AudioClipAsset,
} from '@forgeax/engine-audio';

const created = await createApp(canvas, { plugins: [audioPlugin()] });
if (!created.ok) throw created.error;
const app = created.value;

const loaded = await app.renderer.assets.loadByGuid<AudioClipAsset>(clipGuid);
if (!loaded.ok) throw loaded.error;
const clip = app.world.allocSharedRef('AudioClipAsset', loaded.value);

app.world.spawn({
  component: AudioSource,
  data: {
    clip,
    playing: true,
    loop: true,
    volume: 0.8,
    spatialBlend: 0,
    bus: 'music',
  },
}).unwrap();

const backend = app.world.getResource<AudioBackend>(AUDIO_ENGINE_RESOURCE_KEY);
backend.setBusVolume('music', 0.3);
app.start().unwrap();
```

Add `AudioListener` to the camera entity for spatial audio. The plugin runs listener sync after transform propagation and sends position, forward, and up as nine numeric scalars.

## Realm contract

| Owner | Data | Rule |
|:--|:--|:--|
| ECS World | `AudioSource`, `AudioListener`, playing edges, listener pose | Realm-neutral gameplay authority |
| Engine Worker | `createAudioIntentBackend()` and a per-frame intent batch | No Web Audio objects; first play carries bytes, later plays reuse `sourceKey` |
| Host | `createHostAudioConsumer()` and `WebAudioEngine` | Owns decode cache, `AudioBuffer`, nodes, buses, gesture resume, and `AudioContext` |
| Kernel Worker | Nothing | Audio is never a Shared Kernel concern |

`main-serial`, `engine-worker`, and `shared` use the same `audioPlugin()` and intent vocabulary. The App report projects Host state at `app.execution.report().audio`.

## Components and controls

| Surface | Purpose |
|:--|:--|
| `AudioSource.playing` | False-to-true plays; true-to-false stops. Toggle false before replaying a one-shot. |
| `AudioSource.loop` / `volume` / `bus` | Source playback and fixed `sfx` or `music` routing |
| `AudioSource.spatialBlend` | `0` routes directly to the bus; values above `0` create a panner |
| `AudioListener` | Marker on the first listener entity whose world transform drives pose |
| `AudioBackend` | Source volume, bus volume/mute, state, active count, and destroy |

## Clip and async safety

`AudioClipAsset` is POD: `{ kind: 'audio', sourceKey: string, bytes: Uint8Array }`. The Host caches the decode Promise by `sourceKey`. Each entity play/stop advances an epoch; late decode completion checks that epoch before creating a source, so a replaced or stopped entity cannot be resurrected.

Inspect decode failure through `backend.getState().lastError` or `app.execution.report().audio.lastError`. Consume `.code`, `.expected`, `.hint`, and `.detail`; do not parse the message.

## Cleanup

`app.stop()` disposes the Host consumer exactly once: stop sources, disconnect nodes, clear decode and entity-epoch maps, remove gesture listeners, and close the context. A poisoned World does not keep producing intents. Explicit Worker rebuild creates a fresh Host consumer so old async decode tasks cannot affect the new World identity.

## Sources of truth

| Contract | Owner |
|:--|:--|
| Components, plugin, intent union, tick, backend protocol | [`packages/audio/README.md`](../../packages/audio/README.md) |
| Host decode/cache/node implementation | [`packages/audio-webaudio/README.md`](../../packages/audio-webaudio/README.md) |
| App execution selection and report | [`forgeax-engine-app`](../forgeax-engine-app/SKILL.md) |
| Asset GUID loading | [`forgeax-engine-assets`](../forgeax-engine-assets/SKILL.md) |

## Simulation participant

Use the realm-neutral audio participant for portable intent/state evidence. ECS
owns `record`, `restore`, fixed-tick `trace`, semantic `report`, numeric
`tolerance`, and closed `error` values. The Host consumer still owns
`AudioContext`, `AudioBuffer`, source nodes, and cleanup.

Expose only the inspection summary through App, Preview, or Remote. Diagnose by
`code`/`expected`/`hint`/`detail`, then retry with a fresh target. This is not an
RHI tape or game replay surface.
