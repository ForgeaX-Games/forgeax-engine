import { buildMeshDistanceField } from '@forgeax/engine-geometry';
import { RhiError } from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { createGlobalSdfComposition, type GlobalSdfGrid } from '../../raytracing/global-sdf';
import { createGlobalSdfQuery } from '../../raytracing/global-sdf-query';
import { sdfInstanceKey } from '../../raytracing/sdf-query';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

it('bounds global composition inputs, freezes async preparation and releases every owned buffer', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  assert(device instanceof RhiNullDevice);
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 8 })
  ).unwrap();
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const source = { instanceId: 7, geometryId: 9, mask: 255, transform, field };
  const origin: [number, number, number] = [-2, -2, -2];
  const grid: GlobalSdfGrid = {
    origin,
    dimensions: [9, 9, 9],
    spacing: 0.5,
    maxDistance: 2,
    coverageDistance: 0.25,
  };
  const live = () =>
    device.bookkeeper.allRecords().filter((r) => r.kind === 'Buffer' && !r.destroyed);
  for (const invalid of [
    { ...grid, spacing: 0 },
    { ...grid, spacing: 1e-50 },
    { ...grid, maxDistance: Infinity },
    { ...grid, coverageDistance: 3 },
    { ...grid, coverageDistance: -1 },
    { ...grid, dimensions: [129, 9, 9] as const },
    { ...grid, dimensions: [1, 0, 1] as const },
    { ...grid, origin: [1e20, 0, 0] as const },
    { ...grid, origin: [8388607, 0, 0] as const },
  ])
    expect(
      (await createGlobalSdfComposition(device, createShaderModule, [source], invalid)).ok,
    ).toBe(false);
  const shear = [...transform];
  shear[4] = 0.5;
  expect(
    (
      await createGlobalSdfComposition(
        device,
        createShaderModule,
        [{ ...source, transform: shear }],
        grid,
      )
    ).ok,
  ).toBe(false);
  expect(live()).toHaveLength(0);
  expect(
    (
      await createGlobalSdfComposition(
        device,
        createShaderModule,
        Array.from({ length: 1025 }, (_, instanceId) => ({ ...source, instanceId })),
        grid,
      )
    ).ok,
  ).toBe(false);
  const many = (
    await createGlobalSdfComposition(
      device,
      createShaderModule,
      Array.from({ length: 65 }, (_, instanceId) => ({ ...source, instanceId })),
      grid,
    )
  ).unwrap();
  expect(many.sources).toHaveLength(65);
  many.dispose();
  expect(live()).toHaveLength(0);
  const failure = async () =>
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'injected compile failure',
        hint: 'retry compilation',
      }),
    );
  expect((await createGlobalSdfComposition(device, failure, [source], grid)).ok).toBe(false);
  expect(live()).toHaveLength(0);
  let complete: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const oldKey = sdfInstanceKey(source);
  const pending = createGlobalSdfComposition(
    device,
    async (d, desc) => {
      await gate;
      return createShaderModule(d, desc);
    },
    [source],
    grid,
  );
  transform[12] = 20;
  origin[0] = 99;
  assert(complete);
  complete();
  const built = (await pending).unwrap();
  expect(built.sources[0]?.key).toBe(oldKey);
  expect(built.grid.origin[0]).toBe(-2);
  expect(built.voxelCount).toBe(729);
  expect(live()).toHaveLength(5);
  const encoder = device.createCommandEncoder({}).unwrap();
  expect(built.record(encoder).ok).toBe(true);
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  built.dispose();
  built.dispose();
  expect(live()).toHaveLength(0);
  expect(built.record(device.createCommandEncoder({}).unwrap()).ok).toBe(false);
});

it('keeps global query resource ownership and mask admission at the composed-region boundary', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  assert(device instanceof RhiNullDevice);
  const grid: GlobalSdfGrid = {
    origin: [-3, -3, -3],
    dimensions: [13, 13, 13],
    spacing: 0.5,
    maxDistance: 2,
    coverageDistance: 0.5,
  };
  const composition = (
    await createGlobalSdfComposition(device, createShaderModule, [], grid)
  ).unwrap();
  const live = () =>
    device.bookkeeper.allRecords().filter((r) => r.kind === 'Buffer' && !r.destroyed);
  const ray = {
    origin: [0, 0, 0] as const,
    direction: [0, 1, 0] as const,
    tMin: 0,
    tMax: 2,
    mask: 255,
  };
  const baseline = live().length;
  for (const maxSteps of [0, -1, 1.5, 1025, Infinity])
    expect(
      (await createGlobalSdfQuery(device, createShaderModule, composition, [ray], { maxSteps })).ok,
    ).toBe(false);
  for (const minStepFactor of [0, -1, 1.1, Number.NaN, Infinity, 1e-50])
    expect(
      (
        await createGlobalSdfQuery(device, createShaderModule, composition, [ray], {
          minStepFactor,
        })
      ).ok,
    ).toBe(false);
  expect(
    (await createGlobalSdfQuery(device, createShaderModule, composition, [{ ...ray, mask: 1 }])).ok,
  ).toBe(false);
  for (const invalid of [
    { ...ray, direction: [1e-40, 0, 0] as const },
    { ...ray, direction: [3e38, 3e38, 0] as const },
    { ...ray, direction: [2e38, 0, 0] as const },
    { ...ray, origin: [3e38, 0, 0] as const, direction: [1e38, 0, 0] as const },
  ])
    expect(
      (await createGlobalSdfQuery(device, createShaderModule, composition, [invalid])).ok,
    ).toBe(false);
  const small = (
    await createGlobalSdfComposition(device, createShaderModule, [], {
      ...grid,
      dimensions: [1, 1, 1],
    })
  ).unwrap();
  expect((await createGlobalSdfQuery(device, createShaderModule, small, [ray])).ok).toBe(false);
  small.dispose();
  expect(live()).toHaveLength(baseline);
  const fail = async () =>
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'injected compile failure',
        hint: 'retry',
      }),
    );
  expect((await createGlobalSdfQuery(device, fail, composition, [ray])).ok).toBe(false);
  expect(live()).toHaveLength(baseline);
  let complete: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const mutableRays = [{ ...ray }];
  const pending = createGlobalSdfQuery(
    device,
    async (d, desc) => {
      await gate;
      return createShaderModule(d, desc);
    },
    composition,
    mutableRays,
  );
  assert(mutableRays[0]);
  mutableRays[0].mask = 1;
  mutableRays.push({ ...ray });
  assert(complete);
  complete();
  const query = (await pending).unwrap();
  expect(query.rayCount).toBe(1);
  expect(query.buffers.voxels).toBe(composition.buffers.voxels);
  expect(query.buffers.grid).toBe(composition.buffers.settings);
  expect(live()).toHaveLength(baseline + 3);
  const e = device.createCommandEncoder({}).unwrap();
  composition.record(e).unwrap();
  query.record(e).unwrap();
  device.queue.submit([e.finish().unwrap()]).unwrap();
  query.dispose();
  query.dispose();
  expect(live()).toHaveLength(baseline);
  expect(query.record(device.createCommandEncoder({}).unwrap()).ok).toBe(false);
  const after = device.createCommandEncoder({}).unwrap();
  composition.record(after).unwrap();
  device.queue.submit([after.finish().unwrap()]).unwrap();
  composition.dispose();
  expect(live()).toHaveLength(0);
});
