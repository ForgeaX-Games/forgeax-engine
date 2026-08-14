import type { App } from '@forgeax/engine-app';
import type { World } from '@forgeax/engine-ecs';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';

export interface BootstrapContext {
  readonly app: App;
  readonly assets: AssetRegistry;
  readonly uiRoot: HTMLElement;
  readonly registerCleanup: (cleanup: () => void) => void;
}

export async function bootstrap(_world: World, context: BootstrapContext): Promise<void> {
  const label = document.createElement('div');
  label.textContent = 'ForgeaX SDK ready';
  label.style.cssText =
    'position:absolute;left:24px;top:24px;color:white;font:600 18px system-ui,sans-serif';
  context.uiRoot.append(label);
  context.registerCleanup(() => label.remove());
}
