import {
  createSurfaceMaterialBindings,
  type ResolveSurfaceTexture,
  referenceSurfaceMaterialSnapshot,
} from './material-bindings';
import { packLights, packSettings, type RayPathSettings } from './path-input';
import { INITIAL_PATH_RAYS_WGSL, packInitialPathRays } from './path-source';

export type { RayPathCamera, RayPathInitialRay, RayPathSettings } from './path-input';

import type {
  GraphAccess,
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  Buffer,
  ComputePipeline,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import {
  admitRayMaterial,
  admitRayMaterialValues,
  type MaterialShaderEntry,
  type RayMaterialError,
  type RaySurfaceProgram,
  rayMaterialContract,
  rayMaterialNeedsCoverage,
  type ShaderError,
  type ShaderRegistry,
} from '@forgeax/engine-shader';
import { err, type MaterialAsset, ok, type Result } from '@forgeax/engine-types';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import {
  type LightSnapshot,
  type MaterialSnapshot,
  materialTextureValue,
} from '../render-system-extract';
import {
  RAY_ATTRIBUTE_TRIANGLE_STRIDE,
  RAY_MATERIAL_INPUT_STRIDE,
  RAY_MATERIAL_SURFACE_STRIDE,
  type RaySurfaceScene,
} from './attributes';
import { type RayReferenceError, rayReferenceFailure } from './scene';

export interface RayPathMaterial {
  readonly id: number;
  readonly program: RaySurfaceProgram;
  /** Resolved snapshot produced by cookRayMaterial from the authored MaterialAsset. */
  readonly asset: MaterialAsset;
}
export interface RayPathTracer {
  readonly buffers: Readonly<
    Record<
      | 'triangles'
      | 'nodes'
      | 'attributes'
      | 'paths'
      | 'inputs'
      | 'surfaces'
      | 'accumulation'
      | 'lights'
      | 'settings'
      | 'coverage',
      Buffer
    >
  >;
  readonly pixelCount: number;
  /** One generate, per-bounce trace/material/shade, then one raw HDR accumulation. Caller submits. */
  recordSample(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  /** The same sample stages, with graph-owned passes and explicit borrowed inputs.
   * The caller retires the compiled graph before disposing this frozen transport. */
  addSampleToGraph<Frame extends RenderGraphFrame>(
    graph: RenderGraphBuilder<Frame>,
    input: {
      readonly label: string;
      readonly buffers: ReadonlyMap<Buffer, GraphBuffer>;
      readonly textures: ReadonlyMap<TextureView, GraphTextureView>;
      readonly reset: boolean;
    },
  ): Result<GraphBuffer, RenderGraphError | RayReferenceError>;
  /** Ordered GPU reset; no host write can overtake already encoded samples. */
  reset(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  dispose(): void;
}
export const RAY_COVERAGE_CANDIDATES = 64;
export const RAY_PATH_STRIDE = 80;
export const RAY_ACCUMULATION_STRIDE = 80;
type Failure = RhiError | RayReferenceError | RayMaterialError | ShaderError;
type CompileShader = (
  device: RhiDevice,
  desc: { code: string; label?: string },
) => Promise<Result<ShaderModule, RhiError>>;

interface RayTransportInputs {
  readonly kernel: string;
  readonly scene: RaySurfaceScene;
  readonly lights: readonly LightSnapshot[];
  readonly settings: RayPathSettings;
}
interface TransportMaterial {
  readonly id: number;
  readonly program: MaterialShaderEntry;
  readonly snapshot: MaterialSnapshot;
  readonly evaluateCoverage: boolean;
  readonly resolveTexture?: (parameter: string) => ReturnType<ResolveSurfaceTexture>;
}

/** Frozen source/reference transport; materials cross the linear snapshot boundary once. */
export async function createRayPathTracer(
  device: RhiDevice,
  compile: CompileShader,
  request: RayTransportInputs & {
    readonly materials: readonly RayPathMaterial[];
    readonly resolveTexture?: ResolveSurfaceTexture;
  },
): Promise<Result<RayPathTracer, Failure>> {
  const materials: TransportMaterial[] = [];
  for (const material of request.materials) {
    if (material.program.context !== 'ray-hit')
      return rayReferenceFailure('path tracing requires a ray-hit material context');
    const admitted = admitRayMaterial(material.asset, String(material.id));
    if (!admitted.ok) return admitted;
    if (rayMaterialContract(material.asset) !== material.program.contract)
      return rayReferenceFailure('material contract changed; recook its ray program');
    materials.push({
      id: material.id,
      program: { source: material.program.wgsl, paramSchema: material.program.paramSchema },
      snapshot: referenceSurfaceMaterialSnapshot(material),
      evaluateCoverage: rayMaterialNeedsCoverage(material.asset),
      resolveTexture: (parameter) => {
        const value = materialTextureValue(material.asset.values?.[parameter]);
        return value && request.resolveTexture
          ? request.resolveTexture(value)
          : rayReferenceFailure(`missing texture binding ${parameter}`);
      },
    });
  }
  return createRayPathTransport(device, compile, { ...request, materials });
}

/** Accepted Renderer materials use the same transport without reconstructing author assets. */
export async function createSubmittedRayPathTracer(
  device: RhiDevice,
  compile: CompileShader,
  request: RayTransportInputs & {
    /** The candidate owner's existing scene/material/device fence, also checked at frame submission. */
    readonly generationFence: RendererGenerationFence;
    readonly materials: readonly { readonly id: number; readonly snapshot: MaterialSnapshot }[];
    readonly shaders: ShaderRegistry;
    readonly resolveTexture?: (
      materialId: number,
      parameter: string,
    ) => ReturnType<ResolveSurfaceTexture>;
  },
): Promise<Result<RayPathTracer, Failure>> {
  const current = () =>
    request.generationFence.currentGeneration() === request.generationFence.capturedGeneration;
  const stale = (): Result<never, RayReferenceError> =>
    err({
      code: 'ray-reference-stale',
      expected: 'the accepted scene, material and device generation still owns this preparation',
      hint: 'Release borrowed texture leases and prepare the current accepted snapshot; do not submit this candidate.',
      detail: { cause: 'the candidate owner changed while preparing submitted ray transport' },
    });
  if (!current()) return stale();
  const materials: TransportMaterial[] = [];
  for (const { id, snapshot } of request.materials) {
    const ray = snapshot.materialRay;
    if (ray === undefined) return rayReferenceFailure(`material ${id} has no accepted ray program`);
    const shader = request.shaders.findMaterialArtifact(ray.programKey);
    if (!shader.ok) return shader;
    const values = {
      ...Object.fromEntries(
        shader.value.paramSchema.map((parameter) => [parameter.name, parameter.default]),
      ),
      ...snapshot.paramSnapshot,
    };
    const admitted = admitRayMaterialValues(values, String(id), ray.programKey);
    if (!admitted.ok) return admitted;
    if (
      snapshot.renderState?.blend !== undefined ||
      snapshot.surfaceModel === 'single-layer-medium'
    )
      return rayReferenceFailure(`material ${id} requires unsupported scattering`);
    materials.push({
      id,
      program: shader.value,
      snapshot,
      evaluateCoverage: ray.evaluateCoverage,
      resolveTexture: (parameter) =>
        request.resolveTexture
          ? request.resolveTexture(id, parameter)
          : rayReferenceFailure(`missing texture binding ${parameter}`),
    });
  }
  const prepared = await createRayPathTransport(device, compile, { ...request, materials });
  if (!prepared.ok) return prepared;
  if (!current()) {
    prepared.value.dispose();
    return stale();
  }
  return prepared;
}

/** One frozen GPU transport; textures and optional GPU initial rays remain borrowed. */
async function createRayPathTransport(
  device: RhiDevice,
  compile: CompileShader,
  request: RayTransportInputs & { readonly materials: readonly TransportMaterial[] },
): Promise<Result<RayPathTracer, Failure>> {
  const settings = packSettings(request.settings);
  if (!settings.ok) return settings;
  const lights = packLights(request.lights);
  if (!lights.ok) return lights;
  const pixels = request.settings.width * request.settings.height;
  const maxBounces = request.settings.maxBounces;
  if (
    request.materials.length > 32 ||
    new Set(request.materials.map((m) => m.id)).size !== request.materials.length ||
    request.materials.some((m) => !Number.isInteger(m.id) || m.id < 0 || m.id > 0xffffffff)
  )
    return rayReferenceFailure('expected at most 32 distinct u32 material IDs', true);
  const masked = new Set(
    request.materials
      .filter((material) => material.evaluateCoverage)
      .map((material) => material.id),
  );
  const hasCoverage = masked.size > 0;
  new Float32Array(settings.value.buffer)[7] = hasCoverage ? 1 : 0;
  new Float32Array(settings.value.buffer)[11] = request.lights.length;
  const triangles = request.scene.triangles.slice();
  const triangleView = new DataView(triangles.buffer);
  const materialById = new Map(request.materials.map((m) => [m.id, m]));
  for (let i = 0; i < request.scene.triangleCount; i++) {
    const material = materialById.get(triangleView.getUint32(i * 80 + 60, true));
    if (!material) return rayReferenceFailure('triangle references an absent material');
    const instance = triangleView.getUint32(i * 80 + 48, true);
    const coordinates = material.snapshot.textureCoordinates;
    for (const entry of material.program.paramSchema.filter((p) => p.type === 'texture2d')) {
      if (
        entry.name === 'normalTexture' &&
        !request.scene.instanceAttributes.get(instance)?.tangentFrame
      )
        return rayReferenceFailure(
          `instance ${instance} normal texture requires authored normals and tangents`,
        );
      const set = coordinates?.get(entry.name)?.set ?? 0;
      if (set >= (request.scene.instanceAttributes.get(instance)?.uvCount ?? 0))
        return rayReferenceFailure(`instance ${instance} is missing material UV set ${set}`);
    }
    const cull = material.snapshot.renderState?.cullMode ?? 'back';
    const winding = new DataView(
      request.scene.attributes.buffer,
      request.scene.attributes.byteOffset,
    ).getFloat32(i * RAY_ATTRIBUTE_TRIANGLE_STRIDE + 108, true);
    const side = cull === 'back' ? 1 : cull === 'front' ? 2 : 0;
    triangleView.setUint32(i * 80 + 68, winding < 0 && side !== 0 ? 3 - side : side, true);
    triangleView.setUint32(i * 80 + 72, masked.has(material.id) ? 1 : 0, true);
  }
  const descriptors = new Map<Buffer, { label: string; size: number; usage: number }>();
  const dispose = () => {
    for (const buffer of descriptors.keys()) device.destroyBuffer(buffer);
    descriptors.clear();
  };
  const make = (label: string, bytes: Uint8Array, uniform = false): Result<Buffer, RhiError> => {
    const buffer = device.createBuffer({
      label: `ray-path.${label}`,
      size: bytes.byteLength,
      usage: (uniform ? 0x40 : 0x80) | 0x0c,
    });
    if (!buffer.ok) return buffer;
    descriptors.set(buffer.value, {
      label,
      size: bytes.byteLength,
      usage: (uniform ? 0x40 : 0x80) | 0x0c,
    });
    const wrote = device.queue.writeBuffer(buffer.value, 0, bytes);
    return wrote.ok ? buffer : wrote;
  };
  const lightUniform = new Uint8Array(32 * 64);
  lightUniform.set(lights.value);
  const data = {
    triangles,
    nodes: request.scene.nodes,
    attributes: request.scene.attributes,
    paths: new Uint8Array(pixels * RAY_PATH_STRIDE),
    inputs: new Uint8Array(pixels * RAY_MATERIAL_INPUT_STRIDE),
    surfaces: new Uint8Array(pixels * RAY_MATERIAL_SURFACE_STRIDE),
    accumulation: new Uint8Array(pixels * RAY_ACCUMULATION_STRIDE),
    lights: lightUniform,
    settings: settings.value,
    coverage: new Uint8Array((hasCoverage ? pixels : 1) * 384),
  };
  const buffers = {} as Record<keyof typeof data, Buffer>;
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    const result = make(key, data[key], key === 'settings' || key === 'lights');
    if (!result.ok) {
      dispose();
      return result;
    }
    buffers[key] = result.value;
  }
  const initialRays =
    request.settings.rays === undefined
      ? undefined
      : packInitialPathRays(request.settings.rays, request.settings.seed);
  let initialRayBuffer = request.settings.rayBuffer;
  const module = await compile(device, { code: request.kernel, label: 'ray-path.kernel' });
  if (!module.ok) {
    dispose();
    return module;
  }
  const kernelEntries = Object.keys(data).map((_, binding) => ({
    binding,
    visibility: 4,
    buffer: {
      type:
        binding === 8 || binding === 7
          ? ('uniform' as const)
          : [0, 1, 2].includes(binding)
            ? ('read-only-storage' as const)
            : ('storage' as const),
    },
  }));
  const kernelLayout = device.createBindGroupLayout({ entries: kernelEntries });
  if (!kernelLayout.ok) {
    dispose();
    return kernelLayout;
  }
  const kernelPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [kernelLayout.value],
  });
  if (!kernelPipelineLayout.ok) {
    dispose();
    return kernelPipelineLayout;
  }
  const kernelBindings = device.createBindGroup({
    layout: kernelLayout.value,
    entries: Object.values(buffers).map((buffer, binding) => ({
      binding,
      resource: { kind: 'buffer' as const, value: { buffer } },
    })),
  });
  if (!kernelBindings.ok) {
    dispose();
    return kernelBindings;
  }
  const names = [
    'generate',
    'trace',
    'shade',
    'accumulate',
    'beginCoverage',
    'acceptCoverage',
    'sealCoverage',
    'beginShadow',
    'traceShadow',
    'acceptShadow',
    'endShadow',
  ] as const;
  const pipelines = {} as Record<(typeof names)[number], ComputePipeline>;
  for (const name of names) {
    const result = device.createComputePipeline({
      label: `ray-path.${name}`,
      layout: kernelPipelineLayout.value,
      compute: { module: module.value, entryPoint: name },
    });
    if (!result.ok) {
      dispose();
      return result;
    }
    pipelines[name] = result.value;
  }
  type Work = {
    label: string;
    pipeline: ComputePipeline;
    bindings: readonly BindGroup[];
    buffers: readonly {
      buffer: Buffer;
      usage: 'storage-read' | 'storage-read-write' | 'uniform-read';
    }[];
    textures: readonly TextureView[];
  };
  // Derive conservative bound-resource accesses from the same kernel binding layout.
  // RHI Debug retains shader entry points for finer per-dispatch usage inspection.
  const kernelResources: Work['buffers'] = Object.values(buffers).map((buffer, binding) => ({
    buffer,
    usage:
      kernelEntries[binding]?.buffer.type === 'uniform'
        ? 'uniform-read'
        : kernelEntries[binding]?.buffer.type === 'read-only-storage'
          ? 'storage-read'
          : 'storage-read-write',
  }));
  let generation: Work = {
    pipeline: pipelines.generate,
    bindings: [kernelBindings.value],
    label: 'ray-path.generate',
    buffers: kernelResources,
    textures: [],
  };
  if (initialRays !== undefined) {
    const seeds = make('initial-rays', initialRays);
    if (!seeds.ok) {
      dispose();
      return seeds;
    }
    initialRayBuffer = seeds.value;
  }
  if (initialRayBuffer !== undefined) {
    const layout = device.createBindGroupLayout({
      entries: [0, 1, 2].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: binding === 0 ? ('read-only-storage' as const) : ('storage' as const) },
      })),
    });
    if (!layout.ok) {
      dispose();
      return layout;
    }
    const group = device.createBindGroup({
      layout: layout.value,
      entries: [initialRayBuffer, buffers.paths, buffers.accumulation].map((buffer, binding) => ({
        binding,
        resource: { kind: 'buffer' as const, value: { buffer, size: pixels * RAY_PATH_STRIDE } },
      })),
    });
    if (!group.ok) {
      dispose();
      return group;
    }
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
    if (!pipelineLayout.ok) {
      dispose();
      return pipelineLayout;
    }
    const shader = await compile(device, {
      code: INITIAL_PATH_RAYS_WGSL,
      label: 'ray-path.initial-rays',
    });
    if (!shader.ok) {
      dispose();
      return shader;
    }
    const pipeline = device.createComputePipeline({
      layout: pipelineLayout.value,
      compute: { module: shader.value, entryPoint: 'generateInitialRays' },
    });
    if (!pipeline.ok) {
      dispose();
      return pipeline;
    }
    generation = {
      pipeline: pipeline.value,
      bindings: [group.value],
      label: 'ray-path.initial-rays',
      buffers: [
        { buffer: initialRayBuffer, usage: 'storage-read' },
        { buffer: buffers.paths, usage: 'storage-read-write' },
        { buffer: buffers.accumulation, usage: 'storage-read-write' },
      ],
      textures: [],
    };
  }
  const materialLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 4, buffer: { type: 'storage' } },
      { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
    ],
  });
  if (!materialLayout.ok) {
    dispose();
    return materialLayout;
  }
  const materialWork: (Work & { id: number })[] = [];
  for (const m of request.materials) {
    const materialBindings = createSurfaceMaterialBindings(
      device,
      m.program.paramSchema,
      m.snapshot,
      4,
      m.resolveTexture,
    );
    if (!materialBindings.ok) {
      dispose();
      return materialBindings;
    }
    descriptors.set(materialBindings.value.uniform, {
      label: `material-${m.id}.uniform`,
      size: materialBindings.value.bytes,
      usage: 72,
    });
    const selector = make(
      `material-selector-${m.id}`,
      new Uint8Array(new Uint32Array([m.id, 0, 0, 0]).buffer),
      true,
    );
    if (!selector.ok) {
      dispose();
      return selector;
    }
    const workBindings = device.createBindGroup({
      layout: materialLayout.value,
      entries: [buffers.inputs, buffers.surfaces, selector.value].map((buffer, binding) => ({
        binding,
        resource: { kind: 'buffer' as const, value: { buffer } },
      })),
    });
    if (!workBindings.ok) {
      dispose();
      return workBindings;
    }
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [materialLayout.value, materialBindings.value.layout],
    });
    if (!layout.ok) {
      dispose();
      return layout;
    }
    const shader = await compile(device, {
      code: m.program.source,
      label: `ray-path.material-${m.id}`,
    });
    if (!shader.ok) {
      dispose();
      return shader;
    }
    const pipeline = device.createComputePipeline({
      label: `ray-path.material-${m.id}`,
      layout: layout.value,
      compute: { module: shader.value, entryPoint: 'cs_surface' },
    });
    if (!pipeline.ok) {
      dispose();
      return pipeline;
    }
    materialWork.push({
      id: m.id,
      label: `ray-path.material-${m.id}`,
      pipeline: pipeline.value,
      buffers: [
        { buffer: buffers.inputs, usage: 'storage-read' },
        { buffer: buffers.surfaces, usage: 'storage-read-write' },
        { buffer: selector.value, usage: 'uniform-read' },
        { buffer: materialBindings.value.uniform, usage: 'uniform-read' },
      ],
      textures: materialBindings.value.textureViews,
      bindings: [workBindings.value, materialBindings.value.group],
    });
  }
  let disposed = false;
  const works: Work[] = [];
  works.push(generation);
  for (let bounce = 0; bounce < maxBounces; bounce++) {
    const kernel = (name: (typeof names)[number]) =>
      works.push({
        label: `ray-path.${name}-${bounce}`,
        pipeline: pipelines[name],
        bindings: [kernelBindings.value],
        buffers: kernelResources,
        textures: [],
      });
    if (hasCoverage) kernel('beginCoverage');
    for (let candidate = 0; candidate < (hasCoverage ? RAY_COVERAGE_CANDIDATES : 1); candidate++) {
      kernel('trace');
      for (const m of materialWork)
        if (!hasCoverage || masked.has(m.id))
          works.push({ ...m, label: `ray-path.material-${m.id}-bounce-${bounce}` });
      if (hasCoverage) kernel('acceptCoverage');
    }
    if (hasCoverage) {
      // Opaque hits need one Surface evaluation after candidate resolution,
      // rather than once per rejected alpha layer.
      for (const m of materialWork)
        if (!masked.has(m.id))
          works.push({ ...m, label: `ray-path.material-${m.id}-bounce-${bounce}` });
      kernel('sealCoverage');
      // Analytic lights and one environment NEE ray reuse the same bounded query storage.
      for (let light = 0; light <= request.lights.length; light++) {
        kernel('beginShadow');
        for (let candidate = 0; candidate < RAY_COVERAGE_CANDIDATES; candidate++) {
          kernel('traceShadow');
          for (const m of materialWork)
            if (masked.has(m.id)) works.push({ ...m, label: `ray-path.shadow-material-${m.id}` });
          kernel('acceptShadow');
        }
        kernel('endShadow');
      }
    }
    kernel('shade');
  }
  works.push({
    label: 'ray-path.accumulate',
    pipeline: pipelines.accumulate,
    bindings: [kernelBindings.value],
    buffers: kernelResources,
    textures: [],
  });

  const record = (pass: RhiComputePassEncoder, work: Work) => {
    if (disposed) rayReferenceFailure('path tracer is disposed').unwrap();
    pass.setPipeline(work.pipeline);
    work.bindings.forEach((group, index) => {
      pass.setBindGroup(index, group);
    });
    pass.dispatchWorkgroups(Math.ceil(pixels / 64), 1, 1);
  };
  return ok({
    buffers,
    pixelCount: pixels,
    recordSample(encoder) {
      if (disposed) return rayReferenceFailure('path tracer is disposed');
      for (const work of works) {
        const pass = encoder.beginComputePass({ label: work.label });
        record(pass, work);
        pass.end();
      }
      return ok(undefined);
    },
    addSampleToGraph(graph, input) {
      if (disposed) return rayReferenceFailure('path tracer is disposed');
      // Borrowed resources must reuse their producer's graph address. Silently
      // importing an alias would hide the producer -> transport dependency.
      const graphBuffers = new Map(input.buffers);
      const graphTextures = new Map(input.textures);
      const required = <K, V>(map: ReadonlyMap<K, V>, key: K): V => {
        const value = map.get(key);
        if (value === undefined)
          return rayReferenceFailure('transport graph resource was not admitted').unwrap();
        return value;
      };
      for (const work of works) {
        for (const { buffer } of work.buffers) {
          if (!descriptors.has(buffer) && !graphBuffers.has(buffer))
            return rayReferenceFailure('borrowed ray buffer has no producer graph resource');
        }
        for (const view of work.textures) {
          if (!graphTextures.has(view))
            return rayReferenceFailure('material texture has no producer graph resource');
        }
      }
      for (const [buffer, descriptor] of descriptors) {
        if (graphBuffers.has(buffer)) continue;
        const imported = graph.importBuffer(
          `${input.label}.${descriptor.label}`,
          descriptor,
          () => buffer,
        );
        if (!imported.ok) return imported;
        graphBuffers.set(buffer, imported.value);
      }
      const accumulation = required(graphBuffers, buffers.accumulation);
      if (input.reset) {
        const reset = graph.addCopyPass(`${input.label}.reset`, {
          accesses: [{ resource: accumulation, usage: 'copy-dst' }],
          encode: ({ encoder, resources }) => {
            if (disposed) rayReferenceFailure('path tracer is disposed').unwrap();
            const resolved = resources.buffer(accumulation).unwrap();
            if (resolved !== buffers.accumulation)
              rayReferenceFailure('transport buffer generation changed').unwrap();
            encoder.clearBuffer(resolved);
          },
        });
        if (!reset.ok) return reset;
      }
      for (const [index, work] of works.entries()) {
        const accesses: GraphAccess[] = [
          ...work.buffers.map(({ buffer, usage }) => ({
            resource: required(graphBuffers, buffer),
            usage,
          })),
          ...work.textures.map((view) => ({
            resource: required(graphTextures, view),
            usage: 'sampled-read' as const,
          })),
        ];
        const added = graph.addComputePass(`${input.label}.${index}.${work.label}`, {
          accesses,
          encode: ({ pass, resources }) => {
            // Frozen bind groups may not sample a different generation from the
            // one declared by the frame graph.
            for (const { buffer } of work.buffers)
              if (resources.buffer(required(graphBuffers, buffer)).unwrap() !== buffer)
                rayReferenceFailure('transport buffer generation changed').unwrap();
            for (const view of work.textures)
              if (resources.textureView(required(graphTextures, view)).unwrap() !== view)
                rayReferenceFailure('transport texture generation changed').unwrap();
            record(pass, work);
          },
        });
        if (!added.ok) return added;
      }
      return ok(accumulation);
    },
    reset(encoder) {
      if (disposed) return rayReferenceFailure('path tracer is disposed');
      encoder.clearBuffer(buffers.accumulation);
      return ok(undefined);
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        dispose();
      }
    },
  });
}
