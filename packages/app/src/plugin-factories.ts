// @forgeax/engine-app -- app-layer plugin factories (M2 / w8, plan-strategy D-3 / D-8).
//
// inputPlugin lives in the app package (D-8) because its scan system is
// app-owned wiring and it is tightly coupled to the createApp DOM-attach side
// effect (D-3): the browser InputBackend is attached + inserted as a World
// resource by createApp BEFORE the plugins run, and inputPlugin only does the
// world-registration half (add the frame-start scan system) -- guarded by a
// hasResource check so the plugin is a no-op when no backend was injected
// (assemble form, or a headless host).
//
// Plugin type comes from @forgeax/engine-plugin (L1.5, imported directly --
// the app re-export would be a cycle through its own barrel); ok from
// @forgeax/engine-ecs.
//
// charter awareness:
//   P3 explicit failure: the hasResource guard is an explicit, observable
//       no-op (returns ok with no side effect) rather than a silent throw when
//       the backend was not injected.
//   P4 consistent abstraction: inputPlugin shares the same Plugin shape as
//       every capability plugin; the DOM-attach asymmetry stays in createApp.

import { ok } from '@forgeax/engine-ecs';
import { INPUT_BACKEND_KEY, InputFrameStartScan } from '@forgeax/engine-input';
import type { Plugin } from '@forgeax/engine-plugin';

/**
 * inputPlugin -- registers the input frame-start scan system when a browser
 * InputBackend was injected into the World as the INPUT_BACKEND_KEY resource.
 *
 * Equivalent to the world-registration half of attachInputAuto
 * (input-attach.ts): `world.addSystem(InputFrameStartScan)`. The DOM attach
 * + cleanup funnel stays in createApp (D-3 / C-5) -- this factory takes no
 * canvas and performs no DOM work.
 *
 * No-op (ok with no side effect) when INPUT_BACKEND_KEY is absent: the
 * assemble form does not auto-attach a backend, and a headless host may run
 * without input.
 */
export function inputPlugin(): Plugin {
  return {
    name: 'input',
    build(world) {
      if (!world.hasResource(INPUT_BACKEND_KEY)) {
        return ok(undefined);
      }
      world.addSystem(InputFrameStartScan);
      return ok(undefined);
    },
  };
}
