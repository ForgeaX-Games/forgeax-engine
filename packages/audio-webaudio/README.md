# @forgeax/engine-audio-webaudio

> **Web Audio API backend for @forgeax/engine-audio.** Browser implementation of the `AudioBackend` interface -- owns `AudioContext` lifecycle, fixed two-bus GainNode topology, per-source node graph, and ECS tick systems for edge-detection-driven playback + listener position sync.

## Setup (charter P1 progressive disclosure)

### Canvas form (auto-attach)

```ts
import { createApp } from '@forgeax/engine-app';
import { audioPlugin } from '@forgeax/engine-audio-webaudio';

// audioPlugin() auto-creates WebAudioBackend and registers the AudioEngine Resource
const app = await createApp(canvas, { plugins: [audioPlugin()] });
```

### Assemble form (host-managed)

```ts
import { createWebAudioBackend, audioPlugin, AUDIO_ENGINE_RESOURCE_KEY } from '@forgeax/engine-audio-webaudio';

// Host pre-injects the backend resource, then passes audioPlugin() to wire the tick system.
world.insertResource(AUDIO_ENGINE_RESOURCE_KEY, createWebAudioBackend());

const app = await createApp({
  renderer,
  world,
  plugins: [audioPlugin()],
});
```

## Asset loading

The renderer injects this package's Web Audio decoder into `AssetRegistry`, so disk-backed clips use the ordinary GUID path. Configure the pack index, load the payload, then mint the World-owned shared ref consumed by `AudioSource.clip`:

```ts
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AudioClipAsset } from '@forgeax/engine-types';

assets.configurePackIndex('/pack-index.json');
const guid = AssetGuid.parse(clipGuid);
if (!guid.ok) return;
const loaded = await assets.loadByGuid<AudioClipAsset>(guid.value);
if (!loaded.ok) return;
const clip = world.allocSharedRef('AudioClipAsset', loaded.value);
```

Do not fetch a pack-index row or call `loadAudioClipByGuid` at app level. That function remains the decoder implementation used by the injected loader; its decode failure is surfaced by `loadByGuid` as `AssetError('asset-parse-failed')` with the original recovery hint.

## Tick system registration

Both tick systems (audioTickSystem + audioListenerSync) are registered by `audioPlugin()` during `createApp`. When wiring the ECS World schedule manually (no app layer), register them directly. Note the seam difference: `audioTickSystem` has no frame-order constraint, but listener sync reads `Transform.world` (written by `propagateTransforms`), so it MUST run `after: [PROPAGATE_TRANSFORMS_SYSTEM]` or it reads a stale (one-frame-late) pose.

```ts
import { audioTickSystem, syncListenerFromWorldMatrix } from '@forgeax/engine-audio-webaudio';
import { PROPAGATE_TRANSFORMS_SYSTEM, Transform } from '@forgeax/engine-runtime';
import { AudioListener } from '@forgeax/engine-audio';
import { Update, createQueryState, Entity, queryRun } from '@forgeax/engine-ecs';

world.addSystem(Update, {
  name: 'audio-tick',
  fn: () => {
    const backend = world.getResource('AudioEngine');
    if (backend) audioTickSystem(world, backend);
  },
});

// Listener sync: resolve the first AudioListener entity's Transform.world and
// write it to the backend's Web Audio listener. backend.listener is a lazy
// getter (builds the AudioContext on first access) -- touch it only when an
// AudioListener entity exists so a headless host never forces context creation.
world.addSystem(Update, {
  name: 'audio-listener-sync',
  after: [PROPAGATE_TRANSFORMS_SYSTEM],
  fn: () => {
    const backend = world.getResource('AudioEngine');
    if (!backend) return;
    const query = createQueryState({ with: [AudioListener, Entity] });
    queryRun(query, world, (bundle) => {
      for (let i = 0; i < bundle.Entity.self.length; i++) {
        const tf = world.get(bundle.Entity.self[i], Transform);
        if (!tf.ok) continue;
        const listener = backend.listener;
        if (listener) syncListenerFromWorldMatrix(listener, tf.value.world);
        break; // first AudioListener only (E-3)
      }
    });
  },
});
```

## Architecture

### AudioContext lifecycle (plan-strategy D-3)

- **Lazy creation**: AudioContext is NOT created until first `play()` call.
- **Gesture resume**: If AudioContext starts suspended (autoplay gate), a one-shot `document.addEventListener('click'/'keydown'/'touchstart', resumeOnce, { once: true })` is registered. The tick system defers playback until context state becomes `'running'`.
- **Irreversible close**: `destroy()` calls `ctx.close()`; to restart audio after destroy, create a new backend via `createWebAudioBackend()`.

### Bus topology (plan-strategy D-5)

```
source -> per-source GainNode (volume) -> [PannerNode?] -> bus GainNode -> master GainNode -> ctx.destination
                                                               ^ sfxGain
                                                               ^ musicGain (parallel)
```

- **3 GainNodes**: `masterGain` <= `sfxGain` + `musicGain` (parallel routing).
- **Bus name**: literal union `'sfx' | 'music'`; `AudioSource.bus` defaults to `'sfx'`.
- **Mute/unmute**: `setBusMute('sfx', true)` saves current volume, sets gain to 0; `setBusMute('sfx', false)` restores previous volume.

### 3D spatialization

- **PannerNode**: created when `AudioSource.spatialBlend > 0`.
- **panningModel**: defaults to `'equalpower'` (CPU-friendly; `'HRTF'` is a future extension per OOS-7).
- **Listener sync**: the audio-listener-sync system reads the first `AudioListener` entity's `Transform.world` (16-float column-major mat4, written by propagateTransforms) and syncs position/orientation to `AudioContext.listener` AudioParams. Auto-registered in canvas form (ECS addSystem, after propagateTransforms); assemble form hosts register it manually.

### Entity despawn cleanup (plan-strategy S-7)

When an entity is despawned, `audioTickSystem` detects its removal on the next frame and calls `backend.stop()` + cleans up internal per-entity state. No fade-out (OOS-8). The backend's `stop()` method disconnects all associated Web Audio nodes and removes the entry from its internal map.

## Health check

```ts
const backend = world.getResource('AudioEngine');
const { contextState, activeSourceCount } = backend.getState();
// contextState: 'running' | 'suspended' | 'closed'
// activeSourceCount: number of currently active AudioBufferSourceNode instances
```

## Known limitations

- **gain.value click**: `setBusVolume` and `setVolume` directly assign `GainNode.gain.value`, which may produce an audible pop. Smooth ramp with `setTargetAtTime` is deferred to a future feat (OOS-8).
- **No fade-out on despawn**: entities stop immediately on despawn (OOS-8).
- **No nested bus routing**: fixed two-bus topology only (OOS-2).
- **No playback speed control**: deferred (OOS-7).

## Browser support

Requires Web Audio API (`AudioContext`, `AudioBuffer`, `AudioBufferSourceNode`, `GainNode`, `PannerNode`).

| Browser | Minimum version |
|:--|:--|
| Chrome | 71+ |
| Firefox | 112+ (AudioParam-based listener.positionX/Y/Z) |
| Safari | 14.1+ (Web Audio API baseline) |
| Edge | 79+ (Chromium-based) |

## Error codes

| code | trigger | recovery |
|:--|:--|:--|
| `context-creation-failed` | `new AudioContext()` threw or returned null | check browser supports AudioContext; verify no privacy extension blocks audio |
| `decode-failed` | `decodeAudioData(arrayBuffer)` rejected | ensure audio file is a valid wav/mp3/ogg/flac at the GUID path |
| `context-suspended` | play called while ctx is suspended and gesture listener failed | call play after user gesture (click/tap/keydown) to trigger resume() |
| `invalid-clip-handle` | AudioSource.clip handle is dangling | verify clip was registered via AssetRegistry.register() before spawning |
| `bus-not-found` | AudioSource.bus outside `'sfx' \| 'music'` | use 'sfx' or 'music' bus literal; custom bus names not supported in v1 |

## Related packages

- [`@forgeax/engine-audio`](../audio) -- interface, ECS components, error types, `AudioClipAsset` POD
- [`@forgeax/engine-app`](../app) -- `createApp({ plugins: [audioPlugin()] })` injection
- [`@forgeax/engine-ecs`](../ecs) -- World, Entity, System, Resource
- [`@forgeax/engine-types`](../types) -- `AudioErrorCode`, `AudioError` type definitions SSOT
