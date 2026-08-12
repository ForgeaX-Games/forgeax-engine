import type { ExecutionBootstrapEntry, ExecutionBootstrapValue } from '@forgeax/engine-app';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { createExecutionKernel, ExecutionParticle } from './shared-kernel';

const PARTICLE_COUNT = 65_536;
let shouldFault = new URL(import.meta.url).searchParams.get('fault') === '1';

function telemetryRequested(data: ExecutionBootstrapValue | undefined): boolean {
  if (data === undefined || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  return (data as { readonly [key: string]: ExecutionBootstrapValue }).telemetry === true;
}

const bootstrap: ExecutionBootstrapEntry = (data) => ({
  run({ world, port, registerCleanup }): void {
    const telemetry = telemetryRequested(data) && port !== undefined;
    const faultRequested = shouldFault;
    const normalKernelUrl = new URL(
      '/assets/shared-kernel.js',
      globalThis.location.href,
    ).href;
    const faultKernelUrl = new URL('/assets/fault-kernel.js', globalThis.location.href).href;
    let faultArmed = faultRequested && !telemetry;
    const post = (message: Record<string, unknown>): void => {
      port?.postMessage({ ...message, worldIdentity: world.identity });
    };

    if (telemetry) {
      const registerNamedCleanup = (name: string): void => {
        let cleaned = false;
        registerCleanup(() => {
          if (cleaned) return;
          cleaned = true;
          post({ kind: 'cleanup', name });
        });
        post({ kind: 'cleanup-registered', name });
      };
      registerNamedCleanup('input-observer');
      registerNamedCleanup('render-session');
      world
        .addSystem(world.scheduleToken('Update'), {
          name: 'execution-host-input-observer',
          before: ['execution-particle-kernel'],
          after: ['input-frame-start-scan'],
          queries: [],
          fn(currentWorld) {
            const snapshot = currentWorld.getResource<InputSnapshot>(
              INPUT_SNAPSHOT_RESOURCE_KEY,
            );
            const keyMDown = snapshot.keyboard.downCode('KeyM');
            const mousePrimaryDown = snapshot.mouse.button(0);
            post({
              kind: 'update',
              keyMDown,
              mousePrimaryDown,
              keyMJustPressed: snapshot.keyboard.justPressedCode('KeyM'),
            });
            if (faultRequested && !faultArmed && (keyMDown || mousePrimaryDown)) {
              const replaced = currentWorld.replaceSystem(
                currentWorld.scheduleToken('Update'),
                'execution-particle-kernel',
                createExecutionKernel(faultKernelUrl),
              );
              if (!replaced.ok) throw replaced.error;
              faultArmed = true;
              shouldFault = false;
              post({ kind: 'fault-armed' });
            }
          },
        })
        .unwrap();
    }

    if (telemetry) {
      const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0.1, 0.7, 0.95, 1]));
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], scale: [1, 1, 1] } },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          { component: Camera, data: { fov: 60, aspect: 16 / 9 } },
        )
        .unwrap();
      world
        .spawn({
          component: DirectionalLight,
          data: { direction: [-0.4, -0.7, -1], color: [1, 1, 1], intensity: 1.2 },
        })
        .unwrap();
    }

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
          faultArmed ? faultKernelUrl : normalKernelUrl,
        ),
      )
      .unwrap();
    if (!faultRequested || faultArmed) shouldFault = false;
  },
});

export default bootstrap;
