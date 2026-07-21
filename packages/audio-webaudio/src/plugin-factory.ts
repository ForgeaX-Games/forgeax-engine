import { Update } from '@forgeax/engine-ecs';
// @forgeax/engine-audio-webaudio -- audioPlugin factory (M2 / w9, plan-strategy D-4 / D-9 / D-10).
//
// audioPlugin registers the per-frame audio tick system when an AudioBackend
// was injected into the World as the AUDIO_ENGINE_RESOURCE_KEY resource (D-4:
// the backend is created + inserted + disposed by the app layer; the plugin
// only does the world-registration half, guarded by a hasResource check).
//
// Scope note (D-8 / dependency-graph honesty): the audio LISTENER-SYNC system
// is NOT registered here. Listener-sync reads `Transform.world` (a
// @forgeax/engine-runtime component) to drive the Web Audio listener pose, and
// audio-webaudio deliberately has no dependency on engine-runtime (the
// listener-sync helper is exported as a pure function for host assembly --
// see audio-listener-sync-system.ts). Registering listener-sync from here
// would force a heavy runtime dependency on this backend package and reverse
// that decoupling, so it stays in the app layer (create-app.ts) where both
// audio + runtime are visible. The final world ends up with both audio-tick
// (registered here) and audio-listener-sync (registered by the app) -- the
// observable system set matches AC-02 / w9, registered from the two layers
// that own each system's dependencies.
//
// Plugin type comes from @forgeax/engine-plugin (L1.5); ok from
// @forgeax/engine-ecs.
//
// charter awareness:
//   P3 explicit failure: the hasResource guard is an explicit, observable
//       no-op (ok, no side effect) when no backend was injected.
//   P4 consistent abstraction: audioPlugin shares the same Plugin shape as
//       transform / physics; the backend-lifecycle asymmetry stays in the app.

import { AUDIO_ENGINE_RESOURCE_KEY, type AudioBackend } from '@forgeax/engine-audio';
import { ok } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

import { audioTickSystem } from './audio-tick-system';

/** Stable world-system name for the audio tick (inspector enumeration). */
export const AUDIO_TICK_SYSTEM_NAME = 'audio-tick' as const;

/**
 * audioPlugin -- registers the audio tick system when an AudioBackend was
 * injected as the AUDIO_ENGINE_RESOURCE_KEY world resource.
 *
 * The tick system walks AudioSource entities each frame, detects playing-state
 * edges, and delegates node lifecycle + property sync to the backend. The
 * backend is read from the resource (D-4 pre-injection) so the system has no
 * per-frame getResource lookup. No-op (ok, no side effect) when no backend was
 * injected (the assemble form / a headless host).
 */
export function audioPlugin(): Plugin {
  return {
    name: 'audio',
    build(world) {
      if (!world.hasResource(AUDIO_ENGINE_RESOURCE_KEY)) {
        return ok(undefined);
      }
      const backend = world.getResource<AudioBackend>(AUDIO_ENGINE_RESOURCE_KEY);
      world.addSystem(Update, {
        name: AUDIO_TICK_SYSTEM_NAME,
        queries: [],
        fn: () => {
          audioTickSystem(world, backend);
        },
      });
      return ok(undefined);
    },
  };
}
