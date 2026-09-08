import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GPU_DRIVEN_RIGID_UNLIT_WGSL, GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const EMPTY_RESOURCE_CLASS = JSON.stringify({ textures: [], samplers: [], video: [] });

function snapshot(entityKey: number, assetHandle: number): RenderableSnapshot {
  const world = mat4.identity(mat4.create());
  const material = {
    baseColor: new Float32Array([0.25, 0.5, 0.75]),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-unlit',
  } as MaterialSnapshot;
  return {
    assetHandle,
    transform: { world: new Float32Array(world) },
    localAabb: new Float32Array([-1, -1, -1.25, 1, 1, -0.75]),
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

function camera(): CameraSnapshot {
  const world = mat4.identity(mat4.create());
  world[14] = 3;
  return {
    position: vec3.create(0, 0, 3),
    world: new Float32Array(world),
    fov: Math.PI / 2,
    aspect: 1,
    near: 0.1,
    far: 10,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomBlurRadius: 4,
    clearColor: [0, 0, 0, 0],
  };
}

export interface GpuDrivenIndirectRasterEvidence {
  readonly pixel: readonly number[];
  readonly passNames: readonly string[];
}

export async function runGpuDrivenIndirectRasterEvidence(): Promise<GpuDrivenIndirectRasterEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const viewShader = (
    await createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL, label: 'gpu-driven-view' })
  ).unwrap();
  const rasterShader = (
    await createShaderModule(device, {
      code: GPU_DRIVEN_RIGID_UNLIT_WGSL,
      label: 'gpu-driven-rigid-unlit',
    })
  ).unwrap();
  const viewLayout = device
    .createBindGroupLayout({
      label: 'gpu-driven-production-view-bgl',
      entries: [
        { binding: 0, visibility: 0x1, buffer: { type: 'uniform' } },
        {
          binding: 10,
          visibility: 0x1,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
      ],
    })
    .unwrap();
  const viewUniform = device
    .createBuffer({
      label: 'gpu-driven-production-view',
      size: 784,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const viewPayload = new Float32Array(196);
  const projectionMatrix = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 10);
  const view = mat4.invert(mat4.create(), camera().world);
  viewPayload.set(mat4.multiply(mat4.create(), projectionMatrix, view));
  device.queue.writeBuffer(viewUniform, 0, viewPayload).unwrap();
  const viewBindGroup = device
    .createBindGroup({
      label: 'gpu-driven-production-view-bg',
      layout: viewLayout,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: viewUniform } } },
        { binding: 10, resource: { kind: 'buffer', value: { buffer: viewUniform } } },
      ],
    })
    .unwrap();

  const vertexBuffer = device
    .createBuffer({
      label: 'gpu-driven-production-vertices',
      size: 144,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const vertices = new Float32Array(36);
  vertices.set([-1, -1, -1], 0);
  vertices.set([3, -1, -1], 12);
  vertices.set([-1, 3, -1], 24);
  device.queue.writeBuffer(vertexBuffer, 0, vertices).unwrap();
  const indexBuffer = device
    .createBuffer({
      label: 'gpu-driven-production-indices',
      size: 12,
      usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  device.queue.writeBuffer(indexBuffer, 0, new Uint16Array([0, 1, 2, 0, 1, 2])).unwrap();
  const mesh: MeshGpuHandles = {
    vertexBuffer: new GpuBuffer(device, vertexBuffer),
    indexBuffer: new GpuBuffer(device, indexBuffer),
    vboBytes: 144,
    iboBytes: 12,
    indexCount: 6,
    indexFormat: 'uint16',
    layout: '12F',
    uvSetCount: 1,
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    vertexCount: 3,
    indexed: true,
    topology: 'triangle-list',
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list',
      },
      {
        indexOffset: 3,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
  };

  const indexed = snapshot(1, 3);
  const indexedDraw = indexed.gpuDrivenDraws?.[0];
  const nonIndexed = snapshot(2, 4);
  const nonIndexedDraw = nonIndexed.gpuDrivenDraws?.[0];
  if (indexedDraw === undefined || nonIndexedDraw === undefined) {
    throw new Error('GPU-driven draw fixture unavailable');
  }
  const renderables = [
    { ...indexed, gpuDrivenDraws: [indexedDraw, { ...indexedDraw, first: 3 }] },
    {
      ...nonIndexed,
      gpuDrivenDraws: [{ ...nonIndexedDraw, kind: 'non-indexed' as const }],
    },
  ];
  const projection = new RenderScene();
  const delta = projection.apply(
    renderables.map((renderable) => ({ kind: 'create' as const, snapshot: renderable })),
  );
  const availability = GpuScene.create(device, 2).unwrap();
  if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
  availability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const production = new GpuDrivenProduction(device, {
    createShaderModule: ({ label }) => ok(label === 'gpu-driven-view' ? viewShader : rasterShader),
  });
  const prepared = production
    .prepare({
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
      },
      camera: camera(),
      meshes: new Map([
        [3, mesh],
        [
          4,
          {
            ...mesh,
            indexBuffer: null,
            iboBytes: 0,
            indexCount: 0,
            indexed: false,
            submeshes: [
              {
                indexOffset: 0,
                indexCount: 0,
                vertexCount: 3,
                materialSlot: 0,
                topology: 'triangle-list',
              },
            ],
          },
        ],
      ]),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,
      hdrp: false,
    })
    .unwrap();
  if (prepared === undefined) throw new Error('GPU-driven production lane inactive');

  const readbackBuffer = device
    .createBuffer({
      label: 'gpu-driven-production-readback',
      size: 256,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const gpu = prepared.project(graph, 'rgba8unorm', 1).unwrap();
  const output = graph
    .createTexture('gpu-driven-production-output', {
      format: 'rgba8unorm',
      size: { width: 1, height: 1 },
    })
    .unwrap();
  const outputView = graph.view(output).unwrap();
  const depth = graph
    .createTexture('gpu-driven-production-depth', {
      format: 'depth24plus-stencil8',
      size: { width: 1, height: 1 },
    })
    .unwrap();
  const depthView = graph.view(depth).unwrap();
  const readback = graph
    .importBuffer(
      'gpu-driven-production-readback',
      { size: 256, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
      () => readbackBuffer,
    )
    .unwrap();
  graph
    .addRasterPass('gpu-driven.opaque-indirect', {
      accesses: [
        ...gpu.accesses,
        { resource: outputView, usage: 'color-attachment' },
        { resource: depthView, usage: 'depth-stencil-write' },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'store',
      },
      colorAttachments: [
        {
          view: outputView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      encode: ({ pass, resources }) => gpu.encode(viewBindGroup, pass, resources),
    })
    .unwrap();
  graph
    .addCopyPass('gpu-driven.raster-readback', {
      accesses: [
        { resource: outputView, usage: 'copy-src' },
        { resource: readback, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) => {
        encoder.copyTextureToBuffer(
          { texture: resources.texture(output).unwrap() as unknown as GPUTexture },
          {
            buffer: resources.buffer(readback).unwrap() as unknown as GPUBuffer,
            bytesPerRow: 256,
            rowsPerImage: 1,
          },
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
      },
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const encoder = device.createCommandEncoder({ label: 'gpu-driven-production-frame' }).unwrap();
  compiled.execute({ viewBindGroup, encoder } as unknown as RenderPipelineFrame).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const mapped = (await readbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
  const pixel = [...new Uint8Array(mapped.getMappedRange().unwrap().slice(0, 4))];
  mapped.unmap();
  const passNames = compiled.inspect().passes.map((pass) => pass.name);

  (await compiled.retire()).unwrap();
  production.dispose();
  availability.scene.dispose();
  for (const buffer of [vertexBuffer, indexBuffer, viewUniform, readbackBuffer]) {
    device.destroyBuffer(buffer);
  }
  return { pixel, passNames };
}
