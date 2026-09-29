import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { defineAssetKind, type RuntimeAssetRegistry } from '@forgeax/engine/assets-runtime';
import { createUiLoader, mountUi, type UiAsset } from '@forgeax/engine/ui';
import type { Plugin } from '@forgeax/engine/plugin';
import { ok, err } from '@forgeax/engine/types';

import type {} from '@forgeax/engine/app';
import { installVaseControls } from './vase-controls.ts';

const uiKind = defineAssetKind<UiAsset, 'ui'>('ui');
export const ui: Plugin.Object<{ readonly guide: string }> = {
  name: 'game-3d/ui',
  inject: ['assets', 'gameHost'],
  async apply(ctx, config) {
    const assets = ctx.get('assets') as unknown as RuntimeAssetRegistry;
    await ctx.effect(async function* () {
      const loader = createUiLoader();
      const lease = assets.installDecoder(uiKind, {
        async decode({ envelope }) {
          const result = loader.load(envelope.payload);
          return result.ok
            ? ok(result.value)
            : err({
                code: 'asset-package-invalid',
                expected: 'a valid cooked UI payload',
                hint: 'rebuild the UI source',
                detail: { guid: config.guide, reason: String(result.error) },
              });
        },
      });
      yield () => lease.dispose();
      const loaded = await assets.load(config.guide, uiKind);
      if (!loaded.ok) throw loaded.error;
      const root = document.querySelector<HTMLElement>('#game-ui');
      if (!root) throw new Error('game-3d UI requires the Host #game-ui mount');
      const mounted = mountUi(loaded.value, {
        root,
        layer: 50,
      });
      if (!mounted.ok) throw mounted.error;
      const ui = mounted.value;
      yield () => ui.dispose();
      const update = () => {
        const locked = document.pointerLockElement !== null;
        ui.host.classList.toggle('locked', locked);
        const label = ui.host.shadowRoot?.querySelector<HTMLElement>('[data-ui-slot="lock"]');
        if (label)
          label.textContent = locked
            ? 'Camera locked · mouse look active'
            : 'Click to lock camera, or hold right mouse to look';
      };
      document.addEventListener('pointerlockchange', update);
      yield () => document.removeEventListener('pointerlockchange', update);
      update();
      const port = ctx.gameHost!.port;
      if (port && ui.host.shadowRoot) yield installVaseControls(ui.host.shadowRoot, port);
    });
  },
};

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('019fb7ce-3d00-7000-8000-000000000000'),
  build: () => ok({
    'plugin/host': {
      kind: 'plugin',
      module: { specifier: './ui.pack.ts', export: 'ui' },
      config: { guide: { $asset: '019fb7ce-3600-7000-8000-000000000001' } },
    },
  }),
});
