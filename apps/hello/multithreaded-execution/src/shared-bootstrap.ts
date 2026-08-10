import type { World } from '@forgeax/engine-ecs';
import { createExecutionKernel, ExecutionParticle } from './shared-kernel';

const PARTICLE_COUNT = 65_536;
let shouldFault = new URL(import.meta.url).searchParams.get('fault') === '1';

export default function bootstrap(world: World): void {
  for (let index = 0; index < PARTICLE_COUNT; index += 1) {
    world
      .spawn({
        component: ExecutionParticle,
        data: { x: index / PARTICLE_COUNT, y: (PARTICLE_COUNT - index) / PARTICLE_COUNT },
      })
      .unwrap();
  }
  world
    .addSystem(
      world.scheduleToken('Update'),
      createExecutionKernel(
        new URL(
          shouldFault ? '/assets/fault-kernel.js' : '/assets/shared-kernel.js',
          globalThis.location.href,
        ).href,
      ),
    )
    .unwrap();
  shouldFault = false;
}
