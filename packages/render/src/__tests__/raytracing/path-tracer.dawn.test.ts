import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { renderPathGallery, verifyPathLighting } from './path-lighting.fixture';
import { prepareRayPathFixture } from './path-tracer.commands';
import { verifyRayPath } from './path-tracer.fixture';
import { verifySurfaceAndBsdf } from './surface-bsdf.fixture';

it('traces shared materials and replays warm accumulation on a fresh Dawn device', async () => {
  const fixture = await prepareRayPathFixture();
  const result = await verifyRayPath(fixture);
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'prepared.json'), JSON.stringify(fixture));
    await writeFile(join(dir, 'path-tracer.rhitape'), result.bytes);
    await writeFile(join(dir, 'path-live.bin'), result.live);
    await writeFile(join(dir, 'path-summary.json'), JSON.stringify(result.results, null, 2));
  }
}, 120000);

it('matches raster/ray texture footprints and BSDF quadrature', async () => {
  await verifySurfaceAndBsdf(await prepareRayPathFixture());
}, 120000);

it('validates analytic shadows, emission, material edits and indirect emitter hits', async () => {
  await verifyPathLighting(await prepareRayPathFixture());
}, 120000);
it('renders the bounded reference gallery', async () => {
  const result = await renderPathGallery(await prepareRayPathFixture());
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'gallery-accumulation.bin'), result.bytes);
  }
}, 120000);

it('preserves geometric and shading frames through mirrored traversal, cards and replay', async () => {
  const { verifyNormalFrame } = await import('./normal-frame.fixture');
  const { prepareSdfCardsFixture } = await import('./sdf-cards.commands');
  const result = await verifyNormalFrame(
    await prepareRayPathFixture(),
    await prepareSdfCardsFixture(),
  );
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'normal-frame.rhitape'), result.bytes);
    await writeFile(join(dir, 'normal-frame.json'), JSON.stringify(result.results, null, 2));
  }
}, 120000);

it('resolves masked primary and shadow candidates without skipping coplanar surfaces', async () => {
  const { verifyCoverage } = await import('./coverage.fixture');
  const result = await verifyCoverage(await prepareRayPathFixture(), async (bytes) => {
    const dir = process.env.FORGEAX_RAY_EVIDENCE;
    if (dir) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'coverage.rhitape'), bytes);
    }
  });
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'coverage.rhitape'), result.bytes);
    await writeFile(
      join(dir, 'coverage.json'),
      JSON.stringify({ ...result, bytes: undefined }, null, 2),
    );
  }
}, 120000);

it('resolves external raster receiver rays with shared materials and fresh replay in dawn', async () => {
  const { verifyInitialPathRays } = await import('./path-source.fixture');
  await verifyInitialPathRays(await prepareRayPathFixture());
}, 120000);
