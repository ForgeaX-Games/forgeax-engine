import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { box3, frustum, mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type Buffer,
  type Result,
  RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import {
  RhiNullCommandEncoder,
  RhiNullDevice,
  type RhiNullDevice as RhiNullDeviceType,
  RhiNullQueue,
  rhi,
} from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { deriveMaterialDynamicInputLayout, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderer as constructRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer, PointLight } from '../components';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { gpuDrivenDrawKey, gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { standardPbrProgramKey } from '../gpu-driven/pbr-program';
import { GpuDrivenProduction, resolveGpuDrivenMeshGroup } from '../gpu-driven/production-raster';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { adaptStandardPbrFrameResources } from '../gpu-driven/production-raster-scene';
import {
  SHADOW_CASTER_PROMOTE_WINDOW,
  SHADOW_CASTER_SETTLE_FRAMES,
} from '../gpu-driven/shadow-caster-classes';
import type { ShadowViewIdentity } from '../gpu-driven/shadow-views';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { Materials } from '../materials';
import { buildDispatchPlan } from '../record/frame';
import { makeZeroCameraFallbackSnapshot, worldEntityKey } from '../record/frame-snapshot';
import { emitGpuDrivenDrawReceipts } from '../record/gpu-draw-receipts';
import {
  encodeDirectionalShadowPass,
  encodePointShadowPass,
  encodeSpotShadowPass,
  recordShadowCasterDraws,
  shadowShaderMap,
} from '../record/shadow-pass';
import type { RenderPipelineFrame } from '../render-pipeline';
import type {
  DispatchEntry,
  MaterialSnapshot,
  RenderableSnapshot,
  ShadowCasterMembership,
} from '../render-system-extract';
import { shadowCasterCpuReason } from '../render-system-extract';
import { PersistentRenderScene, RenderScene } from '../scene/render-scene';
import { ReadonlyDynamicInputPage } from '../surface/dynamic-input';
import {
  preparedPbrSnapshot as preparedPbrFixture,
  standardPbrInputs,
} from './gpu-driven-production-fixture';

const STANDARD_PBR_RECEIPT = createStandardPbrArtifactReceipt();

function shadowCandidateCount(
  pool:
    | { submission(identity: ShadowViewIdentity): { plan: { candidateCount: number } } | undefined }
    | undefined,
  identity: ShadowViewIdentity,
): number {
  return (
    (pool?.submission(identity)?.plan.candidateCount ?? 0) +
    (pool?.submission({ ...identity, layer: 'static' })?.plan.candidateCount ?? 0)
  );
}

type PrepareInput = Parameters<GpuDrivenProduction['prepare']>[0];

describe('GPU-driven scene-index mesh address selection', () => {
  it('keeps direct batches on their local group and rebuilds clustered group(2) around the same projection buffer', () => {
    const directGroup = {} as BindGroup;
    const clusteredGroup = {} as BindGroup;
    const legacyClusterGroup = {} as BindGroup;
    const transformBuffer = {} as Buffer;
    const clusterBindGroupForMesh = vi.fn(() => clusteredGroup);
    const frameResources = { clusterBindGroup: legacyClusterGroup, clusterBindGroupForMesh };

    expect(
      resolveGpuDrivenMeshGroup({
        clustered: false,
        deformation: 'rigid',
        meshBindGroup: directGroup,
        sceneTransformBuffer: transformBuffer,
        sceneTransformBytes: 256,
        frameResources,
      }),
    ).toBe(directGroup);
    expect(clusterBindGroupForMesh).not.toHaveBeenCalled();

    expect(
      resolveGpuDrivenMeshGroup({
        clustered: true,
        deformation: 'rigid',
        meshBindGroup: directGroup,
        sceneTransformBuffer: transformBuffer,
        sceneTransformBytes: 512,
        frameResources,
      }),
    ).toBe(clusteredGroup);
    expect(clusterBindGroupForMesh).toHaveBeenCalledExactlyOnceWith(transformBuffer, 512);
  });

  it('rebuilds clustered skin group(2) from the matching scene-index mesh and palette pages', () => {
    const directSkinGroup = {} as BindGroup;
    const clusteredSkinGroup = {} as BindGroup;
    const transformBuffer = {} as Buffer;
    const paletteBuffer = {} as Buffer;
    const clusterBindGroupForSkin = vi.fn(() => clusteredSkinGroup);

    expect(
      resolveGpuDrivenMeshGroup({
        clustered: true,
        deformation: 'skin',
        meshBindGroup: directSkinGroup,
        sceneTransformBuffer: transformBuffer,
        sceneTransformBytes: 768,
        skinPaletteBinding: { buffer: paletteBuffer, bindingWindowBytes: 16_320 },
        frameResources: { clusterBindGroupForSkin },
      }),
    ).toBe(clusteredSkinGroup);
    expect(clusterBindGroupForSkin).toHaveBeenCalledExactlyOnceWith(
      transformBuffer,
      768,
      paletteBuffer,
      16_320,
    );
  });
});

interface BufferWrite {
  readonly buffer: Buffer;
  readonly offset: number;
  readonly bytes: Uint8Array;
}

class RecordingQueue extends RhiNullQueue {
  readonly writes: BufferWrite[] = [];

  override writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): Result<void, RhiError> {
    const source =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const start = dataOffset ?? 0;
    const length = size ?? source.byteLength - start;
    this.writes.push({
      buffer,
      offset: bufferOffset,
      bytes: source.slice(start, start + length),
    });
    return super.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
  }
}

function recordingDevice(queue: RecordingQueue): RhiNullDeviceType {
  return new RhiNullDevice(
    queue,
    (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
  );
}

const EMPTY_RESOURCE_CLASS = JSON.stringify({ textures: [], samplers: [], video: [] });
const OUTPUT_TRANSFORM_WGSL =
  '@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { ' +
  'var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)); ' +
  'return vec4<f32>(p[i], 0.0, 1.0); } ' +
  '@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }';

const STANDARD_PBR_URP_VARIANT_KEY =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false';
const STANDARD_PBR_TRANSMISSION_VARIANT_KEY =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';

function manifestDataUrl(
  pbrWgsl = '/* pbr stub - calls f_schlick( */',
  withReceipt = false,
): string {
  const unlitWgsl = '/* unlit stub */';
  const tonemapWgsl = OUTPUT_TRANSFORM_WGSL;
  const standardPbrVariant = (transmissionAvailable: boolean, definesKey: string) => ({
    definesKey,
    defines: {
      CLUSTER_FORWARD_AVAILABLE: false,
      STORAGE_BUFFER_AVAILABLE: true,
      TRANSMISSION_AVAILABLE: transmissionAvailable,
      VERTEX_COLOR_AVAILABLE: false,
    },
    composedWgsl: pbrWgsl,
    ...(withReceipt ? { receipt: STANDARD_PBR_RECEIPT } : {}),
  });
  const materialShader = (
    identifier: string,
    paramSchema: readonly unknown[],
    composedWgsl: string,
    variants: readonly unknown[] = [],
  ) => ({
    identifier,
    sourcePath: `${identifier}.wgsl`,
    composedWgsl,
    paramSchema: JSON.stringify(paramSchema),
    variants,
    ...(withReceipt && identifier === 'forgeax::default-standard-pbr'
      ? { receipt: STANDARD_PBR_RECEIPT }
      : {}),
  });
  return `data:application/json,${encodeURIComponent(
    JSON.stringify({
      schemaVersion: '1.0.0',
      entries: [
        { hash: 'pbr00000', wgsl: pbrWgsl, glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: unlitWgsl, glsl: '', bindings: '' },
        { hash: 'tonemap0', wgsl: tonemapWgsl, glsl: '', bindings: '' },
      ],
      materialShaders: [
        materialShader(
          'forgeax::default-standard-pbr',
          DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
          pbrWgsl,
          [
            standardPbrVariant(false, STANDARD_PBR_URP_VARIANT_KEY),
            standardPbrVariant(true, STANDARD_PBR_TRANSMISSION_VARIANT_KEY),
          ],
        ),
        materialShader('forgeax::default-unlit', DEFAULT_UNLIT_PARAM_SCHEMA, unlitWgsl),
      ],
    }),
  )}`;
}

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

function preparedSnapshot(entityKey: number, assetHandle: number): RenderableSnapshot {
  return preparedPbrFixture(snapshot(entityKey, assetHandle));
}

function withoutPrepared(
  draw: NonNullable<RenderableSnapshot['gpuDrivenDraws']>[number],
): Omit<typeof draw, 'prepared'> {
  const { prepared, ...rest } = draw;
  void prepared;
  return rest;
}

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

function mesh(device: RhiNullDevice, indexed = true, withLod = false): MeshGpuHandles {
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
    ...(withLod
      ? {
          lodRanges: [
            [{ first: 0, count: 3, baseVertex: 0 }],
            [{ first: 3, count: 1, baseVertex: 0 }],
          ],
        }
      : {}),
  };
}

describe('GPU-driven production projection', () => {
  it('retains suppressed LOD candidates for selector accounting while admitting only active draws', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const lodMeshGuid = '00000000-0000-7000-8000-000000000001' as never;
    const makeLodSnapshot = (entityKey: number): RenderableSnapshot => {
      const base = preparedPbrFixture(snapshot(entityKey, 3));
      const draw = base.gpuDrivenDraws?.[0];
      if (draw === undefined) throw new Error('LOD test snapshot has no draw');
      return {
        ...base,
        lods: [{ mesh: lodMeshGuid, screenCoverage: 0.5 }],
        gpuDrivenDraws: [{ ...draw, lodRanges: [{ first: 3, count: 1, baseVertex: 0 }] }],
      };
    };
    const delta = projection.apply([
      updateSnapshot(makeLodSnapshot(1)),
      updateSnapshot(makeLodSnapshot(2)),
    ]);
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const lodGpuMesh = mesh(device, true, true);
    const prepared = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([
          [0, lodGpuMesh],
          [1, lodGpuMesh],
        ]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,

        activeEntityKeys: new Set([worldEntityKey(0, 1)]),
        activeEntityRevision: 1,
      })
      .unwrap();
    expect(prepared?.drawKeys).toEqual(new Set(['1:-1:0', '2:-1:0']));
    // Both candidates are uploaded to the selector (2 * 304 bytes), while
    // only the active entity is admitted into the compacted draw stream.
    // One shared-chain batch owns one indirect command per LOD level.
    expect(production.inspect()).toMatchObject({
      candidateUploadBytes: 2 * 304,
      batchCount: 1,
      indirectDrawCount: 2,
    });
    if (prepared === undefined) return;
    const projected = prepared
      .project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1)
      .unwrap();
    expect(projected.accesses.length).toBeGreaterThan(0);
    expect(production.inspect()).toMatchObject({
      batchBindGroupCreates: 0,
      indirectDrawCount: 2,
    });

    // The scene/view buffers and visible range are unchanged on a warm
    // projection. The raster owner must reuse the physical batch bind group;
    // a new group is only valid after one of those handles or the range
    // changes (resize/recovery/LOD admission).
    const warm = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([
          [0, lodGpuMesh],
          [1, lodGpuMesh],
        ]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,

        activeEntityKeys: new Set([worldEntityKey(0, 1)]),
        activeEntityRevision: 1,
      })
      .unwrap();
    expect(warm?.topologySignature).toBe(prepared.topologySignature);
    warm?.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
    expect(production.inspect()).toMatchObject({ batchBindGroupCreates: 0 });

    const suppressed = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([
          [0, lodGpuMesh],
          [1, lodGpuMesh],
        ]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,

        activeEntityKeys: new Set(),
        activeEntityRevision: 2,
      })
      .unwrap();
    // Admission is a per-view GPU bitmap indexed by primitive slot: hiding an
    // entity uploads dirty words but must not rebuild the plan or the graph.
    expect(suppressed?.topologySignature).toBe(prepared.topologySignature);
    expect(production.inspect()).toMatchObject({ batchCount: 1 });

    const restored = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([
          [0, lodGpuMesh],
          [1, lodGpuMesh],
        ]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,

        activeEntityKeys: new Set([worldEntityKey(0, 1)]),
        activeEntityRevision: 3,
      })
      .unwrap();
    expect(restored?.topologySignature).toBe(prepared.topologySignature);
    expect(production.inspect()).toMatchObject({ batchCount: 1 });
    // Selector accounting precedes suppression; suppression precedes the
    // compacted append in the early cull entry point.
    const cullView = GPU_DRIVEN_VIEW_WGSL.slice(
      GPU_DRIVEN_VIEW_WGSL.indexOf('fn cullView('),
      GPU_DRIVEN_VIEW_WGSL.indexOf('fn linearOcclusionDepth('),
    );
    expect(cullView.indexOf('atomicAdd(&counters[lodCounterIndex')).toBeGreaterThan(0);
    expect(cullView.indexOf('atomicAdd(&counters[lodCounterIndex')).toBeLessThan(
      cullView.indexOf('if (isSuppressed(candidate.primitiveIndex))'),
    );
    expect(cullView.indexOf('if (isSuppressed(candidate.primitiveIndex))')).toBeLessThan(
      cullView.indexOf('appendCandidate('),
    );
    production.dispose();
    availability.scene.dispose();
  });

  it('suppresses an inactive resident candidate through the per-view bitmap', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const candidate = preparedPbrFixture(snapshot(1, 3));
    const delta = projection.apply([updateSnapshot(candidate)]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const input = {
      ...pbrInputs,
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map([[0, mesh(device)]]),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,
    };
    const prepared = production
      .prepare({ ...input, activeEntityKeys: new Set(), activeEntityRevision: 1 })
      .unwrap();
    // The resident candidate stays in the stable plan; the per-view bitmap
    // suppresses its primitive slot on the GPU before any compaction.
    expect(prepared).toBeDefined();
    expect(prepared?.ownsAllDrawItems).toBe(true);
    expect(production.inspect()).toMatchObject({ batchCount: 1, suppressionUploadBytes: 4 });
    prepared?._commitResourceReplacement();
    // Falsifier: an unchanged admission set uploads nothing, and a flipped
    // entity uploads exactly its dirty word without a plan or graph rebuild.
    const steady = production
      .prepare({ ...input, activeEntityKeys: new Set(), activeEntityRevision: 1 })
      .unwrap();
    expect(production.inspect()).toMatchObject({ suppressionUploadBytes: 0 });
    steady?._commitResourceReplacement();
    const admitted = production
      .prepare({
        ...input,
        activeEntityKeys: new Set([worldEntityKey(0, 1)]),
        activeEntityRevision: 2,
      })
      .unwrap();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      suppressionUploadBytes: 4,
    });
    expect(admitted?.topologySignature).toBe(prepared?.topologySignature);
    production.dispose();
    availability.scene.dispose();
  });

  it('keys the compiled graph on buffer capacity, not on plan membership', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const availability = GpuScene.create(device, 8).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    const topology = new BatchTopology();
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const sharedMesh = mesh(device);
    const spawn = (entityKeys: readonly number[]) => {
      availability.scene
        .sync(
          projection.apply(
            entityKeys.map((key) => updateSnapshot(preparedPbrFixture(snapshot(key, 3)))),
          ),
        )
        .unwrap();
      topology.rebuild(projection.slotsSnapshot());
      const prepared = production
        .prepare({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.plan(),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map(
            projection.slotsSnapshot().map((entry) => [entry.slot, sharedMesh] as const),
          ),
          viewBindGroupLayout: viewLayout,
          meshResidencyEpoch: 1,
        })
        .unwrap();
      prepared?._commitResourceReplacement();
      return prepared?.topologySignature;
    };
    try {
      const first = spawn([1, 2, 3]);
      expect(first).toBeDefined();
      // A spawned member of an existing raster class revises the plan inside
      // the retained capacity: the compiled graph must survive it.
      const grown = spawn([4]);
      expect(topology.plan().candidateCount).toBe(4);
      expect(grown).toBe(first);
      // Falsifier: crossing the power-of-two candidate capacity replaces the
      // view buffers, which is a real graph resource dependency.
      const replaced = spawn([5]);
      expect(replaced).not.toBe(first);
    } finally {
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('validates and consumes a published Surface dynamic page through production prepare', async () => {
    const queue = new RecordingQueue();
    const device = recordingDevice(queue);
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const baseArtifact = pbrInputs.standardPbrArtifact;
    expect(baseArtifact).toBeDefined();
    if (baseArtifact === undefined) return;
    const dynamicSchema = {
      name: 'surfaceEvents',
      fields: [
        { name: 'position', type: 'vec3<f32>' as const },
        { name: 'strength', type: 'f32' as const },
      ],
      maxRecords: 4,
      maxDomains: 2,
      maxPageBytes: 64,
      maxBindings: 1,
      maxEventsPerSample: 2,
    };
    const layout = deriveMaterialDynamicInputLayout(dynamicSchema).unwrap();
    const surfaceReceipt = {
      ...STANDARD_PBR_RECEIPT,
      surface: {
        model: 'single-layer-medium' as const,
        module: 'forgeax::single-layer-medium',
        inputAbi: 'SingleLayerMediumSurfaceInput',
        outputAbi: 'SingleLayerMediumSurfaceData',
        passes: ['nearest-layer', 'color'] as const,
        dynamicInput: {
          layout,
          group: 3,
          binding: 3,
          readOnly: true as const,
          accessor: `read_${layout.name}`,
        },
      },
    };
    // One resident mesh: a replaced handle is a real preparation edit.
    const surfaceMesh = mesh(device);
    const artifact = {
      ...baseArtifact,
      receipt: surfaceReceipt,
    };
    const projection = new RenderScene();
    const source = preparedPbrFixture(snapshot(1, 3));
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const twoInstanceSurface = {
      ...source,
      instances: {
        transforms: new Float32Array([...identity, ...identity]),
        instanceCount: 2,
        cacheKey: 1,
        archVersion: 1,
        revision: 1,
      },
    } satisfies RenderableSnapshot;
    const delta = projection.apply([updateSnapshot(twoInstanceSurface)]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const page = ReadonlyDynamicInputPage.create({
      sourceId: 'surface-producer',
      pageId: 1,
      schema: dynamicSchema,
    }).unwrap();
    page.writeRecord(0, { position: [1, 2, 3], strength: 0.75 }).unwrap();
    page.writeRecord(1, { position: [4, 5, 6], strength: 0.25 }).unwrap();
    const firstRange = page
      .reserveRange({
        domain: 'surface-a',
        recordStart: 0,
        recordCount: 1,
        instanceIndex: 3,
        member: {
          worldIdentity: 'world-a',
          entityKey: 1,
          drawItemIndex: 0,
          instanceOrdinal: 0,
        },
      })
      .unwrap();
    const secondRange = page
      .reserveRange({
        domain: 'surface-b',
        recordStart: 1,
        recordCount: 1,
        instanceIndex: 7,
        member: {
          worldIdentity: 'world-a',
          entityKey: 1,
          drawItemIndex: 0,
          instanceOrdinal: 1,
        },
      })
      .unwrap();
    const stableRanges = Object.freeze([firstRange, secondRange]);
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const probeBlendRecordBuffer = device
      .createBuffer({ size: 4096, usage: GPU_BUFFER_USAGE_STORAGE })
      .unwrap();
    const prepared = production
      .prepare({
        ...pbrInputs,
        standardPbrArtifact: artifact,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
          worldIdentities: ['world-a'],
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([[0, surfaceMesh]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        probeBlendRecordBuffer,
        hdrp: false,
        surfaceDynamicInput: {
          page,
          ranges: [secondRange, firstRange],
          projectionRevision: 1,
          frameTime: 1,
        },
        deviceGeneration: 1,
      })
      .unwrap();
    expect(prepared?.surfaceSubmission).toMatchObject({
      model: 'single-layer-medium',
      lane: 'gpu-driven',
      passes: [{ pass: 'nearest-layer' }, { pass: 'color' }],
    });
    expect(page.uploadedRevision).toBe(page.contentRevision);
    const consumeSpy = vi.spyOn(page, 'consume');
    expect(prepared?._consumeSurfaceDynamicInput?.(31)).toMatchObject({
      ok: true,
    });
    expect(consumeSpy).toHaveBeenCalledTimes(2);
    const frameBuffer = prepared?.standardPbrFrameResources.surfaceDynamicInput?.frame;
    expect(frameBuffer).toBeDefined();
    if (frameBuffer === undefined) return;
    const frameWrites = queue.writes.filter(
      (write) => write.buffer === frameBuffer && write.bytes.byteLength === 48,
    );
    const mappedFrameWrite = frameWrites.find((write) => {
      if (write.buffer !== frameBuffer || write.bytes.byteLength !== 48) return false;
      return (
        new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength).getUint32(
          12,
          true,
        ) === 3
      );
    });
    expect(mappedFrameWrite?.offset).toBe(0);
    expect(
      mappedFrameWrite === undefined
        ? undefined
        : new DataView(
            mappedFrameWrite.bytes.buffer,
            mappedFrameWrite.bytes.byteOffset,
            mappedFrameWrite.bytes.byteLength,
          ).getUint32(44, true),
    ).toBe(1);
    const secondMappedFrameWrite = frameWrites.find((write) => {
      if (write.buffer !== frameBuffer || write.bytes.byteLength !== 48) return false;
      return (
        new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength).getUint32(
          12,
          true,
        ) === 7
      );
    });
    expect(secondMappedFrameWrite?.offset).toBe(48);
    const frameWriteCount = frameWrites.length;
    expect(production.inspect()).toMatchObject({
      surfaceFrameRangeBuilds: 1,
      surfaceFrameMemberScans: 4,
      surfaceFrameRowAllocations: 2,
      surfaceFrameTimeWrites: 1,
    });
    const repeated = production
      .prepare({
        ...pbrInputs,
        standardPbrArtifact: artifact,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
          worldIdentities: ['world-a'],
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([[0, surfaceMesh]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        probeBlendRecordBuffer,
        hdrp: false,
        surfaceDynamicInput: { page, ranges: stableRanges, projectionRevision: 1, frameTime: 1 },
        deviceGeneration: 1,
      })
      .unwrap();
    expect(repeated).toBeDefined();
    expect(repeated?._consumeSurfaceDynamicInput?.(32)).toMatchObject({ ok: true });
    expect(consumeSpy).toHaveBeenCalledTimes(2);
    expect(
      queue.writes.filter((write) => write.buffer === frameBuffer && write.bytes.byteLength === 48),
    ).toHaveLength(frameWriteCount);
    const stableInspection = production.inspect();
    expect(stableInspection).toMatchObject({
      surfaceFrameRangeBuilds: 1,
      surfaceFrameMemberScans: 4,
      surfaceFrameRowAllocations: 2,
      surfaceFrameTimeWrites: 1,
    });

    const writesBeforeTimeAdvance = queue.writes.length;
    production
      .prepare({
        ...pbrInputs,
        standardPbrArtifact: artifact,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
          worldIdentities: ['world-a'],
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([[0, surfaceMesh]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        probeBlendRecordBuffer,
        hdrp: false,
        surfaceDynamicInput: { page, ranges: stableRanges, projectionRevision: 1, frameTime: 2 },
        deviceGeneration: 1,
      })
      .unwrap();
    const timeAdvanceWrites = queue.writes.slice(writesBeforeTimeAdvance);
    const sharedFrameBuffer = prepared?.standardPbrFrameResources.surfaceDynamicInput?.sharedFrame;
    expect(sharedFrameBuffer).toBeDefined();
    expect(timeAdvanceWrites.filter((write) => write.buffer === sharedFrameBuffer)).toMatchObject([
      { offset: 0, bytes: { byteLength: 16 } },
    ]);
    expect(timeAdvanceWrites.some((write) => write.buffer === frameBuffer)).toBe(false);
    expect(production.inspect()).toMatchObject({
      surfaceFrameRangeBuilds: stableInspection.surfaceFrameRangeBuilds,
      surfaceFrameMemberScans: stableInspection.surfaceFrameMemberScans,
      surfaceFrameRowAllocations: stableInspection.surfaceFrameRowAllocations,
      surfaceFrameTimeWrites: stableInspection.surfaceFrameTimeWrites + 1,
    });

    const invalid = production.prepare({
      ...pbrInputs,
      standardPbrArtifact: artifact,
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
        worldIdentities: ['world-a'],
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map([[0, surfaceMesh]]),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,
      probeBlendRecordBuffer,
      hdrp: false,
      surfaceDynamicInput: {
        page,
        ranges: [{ ...firstRange, byteOffset: firstRange.byteOffset + 4 }, secondRange],
        projectionRevision: 2,
        frameTime: 1,
      },
      deviceGeneration: 1,
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'rhi-descriptor-invalid' } });
    const retried = production.prepare({
      ...pbrInputs,
      standardPbrArtifact: artifact,
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
        worldIdentities: ['world-a'],
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map([[0, surfaceMesh]]),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,
      probeBlendRecordBuffer,
      hdrp: false,
      surfaceDynamicInput: {
        page,
        ranges: stableRanges,
        projectionRevision: 2,
        frameTime: 2,
      },
      deviceGeneration: 1,
    });
    expect(retried.ok).toBe(true);
    production.dispose();
    availability.scene.dispose();
  });

  it('keeps GPU batches World-homogeneous for same-submit counter attribution', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const first = preparedPbrFixture(snapshot(1, 3));
    const second = { ...preparedPbrFixture(snapshot(2, 3)), worldId: 1 };
    const delta = projection.apply([updateSnapshot(first), updateSnapshot(second)]);
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const prepared = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([
          [0, mesh(device)],
          [1, mesh(device)],
        ]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(prepared).toBeDefined();
    expect(production.inspect()).toMatchObject({ batchCount: 2, indirectDrawCount: 2 });
    production.dispose();
    availability.scene.dispose();
  });

  it('splits texture masks in GPU batches and invalidates the raster projection on edits', async () => {
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const availability = GpuScene.create(device, 2).unwrap();
    if (availability.status !== 'available') throw new Error('GPU scene unavailable');
    const topology = new BatchTopology();
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const sharedMesh = mesh(device);
    const meshes = new Map([
      [0, sharedMesh],
      [1, sharedMesh],
    ]);
    const pipelines = vi.spyOn(device, 'createRenderPipeline');
    const row = (id: number, mask: number) => {
      const source = preparedPbrFixture(snapshot(id, 3));
      const material = { ...source.material, standardTextureMask: mask };
      return { ...source, material, materials: [material] };
    };
    const prepare = () =>
      production
        .prepare({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.plan(),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
          meshResidencyEpoch: 1,
        })
        .unwrap();
    try {
      availability.scene
        .sync(projection.apply([updateSnapshot(row(1, 0)), updateSnapshot(row(2, 4))]))
        .unwrap();
      topology.rebuild(projection.slotsSnapshot());
      const first = prepare();
      expect(first).toBeDefined();
      expect(production.inspect().batchCount).toBe(2);
      first?.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
      expect(
        pipelines.mock.calls.map(([descriptor]) => descriptor.fragment?.constants?.['64000']),
      ).toEqual(expect.arrayContaining([0, 4]));
      const stable = prepare();
      expect(stable?.topologySignature).toBe(first?.topologySignature);
      stable?.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
      pipelines.mockClear();
      availability.scene.sync(projection.apply([updateSnapshot(row(2, 0))])).unwrap();
      topology.rebuild(projection.slotsSnapshot());
      const changed = prepare();
      expect(changed?.topologySignature).not.toBe(first?.topologySignature);
      expect(production.inspect().batchCount).toBe(1);
      changed?.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
      expect(
        pipelines.mock.calls.map(([descriptor]) => descriptor.fragment?.constants?.['64000']),
      ).toEqual([0]);
    } finally {
      pipelines.mockRestore();
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('reuses published program facts across graph projections and observes replacement source', async () => {
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const availability = GpuScene.create(device, 2).unwrap();
    if (availability.status !== 'available') throw new Error('GPU scene unavailable');
    const topology = new BatchTopology();
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const sharedMesh = mesh(device);
    const layout = vi.spyOn(String.prototype, 'replace');
    try {
      if (pbrInputs.standardPbrArtifact === undefined) throw new Error('Missing fixture artifact');
      const rows = [0, 4].map((mask, index) => {
        const source = preparedPbrFixture(snapshot(index + 1, 3));
        const material = { ...source.material, standardTextureMask: mask };
        return updateSnapshot({ ...source, material, materials: [material] });
      });
      availability.scene.sync(projection.apply(rows)).unwrap();
      topology.rebuild(projection.slotsSnapshot());
      for (const source of ['synthetic', '@group(2) @binding(3) var<uniform> cluster: vec4f;']) {
        const program = createMaterialShaderProgram(source);
        layout.mockClear();
        const prepared = production
          .prepare({
            ...pbrInputs,
            standardPbrArtifact: { ...pbrInputs.standardPbrArtifact, program },
            scene: {
              scene: availability.scene,
              plan: topology.plan(),
              slots: projection.slotsSnapshot(),
              slotAt: projection.slotAt,
            },
            camera: makeZeroCameraFallbackSnapshot(),
            meshBySlot: new Map([
              [0, sharedMesh],
              [1, sharedMesh],
            ]),
            viewBindGroupLayout: viewLayout,
            meshResidencyEpoch: 1,
          })
          .unwrap();
        expect(production.inspect().batchCount).toBe(2);
        if (prepared === undefined) throw new Error('Missing GPU projection');
        prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
        expect(layout.mock.contexts.filter((value) => String(value) === source)).toHaveLength(0);
        prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
        expect(layout.mock.contexts.filter((value) => String(value) === source)).toHaveLength(0);
      }
    } finally {
      layout.mockRestore();
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('uses concrete draw keys for CPU validation telemetry', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const gpuLodRow = {
      ...snapshot(7, 3),
      worldId: 1,
      lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
    };
    const plainFallbackRow = { ...snapshot(2, 3), worldId: 0 };
    const gpuOwned = new Set([
      gpuDrivenDrawKey(worldEntityKey(gpuLodRow.worldId, gpuLodRow.entityKey), -1, 0),
    ]);

    // A GPU-owned row is removed from validation before this telemetry hook;
    // the remaining plain row must still be counted as the one CPU fallback.
    production.recordCpuValidation([{ source: plainFallbackRow }], gpuOwned);
    expect(production.inspect()).toMatchObject({
      cpuFallbackDrawItems: 1,
      validatedGpuOwnedRows: 0,
    });

    // A GPU-only row contributes ownership telemetry without inflating the
    // CPU residual row count.
    production.recordCpuValidation([{ source: gpuLodRow }], gpuOwned);
    expect(production.inspect()).toMatchObject({
      cpuFallbackDrawItems: 0,
      validatedGpuOwnedRows: 0,
    });

    // Composition-local world indices do not necessarily equal the retained
    // stable world identity used by the GPU draw-key producer.
    const worldKeys = [101, 202] as const;
    const stableGpuOwned = new Set([
      gpuDrivenDrawKey(
        worldEntityKey(worldKeys[gpuLodRow.worldId] ?? -1, gpuLodRow.entityKey),
        -1,
        0,
      ),
    ]);
    production.recordCpuValidation(
      [{ source: gpuLodRow }],
      stableGpuOwned,
      'stable-world',
      worldKeys,
    );
    expect(production.inspect()).toMatchObject({
      cpuFallbackDrawItems: 0,
      validatedGpuOwnedRows: 0,
    });

    const stableBaseline = production.inspect();
    production.recordCpuValidation(
      [{ source: gpuLodRow }],
      stableGpuOwned,
      'stable-world',
      worldKeys,
    );
    expect(production.inspect()).toMatchObject({
      cpuValidationScans: stableBaseline.cpuValidationScans,
      cpuValidationCacheHits: stableBaseline.cpuValidationCacheHits + 1,
    });

    production.recordCpuValidation(
      [{ source: { ...gpuLodRow } }],
      stableGpuOwned,
      'stable-world',
      worldKeys,
    );
    expect(production.inspect()).toMatchObject({
      cpuValidationScans: stableBaseline.cpuValidationScans + 1,
      cpuValidationCacheHits: stableBaseline.cpuValidationCacheHits + 1,
    });
    production.dispose();
  });

  it('keeps unclaimed mixed draws on the CPU lane while GPU receipts stay concrete', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const base = snapshot(8, 3);
    const firstDraw = base.gpuDrivenDraws?.[0];
    if (firstDraw === undefined) throw new Error('mixed ownership fixture has no first draw');
    const mixed = {
      ...base,
      gpuDrivenDraws: [
        firstDraw,
        { ...firstDraw, drawItemIndex: 1, first: firstDraw.first + firstDraw.count },
      ],
    };
    const claimed = new Set([
      gpuDrivenDrawKey(worldEntityKey(mixed.worldId, mixed.entityKey), -1, 0),
    ]);
    const gpuReceipts: { readonly submeshIndex: number; readonly lane: string }[] = [];
    emitGpuDrivenDrawReceipts({ source: mixed }, claimed, (_entry, submeshIndex, receipt) =>
      gpuReceipts.push({ submeshIndex, lane: receipt.lane }),
    );
    expect(gpuReceipts).toEqual([{ submeshIndex: 0, lane: 'gpu' }]);
    expect(gpuReceipts.some((receipt) => receipt.submeshIndex === 1)).toBe(false);

    production.recordCpuValidation([{ source: mixed }], claimed);
    expect(production.inspect()).toMatchObject({
      cpuFallbackDrawItems: 1,
      validatedGpuOwnedRows: 1,
    });
    production.dispose();
  });

  it.each([
    1, 64,
  ])('validates and serializes batches independently of %i instances', async (instanceCount) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const projection = new RenderScene();
    const source = preparedPbrFixture(snapshot(1, 3));
    const transforms = new Float32Array(instanceCount * 16);
    for (let index = 0; index < instanceCount; index += 1) {
      transforms.set(source.transform.world, index * 16);
    }
    const delta = projection.apply([
      updateSnapshot({
        ...source,
        instances: { transforms, instanceCount, cacheKey: 1, archVersion: 1 },
      }),
    ]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const sourcePlan = topology.plan();
    expect(sourcePlan.batches).toHaveLength(1);
    const serialize = vi.fn((key: object) => key);
    const compatibilityScan = vi.fn();
    const plan = {
      ...sourcePlan,
      batches: sourcePlan.batches.map((batch) => ({
        ...batch,
        key: { ...batch.key, toJSON: () => serialize(batch.key) },
        candidates: Object.assign([...batch.candidates], {
          some: (...args: Parameters<typeof batch.candidates.some>) => {
            compatibilityScan();
            return batch.candidates.some(...args);
          },
        }),
      })),
    };
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    production
      .prepare({
        ...standardPbrInputs(device, shader, viewLayout),
        scene: {
          scene: availability.scene,
          plan,
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([[0, mesh(device)]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(production.inspect()).toMatchObject({
      batchCount: 1,
      indirectDrawCount: 1,
      candidateUploadBytes: instanceCount * 304,
    });
    // One scene preparation shared by main and shadow views, independent of instances.
    expect(serialize).toHaveBeenCalledTimes(1);
    // Mesh compatibility of a non-LOD batch is a batch fact: no member scan.
    expect(compatibilityScan).not.toHaveBeenCalled();
    production.dispose();
    availability.scene.dispose();
  });

  it('shares scene admission across LOD, visibility and shadow projections', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const lodMeshGuid = '00000000-0000-7000-8000-000000000001' as never;
    const makeLodSnapshot = (entityKey: number): RenderableSnapshot => {
      const base = preparedPbrFixture(snapshot(entityKey, 3));
      const draw = base.gpuDrivenDraws?.[0];
      if (draw === undefined) throw new Error('LOD test snapshot has no draw');
      return {
        ...base,
        lods: [{ mesh: lodMeshGuid, screenCoverage: 0.5 }],
        gpuDrivenDraws: [{ ...draw, lodRanges: [{ first: 3, count: 1, baseVertex: 0 }] }],
      };
    };
    const delta = projection.apply([
      updateSnapshot(makeLodSnapshot(1)),
      updateSnapshot(makeLodSnapshot(2)),
    ]);
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const lodGpuMesh = mesh(device, true, true);
    const input = {
      ...pbrInputs,
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 5) },
      meshBySlot: new Map([
        [0, lodGpuMesh],
        [1, lodGpuMesh],
      ]),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,
    };
    const prepared = production.prepare(input).unwrap();
    expect(prepared).toBeDefined();
    // One shared-chain batch owns one indirect command per LOD level.
    expect(production.inspect()).toMatchObject({
      batchCount: 1,
      indirectDrawCount: 2,
      candidateUploadBytes: 2 * 304,
    });
    if (prepared === undefined) throw new Error('expected initial GPU projection');
    expect(production.inspect().gpuOwnedSnapshotsMaterialized).toBe(2);
    prepared._commitResourceReplacement();
    const nearInput = { ...input, camera: { ...input.camera, position: vec3.create(0, 0, 0.5) } };
    const near = production.prepare(nearInput).unwrap();
    expect(near).toBeDefined();
    // Crossing a LOD threshold is a GPU cull decision: the plan is retained.
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      candidateUploadBytes: 0,
      gpuOwnedSnapshotsMaterialized: 0,
    });
    near?._commitResourceReplacement();
    const visible = production.prepare({ ...nearInput, activeEntityKeys: new Set([1]) }).unwrap();
    expect(visible).toBeDefined();
    // Visibility admission is the per-view suppression bitmap, not plan data.
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      gpuOwnedSnapshotsMaterialized: 0,
    });
    expect(production.inspect().suppressionUploadBytes).toBeGreaterThan(0);
    visible?._commitResourceReplacement();
    const shadow = production
      .prepare({ ...nearInput, shadowCasterDrawKeys: new Set(['1:-1:0:0']) })
      .unwrap();
    expect(shadow?.shadowDrawKeys).toEqual(new Set(['1:-1:0:0']));
    expect(production.inspect().gpuOwnedSnapshotsMaterialized).toBe(0);
    shadow?._commitResourceReplacement();
    const rebound = production.prepare({ ...nearInput, meshResidencyEpoch: 2 }).unwrap();
    expect(rebound).toBeDefined();
    expect(production.inspect().gpuOwnedSnapshotsMaterialized).toBe(2);
    rebound?._commitResourceReplacement();
    if (input.standardPbrArtifact === undefined) throw new Error('expected fixture artifact');
    const republished = production
      .prepare({
        ...nearInput,
        meshResidencyEpoch: 2,
        standardPbrArtifact: {
          ...input.standardPbrArtifact,
          program: createMaterialShaderProgram('republished'),
        },
      })
      .unwrap();
    expect(republished).toBeDefined();
    expect(production.inspect().gpuOwnedSnapshotsMaterialized).toBe(2);
    production.dispose();
    availability.scene.dispose();
  });

  it('adapts the four existing Standard PBR groups from one receipt', () => {
    const groups = {
      view: { id: 'view' },
      material: { id: 'material' },
      mesh: { id: 'mesh' },
      instances: { id: 'instances' },
    } as unknown as {
      readonly view: BindGroup;
      readonly material: BindGroup;
      readonly mesh: BindGroup;
      readonly instances: BindGroup;
    };
    const result = adaptStandardPbrFrameResources({
      artifact: {
        material: 'forgeax::default-standard-pbr',
        pass: 'forward',
        program: createMaterialShaderProgram('standard-pbr'),
        layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
        bindings: [],
        deps: [],
        vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs.map((input) => ({ ...input })),
        receipt: STANDARD_PBR_RECEIPT,
      },
      ...groups,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entryPoint).toBe('vs_scene_index');
    expect(result.value.bindGroups).toEqual([
      groups.view,
      groups.material,
      groups.mesh,
      groups.instances,
    ]);
    expect(result.value.resourceSlots).toEqual(STANDARD_PBR_RECEIPT.resourceSlots);
  });

  it('projects aligned multi-batch compute work into one indirect raster pass', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const viewUniform = device
      .createBuffer({ size: 784, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const viewBindGroup = device
      .createBindGroup({
        layout: viewLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: viewUniform } } }],
      })
      .unwrap();
    const first = preparedPbrFixture(snapshot(1, 3));
    const firstDraw = first.gpuDrivenDraws?.[0];
    expect(firstDraw).toBeDefined();
    if (firstDraw === undefined) return;
    const second = { ...preparedPbrFixture(snapshot(2, 4)), worldId: 1 };
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
    const delta = projection.apply(renderables.map((renderable) => updateSnapshot(renderable)));
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan()).toMatchObject({
      candidateCount: 3,
      visibleCapacity: 65,
      batches: [{ visibleBase: 0 }, { visibleBase: 64 }],
    });
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const meshes = new Map([
      [0, mesh(device)],
      [1, mesh(device, false)],
    ]);
    const prepared = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    expect(prepared.drawKeys).toEqual(
      new Set([
        gpuDrivenDrawKey(worldEntityKey(0, 1), -1, 0),
        gpuDrivenDrawKey(worldEntityKey(0, 1), -1, 1),
        gpuDrivenDrawKey(worldEntityKey(1, 2), 42, 0),
      ]),
    );
    expect(production.inspect()).toMatchObject({
      gpuOwnedSnapshotsMaterialized: 2,
      filteredPlanBuilds: 1,
      candidateUploadBytes: 912,
      batchUploadBytes: 64,
      viewBindGroupCreates: 1,
    });

    const stable = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(stable?.topologySignature).toBe(prepared.topologySignature);
    expect(production.inspect()).toMatchObject({
      gpuOwnedSnapshotsMaterialized: 0,
      filteredPlanBuilds: 0,
      candidateUploadBytes: 0,
      batchUploadBytes: 0,
      viewConstantsUploadBytes: 304,
      viewBindGroupCreates: 0,
      batchBindGroupCreates: 0,
      indirectDrawCount: 2,
    });

    // This mixed batch has no LOD relation. Camera movement updates view
    // constants while retaining the scene topology and candidate uploads.
    const movedCamera = {
      ...makeZeroCameraFallbackSnapshot(),
      position: vec3.create(0, 0, 6),
    };
    const moved = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: movedCamera,
        meshBySlot: meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(moved).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      candidateUploadBytes: 0,
      batchUploadBytes: 0,
    });
    if (moved === undefined) return;

    const pipelineLookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'pipeline');
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const gpu = moved.project(graph, 'rgba8unorm', 1).unwrap();
    const projectedPipelineLookups = pipelineLookup.mock.calls.length;
    expect(projectedPipelineLookups).toBeGreaterThan(0);
    const materialBindGroup = device.createBindGroupLayout({ entries: [] }).unwrap();
    const frameResources = {
      ...moved.standardPbrFrameResources,
      materialBindGroups: [
        device.createBindGroup({ layout: materialBindGroup, entries: [] }).unwrap(),
      ],
    };
    let activeFrameResources = frameResources;
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
        encode: ({ pass, resources }) =>
          gpu.encode(viewBindGroup, pass, resources, activeFrameResources),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes.at(-1)).toMatchObject({
      name: 'main',
      dependencies: ['gpu-driven.frustum-compact', 'gpu-driven.finalize-indirect'],
    });
    const encoder = device.createCommandEncoder({ label: 'gpu-driven-production' }).unwrap();
    compiled
      .execute({
        viewBindGroup,
        encoder,
        gpuDrivenStandardPbrFrameResources: frameResources,
      } as unknown as RenderPipelineFrame)
      .unwrap();
    encoder.finish().unwrap();
    expect(pipelineLookup).toHaveBeenCalledTimes(projectedPipelineLookups);
    expect(device.framePassNames).toEqual([
      'gpu-driven.view-reset',
      'gpu-driven.frustum-compact',
      'gpu-driven.finalize-indirect',
      'main',
    ]);
    expect(device.totalDispatchCount).toBe(3);
    expect(device.totalDrawCount).toBe(2);
    expect(production.inspect().indirectDrawCount).toBe(2);
    expect(production.inspect().indirectDrawCount).toBeLessThanOrEqual(
      production.inspect().batchCount,
    );

    const missingMaterialFrameResources = {
      ...frameResources,
      materialBindGroups: [undefined] as unknown as typeof frameResources.materialBindGroups,
    };
    activeFrameResources = missingMaterialFrameResources;
    const missingMaterialEncoder = device
      .createCommandEncoder({ label: 'gpu-driven-production-missing-material' })
      .unwrap();
    const missingMaterialResult = compiled.execute({
      viewBindGroup,
      encoder: missingMaterialEncoder,
      gpuDrivenStandardPbrFrameResources: missingMaterialFrameResources,
    } as unknown as RenderPipelineFrame);
    expect(missingMaterialResult.ok).toBe(false);
    if (!missingMaterialResult.ok) {
      expect(missingMaterialResult.error.code).toBe('pass-encode-failed');
      const detail = missingMaterialResult.error.detail;
      expect(detail).toBeDefined();
      expect(detail !== undefined && 'cause' in detail).toBe(true);
      if (detail === undefined || !('cause' in detail)) return;
      expect(detail.cause).toBeInstanceOf(RhiError);
      expect((detail.cause as RhiError).code).toBe('rhi-not-available');
    }
    expect(pipelineLookup).toHaveBeenCalledTimes(projectedPipelineLookups);
    pipelineLookup.mockRestore();

    // The facet projection is the same admission set consumed by the GPU
    // candidate upload. A suppressed entity must disappear from the indirect
    // plan without making the remaining entity fall back to CPU validation.
    const activeOnly = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: movedCamera,
        meshBySlot: meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,

        activeEntityKeys: new Set([worldEntityKey(0, 1)]),
        activeEntityRevision: 1,
      })
      .unwrap();
    expect(activeOnly?.drawKeys?.size).toBe(3);
    expect(activeOnly?.ownsAllDrawItems).toBe(true);

    const changedActive = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: movedCamera,
        meshBySlot: meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,

        activeEntityKeys: new Set([worldEntityKey(1, 2)]),
        activeEntityRevision: 2,
      })
      .unwrap();
    expect(changedActive?.drawKeys?.size).toBe(3);
    // A changed admission revision only rewrites dirty suppression words; the
    // filtered plan and its per-frame build counter stay untouched.
    expect(production.inspect().filteredPlanBuilds).toBe(0);
    expect(production.inspect().suppressionUploadBytes).toBeGreaterThan(0);

    const replacement = GpuScene.create(device, 2).unwrap();
    expect(replacement.status).toBe('available');
    if (replacement.status !== 'available') return;
    replacement.scene.sync(delta).unwrap();
    const replacementPrepared = production
      .prepare({
        ...pbrInputs,
        scene: {
          scene: replacement.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(replacementPrepared?.topologySignature).not.toBe(prepared.topologySignature);

    production.dispose();
    replacement.scene.dispose();
    availability.scene.dispose();
  });

  it('keeps an ineligible production topology empty while the camera moves', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const base = snapshot(1, 3);
    const material = {
      ...base.material,
      materialShaderId: 'forgeax::default-standard-pbr',
    };
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot({ ...base, material, materials: [material] })]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const input = {
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      meshBySlot: new Map([[0, mesh(device)]]),
      viewBindGroupLayout: viewLayout,
    } as const;

    expect(
      production
        .prepare({
          ...input,
          camera: makeZeroCameraFallbackSnapshot(),
          meshResidencyEpoch: 1,
        })
        .unwrap(),
    ).toBeUndefined();
    expect(production.inspect().filteredPlanBuilds).toBe(0);
    expect(
      production
        .prepare({
          ...input,
          camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 6) },
          meshResidencyEpoch: 2,
        })
        .unwrap(),
    ).toBeUndefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      gpuOwnedSnapshotsMaterialized: 0,
      gpuOwnedEntityCount: 0,
    });

    production.dispose();
    availability.scene.dispose();
  });

  it('preserves texture specialization through Renderer assembly and its PSO cache', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      {
        shaderManifestUrl: manifestDataUrl(`/* f_schlick( */ ${OUTPUT_TRANSFORM_WGSL}`, true),
      },
    );
    const pipelines = vi.spyOn(renderer.device, 'createRenderPipeline');
    try {
      expect((await renderer.initialization).ok).toBe(true);
      const world = new World();
      expect(renderer.attach(world)).toMatchObject({ ok: true });
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();
      for (const values of [
        {},
        { normalTexture: { texture: '11111111-1111-1111-1111-111111111111' } },
      ]) {
        const material = world.allocSharedRef(
          'MaterialAsset',
          Materials.standard({
            baseColor: [1, 1, 1, 1],
            renderState: { blend: { color: {}, alpha: {} } },
            ...values,
          }),
        );
        world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
      }
      for (let frame = 0; frame < 4; frame += 1) {
        world.update(1 / 60).unwrap();
        expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })).toMatchObject({
          ok: true,
        });
        await Promise.resolve();
      }
      const specialized = () =>
        pipelines.mock.calls
          .map(([descriptor]) => descriptor.fragment?.constants?.['64000'])
          .filter((value) => value !== undefined);
      expect(specialized()).toEqual(expect.arrayContaining([0, 4]));
      const count = specialized().length;
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })).toMatchObject({
        ok: true,
      });
      expect(specialized()).toHaveLength(count);
    } finally {
      pipelines.mockRestore();
      renderer.dispose();
    }
  });

  it('preserves color writes and polygon bias through Renderer assembly and cache reuse', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      {
        shaderManifestUrl: manifestDataUrl(`/* f_schlick( */ ${OUTPUT_TRANSFORM_WGSL}`, true),
      },
    );
    const pipelines = vi.spyOn(renderer.device, 'createRenderPipeline');
    try {
      expect((await renderer.initialization).ok).toBe(true);
      const world = new World();
      expect(renderer.attach(world)).toMatchObject({ ok: true });
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();
      for (const renderState of [
        { colorWriteMask: 0, depthBias: -2, depthBiasSlopeScale: -1, depthBiasClamp: -0.1 },
        { colorWriteMask: 5, depthBias: 2, depthBiasSlopeScale: 1, depthBiasClamp: 0.1 },
      ]) {
        const material = world.allocSharedRef(
          'MaterialAsset',
          Materials.standard({
            baseColor: [1, 1, 1, 1],
            renderState,
          }),
        );
        world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
      }
      for (let frame = 0; frame < 4; frame += 1) {
        world.update(1 / 60).unwrap();
        expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })).toMatchObject({
          ok: true,
        });
        await Promise.resolve();
      }
      const specialized = () =>
        pipelines.mock.calls
          .map(([descriptor]) => descriptor)
          .filter((descriptor) =>
            descriptor.fragment?.targets.some((target) => target?.writeMask !== undefined),
          );
      expect(specialized()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fragment: expect.objectContaining({
              targets: expect.arrayContaining([expect.objectContaining({ writeMask: 0 })]),
            }),
            depthStencil: expect.objectContaining({
              depthBias: 2,
              depthBiasSlopeScale: 1,
              depthBiasClamp: 0.1,
            }),
          }),
          expect.objectContaining({
            fragment: expect.objectContaining({
              targets: expect.arrayContaining([expect.objectContaining({ writeMask: 5 })]),
            }),
            depthStencil: expect.objectContaining({
              depthBias: -2,
              depthBiasSlopeScale: -1,
              depthBiasClamp: -0.1,
            }),
          }),
        ]),
      );
      const count = specialized().length;
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })).toMatchObject({
        ok: true,
      });
      expect(specialized()).toHaveLength(count);
    } finally {
      pipelines.mockRestore();
      renderer.dispose();
    }
  });

  it('keeps an ordinary mesh on the common CPU residual while the Standard graph stays active', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      { shaderManifestUrl: manifestDataUrl() },
    );
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
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 1] } },
        { component: PointLight, data: {} },
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
      expect.arrayContaining(['cluster-membership-producer', 'main', 'output-transform']),
    );
    expect(renderer.perFramePassNames).toContain('output-transform');
    // Storage-buffer LDR frames keep the scene linear until the one output
    // transform writes the encoded surface. The ordinary unprepared mesh
    // remains the CPU residual under common visibility projection, while the
    // clustered Standard graph and output transform stay active.
    expect(device.totalDrawCount).toBe(2);
    expect(renderer.inspect().lodOcclusion).toMatchObject({
      fallback: { active: false },
      degradation: { active: false },
      pagePressure: { used: 0, capacity: 3 * 4096 },
    });
    expect(renderer.renderScene).toMatchObject({
      worldEntitiesScanned: 0,
      fullRebuilds: 1,
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
        cpuFallbackDrawItems: 1,
      },
    });
    renderer.dispose();
  });

  it('keeps a stable multi-World composition resident and patches one World transform', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      { shaderManifestUrl: manifestDataUrl() },
    );
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
      gpuDriven: { cpuFallbackDrawItems: 1, validatedGpuOwnedRows: 0 },
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

  it('routes mixed ordinary camera and light edits through common visibility projection', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      { shaderManifestUrl: manifestDataUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    expect(renderer.attach(world).ok).toBe(true);
    const camera = world
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
    const lamp = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 1] } },
        { component: PointLight, data: { intensity: 1, range: 10 } },
      )
      .unwrap();
    const updateVisibility = vi.spyOn(PersistentRenderScene.prototype, 'updateVisibilityFacet');
    const projectVisibility = vi.spyOn(PersistentRenderScene.prototype, 'projectVisibility');
    try {
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
      const warmUpdateCalls = updateVisibility.mock.calls.length;
      const warmProjectCalls = projectVisibility.mock.calls.length;
      const before = renderer.inspect().renderScene;

      world.set(camera, Transform, { pos: [0, 1, 5] }).unwrap();
      world.set(lamp, PointLight, { intensity: 3, range: 8 }).unwrap();
      propagateTransforms(world).unwrap();
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);

      expect(updateVisibility.mock.calls.length).toBeGreaterThan(warmUpdateCalls);
      expect(projectVisibility.mock.calls.length).toBeGreaterThan(warmProjectCalls);
      const after = renderer.inspect().renderScene;
      expect(after).toMatchObject({
        fullRebuilds: 1,
        projectionRecords: before.projectionRecords,
      });
      expect(after.topology.revision).toBe(before.topology.revision);
    } finally {
      updateVisibility.mockRestore();
      projectVisibility.mockRestore();
      renderer.dispose();
    }
  });

  it('admits prepared Alpha Mask draws to the GPU shadow lane', () => {
    const source = preparedSnapshot(10, 3);
    const alphaMaterial = {
      ...source.material,
      paramSnapshot: { alphaCutoff: 0.5 },
      textureHandles: new Map([['baseColorTexture', 1]]) as never,
      samplerHandles: new Map([['baseColorTexture', 2]]) as never,
    } as MaterialSnapshot;
    const draw = source.gpuDrivenDraws?.[0];
    expect(draw?.prepared).toBeDefined();
    if (draw === undefined || draw.prepared === undefined) return;

    // Alpha Mask is a prepared material fact: it keeps the opaque depth
    // state, carries an authored cutoff, and owns the base-color resource
    // needed by the shadow fragment discard. Alpha Blend is covered by the
    // adjacent residual-lane regression and must remain CPU-owned.
    expect(
      shadowCasterCpuReason(
        alphaMaterial,
        draw,
        [{ materialShaderId: 'forgeax::default-shadow-caster' } as DispatchEntry],
        undefined,
        undefined,
      ),
    ).toBeUndefined();

    const projection = new RenderScene();
    projection.apply([
      updateSnapshot({ ...source, material: alphaMaterial, materials: [alphaMaterial] }),
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan()).toMatchObject({
      candidateCount: 1,
      batches: [{ key: { admission: 'alpha-mask' } }],
    });
  });

  it('does not admit Alpha Blend or CPU transmission draw plans as GPU-owned', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const meshLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } }],
      })
      .unwrap();
    const instancesLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: 0x1, buffer: { type: 'read-only-storage' } },
        ],
      })
      .unwrap();
    const pbrPipelineLayout = device
      .createPipelineLayout({
        bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instancesLayout],
      })
      .unwrap();
    const opaque = preparedSnapshot(1, 3);
    const blendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } as const;
    const alphaMaterial = {
      ...opaque.material,
      renderState: { cullMode: 'none' as const, blend: blendState, depthWriteEnabled: false },
    } as MaterialSnapshot;
    const alphaSnapshots = [2, 3].map(
      (entityKey): RenderableSnapshot => ({
        ...preparedSnapshot(entityKey, 3),
        material: alphaMaterial,
        materials: [alphaMaterial],
        gpuDrivenDraws: [],
      }),
    );
    const transmissionMaterial = {
      ...opaque.material,
      paramSnapshot: { transmission: 0.5 },
    } as MaterialSnapshot;
    const transmissionSnapshot: RenderableSnapshot = {
      ...preparedSnapshot(4, 3),
      material: transmissionMaterial,
      materials: [transmissionMaterial],
    };
    const sceneProjection = new RenderScene();
    const delta = sceneProjection.apply([
      updateSnapshot(opaque),
      ...alphaSnapshots.map((snapshot) => updateSnapshot(snapshot)),
      updateSnapshot(transmissionSnapshot),
    ]);
    const availability = GpuScene.create(device, 3).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(sceneProjection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const artifact = {
      material: 'forgeax::default-standard-pbr',
      pass: 'forward',
      program: createMaterialShaderProgram('synthetic'),
      layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
      bindings: [],
      deps: [],
      vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs as unknown as readonly Readonly<
        Record<string, unknown>
      >[],
      receipt: STANDARD_PBR_RECEIPT,
    };
    const programKey = standardPbrProgramKey(artifact.material);
    expect(programKey).toBeDefined();
    if (programKey === undefined) return;
    const prepared = production.prepare({
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: sceneProjection.slotsSnapshot(),
        slotAt: sceneProjection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map([[0, mesh(device)]]),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,

      standardPbrArtifact: artifact,
      standardPbrPipelineState: {
        pbrPipelineLayout,
        meshBindGroupLayout: meshLayout,
        instancesBindGroupLayout: instancesLayout,
        gpuDrivenInstancesBindGroupLayout: instancesLayout,
        gpuDrivenPbrPipelineLayout: pbrPipelineLayout,
        standardPbrShaderModule: shader,
        gpuDrivenPbrPrograms: new Map([[programKey, { module: shader, artifact }]]),
      } as never,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value?.drawKeys).toEqual(new Set(['1:-1:0']));
    expect(prepared.value?.ownsAllDrawItems).toBe(false);
    production.dispose();
    availability.scene.dispose();
  });

  it('retains shadow topology across main-view binding changes and refreshes shadow dependencies', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const delta = projection.apply([1, 2].map((key) => updateSnapshot(preparedSnapshot(key, 3))));
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const input = {
      ...pbrInputs,
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map([
        [0, mesh(device)],
        [1, mesh(device)],
      ]),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,
      shadowCasterDrawKeys: new Set(['1:-1:0:0', '2:-1:0:0']),
      materialBindingClasses: new Map([['0:1:-1', 'forward|probe:first']]),
    } as { -readonly [K in keyof PrepareInput]: PrepareInput[K] } & typeof pbrInputs & {
        meshResidencyEpoch: number;
      };
    const identity = { kind: 'directional' as const, index: 0 };
    const planes = new Float32Array(24);
    const prepare = () => {
      const frame = production.prepare(input).unwrap();
      if (frame === undefined) throw new Error('expected prepared shadow frame');
      expect(
        frame.updateShadowViews?.([{ identity, planes, candidatePrimitiveIndices: [0, 1] }]).ok,
      ).toBe(true);
      // Settled casters live in the view's static layer.
      const submission = frame.shadowViewPool?.submission({ ...identity, layer: 'static' });
      if (submission === undefined) throw new Error('expected shadow submission');
      return { frame, submission };
    };
    // The first population starts in the static layer.
    let first = prepare();
    for (
      let frame = 0;
      frame <= SHADOW_CASTER_SETTLE_FRAMES + SHADOW_CASTER_PROMOTE_WINDOW &&
      first.submission.plan.candidateCount < 2;
      frame += 1
    ) {
      first.frame._commitResourceReplacement();
      first = prepare();
    }
    expect(first.submission.plan.candidateCount).toBe(2);
    first.frame._commitResourceReplacement();

    // Main-view probe membership changes while the shadow camera also moves.
    input.materialBindingClasses = new Map([['0:2:-1', 'forward|probe:second']]);
    planes[3] = 0.5;
    const rotated = prepare();
    // The main-view filter rebuilds this frame; the shadow plan stays retained.
    expect(production.inspect().filteredPlanBuilds).toBe(1);
    expect(rotated.submission.plan).toBe(first.submission.plan);
    expect(rotated.submission.view.inspect()).toMatchObject({
      candidateUploadBytes: 0,
      batchUploadBytes: 0,
      viewConstantsUploadBytes: 304,
    });
    expect(rotated.frame.shadowDrawKeys).toEqual(input.shadowCasterDrawKeys);
    rotated.frame._commitResourceReplacement();

    // A re-published snapshot re-derives preparation without changing what
    // the shadow views draw; the retained static layer stays a cache hit.
    projection.apply([updateSnapshot(preparedSnapshot(1, 3))]);
    input.scene = {
      ...input.scene,
      slots: projection.slotsSnapshot(),
      slotAt: projection.slotAt,
    } as typeof input.scene;
    const reslotted = prepare();
    expect(reslotted.submission.plan).toBe(rotated.submission.plan);
    expect(
      reslotted.frame.shadowViewPool
        ?.inspect()
        .find((view) => view.identity.kind === 'directional' && view.identity.layer === 'static')
        ?.cache,
    ).toBe('hit');
    reslotted.frame._commitResourceReplacement();

    // The skin fallback is re-resolved every frame as a fresh object with the
    // same program; object identity alone keeps the static layer cached.
    const skin = input.standardPbrArtifact;
    if (skin === undefined) throw new Error('expected material artifact');
    const reresolved = () => {
      input.materialSkinArtifact = { ...skin };
      return prepare();
    };
    const resolved = reresolved();
    resolved.frame._commitResourceReplacement();
    const reresolvedAgain = reresolved();
    expect(reresolvedAgain.submission.plan).toBe(resolved.submission.plan);
    expect(
      reresolvedAgain.frame.shadowViewPool
        ?.inspect()
        .find((view) => view.identity.kind === 'directional' && view.identity.layer === 'static')
        ?.cache,
    ).toBe('hit');
    reresolvedAgain.frame._commitResourceReplacement();

    input.shadowCasterDrawKeys = new Set(['2:-1:0:0']);
    const membership = prepare();
    expect(membership.submission.plan).not.toBe(rotated.submission.plan);
    expect(membership.submission.plan.candidateCount).toBe(1);
    expect(membership.frame.shadowDrawKeys).toEqual(new Set(['2:-1:0:0']));
    membership.frame._commitResourceReplacement();

    const artifact = input.standardPbrArtifact;
    if (artifact === undefined) throw new Error('expected material artifact');
    input.standardPbrArtifact = {
      ...artifact,
      program: createMaterialShaderProgram('republished program'),
    };
    const material = prepare();
    expect(material.submission.plan).not.toBe(membership.submission.plan);
    expect(material.submission.plan.candidateCount).toBe(1);
    material.frame._commitResourceReplacement();

    input.meshResidencyEpoch += 1;
    const resident = prepare();
    expect(resident.submission.plan).not.toBe(material.submission.plan);
    expect(resident.submission.plan.candidateCount).toBe(1);
    resident.frame._abortResourceReplacement?.();
    const retry = prepare();
    expect(retry.submission.view.inspect().candidateUploadBytes).toBeGreaterThan(0);
    expect(retry.frame.shadowDrawKeys).toEqual(new Set(['2:-1:0:0']));
    retry.frame._commitResourceReplacement();
    production.dispose();
    availability.scene.dispose();
  });

  it('projects concrete ShadowCaster candidates and leaves the CPU residual disjoint', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const meshLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } }],
      })
      .unwrap();
    const instancesLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: 0x1, buffer: { type: 'read-only-storage' } },
        ],
      })
      .unwrap();
    const pbrPipelineLayout = device
      .createPipelineLayout({
        bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instancesLayout],
      })
      .unwrap();
    const source = preparedSnapshot(1, 3);
    const firstDraw = source.gpuDrivenDraws?.[0];
    expect(firstDraw).toBeDefined();
    if (firstDraw === undefined) return;
    const firstPrepared = firstDraw.prepared;
    expect(firstPrepared).toBeDefined();
    if (firstPrepared === undefined) return;
    const blendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } as const;
    const residualMaterial = {
      ...source.material,
      materialHandle: 22,
      transparent: true,
      renderState: { cullMode: 'none' as const, blend: blendState, depthWriteEnabled: false },
    } as MaterialSnapshot;
    const residualDraw = {
      ...firstDraw,
      first: 3,
      materialSlot: 1,
      materialResourceClass: 'alpha-blend',
      prepared: { ...firstPrepared, first: 3 },
    };
    const mixed = {
      ...source,
      materials: [source.material, residualMaterial],
      gpuDrivenDraws: [firstDraw, residualDraw],
    } as RenderableSnapshot;
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(mixed)]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan()).toMatchObject({ candidateCount: 1 });
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const artifact = {
      material: 'forgeax::default-standard-pbr',
      pass: 'forward',
      program: createMaterialShaderProgram('synthetic'),
      layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
      bindings: [],
      deps: [],
      vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs as unknown as readonly Readonly<
        Record<string, unknown>
      >[],
      receipt: STANDARD_PBR_RECEIPT,
    };
    const programKey = standardPbrProgramKey(artifact.material);
    expect(programKey).toBeDefined();
    if (programKey === undefined) return;
    const entity = worldEntityKey(mixed.worldId, mixed.entityKey);
    const gpuKey = gpuDrivenShadowDrawKey(entity, -1, 0, 0);
    const residualKey = gpuDrivenShadowDrawKey(entity, 22, 1, 0);
    const allShadowKeys = new Set([gpuKey, residualKey]);
    const prepareFrame = () =>
      production
        .prepare({
          scene: {
            scene: availability.scene,
            plan: topology.plan(),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([[0, mesh(device)]]),
          viewBindGroupLayout: viewLayout,
          meshResidencyEpoch: 1,
          standardPbrArtifact: artifact,
          standardPbrPipelineState: {
            pbrPipelineLayout,
            meshBindGroupLayout: meshLayout,
            instancesBindGroupLayout: instancesLayout,
            gpuDrivenInstancesBindGroupLayout: instancesLayout,
            gpuDrivenPbrPipelineLayout: pbrPipelineLayout,
            standardPbrShaderModule: shader,
            gpuDrivenPbrPrograms: new Map([[programKey, { module: shader, artifact }]]),
          } as never,
          shadowCasterDrawKeys: allShadowKeys,
        })
        .unwrap();
    const prepared = prepareFrame();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const claimed = new Set(prepared.shadowDrawKeys ?? []);
    expect([...claimed]).toEqual([gpuKey]);
    expect(prepared.ownsAllShadowCasters).toBe(false);
    const residual = [...allShadowKeys].filter((key) => !claimed.has(key));
    expect(residual).toEqual([residualKey]);
    expect([...new Set([...claimed, ...residual])].sort()).toEqual([...allShadowKeys].sort());
    const identity = { kind: 'directional' as const, index: 0 };
    const updated = prepared.updateShadowViews?.([{ identity, planes: new Float32Array(24) }]);
    expect(updated?.ok).toBe(true);
    expect(production.inspect().channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewPass: 'directional-shadow',
          lane: 'blocked',
          reason: 'shadow-ownership',
          drawCount: 1,
          failure: expect.objectContaining({
            code: 'shadow-ownership',
            detail: expect.objectContaining({
              owner: 'shadow',
              reason: 'shadow-ownership-missing',
              recovery: 'route-cpu-lane',
            }),
          }),
        }),
      ]),
    );
    expect(shadowCandidateCount(prepared.shadowViewPool, identity)).toBe(1);
    const resumed = prepareFrame();
    expect(resumed?.updateShadowViews?.([{ identity, planes: new Float32Array(24) }]).ok).toBe(
      true,
    );
    expect(
      production.inspect().channels.some((channel) => channel.viewPass === 'directional-shadow'),
    ).toBe(true);
    production.dispose();
    availability.scene.dispose();
  });

  it('claims exact ShadowCaster passes without swallowing residual or custom passes', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const meshLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } }],
      })
      .unwrap();
    const instancesLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: 0x1, buffer: { type: 'read-only-storage' } },
        ],
      })
      .unwrap();
    const pbrPipelineLayout = device
      .createPipelineLayout({
        bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instancesLayout],
      })
      .unwrap();
    const source = preparedSnapshot(7, 3);
    const firstDraw = source.gpuDrivenDraws?.[0];
    expect(firstDraw?.prepared).toBeDefined();
    if (firstDraw === undefined || firstDraw.prepared === undefined) return;
    const materials = [0, 1, 2].map((handle) => ({
      ...source.material,
      materialHandle: handle + 10,
    })) as MaterialSnapshot[];
    const draws = [
      { ...firstDraw, drawItemIndex: 0, materialSlot: 0, first: 0, count: 3 },
      {
        ...withoutPrepared(firstDraw),
        drawItemIndex: 1,
        materialSlot: 1,
        first: 3,
        count: 3,
      },
      { ...firstDraw, drawItemIndex: 2, materialSlot: 2, first: 6, count: 3 },
    ];
    const mixed: RenderableSnapshot = {
      ...source,
      material: materials[0] as MaterialSnapshot,
      materials,
      gpuDrivenDraws: draws,
    };
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(mixed)]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan().candidateCount).toBe(3);
    const entity = worldEntityKey(mixed.worldId, mixed.entityKey);
    const membership: ShadowCasterMembership[] = [
      {
        worldEntity: entity,
        renderableIndex: 0,
        drawItemIndex: 0,
        materialHandle: 10,
        passIndex: 0,
        materialShaderId: 'forgeax::default-shadow-caster',
      },
      {
        worldEntity: entity,
        renderableIndex: 0,
        drawItemIndex: 1,
        materialHandle: 11,
        passIndex: 0,
        materialShaderId: 'forgeax::default-shadow-caster',
      },
      {
        worldEntity: entity,
        renderableIndex: 0,
        drawItemIndex: 2,
        materialHandle: 12,
        passIndex: 0,
        materialShaderId: 'forgeax::default-shadow-caster',
      },
      {
        worldEntity: entity,
        renderableIndex: 0,
        drawItemIndex: 2,
        materialHandle: 12,
        passIndex: 7,
        materialShaderId: 'custom-shadow-caster',
      },
    ];
    const allKeys = new Set(
      membership.map((entry) =>
        gpuDrivenShadowDrawKey(
          entry.worldEntity,
          entry.materialHandle,
          entry.drawItemIndex,
          entry.passIndex,
        ),
      ),
    );
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const artifact = {
      material: 'forgeax::default-standard-pbr',
      pass: 'forward',
      program: createMaterialShaderProgram('synthetic'),
      layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
      bindings: [],
      deps: [],
      vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs as unknown as readonly Readonly<
        Record<string, unknown>
      >[],
      receipt: STANDARD_PBR_RECEIPT,
    };
    const programKey = standardPbrProgramKey(artifact.material);
    expect(programKey).toBeDefined();
    if (programKey === undefined) return;
    const multiMesh = {
      ...mesh(device),
      submeshes: [0, 1, 2].map((materialSlot) => ({
        indexOffset: materialSlot * 3,
        indexCount: 3,
        vertexCount: 3,
        materialSlot,
        topology: 'triangle-list' as const,
      })),
    };
    const prepared = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([[0, multiMesh]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,

        standardPbrArtifact: artifact,
        standardPbrPipelineState: {
          pbrPipelineLayout,
          meshBindGroupLayout: meshLayout,
          instancesBindGroupLayout: instancesLayout,
          gpuDrivenInstancesBindGroupLayout: instancesLayout,
          gpuDrivenPbrPipelineLayout: pbrPipelineLayout,
          standardPbrShaderModule: shader,
          gpuDrivenPbrPrograms: new Map([[programKey, { module: shader, artifact }]]),
        } as never,
        shadowCasterDrawKeys: allKeys,
        shadowCasterMembership: membership,
      })
      .unwrap();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const gpuKey = gpuDrivenShadowDrawKey(entity, 10, 0, 0);
    expect([...(prepared.shadowDrawKeys ?? [])]).toEqual([gpuKey]);
    expect(prepared.ownsAllShadowCasters).toBe(false);
    const residual = [...allKeys].filter((key) => !prepared.shadowDrawKeys?.has(key));
    expect(residual).toHaveLength(3);
    expect(new Set([...(prepared.shadowDrawKeys ?? []), ...residual])).toEqual(allKeys);
    const identity = { kind: 'directional' as const, index: 0 };
    expect(prepared.updateShadowViews?.([{ identity, planes: new Float32Array(24) }]).ok).toBe(
      true,
    );
    expect(shadowCandidateCount(prepared.shadowViewPool, identity)).toBe(1);
    expect(prepared.shadowDrawKeysByView?.get('directional:0:')).toEqual(new Set([gpuKey]));
    production.dispose();
    availability.scene.dispose();
  });

  it.each([false, true])('prepares off-camera CPU shadow materials (main rows=%s)', (withMain) => {
    const material = { ...preparedSnapshot(1, 3).material, materialHandle: 42 };
    const shadow = {
      source: { ...preparedSnapshot(1, 3), material, materials: [material] },
      renderableIndex: 0,
    } as never;
    const main = { source: preparedSnapshot(2, 3), renderableIndex: 0 } as never;
    const plan = buildDispatchPlan({} as never, withMain ? [main] : [], [], [], [shadow]);
    expect(plan.shadowValidatedOrdered).toEqual([shadow]);
    const slot = plan.materialSlots.indexOf(material);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(plan.materialSlotOwners[slot]).toBe(shadow);
    const dispatch = {
      renderableIndex: 0,
      materialHandle: 42,
      materialShaderId: 'forgeax::default-standard-pbr',
      tags: { LightMode: 'ShadowCaster' },
    };
    const map = shadowShaderMap({ ...plan, shadowDispatch: [dispatch] } as never);
    expect(map.get(0)?.get(42)?.[0]?.materialSlot).toBe(slot);
  });

  it.each([
    false,
    true,
  ])('records exact CPU residuals with authored state (skinned=%s)', async (skinned) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const source = preparedSnapshot(8, 3);
    const firstDraw = source.gpuDrivenDraws?.[0];
    expect(firstDraw?.prepared).toBeDefined();
    if (firstDraw === undefined || firstDraw.prepared === undefined) return;
    const materials = [0, 1, 2].map((handle) => ({
      ...source.material,
      materialHandle: handle + 20,
    })) as MaterialSnapshot[];
    const draws = [
      { ...firstDraw, drawItemIndex: 0, materialSlot: 0, first: 0, count: 3 },
      { ...firstDraw, drawItemIndex: 1, materialSlot: 1, first: 3, count: 3 },
      { ...firstDraw, drawItemIndex: 2, materialSlot: 2, first: 6, count: 3 },
    ];
    const sourceForRecord: RenderableSnapshot = {
      ...source,
      ...(skinned ? { skin: { buffer: {} as never, byteOffset: 0 } as never } : {}),
      material: materials[0] as MaterialSnapshot,
      materials,
      gpuDrivenDraws: draws,
    };
    const geometry = {
      ...mesh(device),
      submeshes: [0, 1, 2].map((materialSlot) => ({
        indexOffset: materialSlot * 3,
        indexCount: 3,
        vertexCount: 3,
        materialSlot,
        topology: 'triangle-list' as const,
      })),
    };
    const identityInstanceBuffer = device
      .createBuffer({ size: 64, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const instancesBindGroupLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: 'uniform' } },
          { binding: 1, visibility: 0x1, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const worldEntity = worldEntityKey(sourceForRecord.worldId, sourceForRecord.entityKey);
    const claimedKey = gpuDrivenShadowDrawKey(worldEntity, 20, 0, 0);
    const residualKeys = new Set([
      gpuDrivenShadowDrawKey(worldEntity, 21, 1, 0),
      gpuDrivenShadowDrawKey(worldEntity, 22, 2, 0),
      gpuDrivenShadowDrawKey(worldEntity, 22, 2, 7),
    ]);
    const shadowDispatches = new Map([
      [
        0,
        new Map([
          [
            20,
            [
              {
                passIndex: 0,
                materialHandle: 20,
                vertexEntry: undefined,
                fragmentEntry: undefined,
                materialShaderId: 'forgeax::default-shadow-caster',
                renderState: undefined,
                materialSlot: 0,
                paramSnapshot: materials[0]?.paramSnapshot,
              },
            ],
          ],
          [
            21,
            [
              {
                passIndex: 0,
                materialHandle: 21,
                vertexEntry: undefined,
                fragmentEntry: undefined,
                materialShaderId: 'forgeax::default-shadow-caster',
                renderState: undefined,
                materialSlot: 1,
                paramSnapshot: materials[1]?.paramSnapshot,
              },
            ],
          ],
          [
            22,
            [
              {
                passIndex: 0,
                materialHandle: 22,
                vertexEntry: undefined,
                fragmentEntry: undefined,
                materialShaderId: 'forgeax::default-shadow-caster',
                renderState: undefined,
                materialSlot: 2,
                paramSnapshot: materials[2]?.paramSnapshot,
              },
              {
                passIndex: 7,
                materialHandle: 22,
                vertexEntry: undefined,
                fragmentEntry: undefined,
                materialShaderId: 'custom-shadow-caster',
                renderState: { cullMode: 'none' as const, frontFace: 'cw' as const },
                materialSlot: 2,
                paramSnapshot: materials[2]?.paramSnapshot,
              },
            ],
          ],
        ]),
      ],
    ]);
    const indexedDraws: number[][] = [];
    const pipelineRequests: unknown[][] = [];
    const pass = {
      setPipeline: () => undefined,
      setVertexBuffer: () => undefined,
      setIndexBuffer: () => undefined,
      setBindGroup: () => undefined,
      drawIndexed: (...args: number[]) => indexedDraws.push(args),
      draw: () => undefined,
    } as unknown as RhiRenderPassEncoder;
    const context = {
      runtime: {
        device,
        getMaterialShaderPipeline: (...args: unknown[]) => {
          pipelineRequests.push(args);
          return {} as never;
        },
      },
      pipelineState: {
        identityInstanceBuffer,
        pbrSkinMeshBindGroupLayout: {} as never,
        skinPaletteAllocator: { bindingWindowBytes: 256 },
        instancesBindGroupLayout,
        materialBindGroupLayout: {} as never,
        materialUniformBuffer: { buffer: {} as never, sizeInBytes: 256 },
        meshStorageBuffer: { buffer: {} as never, sizeInBytes: 256 },
        defaultSampler: {} as never,
        fallbackTextureView: {} as never,
        defaultNormalTextureView: {} as never,
        defaultWhiteTextureView: {} as never,
        skylightFallback: {
          irradianceView: {} as never,
          prefilterView: {} as never,
          brdfLutView: {} as never,
          sampler: {} as never,
          intensityBuffer: {} as never,
        },
      },
      validatedOrdered: [
        {
          source: sourceForRecord,
          mesh: geometry,
          renderableIndex: 0,
        },
      ],
      frameState: {
        instanceBuffers: new Map(),
        meshBindGroupCache: new Map(),
        instancesBgPerEntity: new Map(),
        shadowMaterialBindGroups: new WeakMap(),
        materialBgShared: new Map(),
      },
      materialBgAssemblyCache: new Map(),
      store: { materialResourceEpoch: 0 } as never,
      world: new World(),
      bindGroupCounts: { createBindGroup: 0, keys: [] },
      dispatch: [],
      // Stands in for the persistent scene owner, the only bounds source.
      shadowCasterBounds: (source: RenderableSnapshot) => {
        if (source.localAabb === undefined) return undefined;
        const bounds = box3.transformBox3(box3.create(), source.localAabb, source.transform.world);
        return {
          min: [bounds[0], bounds[1], bounds[2]],
          max: [bounds[3], bounds[4], bounds[5]],
        };
      },
    } as never;
    const recorded = recordShadowCasterDraws(
      context,
      pass,
      {} as never,
      {} as never,
      new Set([0]),
      new Map([[0, new Set([20, 21, 22])]]),
      shadowDispatches,
      new Set([claimedKey]),
    );
    expect(indexedDraws).toHaveLength(3);
    expect(recorded).toEqual(residualKeys);
    expect(recorded.has(claimedKey)).toBe(false);
    const authored = pipelineRequests.find((args) => args[0] === 'custom-shadow-caster');
    expect(authored).toBeDefined();
    expect(authored?.[2]).toEqual({ cullMode: 'none', frontFace: 'cw' });
    expect(authored?.[15]).toBe(skinned ? 'pbr-skin' : 'pbr');
    if (skinned) expect(authored?.[5]).toContain('SKINNING_DISABLED=false');

    sourceForRecord.transform.world[12] = 100;
    indexedDraws.length = 0;
    const culled = recordShadowCasterDraws(
      context,
      pass,
      {} as never,
      {} as never,
      new Set([0]),
      new Map([[0, new Set([20, 21, 22])]]),
      shadowDispatches,
      new Set([claimedKey]),
      false,
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    );
    expect(indexedDraws).toHaveLength(skinned ? 3 : 0);
    expect(culled).toEqual(skinned ? residualKeys : new Set());
  });

  it('fails closed at every shadow front door when expected casters lack bind groups', () => {
    const membership: ShadowCasterMembership[] = [
      {
        worldEntity: 1,
        renderableIndex: 0,
        drawItemIndex: 0,
        materialHandle: 20,
        passIndex: 0,
        materialShaderId: 'forgeax::default-shadow-caster',
        cpuReason: 'unprepared',
      },
    ];
    const context = {
      runtime: {
        device: { caps: { storageBuffer: false } },
        getMaterialShaderPipeline: () => null,
      },
      pipelineState: { perPassResources: { shadowSampler: null } },
      frameState: {
        pointShadowSnapshots: [{ shadowAtlasLayer: 0 }],
        spotShadowSnapshots: [{ shadowAtlasTile: 0, lightViewProj: new Float32Array(16) }],
      },
      dispatch: [],
      shadowCasterMembership: membership,
    } as never;
    const pass = {} as RhiRenderPassEncoder;
    const calls = [
      () => encodeDirectionalShadowPass(context, pass, 0),
      () => encodePointShadowPass(context, pass, 0, 0),
      () => encodeSpotShadowPass(context, pass, 0),
    ];
    for (const call of calls) {
      expect(call).toThrowError(RhiError);
      try {
        call();
      } catch (error) {
        expect(error).toBeInstanceOf(RhiError);
        expect((error as RhiError).code).toBe('rhi-not-available');
      }
    }
  });

  it('labels a prepared-contract admission rejection for the CPU residual', () => {
    const source = preparedSnapshot(9, 3);
    const draw = source.gpuDrivenDraws?.[0];
    expect(draw?.prepared).toBeDefined();
    if (draw === undefined || draw.prepared === undefined) return;
    const mismatched = {
      ...draw,
      prepared: {
        ...draw.prepared,
        identity: {
          ...draw.prepared.identity,
          material: 'forgeax::pbr-skin' as const,
          deformation: 'skin' as const,
        },
      },
    };
    const material = {
      ...source.material,
      materialShaderId: 'forgeax::default-standard-pbr',
    } as MaterialSnapshot;
    expect(
      shadowCasterCpuReason(
        material,
        mismatched,
        [
          {
            entityIndex: source.entityKey,
            materialHandle: material.materialHandle ?? -1,
            renderableIndex: 0,
            passIndex: 0,
            queue: 2000,
            layer: 0,
            tags: { LightMode: 'ShadowCaster' },
            renderState: undefined,
            defines: undefined,
            vertexEntry: undefined,
            fragmentEntry: undefined,
            materialShaderId: 'forgeax::default-shadow-caster',
            paramSnapshot: undefined,
          } as DispatchEntry,
        ],
        undefined,
        undefined,
      ),
    ).toBe('prepared-contract');
  });
});
