// @forgeax/engine-net -- session plugin (host-neutral World integration).
// (requirements AC-04, plan-strategy D-1/D-3)

import { FixedUpdate, Update, type World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { ok } from '@forgeax/engine-types';
import type { NetEndpoint } from '../endpoint/endpoint';
import { NetSession } from './net-session';

export interface NetPluginConfig {
  readonly endpoint: NetEndpoint;
  readonly maxRawMessages?: number;
}

export function netPlugin(config: NetPluginConfig): Plugin {
  return {
    name: 'net-session',
    build(world: World) {
      const session = new NetSession({
        endpoint: config.endpoint,
        maxRawMessages: config.maxRawMessages ?? 256,
      });
      world.insertResource('net-session', session);
      world.addSystem(Update, {
        name: 'net-receive',
        queries: [],
        before: [FixedUpdate],
        resources: ['net-session'],
        fn: (world) => world.getResource<NetSession>('net-session').receiveEvents(),
      });
      world.addSystem(Update, {
        name: 'net-publish',
        queries: [],
        after: [FixedUpdate],
        resources: ['net-session'],
        fn: (world) => world.getResource<NetSession>('net-session').publish(),
      });
      return ok(undefined);
    },
  };
}
