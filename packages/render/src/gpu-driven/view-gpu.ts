import type {
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  PipelineLayout,
  Result,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { GpuScene } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_INDIRECT,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { SubmissionPlan } from './batch-topology';

const COMPUTE_STAGE = 0x4;
const WORKGROUP_SIZE = 64;
const CANDIDATE_STRIDE = 28;
const BATCH_STRIDE = 28;
const VIEW_BYTES = 112;

export const GPU_DRIVEN_VIEW_WGSL = /* wgsl */ `
struct PrimitiveRecord {
  generation: u32,
  flags: u32,
  transformIndex: u32,
  materialIndex: u32,
  drawTemplateIndex: u32,
  instanceStart: u32,
  instanceCount: u32,
  assetHandle: u32,
  localBoundsMin: vec4<f32>,
  localBoundsMax: vec4<f32>,
};

struct TransformRecord {
  currentWorld: mat4x4<f32>,
  previousWorld: mat4x4<f32>,
};

struct CandidateRecord {
  primitiveIndex: u32,
  generation: u32,
  instanceOrdinal: u32,
  materialSlot: u32,
  batchIndex: u32,
  visibleBase: u32,
  visibleCapacity: u32,
};

struct InstanceRecord {
  primitiveIndex: u32,
  transformIndex: u32,
  customDataStart: u32,
  flags: u32,
};

struct BatchRecord {
  visibleBase: u32,
  visibleCapacity: u32,
  count: u32,
  first: u32,
  baseVertex: i32,
  indirectIndex: u32,
  indexed: u32,
};

struct ViewConstants {
  planes: array<vec4<f32>, 6>,
  candidateCount: u32,
  batchCount: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<storage, read> primitives: array<PrimitiveRecord>;
@group(0) @binding(1) var<storage, read> instances: array<InstanceRecord>;
@group(0) @binding(2) var<storage, read> transforms: array<TransformRecord>;
@group(0) @binding(3) var<storage, read> candidates: array<CandidateRecord>;
@group(0) @binding(4) var<storage, read> batches: array<BatchRecord>;
@group(0) @binding(5) var<uniform> view: ViewConstants;
@group(0) @binding(6) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> visibleIndices: array<vec2<u32>>;
@group(0) @binding(8) var<storage, read_write> indirectArgs: array<u32>;

fn counterIndex(batchIndex: u32) -> u32 { return batchIndex * 2u; }
fn overflowIndex(batchIndex: u32) -> u32 { return batchIndex * 2u + 1u; }

fn isVisible(primitive: PrimitiveRecord, world: mat4x4<f32>) -> bool {
  if ((primitive.flags & 7u) != 7u) { return false; }
  let localCenter = (primitive.localBoundsMin.xyz + primitive.localBoundsMax.xyz) * 0.5;
  let localExtent = (primitive.localBoundsMax.xyz - primitive.localBoundsMin.xyz) * 0.5;
  let worldCenter = (world * vec4<f32>(localCenter, 1.0)).xyz;
  let worldExtent =
    abs(world[0].xyz) * localExtent.x +
    abs(world[1].xyz) * localExtent.y +
    abs(world[2].xyz) * localExtent.z;
  for (var planeIndex = 0u; planeIndex < 6u; planeIndex += 1u) {
    let plane = view.planes[planeIndex];
    let radius = dot(abs(plane.xyz), worldExtent);
    if (dot(plane.xyz, worldCenter) + plane.w < -radius) { return false; }
  }
  return true;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn resetView(@builtin(global_invocation_id) id: vec3<u32>) {
  let batchIndex = id.x;
  if (batchIndex >= view.batchCount) { return; }
  atomicStore(&counters[counterIndex(batchIndex)], 0u);
  atomicStore(&counters[overflowIndex(batchIndex)], 0u);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn cullView(@builtin(global_invocation_id) id: vec3<u32>) {
  let candidateIndex = id.x;
  if (candidateIndex >= view.candidateCount) { return; }
  let candidate = candidates[candidateIndex];
  let primitive = primitives[candidate.primitiveIndex];
  if (primitive.generation != candidate.generation) { return; }
  if (candidate.instanceOrdinal >= primitive.instanceCount) { return; }
  let instanceIndex = primitive.instanceStart + candidate.instanceOrdinal;
  let instance = instances[instanceIndex];
  let world = transforms[primitive.transformIndex].currentWorld * transforms[instance.transformIndex].currentWorld;
  if (!isVisible(primitive, world)) { return; }
  let localVisible = atomicAdd(&counters[counterIndex(candidate.batchIndex)], 1u);
  if (localVisible >= candidate.visibleCapacity) {
    atomicStore(&counters[overflowIndex(candidate.batchIndex)], 1u);
    return;
  }
  visibleIndices[candidate.visibleBase + localVisible] = vec2<u32>(
    instanceIndex,
    primitive.materialIndex + candidate.materialSlot,
  );
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn finalizeView(@builtin(global_invocation_id) id: vec3<u32>) {
  let batchIndex = id.x;
  if (batchIndex >= view.batchCount) { return; }
  let batch = batches[batchIndex];
  let visibleCount = min(
    atomicLoad(&counters[counterIndex(batchIndex)]),
    batch.visibleCapacity,
  );
  let args = batch.indirectIndex * 5u;
  indirectArgs[args] = batch.count;
  indirectArgs[args + 1u] = visibleCount;
  indirectArgs[args + 2u] = batch.first;
  indirectArgs[args + 3u] = select(0u, bitcast<u32>(batch.baseVertex), batch.indexed != 0u);
  indirectArgs[args + 4u] = 0u;
}
`;

interface ViewBuffers {
  readonly candidates: Buffer;
  readonly batches: Buffer;
  readonly view: Buffer;
  readonly counters: Buffer;
  readonly visible: Buffer;
  readonly indirect: Buffer;
}

type MutableViewBuffers = { -readonly [Name in keyof ViewBuffers]: ViewBuffers[Name] };

export interface GpuDrivenViewGraphResources {
  readonly primitive: GraphBuffer;
  readonly instance: GraphBuffer;
  readonly transform: GraphBuffer;
  readonly material: GraphBuffer;
  readonly visible: GraphBuffer;
  readonly indirect: GraphBuffer;
  readonly overflow: GraphBuffer;
}

export interface GpuDrivenViewInspection {
  readonly topologyRevision: number | undefined;
  readonly candidateCount: number;
  readonly batchCount: number;
  readonly visibleCapacity: number;
  readonly candidateCapacity: number;
  readonly batchCapacity: number;
  readonly indirectCapacity: number;
  readonly updateCount: number;
  readonly uploadBytes: number;
  readonly candidateUploadBytes: number;
  readonly batchUploadBytes: number;
  readonly viewConstantsUploadBytes: number;
  readonly bindGroupCreates: number;
  readonly bufferRebuilds: number;
  readonly resourceGeneration: number;
}

function nextCapacity(required: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, required)));
}

function bufferBinding(buffer: Buffer): {
  readonly kind: 'buffer';
  readonly value: { buffer: Buffer };
} {
  return { kind: 'buffer', value: { buffer } };
}

export class GpuDrivenView {
  private buffers: ViewBuffers | undefined;
  private supersededBuffers: ViewBuffers[] = [];
  private bindGroup: BindGroup | undefined;
  private candidateCapacity = 0;
  private batchCapacity = 0;
  private indirectCapacity = 0;
  private plan: SubmissionPlan | undefined;
  private scenePrimitive: Buffer | undefined;
  private sceneInstance: Buffer | undefined;
  private sceneTransform: Buffer | undefined;
  private sceneMaterial: Buffer | undefined;
  private sceneCapacity = 0;
  private updateCount = 0;
  private uploadBytes = 0;
  private candidateUploadBytes = 0;
  private batchUploadBytes = 0;
  private viewConstantsUploadBytes = 0;
  private bindGroupCreates = 0;
  private bufferRebuilds = 0;
  private resourceGeneration = 0;

  private constructor(
    private readonly device: RhiDevice,
    private readonly bindGroupLayout: BindGroupLayout,
    private readonly pipelineLayout: PipelineLayout,
    private readonly resetPipeline: ComputePipeline,
    private readonly cullPipeline: ComputePipeline,
    private readonly finalizePipeline: ComputePipeline,
  ) {}

  static create(input: {
    readonly device: RhiDevice;
    readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
  }): Result<GpuDrivenView, RhiError> {
    const { device, shaderModuleFactory } = input;
    if (!device.caps.compute || !device.caps.storageBuffer || !device.caps.indirectDrawing) {
      return err(
        new RhiError({
          code: 'feature-not-enabled',
          expected: 'compute && storageBuffer && indirectDrawing',
          hint: 'use the CPU projection and direct submission fallback on this device',
        }),
      );
    }
    const layout = device.createBindGroupLayout({
      label: 'gpu-driven-view-bgl',
      entries: [
        { binding: 0, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: COMPUTE_STAGE, buffer: { type: 'uniform' } },
        { binding: 6, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
        { binding: 7, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
        { binding: 8, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
      ],
    });
    if (!layout.ok) return layout;
    const pipelineLayout = device.createPipelineLayout({
      label: 'gpu-driven-view-pl',
      bindGroupLayouts: [layout.value],
    });
    if (!pipelineLayout.ok) return pipelineLayout;
    const module = shaderModuleFactory.createShaderModule({
      label: 'gpu-driven-view',
      code: GPU_DRIVEN_VIEW_WGSL,
    });
    if (!module.ok) return module;
    const createPipeline = (entryPoint: string): Result<ComputePipeline, RhiError> =>
      device.createComputePipeline({
        label: `gpu-driven-view.${entryPoint}`,
        layout: pipelineLayout.value,
        compute: { module: module.value, entryPoint },
      });
    const reset = createPipeline('resetView');
    if (!reset.ok) return reset;
    const cull = createPipeline('cullView');
    if (!cull.ok) return cull;
    const finalize = createPipeline('finalizeView');
    if (!finalize.ok) return finalize;
    return ok(
      new GpuDrivenView(
        device,
        layout.value,
        pipelineLayout.value,
        reset.value,
        cull.value,
        finalize.value,
      ),
    );
  }

  update(plan: SubmissionPlan, scene: GpuScene, planes: Float32Array): Result<void, RhiError> {
    this.candidateUploadBytes = 0;
    this.batchUploadBytes = 0;
    this.viewConstantsUploadBytes = 0;
    this.bindGroupCreates = 0;
    const topologyChanged = this.plan !== plan;
    let buffersRebuilt = false;
    if (topologyChanged || this.buffers === undefined) {
      const requiredCandidates = Math.max(1, plan.candidateCount, plan.visibleCapacity);
      const requiredBatches = Math.max(1, plan.batches.length);
      const requiredIndirect = Math.max(
        1,
        plan.batches.reduce((maximum, batch) => Math.max(maximum, batch.batchId + 1), 0),
      );
      if (
        this.buffers === undefined ||
        requiredCandidates > this.candidateCapacity ||
        requiredBatches > this.batchCapacity ||
        requiredIndirect > this.indirectCapacity
      ) {
        const rebuilt = this.rebuildBuffers(requiredCandidates, requiredBatches, requiredIndirect);
        if (!rebuilt.ok) return rebuilt;
        buffersRebuilt = true;
      }
    }
    const buffers = this.buffers;
    if (buffers === undefined) return ok(undefined);
    if (topologyChanged || buffersRebuilt) {
      const candidateBytes = new ArrayBuffer(Math.max(1, plan.candidateCount) * CANDIDATE_STRIDE);
      const candidates = new DataView(candidateBytes);
      const batchBytes = new ArrayBuffer(Math.max(1, plan.batches.length) * BATCH_STRIDE);
      const batches = new DataView(batchBytes);
      let candidateIndex = 0;
      for (let batchIndex = 0; batchIndex < plan.batches.length; batchIndex += 1) {
        const batch = plan.batches[batchIndex];
        if (batch === undefined) continue;
        const batchOffset = batchIndex * BATCH_STRIDE;
        batches.setUint32(batchOffset, batch.visibleBase, true);
        batches.setUint32(batchOffset + 4, batch.visibleCapacity, true);
        batches.setUint32(batchOffset + 8, batch.key.count, true);
        batches.setUint32(batchOffset + 12, batch.key.first, true);
        batches.setInt32(batchOffset + 16, batch.key.baseVertex, true);
        batches.setUint32(batchOffset + 20, batch.batchId, true);
        batches.setUint32(batchOffset + 24, batch.key.drawKind === 'indexed' ? 1 : 0, true);
        for (const candidate of batch.candidates) {
          const candidateOffset = candidateIndex * CANDIDATE_STRIDE;
          candidates.setUint32(candidateOffset, candidate.primitiveIndex, true);
          candidates.setUint32(candidateOffset + 4, candidate.generation, true);
          candidates.setUint32(candidateOffset + 8, candidate.instanceOrdinal, true);
          candidates.setUint32(candidateOffset + 12, batch.key.materialSlot, true);
          candidates.setUint32(candidateOffset + 16, batchIndex, true);
          candidates.setUint32(candidateOffset + 20, batch.visibleBase, true);
          candidates.setUint32(candidateOffset + 24, batch.visibleCapacity, true);
          candidateIndex += 1;
        }
      }
      const candidateWrite = this.device.queue.writeBuffer(
        buffers.candidates,
        0,
        new Uint8Array(candidateBytes),
      );
      if (!candidateWrite.ok) return candidateWrite;
      const batchWrite = this.device.queue.writeBuffer(
        buffers.batches,
        0,
        new Uint8Array(batchBytes),
      );
      if (!batchWrite.ok) return batchWrite;
      this.candidateUploadBytes = candidateBytes.byteLength;
      this.batchUploadBytes = batchBytes.byteLength;
      this.uploadBytes += candidateBytes.byteLength + batchBytes.byteLength;
    }
    const viewBytes = new ArrayBuffer(VIEW_BYTES);
    const viewFloats = new Float32Array(viewBytes);
    viewFloats.set(planes.subarray(0, 24));
    const viewU32 = new Uint32Array(viewBytes);
    viewU32[24] = plan.candidateCount;
    viewU32[25] = plan.batches.length;
    const viewWrite = this.device.queue.writeBuffer(buffers.view, 0, new Uint8Array(viewBytes));
    if (!viewWrite.ok) return viewWrite;
    this.viewConstantsUploadBytes = viewBytes.byteLength;
    this.uploadBytes += viewBytes.byteLength;
    const sceneChanged =
      this.scenePrimitive !== scene.primitiveBuffer ||
      this.sceneInstance !== scene.instanceBuffer ||
      this.sceneTransform !== scene.transformBuffer ||
      this.sceneMaterial !== scene.materialBuffer;
    if (this.bindGroup === undefined || sceneChanged || buffersRebuilt) {
      const binding = this.device.createBindGroup({
        label: 'gpu-driven-view-bg',
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: bufferBinding(scene.primitiveBuffer) },
          { binding: 1, resource: bufferBinding(scene.instanceBuffer) },
          { binding: 2, resource: bufferBinding(scene.transformBuffer) },
          { binding: 3, resource: bufferBinding(buffers.candidates) },
          { binding: 4, resource: bufferBinding(buffers.batches) },
          { binding: 5, resource: bufferBinding(buffers.view) },
          { binding: 6, resource: bufferBinding(buffers.counters) },
          { binding: 7, resource: bufferBinding(buffers.visible) },
          { binding: 8, resource: bufferBinding(buffers.indirect) },
        ],
      });
      if (!binding.ok) return binding;
      this.bindGroup = binding.value;
      this.bindGroupCreates = 1;
      this.resourceGeneration += 1;
    }
    this.plan = plan;
    this.scenePrimitive = scene.primitiveBuffer;
    this.sceneInstance = scene.instanceBuffer;
    this.sceneTransform = scene.transformBuffer;
    this.sceneMaterial = scene.materialBuffer;
    this.sceneCapacity = scene.inspect().capacity;
    this.updateCount += 1;
    return ok(undefined);
  }

  inspect(): GpuDrivenViewInspection {
    return {
      topologyRevision: this.plan?.revision,
      candidateCount: this.plan?.candidateCount ?? 0,
      batchCount: this.plan?.batches.length ?? 0,
      visibleCapacity: this.plan?.visibleCapacity ?? 0,
      candidateCapacity: this.candidateCapacity,
      batchCapacity: this.batchCapacity,
      indirectCapacity: this.indirectCapacity,
      updateCount: this.updateCount,
      uploadBytes: this.uploadBytes,
      candidateUploadBytes: this.candidateUploadBytes,
      batchUploadBytes: this.batchUploadBytes,
      viewConstantsUploadBytes: this.viewConstantsUploadBytes,
      bindGroupCreates: this.bindGroupCreates,
      bufferRebuilds: this.bufferRebuilds,
      resourceGeneration: this.resourceGeneration,
    };
  }

  get visibleBuffer(): Buffer | undefined {
    return this.buffers?.visible;
  }

  get indirectBuffer(): Buffer | undefined {
    return this.buffers?.indirect;
  }

  get overflowBuffer(): Buffer | undefined {
    return this.buffers?.counters;
  }

  get overflowByteOffset(): number {
    return 4;
  }

  addPasses<FrameCtx extends RenderGraphFrame>(
    builder: RenderGraphBuilder<FrameCtx>,
  ): Result<GpuDrivenViewGraphResources, RenderGraphError> {
    const buffers = this.buffers;
    const bindGroup = this.bindGroup;
    const plan = this.plan;
    if (buffers === undefined || bindGroup === undefined || plan === undefined) {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'GpuDrivenView.update(...) precedes addPasses(...)',
          hint: 'publish the current SubmissionPlan and view planes first',
          detail: {
            resourceLabel: 'gpu-driven-view',
            field: 'state',
            expected: 'updated',
            actual: 'not-updated',
          },
        }),
      );
    }
    const importBuffer = (name: string, buffer: Buffer, size: number, usage: number) =>
      builder.importBuffer(name, { size, usage }, () => buffer);
    const primitive = importBuffer(
      'gpu-scene.primitive',
      this.scenePrimitive as Buffer,
      this.sceneCapacity * GPU_SCENE_LAYOUTS.primitive.stride,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!primitive.ok) return primitive;
    const transform = importBuffer(
      'gpu-scene.transform',
      this.sceneTransform as Buffer,
      this.sceneCapacity * GPU_SCENE_LAYOUTS.transform.stride,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!transform.ok) return transform;
    const instance = importBuffer(
      'gpu-scene.instance',
      this.sceneInstance as Buffer,
      this.sceneCapacity * GPU_SCENE_LAYOUTS.instance.stride,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!instance.ok) return instance;
    const material = importBuffer(
      'gpu-scene.material',
      this.sceneMaterial as Buffer,
      this.sceneCapacity * GPU_SCENE_LAYOUTS.material.stride,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!material.ok) return material;
    const candidates = importBuffer(
      'gpu-driven.candidates',
      buffers.candidates,
      this.candidateCapacity * CANDIDATE_STRIDE,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!candidates.ok) return candidates;
    const batches = importBuffer(
      'gpu-driven.batches',
      buffers.batches,
      this.batchCapacity * BATCH_STRIDE,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!batches.ok) return batches;
    const view = importBuffer(
      'gpu-driven.view',
      buffers.view,
      VIEW_BYTES,
      GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!view.ok) return view;
    const counters = importBuffer(
      'gpu-driven.counters',
      buffers.counters,
      this.batchCapacity * 8,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!counters.ok) return counters;
    const visible = importBuffer(
      'gpu-driven.visible',
      buffers.visible,
      this.candidateCapacity * 8,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!visible.ok) return visible;
    const indirect = importBuffer(
      'gpu-driven.indirect',
      buffers.indirect,
      this.indirectCapacity * 20,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!indirect.ok) return indirect;
    const reset = builder.addComputePass('gpu-driven.view-reset', {
      accesses: [
        { resource: view.value, usage: 'uniform-read' },
        { resource: counters.value, usage: 'storage-read-write' },
      ],
      encode: ({ pass }) => {
        pass.setPipeline(this.resetPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(Math.max(1, plan.batches.length) / WORKGROUP_SIZE));
      },
    });
    if (!reset.ok) return reset;
    const cull = builder.addComputePass('gpu-driven.frustum-compact', {
      accesses: [
        { resource: primitive.value, usage: 'storage-read' },
        { resource: instance.value, usage: 'storage-read' },
        { resource: transform.value, usage: 'storage-read' },
        { resource: candidates.value, usage: 'storage-read' },
        { resource: view.value, usage: 'uniform-read' },
        { resource: counters.value, usage: 'storage-read-write' },
        { resource: visible.value, usage: 'storage-read-write' },
      ],
      encode: ({ pass }) => {
        pass.setPipeline(this.cullPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(Math.max(1, plan.candidateCount) / WORKGROUP_SIZE));
      },
    });
    if (!cull.ok) return cull;
    const finalize = builder.addComputePass('gpu-driven.finalize-indirect', {
      accesses: [
        { resource: batches.value, usage: 'storage-read' },
        { resource: view.value, usage: 'uniform-read' },
        { resource: counters.value, usage: 'storage-read' },
        { resource: indirect.value, usage: 'storage-read-write' },
      ],
      encode: ({ pass }) => {
        pass.setPipeline(this.finalizePipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(Math.max(1, plan.batches.length) / WORKGROUP_SIZE));
      },
    });
    if (!finalize.ok) return finalize;
    return ok({
      visible: visible.value,
      primitive: primitive.value,
      instance: instance.value,
      transform: transform.value,
      material: material.value,
      indirect: indirect.value,
      overflow: counters.value,
    });
  }

  dispose(): void {
    const buffers = [
      ...this.supersededBuffers,
      ...(this.buffers === undefined ? [] : [this.buffers]),
    ];
    this.supersededBuffers = [];
    this.buffers = undefined;
    this.bindGroup = undefined;
    this.plan = undefined;
    this.scenePrimitive = undefined;
    this.sceneInstance = undefined;
    this.sceneTransform = undefined;
    this.sceneMaterial = undefined;
    this.sceneCapacity = 0;
    this.destroyAfterSubmittedWork(buffers);
    void this.pipelineLayout;
  }

  /**
   * @internal
   * Accept the current buffer generation after its typed graph compiles.
   * Superseded imports stay alive while the last-known-good graph remains
   * executable, then retire behind the queue fence only after promotion.
   */
  _commitResourceReplacement(): void {
    const buffers = this.supersededBuffers;
    if (buffers.length === 0) return;
    this.supersededBuffers = [];
    this.destroyAfterSubmittedWork(buffers);
  }

  private rebuildBuffers(
    candidateCapacity: number,
    batchCapacity: number,
    indirectCapacity: number,
  ): Result<void, RhiError> {
    const nextCandidate = nextCapacity(candidateCapacity);
    const nextBatch = nextCapacity(batchCapacity);
    const nextIndirect = nextCapacity(indirectCapacity);
    const created: Partial<MutableViewBuffers> = {};
    const allocate = (
      name: keyof ViewBuffers,
      size: number,
      usage: number,
    ): Result<void, RhiError> => {
      const buffer = this.device.createBuffer({
        label: `gpu-driven-view-${name}`,
        size,
        usage,
        mappedAtCreation: false,
      });
      if (!buffer.ok) return buffer;
      created[name] = buffer.value;
      return ok(undefined);
    };
    const storage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC;
    for (const result of [
      allocate('candidates', nextCandidate * CANDIDATE_STRIDE, storage | GPU_BUFFER_USAGE_COPY_DST),
      allocate('batches', nextBatch * BATCH_STRIDE, storage | GPU_BUFFER_USAGE_COPY_DST),
      allocate('view', VIEW_BYTES, GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST),
      allocate('counters', nextBatch * 8, storage),
      allocate('visible', nextCandidate * 8, storage),
      allocate('indirect', nextIndirect * 20, storage | GPU_BUFFER_USAGE_INDIRECT),
    ]) {
      if (!result.ok) {
        for (const buffer of Object.values(created)) this.device.destroyBuffer(buffer);
        return result;
      }
    }
    if (this.buffers !== undefined) this.supersededBuffers.push(this.buffers);
    this.buffers = created as ViewBuffers;
    this.candidateCapacity = nextCandidate;
    this.batchCapacity = nextBatch;
    this.indirectCapacity = nextIndirect;
    this.bufferRebuilds += 1;
    this.bindGroup = undefined;
    return ok(undefined);
  }

  private destroyAfterSubmittedWork(generations: readonly ViewBuffers[]): void {
    if (generations.length === 0) return;
    const release = (): void => {
      for (const buffers of generations) {
        for (const buffer of Object.values(buffers)) {
          this.device.destroyBuffer(buffer);
        }
      }
    };
    void this.device.queue.onSubmittedWorkDone().then(release, release);
  }
}
