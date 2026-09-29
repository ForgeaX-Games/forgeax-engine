import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyGpuPathSource } from './path-buffer.fixture';

it('consumes GPU-written receiver rays in command order and replays both source generations', async () => {
  await verifyGpuPathSource(await commands.prepareRayPathFixture());
}, 120000);

it('declares real producer and transport work in RenderGraph without hiding compute in copy passes', async () => {
  await verifyGpuPathSource(await commands.prepareRayPathFixture(), true);
}, 120000);
