import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, RenderPipeline, Sampler } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { addAtmosphereIbl, type GraphEnvironment } from './ibl';
import { atmosphereStorage } from './storage';

const CUBE_SIZE = 128;

/** One device-owned sky cube feeds the graph background; the sun disc is added only there. */
export function addAtmosphereBackground(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  color: RenderPipelineTarget,
): Result<GraphEnvironment, RenderGraphError> {
  const cube = graph.importTexture(
    'atmosphere-sky',
    {
      format: 'rgba16float',
      size: { width: CUBE_SIZE, height: CUBE_SIZE, depthOrArrayLayers: 6 },
      usage: 0x14,
    },
    (frame) => atmosphereStorage(frame).sky,
  );
  if (!cube.ok) return cube;
  const cubeView = graph.view(cube.value, { dimension: 'cube', arrayLayerCount: 6 });
  if (!cubeView.ok) return cubeView;
  const params = graph.importBuffer(
    'atmosphere-params',
    { size: 64, usage: 0x48 },
    (frame) => atmosphereStorage(frame).params,
  );
  if (!params.ok) return params;
  const vertices = graph.importBuffer(
    'atmosphere-face-vertices',
    { size: 6 * 3 * 3 * 4, usage: 0x28 },
    (frame) => atmosphereStorage(frame).vertices,
  );
  if (!vertices.ok) return vertices;
  const view = graph.importBuffer(
    'atmosphere-view',
    { size: VIEW_UNIFORM_BYTES, usage: 0x40 | 0x08 },
    (frame) => (frame as _InternalRenderPipelineContext).pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  let state:
    | {
        cubePipeline: RenderPipeline;
        cubeLayout: BindGroupLayout;
        backgroundPipeline: RenderPipeline;
        backgroundLayout: BindGroupLayout;
        sampler: Sampler;
        cubeGroup?: BindGroup;
        backgroundGroup?: BindGroup;
      }
    | undefined;
  const frameOf = (frame: RenderPipelineFrame) => frame as _InternalRenderPipelineContext;
  const dirty = (frame: RenderPipelineFrame) =>
    frameOf(frame).frameState.environmentFrame?.environmentSignature !==
    atmosphereStorage(frame).submittedSignature;
  const upload = graph.addCopyPass('atmosphere-prepare', {
    accesses: [
      { resource: params.value, usage: 'copy-dst' },
      { resource: vertices.value, usage: 'copy-dst' },
    ],
    executeIf: dirty,
    encode: ({ frame, resources }) => {
      const environment = frameOf(frame).frameState.environmentFrame;
      const sun = environment?.sun;
      if (environment?.source.kind !== 'atmosphere' || sun === undefined) {
        throw new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'selected Atmosphere frame carries its directional sun',
          hint: 'publish the validated resource-owner environment frame before graph recording',
        });
      }
      const settings = environment.source.atmosphere;
      const values = new Float32Array([
        ...sun.direction,
        sun.intensity,
        ...sun.color,
        0,
        settings.turbidity,
        settings.rayleigh,
        settings.mieCoefficient,
        settings.mieDirectionalG,
        settings.sunAngularRadius,
        settings.sunAngularRadius > 0 ? 1 : 0,
        settings.circumsolarStrength,
        settings.circumsolarWidth,
      ]);
      frame.runtime.device.queue
        .writeBuffer(resources.buffer(params.value).unwrap(), 0, values)
        .unwrap();
      const triangles = new Float32Array(6 * 9);
      for (let face = 0; face < 6; face += 1) {
        triangles.set([-1, -1, face + 1, 3, -1, face + 1, -1, 3, face + 1], face * 9);
      }
      frame.runtime.device.queue
        .writeBuffer(resources.buffer(vertices.value).unwrap(), 0, triangles)
        .unwrap();
    },
  });
  if (!upload.ok) return upload;
  const ensureState = (frame: RenderPipelineFrame) => {
    if (state !== undefined) return state;
    const sources = frame.atmosphereShaders;
    const factory = frame.runtime.shaderModuleFactory;
    if (sources === undefined || factory === undefined) {
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'shader manifest includes the Atmosphere cube and background programs',
        hint: 'rebuild the Engine shader manifest with the package-owned Atmosphere entries',
      });
    }
    const device = frame.runtime.device;
    const cubeModule = factory
      .createShaderModule({ code: sources.cube, label: 'atmosphere_cube' })
      .unwrap();
    const backgroundModule = factory
      .createShaderModule({ code: sources.background, label: 'atmosphere_background' })
      .unwrap();
    const cubeLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform', minBindingSize: 64 } }],
      })
      .unwrap();
    const backgroundLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: 'cube' } },
          { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
          {
            binding: 2,
            visibility: 2,
            buffer: { type: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
          },
          { binding: 3, visibility: 2, buffer: { type: 'uniform', minBindingSize: 64 } },
        ],
      })
      .unwrap();
    const cubePipeline = device
      .createRenderPipeline({
        label: 'atmosphere_cube',
        layout: device.createPipelineLayout({ bindGroupLayouts: [cubeLayout] }).unwrap(),
        vertex: {
          module: cubeModule,
          entryPoint: 'atmosphere_cubemap_vs',
          buffers: [
            {
              arrayStride: 12,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
          ],
        },
        fragment: {
          module: cubeModule,
          entryPoint: 'atmosphere_cubemap_fs',
          targets: [{ format: 'rgba16float' }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      })
      .unwrap();
    const backgroundPipeline = device
      .createRenderPipeline({
        label: 'atmosphere_background',
        layout: device.createPipelineLayout({ bindGroupLayouts: [backgroundLayout] }).unwrap(),
        vertex: { module: backgroundModule, entryPoint: 'atmosphere_background_vs', buffers: [] },
        fragment: {
          module: backgroundModule,
          entryPoint: 'atmosphere_background_fs',
          targets: [{ format: color.format }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: { count: color.sampleCount },
      })
      .unwrap();
    const sampler = device
      .createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' })
      .unwrap();
    state = { cubePipeline, cubeLayout, backgroundPipeline, backgroundLayout, sampler };
    return state;
  };
  for (let face = 0; face < 6; face += 1) {
    const faceView = graph.view(cube.value, {
      dimension: '2d',
      baseArrayLayer: face,
      arrayLayerCount: 1,
    });
    if (!faceView.ok) return faceView;
    const pass = graph.addRasterPass(`atmosphere-cube-${face}`, {
      accesses: [
        { resource: faceView.value, usage: 'color-attachment' },
        { resource: params.value, usage: 'uniform-read' },
        { resource: vertices.value, usage: 'vertex-read' },
      ],
      colorAttachments: [{ view: faceView.value, loadOp: 'clear', storeOp: 'store' }],
      executeIf: dirty,
      encode: ({ pass, frame, resources }) => {
        const current = ensureState(frame);
        current.cubeGroup ??= frame.runtime.device
          .createBindGroup({
            layout: current.cubeLayout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: { buffer: resources.buffer(params.value).unwrap(), size: 64 },
                },
              },
            ],
          })
          .unwrap();
        pass.setPipeline(current.cubePipeline);
        pass.setBindGroup(0, current.cubeGroup);
        pass.setVertexBuffer(0, resources.buffer(vertices.value).unwrap());
        pass.draw(3, 1, face * 3, 0);
        if (face === 5) {
          const signature = frameOf(frame).frameState.environmentFrame?.environmentSignature;
          frameOf(frame).frameState.pendingAtmospherePublish = () => {
            atmosphereStorage(frame).submittedSignature = signature;
          };
        }
      },
    });
    if (!pass.ok) return pass;
  }
  const ibl = addAtmosphereIbl(graph, cubeView.value, vertices.value, dirty);
  if (!ibl.ok) return ibl;
  const background = graph.addRasterPass('atmosphere-background', {
    accesses: [
      { resource: cubeView.value, usage: 'sampled-read' },
      { resource: params.value, usage: 'uniform-read' },
      { resource: view.value, usage: 'uniform-read' },
      { resource: color.view, usage: 'color-attachment' },
    ],
    // Initialize scene radiance before opaque and transparent draws. Geometry
    // uses the normal scene depth authority, so alpha blending sees the sky
    // and no later background pass can overwrite a transparent foreground.
    colorAttachments: [{ view: color.view, loadOp: 'clear', storeOp: 'store' }],
    encode: ({ pass, frame, resources }) => {
      const current = ensureState(frame);
      current.backgroundGroup ??= frame.runtime.device
        .createBindGroup({
          layout: current.backgroundLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'textureView',
                value: resources.textureView(cubeView.value).unwrap(),
              },
            },
            { binding: 1, resource: { kind: 'sampler', value: current.sampler } },
            {
              binding: 2,
              resource: {
                kind: 'buffer',
                value: { buffer: resources.buffer(view.value).unwrap(), size: VIEW_UNIFORM_BYTES },
              },
            },
            {
              binding: 3,
              resource: {
                kind: 'buffer',
                value: { buffer: resources.buffer(params.value).unwrap(), size: 64 },
              },
            },
          ],
        })
        .unwrap();
      pass.setPipeline(current.backgroundPipeline);
      pass.setBindGroup(0, current.backgroundGroup);
      pass.draw(3);
    },
  });
  return background.ok ? ibl : background;
}
