import type { BootstrapContext } from '@forgeax/engine-app';
import type { World } from '@forgeax/engine-ecs';
import { installGameplayShaders } from './gameplay-shaders';
import { createGameplaySession } from './gameplay-session';
import { createGameplayTargetFeatures } from './gameplay-targets';
import { installGameplayWiring } from './gameplay-wiring';

/** Host assembly only; gameplay state and frame work live in asset plugins. */
export async function bootstrap(world: World, host?: BootstrapContext): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#app');
  if (canvas === null) throw new Error('game-default requires #app canvas');

  installGameplayShaders(host?.renderer);
  const targets = await createGameplayTargetFeatures(world, host);
  const session = await createGameplaySession(world, host, canvas, targets);
  const assetEvidenceMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('asset-evidence');
  installGameplayWiring({ world, host, assetEvidenceMode, targets, session });
}
