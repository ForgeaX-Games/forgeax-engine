import type {
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import type { Texture, TextureView } from '@forgeax/engine-rhi';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { DIFFUSE_HISTORY_BYTES } from './diffuse-reconstruction';
import { RAY_PATH_STRIDE } from './path-tracer';
import type { PreparedRayDiffuse } from './renderer-diffuse';

export interface RayDiffuseTargets {
  readonly scene: RenderPipelineTarget;
  readonly depth: GraphTextureView;
  readonly normal: RenderPipelineTarget;
  readonly albedo: RenderPipelineTarget;
  readonly f0: RenderPipelineTarget;
  readonly identity: RenderPipelineTarget;
  readonly motion: RenderPipelineTarget;
}

/** Declare the actual G-buffer -> receiver -> raw D -> additive HDR dependency chain. */
export function addRayDiffusePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepared: PreparedRayDiffuse,
  target: RayDiffuseTargets,
) {
  const records = graph
    .importBuffer(
      'ray-diffuse.records',
      { size: prepared.recordBytes, usage: 128 | 8 },
      () => prepared.records,
    )
    .unwrap();
  const rays = graph
    .importBuffer(
      'ray-diffuse.initial-rays',
      { size: prepared.pixelCount * RAY_PATH_STRIDE, usage: 128 | 8 },
      () => prepared.rays,
    )
    .unwrap();
  const sample = graph
    .importBuffer('ray-diffuse.sample', { size: 16, usage: 64 | 8 }, () => prepared.sample)
    .unwrap();
  const view = graph
    .importBuffer(
      'ray-diffuse.view',
      { size: VIEW_UNIFORM_BYTES, usage: 64 | 8 },
      (frame) => frame.pipelineState.viewUniformBuffer,
    )
    .unwrap();
  const generated = graph.addComputePass('ray-diffuse.generate', {
    accesses: [
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
      { resource: target.identity.view, usage: 'sampled-read' },
      { resource: records, usage: 'storage-read' },
      { resource: view, usage: 'uniform-read' },
      { resource: sample, usage: 'uniform-read' },
      { resource: rays, usage: 'storage-write' },
    ],
    encode: ({ pass, resources }) => {
      if (prepared.fence.currentGeneration() !== prepared.generation)
        throw new Error('stale diffuse GI graph; prepare the current scene');
      prepared.writeSample();
      prepared.generate
        .record(
          pass,
          {
            depth: resources.textureView(target.depth).unwrap(),
            normal: resources.textureView(target.normal.view).unwrap(),
            identity: resources.textureView(target.identity.view).unwrap(),
            records: { buffer: resources.buffer(records).unwrap(), size: prepared.recordBytes },
            view: { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
            sample: resources.buffer(sample).unwrap(),
            rays: resources.buffer(rays).unwrap(),
          },
          prepared.pixelCount,
        )
        .unwrap();
    },
  });
  if (!generated.ok) return generated;
  const textures = new Map<TextureView, GraphTextureView>();
  const allocations = new Map<Texture, GraphTexture>();
  for (const material of prepared.textures) {
    for (const resident of material.textures.values()) {
      if (textures.has(resident.view)) continue;
      const receipt = resident.receipt;
      if (receipt.view !== '2d') throw new Error('ray material expects a 2D resident texture');
      let allocation = allocations.get(resident.texture);
      if (allocation === undefined) {
        allocation = graph
          .importTexture(
            `ray-diffuse.material.${allocations.size}`,
            {
              format: receipt.format,
              size: receipt.extent,
              mipLevelCount: receipt.mipLevelCount,
              usage: 4,
            },
            () => resident.texture,
          )
          .unwrap();
        allocations.set(resident.texture, allocation);
      }
      textures.set(
        resident.view,
        graph
          .importView(
            allocation,
            { dimension: '2d', mipLevelCount: receipt.mipLevelCount },
            () => resident.view,
          )
          .unwrap(),
      );
    }
  }
  const accumulation = prepared.transport
    .addSampleToGraph(graph, {
      label: 'ray-diffuse.transport',
      buffers: new Map([[prepared.rays, rays]]),
      textures,
      // Iteration 2 produces one independent raw sample per frame. Temporal
      // accumulation belongs to the later reconstruction owner, never this buffer.
      reset: true,
    })
    .unwrap();
  let irradiance = accumulation;
  const reconstruction = prepared.reconstruction;
  if (reconstruction !== undefined) {
    const previous = graph
      .importBuffer(
        'ray-diffuse.history.previous',
        { size: prepared.pixelCount * DIFFUSE_HISTORY_BYTES, usage: 128 | 12 },
        () => reconstruction.previous,
      )
      .unwrap();
    const current = graph
      .importBuffer(
        'ray-diffuse.history.current',
        { size: prepared.pixelCount * DIFFUSE_HISTORY_BYTES, usage: 128 | 12 },
        () => reconstruction.current,
      )
      .unwrap();
    const signal = graph
      .importBuffer(
        'ray-diffuse.signal',
        { size: prepared.pixelCount * 16, usage: 128 | 12 },
        () => reconstruction.signal,
      )
      .unwrap();
    const diagnostics = graph
      .importBuffer(
        'ray-diffuse.diagnostics',
        { size: prepared.pixelCount * 16, usage: 128 | 12 },
        () => reconstruction.diagnostics,
      )
      .unwrap();
    const config = graph
      .importBuffer(
        'ray-diffuse.reconstruction-config',
        { size: 48, usage: 64 | 8 },
        () => reconstruction.config,
      )
      .unwrap();
    for (const stage of reconstruction.mode === 'temporal'
      ? (['temporal'] as const)
      : (['temporal', 'spatial'] as const)) {
      const added = graph.addComputePass(`ray-diffuse.${stage}`, {
        accesses: [
          { resource: accumulation, usage: 'storage-read' },
          { resource: records, usage: 'storage-read' },
          { resource: previous, usage: 'storage-read' },
          { resource: current, usage: stage === 'temporal' ? 'storage-write' : 'storage-read' },
          { resource: signal, usage: 'storage-write' },
          { resource: diagnostics, usage: 'storage-write' },
          { resource: target.depth, usage: 'sampled-read' },
          { resource: target.normal.view, usage: 'sampled-read' },
          { resource: target.identity.view, usage: 'sampled-read' },
          { resource: target.motion.view, usage: 'sampled-read' },
          { resource: view, usage: 'uniform-read' },
          { resource: config, usage: 'uniform-read' },
        ],
        encode: ({ pass, resources }) =>
          reconstruction.kernel
            .record(
              pass,
              {
                raw: resources.buffer(accumulation).unwrap(),
                records: { buffer: resources.buffer(records).unwrap(), size: prepared.recordBytes },
                previous: resources.buffer(previous).unwrap(),
                current: resources.buffer(current).unwrap(),
                signal: resources.buffer(signal).unwrap(),
                diagnostics: resources.buffer(diagnostics).unwrap(),
                depth: resources.textureView(target.depth).unwrap(),
                normal: resources.textureView(target.normal.view).unwrap(),
                identity: resources.textureView(target.identity.view).unwrap(),
                motion: resources.textureView(target.motion.view).unwrap(),
                view: { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
                config: resources.buffer(config).unwrap(),
              },
              prepared.pixelCount,
              stage,
            )
            .unwrap(),
      });
      if (!added.ok) return added;
    }
    irradiance = signal;
  }
  return graph.addRasterPass('ray-diffuse.composite', {
    accesses: [
      { resource: target.scene.view, usage: 'color-attachment' },
      { resource: irradiance, usage: 'storage-read' },
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
      { resource: target.albedo.view, usage: 'sampled-read' },
      { resource: target.f0.view, usage: 'sampled-read' },
      { resource: view, usage: 'uniform-read' },
    ],
    colorAttachments: [{ view: target.scene.view, loadOp: 'load', storeOp: 'store' }],
    encode: ({ pass, resources }) => {
      prepared.composite
        .record(
          pass,
          {
            irradiance: resources.buffer(irradiance).unwrap(),
            depth: resources.textureView(target.depth).unwrap(),
            normal: resources.textureView(target.normal.view).unwrap(),
            albedoMetallic: resources.textureView(target.albedo.view).unwrap(),
            f0Occlusion: resources.textureView(target.f0.view).unwrap(),
            view: { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
          },
          prepared.pixelCount,
        )
        .unwrap();
    },
  });
}
