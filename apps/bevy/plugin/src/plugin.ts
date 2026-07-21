import { ok, Time, Update, type World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

const PRINT_MESSAGE_STATE_KEY = 'PrintMessageState';

interface PrintMessageState {
  message: string;
  waitDuration: number;
  accumulator: number;
}

/**
 * Custom plugin that prints a message every `waitDuration` seconds.
 * Reproduces Bevy `app/plugin`: a Plugin with configuration that registers
 * a resource and an Update system.
 */
export function printMessagePlugin(waitDuration: number, message: string): Plugin {
  return {
    name: 'print-message',
    build(world: World) {
      world.insertResource<PrintMessageState>(PRINT_MESSAGE_STATE_KEY, {
        message,
        waitDuration,
        accumulator: 0,
      });
      world.addSystem(Update, {
        name: 'print-message-system',
        queries: [],
        fn: (_world) => {
          const state = _world.getResource<PrintMessageState>(PRINT_MESSAGE_STATE_KEY);
          if (!state) return;
          const time = _world.getResource(Time);
          state.accumulator += time.delta;
          if (state.accumulator >= state.waitDuration) {
            state.accumulator -= state.waitDuration;
            console.log(state.message);
          }
        },
      });
      return ok(undefined);
    },
  };
}