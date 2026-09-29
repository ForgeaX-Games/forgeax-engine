import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyGlobalCards } from './global-card-lookup.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareSdfCardsFixture(): Promise<SdfCardsFixture>;
  }
}
it('retains bounded object candidates and independently validates shared Card samples', async () => {
  await verifyGlobalCards(await commands.prepareSdfCardsFixture());
}, 120000);
