import { frustum, mat4 } from '@forgeax/engine-math';
import type {
  GraphAccess,
  GraphBuffer,
  GraphResourceResolver,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  RenderPipeline,
  Result,
  RhiDevice,
  ShaderModule,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialRenderState } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GPU_SCENE_WGSL } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import type { GpuDrivenProductionInspection } from '../inspection-types';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { worldEntityKey } from '../record/frame-snapshot';
import { geometryRenderStateForTopology } from '../record/main-pass-material';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenProjection } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { GpuDrivenBatch, SubmissionPlan } from './batch-topology';
import { GpuDrivenView } from './view-gpu';

const VERTEX_STAGE = 0x1;
const FRAGMENT_STAGE = 0x2;
const EMPTY_RESOURCE_CLASS = JSON.stringify({ textures: [], samplers: [], video: [] });

export const GPU_DRIVEN_RIGID_UNLIT_WGSL = /* wgsl */ `
${GPU_SCENE_WGSL}

struct ViewData {
  slots: array<vec4<f32>, 49>,
};

@group(0) @binding(0) var<uniform> view: ViewData;
@group(1) @binding(0) var<storage, read> primitives: array<GpuScenePrimitive>;
@group(1) @binding(1) var<storage, read> instances: array<GpuSceneInstance>;
@group(1) @binding(2) var<storage, read> materials: array<GpuSceneMaterial>;
@group(1) @binding(3) var<storage, read> visibleItems: array<vec2<u32>>;
@group(1) @binding(4) var<storage, read> transforms: array<GpuSceneTransform>;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  let viewProjection = mat4x4<f32>(view.slots[0], view.slots[1], view.slots[2], view.slots[3]);
  let visible = visibleItems[instanceIndex];
  let sceneInstance = instances[visible.x];
  let primitiveIndex = sceneInstance.primitiveIndex;
  let primitive = primitives[primitiveIndex];
  let material = materials[visible.y];
  var output: VertexOutput;
  let world = transforms[primitive.transformIndex].currentWorld * transforms[sceneInstance.transformIndex].currentWorld;
  output.position = viewProjection * world * vec4<f32>(input.position, 1.0);
  output.color = material.params0;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`;

interface PreparedBatch {
  readonly batch: GpuDrivenBatch;
  readonly mesh: MeshGpuHandles;
  readonly renderState: MaterialRenderState | undefined;
}

interface ProjectedBatch extends PreparedBatch {
  readonly bindings: BindGroup;
  readonly pipeline: RenderPipeline;
  readonly vertex: GraphBuffer;
  readonly index?: GraphBuffer;
}

function bufferBinding(
  buffer: import('@forgeax/engine-rhi').Buffer,
  offset?: number,
  size?: number,
) {
  return {
    kind: 'buffer' as const,
    value: {
      buffer,
      ...(offset === undefined ? {} : { offset }),
      ...(size === undefined ? {} : { size }),
    },
  };
}

function activeFrustum(camera: CameraSnapshot): Float32Array {
  const projection = mat4.create();
  if (camera.projection === 'orthographic') {
    mat4.orthographic(
      projection,
      camera.orthoLeft,
      camera.orthoRight,
      camera.orthoBottom,
      camera.orthoTop,
      camera.near,
      camera.far,
    );
  } else {
    mat4.perspective(projection, camera.fov, camera.aspect, camera.near, camera.far);
  }
  const view = mat4.invert(mat4.create(), camera.world);
  return frustum.fromViewProjection(
    frustum.create(),
    mat4.multiply(mat4.create(), projection, view),
  );
}

function productionEligible(snapshot: RenderableSnapshot, batch: GpuDrivenBatch): boolean {
  const material = snapshot.materials[batch.key.materialSlot] ?? snapshot.material;
  const shader = material.materialShaderId ?? 'forgeax::default-unlit';
  return (
    shader === 'forgeax::default-unlit' &&
    batch.key.materialResourceClass === EMPTY_RESOURCE_CLASS &&
    material.baseColorTexture === undefined &&
    material.transparent !== true
  );
}

function meshSupportsBatch(mesh: MeshGpuHandles, batch: GpuDrivenBatch): boolean {
  if (mesh.layoutProjection.arrayStride !== 48) return false;
  return batch.key.drawKind === 'indexed'
    ? mesh.indexed && mesh.indexBuffer !== null
    : !mesh.indexed;
}

function filteredPlan(
  source: SubmissionPlan,
  slots: PersistentGpuDrivenState['slots'],
  meshes: ReadonlyMap<number, MeshGpuHandles>,
): {
  readonly plan: SubmissionPlan;
  readonly batches: readonly PreparedBatch[];
  readonly entityKeys: ReadonlySet<number>;
} {
  const slotByPrimitive = new Map(slots.map((slot) => [slot.slot, slot] as const));
  const entityKeys = new Set<number>();
  const eligiblePrimitives = new Set<number>();
  for (const slot of slots) {
    const mesh = meshes.get(slot.snapshot.assetHandle);
    const participating = source.batches.filter((batch) =>
      batch.candidates.some((candidate) => candidate.primitiveIndex === slot.slot),
    );
    if (
      mesh !== undefined &&
      participating.length === (slot.snapshot.gpuDrivenDraws?.length ?? 0) &&
      participating.every(
        (batch) => productionEligible(slot.snapshot, batch) && meshSupportsBatch(mesh, batch),
      )
    ) {
      eligiblePrimitives.add(slot.slot);
      entityKeys.add(worldEntityKey(slot.snapshot.worldId, slot.snapshot.entityKey));
    }
  }
  const batches: PreparedBatch[] = [];
  let visibleBase = 0;
  const filteredBatches: GpuDrivenBatch[] = [];
  for (const batch of source.batches) {
    const candidates = batch.candidates.filter((candidate) => {
      const slot = slotByPrimitive.get(candidate.primitiveIndex);
      if (slot === undefined || !eligiblePrimitives.has(slot.slot)) return false;
      const mesh = meshes.get(slot.snapshot.assetHandle);
      return mesh !== undefined && meshSupportsBatch(mesh, batch);
    });
    if (candidates.length === 0) continue;
    visibleBase = Math.ceil(visibleBase / 64) * 64;
    const filtered: GpuDrivenBatch = Object.freeze({
      ...batch,
      candidates: Object.freeze(candidates),
      visibleBase,
      visibleCapacity: candidates.length,
    });
    visibleBase += candidates.length;
    const first = slotByPrimitive.get(candidates[0]?.primitiveIndex ?? -1);
    const mesh = first === undefined ? undefined : meshes.get(first.snapshot.assetHandle);
    if (mesh === undefined || first === undefined) continue;
    filteredBatches.push(filtered);
    const material = first.snapshot.materials[batch.key.materialSlot] ?? first.snapshot.material;
    batches.push({
      batch: filtered,
      mesh,
      renderState: geometryRenderStateForTopology(batch.key.topology, material.renderState),
    });
  }
  return {
    plan: Object.freeze({
      revision: source.revision,
      batches: Object.freeze(filteredBatches),
      candidateCount: filteredBatches.reduce((total, batch) => total + batch.candidates.length, 0),
      visibleCapacity: visibleBase,
    }),
    batches: Object.freeze(batches),
    entityKeys,
  };
}

type FilteredProductionPlan = ReturnType<typeof filteredPlan>;

class GpuDrivenRigidRaster {
  private readonly pipelines = new Map<string, RenderPipeline>();

  private constructor(
    private readonly device: RhiDevice,
    private readonly layout: BindGroupLayout,
    private readonly pipelineLayout: import('@forgeax/engine-rhi').PipelineLayout,
    private readonly module: ShaderModule,
  ) {}

  static create(input: {
    readonly device: RhiDevice;
    readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
    readonly viewBindGroupLayout: BindGroupLayout;
  }): Result<GpuDrivenRigidRaster, RhiError> {
    const layout = input.device.createBindGroupLayout({
      label: 'gpu-driven-rigid-raster-bgl',
      entries: [
        { binding: 0, visibility: VERTEX_STAGE, buffer: { type: 'read-only-storage' } },
        {
          binding: 1,
          visibility: VERTEX_STAGE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 2,
          visibility: VERTEX_STAGE | FRAGMENT_STAGE,
          buffer: { type: 'read-only-storage' },
        },
        { binding: 3, visibility: VERTEX_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: VERTEX_STAGE, buffer: { type: 'read-only-storage' } },
      ],
    });
    if (!layout.ok) return layout;
    const pipelineLayout = input.device.createPipelineLayout({
      label: 'gpu-driven-rigid-raster-pl',
      bindGroupLayouts: [input.viewBindGroupLayout, layout.value],
    });
    if (!pipelineLayout.ok) return pipelineLayout;
    const module = input.shaderModuleFactory.createShaderModule({
      label: 'gpu-driven-rigid-unlit',
      code: GPU_DRIVEN_RIGID_UNLIT_WGSL,
    });
    if (!module.ok) return module;
    return ok(
      new GpuDrivenRigidRaster(input.device, layout.value, pipelineLayout.value, module.value),
    );
  }

  pipeline(
    format: TextureFormat,
    sampleCount: 1 | 4,
    vertexStride: number,
    topology: GpuDrivenBatch['key']['topology'],
    stripIndexFormat: 'uint16' | 'uint32' | undefined,
    renderState: MaterialRenderState | undefined,
  ): Result<RenderPipeline, RhiError> {
    const key = `${format}|${sampleCount}|${vertexStride}|${topology}|${stripIndexFormat ?? ''}|${JSON.stringify(renderState ?? null)}`;
    const cached = this.pipelines.get(key);
    if (cached !== undefined) return ok(cached);
    const created = this.device.createRenderPipeline({
      label: `gpu-driven-rigid-unlit.${key}`,
      layout: this.pipelineLayout,
      vertex: {
        module: this.module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: vertexStride,
            stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
        ],
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs_main',
        targets: [
          {
            format,
            ...(renderState?.blend === undefined ? {} : { blend: renderState.blend }),
          },
        ],
      },
      primitive: {
        topology,
        cullMode: renderState?.cullMode ?? 'back',
        frontFace: renderState?.frontFace ?? 'ccw',
        ...(stripIndexFormat === undefined ? {} : { stripIndexFormat }),
      },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: renderState?.depthWriteEnabled ?? true,
        depthCompare: renderState?.depthCompare ?? 'less',
        ...(renderState?.stencil === undefined
          ? {}
          : {
              stencilFront: renderState.stencil,
              stencilBack: renderState.stencil,
              stencilReadMask: renderState.stencilReadMask,
              stencilWriteMask: renderState.stencilWriteMask,
            }),
      },
      ...(sampleCount === 4
        ? {
            multisample: {
              count: 4,
              alphaToCoverageEnabled: renderState?.alphaToCoverageEnabled ?? false,
            },
          }
        : {}),
    });
    if (!created.ok) return created;
    this.pipelines.set(key, created.value);
    return created;
  }

  bindGroup(
    scene: PersistentGpuDrivenState['scene'],
    view: GpuDrivenView,
    batch: GpuDrivenBatch,
  ): Result<BindGroup, RhiError> {
    const visible = view.visibleBuffer;
    if (visible === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'GPU-driven view buffers exist after a successful view update',
          hint: 'prepare the GPU-driven view before projecting its raster batches',
        }),
      );
    }
    return this.device.createBindGroup({
      label: `gpu-driven-rigid-batch-${batch.batchId}`,
      layout: this.layout,
      entries: [
        { binding: 0, resource: bufferBinding(scene.primitiveBuffer) },
        { binding: 1, resource: bufferBinding(scene.instanceBuffer) },
        { binding: 2, resource: bufferBinding(scene.materialBuffer) },
        {
          binding: 3,
          resource: bufferBinding(visible, batch.visibleBase * 8, batch.visibleCapacity * 8),
        },
        {
          binding: 4,
          resource: bufferBinding(scene.transformBuffer),
        },
      ],
    });
  }
}

export interface PreparedGpuDrivenFrame {
  readonly topologySignature: string;
  readonly entityKeys: ReadonlySet<number>;
  readonly ownsAllRenderables: boolean;
  /** @internal Commits a replacement generation only after graph promotion. */
  readonly _commitResourceReplacement: () => void;
  project(
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    format: TextureFormat,
    sampleCount: 1 | 4,
  ): Result<RenderPipelineGpuDrivenProjection, RenderGraphError | RhiError>;
}

export class GpuDrivenProduction {
  private view: GpuDrivenView | undefined;
  private raster: GpuDrivenRigidRaster | undefined;
  private readonly sceneIdentities = new WeakMap<object, number>();
  private nextSceneIdentity = 1;
  private filteredCache:
    | {
        readonly source: SubmissionPlan;
        readonly meshResidencyEpoch: number;
        readonly value: FilteredProductionPlan;
      }
    | undefined;
  private gpuOwnedSnapshotsMaterialized = 0;
  private filteredPlanBuilds = 0;
  private gpuOwnedEntityCount = 0;
  private batchBindGroupCreates = 0;
  private validatedGpuOwnedRows = 0;
  private cpuFallbackDrawItems = 0;
  private signatureCache:
    | {
        readonly filtered: FilteredProductionPlan;
        readonly sceneIdentity: number;
        readonly viewResourceGeneration: number;
        readonly meshResidencyEpoch: number;
        readonly value: string;
      }
    | undefined;

  constructor(
    private readonly device: RhiDevice,
    private readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory,
  ) {}

  prepare(input: {
    readonly scene: PersistentGpuDrivenState | undefined;
    readonly camera: CameraSnapshot;
    readonly meshes: ReadonlyMap<number, MeshGpuHandles>;
    readonly viewBindGroupLayout: BindGroupLayout;
    readonly meshResidencyEpoch: number;
    readonly hdrp: boolean;
  }): Result<PreparedGpuDrivenFrame | undefined, RhiError> {
    this.gpuOwnedSnapshotsMaterialized = 0;
    this.filteredPlanBuilds = 0;
    this.batchBindGroupCreates = 0;
    this.validatedGpuOwnedRows = 0;
    this.cpuFallbackDrawItems = 0;
    if (
      input.hdrp ||
      input.scene === undefined ||
      !this.device.caps.compute ||
      !this.device.caps.storageBuffer ||
      !this.device.caps.indirectDrawing
    ) {
      this.gpuOwnedEntityCount = 0;
      return ok(undefined);
    }
    const scene = input.scene;
    let filtered = this.filteredCache?.value;
    if (
      filtered === undefined ||
      this.filteredCache?.source !== scene.plan ||
      this.filteredCache.meshResidencyEpoch !== input.meshResidencyEpoch
    ) {
      filtered = filteredPlan(scene.plan, scene.slots, input.meshes);
      this.filteredCache = {
        source: scene.plan,
        meshResidencyEpoch: input.meshResidencyEpoch,
        value: filtered,
      };
      this.gpuOwnedSnapshotsMaterialized = scene.slots.length;
      this.filteredPlanBuilds = 1;
    }
    this.gpuOwnedEntityCount = filtered.entityKeys.size;
    if (filtered.batches.length === 0) return ok(undefined);
    if (this.view === undefined) {
      const created = GpuDrivenView.create({
        device: this.device,
        shaderModuleFactory: this.shaderModuleFactory,
      });
      if (!created.ok) return created;
      this.view = created.value;
    }
    if (this.raster === undefined) {
      const created = GpuDrivenRigidRaster.create({
        device: this.device,
        shaderModuleFactory: this.shaderModuleFactory,
        viewBindGroupLayout: input.viewBindGroupLayout,
      });
      if (!created.ok) return created;
      this.raster = created.value;
    }
    const updated = this.view.update(filtered.plan, scene.scene, activeFrustum(input.camera));
    if (!updated.ok) return updated;
    const view = this.view;
    const raster = this.raster;
    const sceneIdentity = this.sceneIdentity(scene.scene);
    const viewInspection = view.inspect();
    let signature = this.signatureCache?.value;
    if (
      signature === undefined ||
      this.signatureCache?.filtered !== filtered ||
      this.signatureCache.sceneIdentity !== sceneIdentity ||
      this.signatureCache.viewResourceGeneration !== viewInspection.resourceGeneration ||
      this.signatureCache.meshResidencyEpoch !== input.meshResidencyEpoch
    ) {
      signature = JSON.stringify({
        sceneIdentity,
        revision: filtered.plan.revision,
        meshResidencyEpoch: input.meshResidencyEpoch,
        viewResourceGeneration: viewInspection.resourceGeneration,
        batches: filtered.batches.map(({ batch, mesh }) => [
          batch.batchId,
          batch.generation,
          batch.visibleBase,
          batch.candidates.map((candidate) => [
            candidate.primitiveIndex,
            candidate.generation,
            candidate.instanceOrdinal,
          ]),
          mesh.vboBytes,
          mesh.iboBytes,
          mesh.indexFormat,
          mesh.uvSetCount,
        ]),
        capacities: [
          viewInspection.candidateCapacity,
          viewInspection.batchCapacity,
          viewInspection.indirectCapacity,
        ],
      });
      this.signatureCache = {
        filtered,
        sceneIdentity,
        viewResourceGeneration: viewInspection.resourceGeneration,
        meshResidencyEpoch: input.meshResidencyEpoch,
        value: signature,
      };
    }
    return ok({
      topologySignature: signature,
      entityKeys: filtered.entityKeys,
      ownsAllRenderables: filtered.entityKeys.size === scene.slots.length,
      _commitResourceReplacement: () => view._commitResourceReplacement(),
      project: (graph, format, sampleCount) => {
        const outputs = view.addPasses(graph);
        if (!outputs.ok) return outputs;
        const projected: ProjectedBatch[] = [];
        const accesses: GraphAccess[] = [
          { resource: outputs.value.primitive, usage: 'storage-read' },
          { resource: outputs.value.instance, usage: 'storage-read' },
          { resource: outputs.value.material, usage: 'storage-read' },
          { resource: outputs.value.visible, usage: 'storage-read' },
          { resource: outputs.value.transform, usage: 'storage-read' },
          { resource: outputs.value.indirect, usage: 'indirect-read' },
        ];
        const meshBuffers = new Map<
          number,
          { readonly vertex: GraphBuffer; readonly index?: GraphBuffer }
        >();
        for (const prepared of filtered.batches) {
          let buffers = meshBuffers.get(prepared.batch.key.assetHandle);
          if (buffers === undefined) {
            const vertex = graph.importBuffer(
              `gpu-driven.mesh.${prepared.batch.key.assetHandle}.vertex`,
              {
                size: prepared.mesh.vboBytes,
                usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
              },
              () => prepared.mesh.vertexBuffer.handle,
            );
            if (!vertex.ok) return vertex;
            let index: GraphBuffer | undefined;
            const indexHandle = prepared.mesh.indexBuffer;
            if (indexHandle !== null) {
              const imported = graph.importBuffer(
                `gpu-driven.mesh.${prepared.batch.key.assetHandle}.index`,
                {
                  size: prepared.mesh.iboBytes,
                  usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
                },
                () => indexHandle.handle,
              );
              if (!imported.ok) return imported;
              index = imported.value;
            }
            buffers = { vertex: vertex.value, ...(index === undefined ? {} : { index }) };
            meshBuffers.set(prepared.batch.key.assetHandle, buffers);
            accesses.push({ resource: buffers.vertex, usage: 'vertex-read' });
            if (buffers.index !== undefined) {
              accesses.push({ resource: buffers.index, usage: 'index-read' });
            }
          }
          const pipeline = raster.pipeline(
            format,
            sampleCount,
            48 + (prepared.mesh.uvSetCount - 1) * 8,
            prepared.batch.key.topology,
            prepared.batch.key.drawKind === 'indexed' &&
              (prepared.batch.key.topology === 'line-strip' ||
                prepared.batch.key.topology === 'triangle-strip')
              ? prepared.mesh.indexFormat
              : undefined,
            prepared.renderState,
          );
          if (!pipeline.ok) return pipeline;
          const bindings = raster.bindGroup(scene.scene, view, prepared.batch);
          if (!bindings.ok) return bindings;
          this.batchBindGroupCreates += 1;
          projected.push({
            ...prepared,
            ...buffers,
            pipeline: pipeline.value,
            bindings: bindings.value,
          });
        }
        return ok({
          accesses,
          encode: (viewBindGroup, pass, resources: GraphResourceResolver) => {
            // pbr-view-bgl carries the vertex-only Points/Lines UBO at binding
            // 10 as a dynamic uniform buffer.  The production view group is
            // shared by the GPU-driven raster pipeline, so even rigid draws
            // must provide the binding-10 offset (zero selects the frame
            // default slot).
            pass.setBindGroup(0, viewBindGroup, [0]);
            let currentPipeline: RenderPipeline | undefined;
            let currentVertex: GraphBuffer | undefined;
            let currentIndex: GraphBuffer | undefined;
            for (const batch of projected) {
              if (currentPipeline !== batch.pipeline) {
                pass.setPipeline(batch.pipeline);
                currentPipeline = batch.pipeline;
              }
              pass.setBindGroup(1, batch.bindings);
              if (currentVertex !== batch.vertex) {
                const vertex = resources.buffer(batch.vertex);
                if (!vertex.ok) throw vertex.error;
                pass.setVertexBuffer(0, vertex.value);
                currentVertex = batch.vertex;
              }
              if (batch.index !== undefined && currentIndex !== batch.index) {
                const index = resources.buffer(batch.index);
                if (!index.ok) throw index.error;
                pass.setIndexBuffer(index.value, batch.mesh.indexFormat);
                currentIndex = batch.index;
              }
              const indirect = resources.buffer(outputs.value.indirect);
              if (!indirect.ok) throw indirect.error;
              if (batch.batch.key.drawKind === 'indexed') {
                pass.drawIndexedIndirect(indirect.value, batch.batch.indirectOffset);
              } else {
                pass.drawIndirect(indirect.value, batch.batch.indirectOffset);
              }
            }
          },
        });
      },
    });
  }

  dispose(): void {
    this.view?.dispose();
    this.view = undefined;
    this.raster = undefined;
    this.filteredCache = undefined;
    this.signatureCache = undefined;
  }

  inspect(): GpuDrivenProductionInspection {
    const view = this.view?.inspect();
    return {
      gpuOwnedSnapshotsMaterialized: this.gpuOwnedSnapshotsMaterialized,
      filteredPlanBuilds: this.filteredPlanBuilds,
      gpuOwnedEntityCount: this.gpuOwnedEntityCount,
      candidateUploadBytes: view?.candidateUploadBytes ?? 0,
      batchUploadBytes: view?.batchUploadBytes ?? 0,
      viewConstantsUploadBytes: view?.viewConstantsUploadBytes ?? 0,
      batchBindGroupCreates: this.batchBindGroupCreates,
      viewBindGroupCreates: view?.bindGroupCreates ?? 0,
      topologyRevision: view?.topologyRevision,
      validatedGpuOwnedRows: this.validatedGpuOwnedRows,
      cpuFallbackDrawItems: this.cpuFallbackDrawItems,
    };
  }

  recordCpuValidation(
    validated: readonly { readonly source: RenderableSnapshot }[],
    gpuOwned: ReadonlySet<number>,
  ): void {
    this.cpuFallbackDrawItems = validated.length;
    let gpuOwnedRows = 0;
    for (const row of validated) {
      if (gpuOwned.has(worldEntityKey(row.source.worldId, row.source.entityKey))) gpuOwnedRows += 1;
    }
    this.validatedGpuOwnedRows = gpuOwnedRows;
  }

  private sceneIdentity(scene: object): number {
    const existing = this.sceneIdentities.get(scene);
    if (existing !== undefined) return existing;
    const identity = this.nextSceneIdentity;
    this.nextSceneIdentity += 1;
    this.sceneIdentities.set(scene, identity);
    return identity;
  }
}
