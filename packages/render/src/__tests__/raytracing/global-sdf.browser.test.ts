import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyGlobalSdf } from './global-sdf.fixture';
import { verifyGlobalSdfQuery } from './global-sdf-query.fixture';
import { verifyGlobalSdfMinimumStep } from './global-sdf-step.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareSdfCardsFixture(): Promise<SdfCardsFixture>;
  }
}
it('composes and replays world fields, coverage, missing inputs and transformed bounds in WebGPU', async () => {
  await verifyGlobalSdf(await commands.prepareSdfCardsFixture());
}, 120000);

it('queries world fields with explicit incomplete states and fresh-device replay in WebGPU', async () => {
  await verifyGlobalSdfQuery(await commands.prepareSdfCardsFixture());
}, 120000);

it('keeps minimum step independent of expansion and preserves a sampled near blocker', async () => {
  await verifyGlobalSdfMinimumStep();
}, 120000);
