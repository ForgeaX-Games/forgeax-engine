import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderer as constructRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const EMPTY_RESOURCE_CLASS = JSON.stringify({ textures: [], samplers: [], video: [] });

function snapshot(entityKey: number, assetHandle: number): RenderableSnapshot {
  const material = {
    baseColor: new Float32Array([0.25 * entityKey, 0.5, 0.75]),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-unlit',
  } as MaterialSnapshot;
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  return {
    assetHandle,
    transform: { world },
    localAabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'forgeax::default-unlit|triangle-list|null',
        materialResourceClass: EMPTY_RESOURCE_CLASS,
      },
    ],
  };
}

function mesh(device: RhiNullDevice, indexed = true): MeshGpuHandles {
  const vertex = device
    .createBuffer({
      size: 144,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const index = indexed
    ? device
        .createBuffer({
          size: 8,
          usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        .unwrap()
    : null;
  return {
    vertexBuffer: new GpuBuffer(device, vertex),
    indexBuffer: index === null ? null : new GpuBuffer(device, index),
    vboBytes: 144,
    iboBytes: indexed ? 8 : 0,
    indexCount: indexed ? 3 : 0,
    indexFormat: 'uint16',
    layout: '12F',
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    uvSetCount: 1,
    vertexCount: 3,
    indexed,
    topology: 'triangle-list',
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
  };
}

describe('GPU-driven production projection', () => {
  it('projects aligned multi-batch compute work into one indirect raster pass', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const viewUniform = device
      .createBuffer({ size: 784, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const viewBindGroup = device
      .createBindGroup({
        layout: viewLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: viewUniform } } }],
      })
      .unwrap();
    const first = snapshot(1, 3);
    const firstDraw = first.gpuDrivenDraws?.[0];
    expect(firstDraw).toBeDefined();
    if (firstDraw === undefined) return;
    const second = snapshot(2, 4);
    const secondDraw = second.gpuDrivenDraws?.[0];
    expect(secondDraw).toBeDefined();
    if (secondDraw === undefined) return;
    const preparedMaterial = {
      ...second.material,
      materialHandle: 42,
      renderState: { cullMode: 'none' as const, depthCompare: 'less-equal' as const },
    };
    const renderables = [
      { ...first, gpuDrivenDraws: [firstDraw, { ...firstDraw, first: 3 }] },
      {
        ...second,
        material: preparedMaterial,
        materials: [preparedMaterial],
        gpuDrivenDraws: [
          {
            ...secondDraw,
            kind: 'non-indexed' as const,
            pipelineClass:
              'forgeax::default-unlit|triangle-list|{"cullMode":"none","depthCompare":"less-equal"}',
          },
        ],
      },
    ];
    const projection = new RenderScene();
    const delta = projection.apply(
      renderables.map((renderable) => ({ kind: 'create' as const, snapshot: renderable })),
    );
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan()).toMatchObject({
      candidateCount: 3,
      visibleCapacity: 129,
      batches: [{ visibleBase: 0 }, { visibleBase: 64 }, { visibleBase: 128 }],
    });
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const meshes = new Map([
      [3, mesh(device)],
      [4, mesh(device, false)],
    ]);
    const prepared = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
      })
      .unwrap();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    expect([...prepared.entityKeys]).toEqual([1, 2]);
    expect(production.inspect()).toMatchObject({
      gpuOwnedSnapshotsMaterialized: 2,
      filteredPlanBuilds: 1,
      candidateUploadBytes: 84,
      batchUploadBytes: 84,
      viewBindGroupCreates: 1,
    });

    const stable = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
      })
      .unwrap();
    expect(stable?.topologySignature).toBe(prepared.topologySignature);
    expect(production.inspect()).toMatchObject({
      gpuOwnedSnapshotsMaterialized: 0,
      filteredPlanBuilds: 0,
      candidateUploadBytes: 0,
      batchUploadBytes: 0,
      viewConstantsUploadBytes: 112,
      viewBindGroupCreates: 0,
      batchBindGroupCreates: 0,
    });

    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const gpu = prepared.project(graph, 'rgba8unorm', 1).unwrap();
    const color = graph
      .createTexture('gpu-driven-production-color', {
        format: 'rgba8unorm',
        size: { width: 1, height: 1 },
      })
      .unwrap();
    const colorView = graph.view(color).unwrap();
    graph
      .addRasterPass('main', {
        accesses: [...gpu.accesses, { resource: colorView, usage: 'color-attachment' }],
        colorAttachments: [
          {
            view: colorView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
        encode: ({ pass, resources }) => gpu.encode(viewBindGroup, pass, resources),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes.at(-1)).toMatchObject({
      name: 'main',
      dependencies: ['gpu-driven.frustum-compact', 'gpu-driven.finalize-indirect'],
    });
    const encoder = device.createCommandEncoder({ label: 'gpu-driven-production' }).unwrap();
    compiled.execute({ viewBindGroup, encoder } as unknown as RenderPipelineFrame).unwrap();
    encoder.finish().unwrap();
    expect(device.framePassNames).toEqual([
      'gpu-driven.view-reset',
      'gpu-driven.frustum-compact',
      'gpu-driven.finalize-indirect',
      'main',
    ]);
    expect(device.totalDispatchCount).toBe(3);
    expect(device.totalDrawCount).toBe(3);

    const replacement = GpuScene.create(device, 2).unwrap();
    expect(replacement.status).toBe('available');
    if (replacement.status !== 'available') return;
    replacement.scene.sync(delta).unwrap();
    const replacementPrepared = production
      .prepare({
        scene: {
          scene: replacement.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
      })
      .unwrap();
    expect(replacementPrepared?.topologySignature).not.toBe(prepared.topologySignature);

    production.dispose();
    replacement.scene.dispose();
    availability.scene.dispose();
  });

  it('activates inside the renderer-owned URP graph and removes the CPU forward draw', async () => {
    const manifest = `data:application/json,${encodeURIComponent(
      JSON.stringify({
        schemaVersion: '1.0.0',
        entries: [
          { hash: 'pbr00000', wgsl: '/* pbr stub */', glsl: '', bindings: '' },
          { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
          { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
        ],
      }),
    )}`;
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(canvas, { rhi }, { shaderManifestUrl: manifest });
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    expect(renderer.attach(world).ok).toBe(true);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();

    for (let frame = 0; frame < 4; frame += 1) {
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
      await Promise.resolve();
    }
    const device = renderer.device as RhiNullDevice;
    device.totalDrawCount = 0;
    world.update(1 / 60).unwrap();
    expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
    expect(renderer.perFramePassNames).toEqual(
      expect.arrayContaining([
        'gpu-driven.view-reset',
        'gpu-driven.frustum-compact',
        'gpu-driven.finalize-indirect',
        'main',
      ]),
    );
    expect(device.totalDrawCount).toBe(2);
    expect(renderer.renderScene).toMatchObject({
      worldEntitiesScanned: 0,
      projectionRecords: 1,
      topology: { batchCount: 1, candidateCount: 1 },
      gpu: { status: 'resident' },
      gpuDriven: {
        gpuOwnedSnapshotsMaterialized: 0,
        filteredPlanBuilds: 0,
        candidateUploadBytes: 0,
        batchUploadBytes: 0,
        batchBindGroupCreates: 0,
        viewBindGroupCreates: 0,
        validatedGpuOwnedRows: 0,
        cpuFallbackDrawItems: 0,
      },
    });
    renderer.dispose();
  });

  it('keeps a stable multi-World composition resident and patches one World transform', async () => {
    const manifest = `data:application/json,${encodeURIComponent(
      JSON.stringify({
        schemaVersion: '1.0.0',
        entries: [
          { hash: 'pbr00000', wgsl: '/* pbr stub */', glsl: '', bindings: '' },
          { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
          { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
        ],
      }),
    )}`;
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(canvas, { rhi }, { shaderManifestUrl: manifest });
    expect((await renderer.initialization).ok).toBe(true);
    const cameraWorld = new World();
    const sceneWorld = new World();
    expect(renderer.attach(cameraWorld).ok).toBe(true);
    expect(renderer.attach(sceneWorld).ok).toBe(true);
    cameraWorld
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    const rendered = sceneWorld
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();

    for (let frame = 0; frame < 4; frame += 1) {
      cameraWorld.update(1 / 60).unwrap();
      sceneWorld.update(1 / 60).unwrap();
      expect(
        renderer.draw([cameraWorld, sceneWorld], { cameraOwner: 0, resourceOwner: 0 }).ok,
      ).toBe(true);
      await Promise.resolve();
    }
    expect(renderer.renderScene).toMatchObject({
      worldEntitiesScanned: 0,
      projectionRecords: 1,
      topology: { batchCount: 1, candidateCount: 1 },
      gpu: { status: 'resident' },
      gpuDriven: { cpuFallbackDrawItems: 0, validatedGpuOwnedRows: 0 },
    });

    sceneWorld.set(rendered, Transform, { pos: [1, 0, 0] }).unwrap();
    cameraWorld.update(1 / 60).unwrap();
    sceneWorld.update(1 / 60).unwrap();
    expect(renderer.draw([cameraWorld, sceneWorld], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(
      true,
    );
    expect(renderer.renderScene).toMatchObject({
      worldEntitiesScanned: 0,
      fullRebuilds: 1,
      transformUpdates: 1,
      projectionRecords: 1,
    });
    renderer.dispose();
  });
});
