import { it } from 'vitest';
import { commands } from 'vitest/browser';
import type { DiffuseGiFixture } from './diffuse-gi.commands';
import { runGi, verifyDiffuseGi, verifyGiReplay } from './diffuse-gi.fixture';
import {
  verifyGiChanges,
  verifyGiEnergy,
  verifyGiOcclusion,
  verifyGiPunctual,
} from './diffuse-gi-cases.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareDiffuseGiFixture(): Promise<DiffuseGiFixture>;
  }
}
it('renders and independently replays raster primary with diffuse scene transport', async () => {
  const result = await runGi(await commands.prepareDiffuseGiFixture(), { capture: true });
  await verifyGiReplay(result);
  verifyDiffuseGi(result);
}, 120000);
it('preserves radiometric units, metal transport, updates, camera independence and strict wall support', async () => {
  const fixture = await commands.prepareDiffuseGiFixture();
  await verifyGiEnergy(fixture);
  await verifyGiChanges(fixture);
  await verifyGiOcclusion(fixture);
  await verifyGiPunctual(fixture);
}, 180000);

import { verifyGiRoom } from './diffuse-gi-room.fixture';

it('keeps enclosed-room visibility separate from unresolved feedback', async () => {
  const fixture = await commands.prepareDiffuseGiFixture();
  await verifyGiRoom(fixture);
  await verifyGiRoom(fixture, true);
}, 180000);

import { verifyGiFallback } from './diffuse-gi-cases.fixture';

it('falls back from unavailable probe support to local scene transport', async () => {
  await verifyGiFallback(await commands.prepareDiffuseGiFixture());
}, 120000);

import { verifyGiPerspective } from './gi-view.fixture';

it('matches the perspective raster primary against independent exact triangle rays', async () => {
  await verifyGiPerspective(await commands.prepareDiffuseGiFixture());
}, 120000);
