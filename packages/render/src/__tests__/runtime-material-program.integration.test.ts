import { AssetRegistry, HANDLE_CUBE, RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
  type MaterialCookRayContext,
} from '@forgeax/engine-pack';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  MATERIAL_CONTEXT,
  materialRecordFixture,
} from '../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { MeshFilter, MeshRenderer } from '../components';
import { installPublicationPrograms } from '../publication/programs';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { materialRayForMaterial, resolveMaterialSnapshot } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';

it('keeps cooked Forward and ShadowCaster programs when World values change or a catalogue entry is replaced', () => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const world = new World();
  const record = materialRecordFixture({
    parameters: [{ name: 'roughness', type: 'f32' }],
    values: { roughness: 0.8 },
    passes: [
      { name: 'Forward', program: { module: 'game::material' } },
      { name: 'ShadowCaster', program: { module: 'game::shadow' } },
    ],
  });
  const [firstPass, ...otherPasses] = record.resolved.passes;
  if (firstPass === undefined) throw new Error('Missing cooked passes');
  const base: MaterialAsset = {
    kind: 'material',
    ...record.resolved,
    passes: [firstPass, ...otherPasses],
    values: Object.fromEntries(
      Object.entries(record.resolved.values).filter(
        (entry): entry is [string, Exclude<(typeof entry)[1], null>] => entry[1] !== null,
      ),
    ),
  };
  assets.catalog(record.guid, base).unwrap();
  if (
    !record.sourceClosure ||
    !record.parameterContract ||
    record.publicationGeneration === undefined ||
    record.specializationKey === undefined ||
    record.artifactDigest === undefined
  )
    throw new Error('Missing cooked metadata');
  assets.recordMaterialReadiness(record.guid, {
    status: 'Ready',
    guid: record.guid,
    materialGuid: record.guid,
    publicationGeneration: record.publicationGeneration,
    specializationKey: record.specializationKey,
    artifactDigest: record.artifactDigest,
    sourceClosure: record.sourceClosure,
    parameterContract: record.parameterContract,
    record,
    programs: record.programs,
  });
  const handle = world.internSharedRef('MaterialAsset', base);
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  world.update(0).unwrap();
  const frameRead = () =>
    extractFrames([world], 0, assets, undefined, undefined, {
      materialContext: MATERIAL_CONTEXT,
      cull: 'none',
    }).renderables[0]?.materials[0];
  const read = () =>
    resolveMaterialSnapshot(handle, world, assets, undefined, undefined, MATERIAL_CONTEXT);
  const before = read();
  expect(frameRead()?.materialProgramKeys).toEqual(before.materialProgramKeys);
  expect(Object.keys(before.materialProgramKeys ?? {})).toEqual(['Forward', 'ShadowCaster']);
  const content = world
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: handle,
        parameter: 'roughness',
        kind: 0,
        value: [0.25],
      },
    })
    .unwrap();
  expect(read().roughness).toBe(0.25);
  expect(frameRead()?.materialProgramKeys).toEqual(before.materialProgramKeys);
  expect(read().materialProgramKeys).toEqual(before.materialProgramKeys);
  assets.catalog(record.guid, { ...base, values: { roughness: 0.6 } }).unwrap();
  expect(read().materialProgramKeys).toEqual(before.materialProgramKeys);
  world.despawn(content).unwrap();
  expect(read().roughness).toBeCloseTo(0.8);
  expect(read().materialProgramKeys).toEqual(before.materialProgramKeys);
});

it('carries the accepted ray program through value edits and detached publication', async () => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const receiverAssets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const world = new World();
  const context: MaterialCookRayContext = {
    backend: 'webgpu',
    capability: 'storage-buffer',
    pipeline: 'ray',
    geometry: 'mesh',
    pass: 'ray-hit',
    profile: 'forgeax-material-ray-v1',
    toolchain: 'naga-oil',
    instrumentation: 'none',
  };
  const publishMaterial = (generation: number) => {
    const record = materialRecordFixture({
      generation,
      parameters: [
        { name: 'roughness', type: 'f32', default: 0.8 },
        { name: 'alphaCutoff', type: 'f32', default: 0 },
      ],
      passes: [{ name: 'Forward', program: { module: 'game::material' } }],
    });
    const bytes = new TextEncoder().encode(`ray fixture generation ${generation}`);
    const digest = createMaterialArtifactDigest(bytes);
    const ray = {
      specializationKey: `program/${digest}`,
      artifact: { mediaType: 'text/wgsl' as const, path: 'ray.wgsl', bytes, digest },
      selections: [{ pass: 'Forward', context }],
    };
    const programs = [...record.programs, ray];
    const artifactDigest = createMaterialProgramSetDigest(programs, record.resolved.passes);
    const cooked = {
      ...record,
      programs,
      artifactDigest,
      receipt: { ...record.receipt, identity: { ...record.receipt.identity, artifactDigest } },
    };
    const [first, ...rest] = cooked.resolved.passes;
    if (
      !first ||
      !cooked.parameterContract ||
      !cooked.sourceClosure ||
      cooked.specializationKey === undefined ||
      cooked.artifactDigest === undefined
    )
      throw new Error('incomplete fixture');
    const material: MaterialAsset = {
      kind: 'material',
      parameters: cooked.resolved.parameters,
      passes: [first, ...rest],
      values: {},
    };
    assets.catalog(cooked.guid, material).unwrap();
    assets.recordMaterialReadiness(cooked.guid, {
      status: 'Ready',
      guid: cooked.guid,
      materialGuid: cooked.guid,
      publicationGeneration: generation,
      specializationKey: cooked.specializationKey,
      artifactDigest: cooked.artifactDigest,
      sourceClosure: cooked.sourceClosure,
      parameterContract: cooked.parameterContract,
      record: cooked,
      programs: cooked.programs,
    });
    return { material, key: ray.specializationKey, bytes };
  };
  const first = publishMaterial(1);
  for (const context of [
    { ...MATERIAL_CONTEXT, backend: 'webgl2' as const },
    { ...MATERIAL_CONTEXT, capability: 'uniform-fallback' as const },
    { ...MATERIAL_CONTEXT, geometry: 'skinned' as const },
    { ...MATERIAL_CONTEXT, instrumentation: 'validation' as const },
  ])
    expect(materialRayForMaterial(first.material, assets, context, first.material)).toBeUndefined();
  const handle = world.internSharedRef('MaterialAsset', first.material);
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  world.update(0).unwrap();
  const read = () =>
    resolveMaterialSnapshot(handle, world, assets, undefined, undefined, MATERIAL_CONTEXT);
  const frameRead = () =>
    extractFrames([world], 0, assets, undefined, undefined, {
      materialContext: MATERIAL_CONTEXT,
      cull: 'none',
    }).renderables[0]?.material;
  expect(read().materialRay?.programKey).toBe(first.key);
  expect(frameRead()?.materialRay?.programKey).toBe(first.key);
  expect(read().materialRay?.evaluateCoverage).toBe(false);
  const coverage = world
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: handle,
        parameter: 'alphaCutoff',
        kind: 0,
        value: [0.5],
      },
    })
    .unwrap();
  expect(read().materialRay).toEqual({ programKey: first.key, evaluateCoverage: true });
  expect(frameRead()?.materialRay).toEqual(read().materialRay);
  world.despawn(coverage).unwrap();
  expect(read().materialRay?.evaluateCoverage).toBe(false);
  // An arbitrary Surface can cut holes even with zero Standard alphaCutoff.
  expect(
    materialRayForMaterial(first.material, assets, MATERIAL_CONTEXT, {
      ...first.material,
      surface: { model: 'standard', module: 'game::cut-holes' },
    })?.evaluateCoverage,
  ).toBe(true);

  const source = world
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: handle,
        parameter: 'roughness',
        kind: 0,
        value: [0.25],
      },
    })
    .unwrap();
  expect(read().roughness).toBe(0.25);
  expect(read().materialRay?.programKey).toBe(first.key);
  const latest = publishMaterial(2);
  expect(latest.key).not.toBe(first.key);
  expect(read().materialRay?.programKey).toBe(first.key);
  expect(frameRead()?.materialRay?.programKey).toBe(first.key);
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const identity = { source: 'ray-publication', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, {
    ...device.caps,
    backendKind: 'webgpu',
  });
  try {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    expect(packet.programs.some((program) => program.key === first.key)).toBe(true);
    expect(packet.programs.some((program) => program.key === latest.key)).toBe(false);
    installPublicationPrograms(receiverAssets, packet.programs);
    const accepted = new RenderPublicationReceiver(identity).accept(packet).unwrap();
    expect(accepted.frame.renderables[0]?.material.materialRay?.programKey).toBe(first.key);
    expect(receiverAssets.getMaterialArtifact(first.key)?.bytes).toEqual(first.bytes);
    expect(receiverAssets.getMaterialArtifact(latest.key)).toBeUndefined();
    world.despawn(source).unwrap();
    expect(read().roughness).toBeCloseTo(0.8);
    expect(read().materialRay?.programKey).toBe(first.key);
  } finally {
    publisher.dispose();
  }
});
