import { ok, Time, Update, type World } from '@forgeax/engine-ecs';
import { definePluginGroup, type Plugin } from '@forgeax/engine-plugin';

function printPlugin(name: 'hello' | 'world', message: string): Plugin {
  return {
    name: `print-${name}`,
    build(world: World) {
      world.addSystem(Update, {
        name: `print-${name}-system`,
        queries: [],
        fn: () => {
          console.log(message);
          void world.getResource(Time).delta;
        },
      });
      return ok(undefined);
    },
  };
}

/** Bevy's HelloWorldPlugins expressed as one named ForgeaX PluginGroup. */
export const helloWorldPlugins = definePluginGroup('hello-world', (group) => {
  group.add(printPlugin('hello', 'hello')).add(printPlugin('world', 'world'));
});
