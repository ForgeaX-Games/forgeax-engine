import { type Component, Update, type World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { PROPAGATE_TRANSFORMS_SYSTEM, Transform } from '@forgeax/engine-scene';
import { AUDIO_ENGINE_RESOURCE_KEY } from './audio-backend';
import { audioTickSystem, listenerPoseFromWorldMatrix } from './audio-tick-system';
import { AudioListener, AudioSource } from './components';

export const AUDIO_TICK_SYSTEM_NAME = 'audio-tick' as const;

const AUDIO_COMPONENTS: readonly Component[] = [AudioSource, AudioListener];

function registerAudioComponents(world: World): () => void {
  const leases = AUDIO_COMPONENTS.map((component) => world.components.register(component).unwrap());
  return () => {
    for (let index = leases.length - 1; index >= 0; index -= 1) leases[index]?.dispose();
  };
}

export function audioPlugin(): Plugin {
  return {
    name: 'audio',
    inject: ['world', 'audio'],
    apply(ctx) {
      const world = ctx.world;
      const backend = ctx.audio;
      if (backend === undefined) throw new Error('Cordis activated audio without its provider');
      ctx.effect(() => registerAudioComponents(world), 'audio/components');
      ctx.effect(() => {
        world.insertResource(AUDIO_ENGINE_RESOURCE_KEY, backend);
        return () => {
          world.removeResource(AUDIO_ENGINE_RESOURCE_KEY);
        };
      }, 'audio/resource');
      ctx.effect(() => {
        world
          .addSystem(Update, {
            name: AUDIO_TICK_SYSTEM_NAME,
            queries: [],
            fn: () => audioTickSystem(world, backend),
          })
          .unwrap();
        return () => world.removeSystem(Update, AUDIO_TICK_SYSTEM_NAME);
      }, 'audio/tick');
      ctx.effect(() => {
        world
          .addSystem(Update, {
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
                break;
              }
            },
          })
          .unwrap();
        return () => world.removeSystem(Update, 'audio-listener-sync');
      }, 'audio/listener-sync');
    },
  };
}
