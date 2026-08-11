import { ok } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { PROPAGATE_TRANSFORMS_SYSTEM, Transform } from '@forgeax/engine-scene';
import { AUDIO_ENGINE_RESOURCE_KEY, type AudioBackend } from './audio-backend';
import {
  audioTickSystem,
  listenerPoseFromWorldMatrix,
  recordAudioListenerPose,
} from './audio-tick-system';
import { AudioListener } from './components';

export const AUDIO_TICK_SYSTEM_NAME = 'audio-tick' as const;

export function audioPlugin(): Plugin {
  return {
    name: 'audio',
    build(world) {
      if (!world.hasResource(AUDIO_ENGINE_RESOURCE_KEY)) return ok(undefined);
      const backend = world.getResource<AudioBackend>(AUDIO_ENGINE_RESOURCE_KEY);
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
