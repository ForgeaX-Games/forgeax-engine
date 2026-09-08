import type { Plugin } from '@forgeax/engine-plugin';
import { createGameplaySession } from './gameplay-session';
import { createGameplayTargetFeatures } from './gameplay-targets';
import { installGameplayWiring } from './gameplay-wiring';

/** The one game capability mounted into the App-owned Cordis realm. */
export const gameplay: Plugin = {
  name: 'game-default',
  inject: ['world', 'assets', 'renderer', 'gameHost'],
  async apply(ctx) {
    const host = ctx.gameHost;
    if (host === undefined) throw new Error('Cordis activated game-default without its Host provider');
    const query = new URLSearchParams(window.location.search);
    const assetEvidenceMode = query.has('asset-evidence');
    const comparisonEvidenceMode = assetEvidenceMode || query.has('render-evidence');
    const targets = await createGameplayTargetFeatures(ctx, ctx.world, host, {
      comparisonEvidenceMode,
    });
    const session = await createGameplaySession(ctx, ctx.world, host, host.canvas, targets);
    installGameplayWiring({
      context: ctx,
      world: ctx.world,
      host,
      assetEvidenceMode,
      targets,
      session,
    });
  },
};
