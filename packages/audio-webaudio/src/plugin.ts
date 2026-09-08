import type { Plugin } from '@forgeax/engine-plugin';

import { createWebAudioBackend } from './host-audio-consumer';

export function webAudioPlugin(): Plugin {
  return {
    name: 'web-audio',
    provide: 'audio',
    apply(ctx) {
      const backend = createWebAudioBackend();
      ctx.effect(() => () => backend.destroy(), 'audio/destroy-webaudio');
      ctx.provide('audio', backend);
    },
  };
}
