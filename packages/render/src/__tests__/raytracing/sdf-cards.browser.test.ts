import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyCardCoverage } from './card-coverage.fixture';
import { verifyCardSampling } from './card-sampling.fixture';
import { verifyMultiMaterialCards } from './multi-material-cards.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { verifySdfCards } from './sdf-cards.fixture';
import { verifySdfCases } from './sdf-cases.fixture';
import { verifySdfExpansion } from './sdf-expansion.fixture';
import { verifyCardMaterial } from './sdf-material.fixture';
import { verifyTwoSidedSdf } from './sdf-two-sided.fixture';
import { verifyVisibilityCards } from './visibility-cards.fixture';

it('normalizes depth-qualified Card texels without leaking across atlas tiles', async () => {
  await verifyCardSampling(await commands.prepareSdfCardsFixture());
}, 120000);

it('selects caller-owned visibility expansion without losing the near-occluder control', async () => {
  await verifySdfExpansion();
}, 120000);

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareSdfCardsFixture(): Promise<SdfCardsFixture>;
  }
}
it('captures shared material cards, traces SDFs and replays their mapping in browser WebGPU', async () => {
  await verifySdfCards(await commands.prepareSdfCardsFixture());
}, 120000);

it('keeps transformed, missing, stale and uncaptured SDF outcomes explicit', async () => {
  await verifySdfCases(await commands.prepareSdfCardsFixture());
}, 120000);

it('matches textured UV1 and vertex-color cards with ray-hit Surface', async () => {
  await verifyCardMaterial(await commands.prepareSdfCardsFixture());
}, 120000);

it('captures open and two-sided MASK sheets with variable card counts and empty atlas padding', async () => {
  await verifyCardCoverage(await commands.prepareSdfCardsFixture());
}, 120000);

it('traces both sides of loaded thin-sheet fields and replays hits and material mapping', async () => {
  await verifyTwoSidedSdf(await commands.prepareSdfCardsFixture());
}, 120000);

it('shares whole-mesh card depth across material sections and rejects stale colors', async () => {
  await verifyMultiMaterialCards(await commands.prepareSdfCardsFixture());
}, 120000);

it('maps sampled visibility hits with zero allowance and rejects invalid card associations', async () => {
  await verifyVisibilityCards(await commands.prepareSdfCardsFixture());
}, 120000);
