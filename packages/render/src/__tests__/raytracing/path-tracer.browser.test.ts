import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyPathLighting } from './path-lighting.fixture';
import { verifyRayPath } from './path-tracer.fixture';
import { verifySurfaceAndBsdf } from './surface-bsdf.fixture';

it('traces shared materials and replays warm accumulation in browser WebGPU', async () => {
  await verifyRayPath(await commands.prepareRayPathFixture());
}, 120000);

it('matches raster/ray texture footprints and BSDF quadrature in browser', async () => {
  await verifySurfaceAndBsdf(await commands.prepareRayPathFixture());
}, 120000);

it('validates analytic shadows, emission, material edits and indirect emitter hits in browser', async () => {
  await verifyPathLighting(await commands.prepareRayPathFixture());
}, 120000);

it('preserves geometric and shading frames through mirrored traversal, cards and replay in browser', async () => {
  const { verifyNormalFrame } = await import('./normal-frame.fixture');
  await verifyNormalFrame(
    await commands.prepareRayPathFixture(),
    await commands.prepareSdfCardsFixture(),
  );
}, 120000);

it('resolves masked primary and shadow candidates in browser WebGPU', async () => {
  const { verifyCoverage } = await import('./coverage.fixture');
  await verifyCoverage(await commands.prepareRayPathFixture());
}, 120000);

it('resolves external raster receiver rays with shared materials and fresh replay in browser', async () => {
  const { verifyInitialPathRays } = await import('./path-source.fixture');
  await verifyInitialPathRays(await commands.prepareRayPathFixture());
}, 120000);

it('separates the diffuse receiver from the full BSDF under an open-sky white furnace in browser', async () => {
  const { verifyPathReceiver } = await import('./path-receiver.fixture');
  await verifyPathReceiver(await commands.prepareRayPathFixture());
}, 120000);
