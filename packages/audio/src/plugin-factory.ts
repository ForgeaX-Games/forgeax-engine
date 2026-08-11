import { err, ok } from '@forgeax/engine-ecs';
import {
  PLUGIN_ERROR_HINTS,
  PLUGIN_EXPECTED,
  type Plugin,
  PluginError,
} from '@forgeax/engine-plugin';
import { PROPAGATE_TRANSFORMS_SYSTEM, Transform } from '@forgeax/engine-scene';
import { AUDIO_ENGINE_RESOURCE_KEY, type AudioBackend } from './audio-backend';
import {
  audioTickSystem,
  listenerPoseFromWorldMatrix,
  recordAudioListenerPose,
} from './audio-tick-system';
import { AudioListener } from './components';
import { createAudioSimulationParticipant } from './simulation-participant';

export const AUDIO_TICK_SYSTEM_NAME = 'audio-tick' as const;

function participantRegistrationError(code: string): PluginError {
  return new PluginError({
    code: 'plugin-build-failed',
    expected: PLUGIN_EXPECTED['plugin-build-failed'],
    hint: PLUGIN_ERROR_HINTS['plugin-build-failed'],
    detail: {
      pluginName: 'audio',
      cause: `simulation participant registration failed: ${code}`,
      failures: [{ pluginName: 'audio', cause: code }],
    },
  });
}

export function audioPlugin(): Plugin {
  return {
    name: 'audio',
    build(world) {
      if (!world.hasResource(AUDIO_ENGINE_RESOURCE_KEY)) return ok(undefined);
      const backend = world.getResource<AudioBackend>(AUDIO_ENGINE_RESOURCE_KEY);
      world.registerSimulationTransientResource(AUDIO_ENGINE_RESOURCE_KEY);
      const registered = world.registerSimulationParticipant(
        createAudioSimulationParticipant(backend),
      );
      if (!registered.ok) return err(participantRegistrationError(registered.error.code));
      if (backend.simulationParticipant !== undefined) {
        const hostRegistered = world.registerSimulationParticipant(backend.simulationParticipant);
        if (!hostRegistered.ok) return err(participantRegistrationError(hostRegistered.error.code));
      }
      world
        .addSystem(world.scheduleToken('Update'), {
          name: AUDIO_TICK_SYSTEM_NAME,
          queries: [],
          fn: () => audioTickSystem(world, backend),
        })
        .unwrap();
      world
        .addSystem(world.scheduleToken('Update'), {
          name: 'audio-listener-sync',
          after: [PROPAGATE_TRANSFORMS_SYSTEM],
          queries: [],
          fn: () => {
            const listeners = world.query({ read: [Transform], with: [AudioListener] });
            if (!listeners.ok) return;
            for (const row of listeners.value) {
              const transform = row.get(Transform);
              const pose = listenerPoseFromWorldMatrix(transform.world);
              backend.setListenerPose(pose);
              recordAudioListenerPose(backend, pose);
              break;
            }
          },
        })
        .unwrap();
      return ok(undefined);
    },
  };
}
