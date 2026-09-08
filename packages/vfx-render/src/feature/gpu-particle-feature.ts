import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { frustum } from '@forgeax/engine-math';
import type { RenderFeature, RenderFeaturePlan } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { err, type MaterialAsset, type MeshAsset, ok } from '@forgeax/engine-types';
import type { ParticleRendererSource } from '@forgeax/engine-vfx';
import {
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  type VfxGpuTickIntent,
} from '@forgeax/engine-vfx';
import { RenderFeatureStageFailedError } from '../../../render/src/errors/render';
import { RENDER_FEATURE_VERTEX_LAYOUTS } from '../../../render/src/features/prepared-graphics';
import type { VfxDataInterfaceRegistry } from '../host/data-interface-providers.js';
import type { ParticleRenderCamera } from './camera.js';
import {
  encodeEventInputs,
  eventCapacity,
  eventInputCapacity,
  VFX_EVENT_BYTES,
  VFX_EVENT_INPUT_BYTES,
} from './event-resources.js';
import {
  canonicalMeshVertices,
  createTopologyResourcePlan,
  PARTICLE_SHADER_IDENTIFIERS,
  particleMaterialPass,
  particleMaterialSceneDepthBinding,
  particleMaterialUsesBindings,
} from './particle-resources.js';
import type { VfxStagePlanObservation, VfxValidatedStagePlan } from './stage-plan.js';
import { validatedStagePlan } from './stage-plan.js';

const IDENTITY = 'forgeax.vfx-render.gpu-particles';
const WORKGROUP_SIZE = 256;
const PARTICLE_BYTES = 80;
const BILLBOARD_INSTANCE_BYTES = 31 * 4;
const MESH_INSTANCE_BYTES = 28 * 4;
const COUNTERS_BYTES = 24;
const RUNTIME_BYTES = 72 * 4;
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

type ParticleRendererKind = ParticleRendererSource['kind'];
type ParticleTopologyRenderer = Extract<ParticleRendererSource, { readonly capacity: number }>;
type ParticleTopologyKind = ParticleTopologyRenderer['kind'];
type VfxStageOutput = VfxStagePlanObservation['stageOutput'];

interface VfxRenderStageState {
  readonly stageOutput: VfxStageOutput;
}

interface VfxRenderInspectSnapshot extends VfxRenderStageState {
  readonly topology: ParticleRendererKind;
  readonly counters: {
    readonly capacity: number;
    readonly produced: number;
    readonly dropped: number;
  };
  readonly stageReadiness: readonly unknown[];
  readonly providerReadiness: unknown;
  readonly gpuTiming: unknown;
}

export interface VfxRenderInspectInput {
  readonly topology: ParticleRendererKind;
  readonly capacity: number;
  readonly produced: number;
  readonly dropped: number;
  readonly stageReadiness: readonly unknown[];
  readonly stageOutput?: VfxStageOutput;
  readonly providerReadiness: unknown;
  readonly gpuTiming: unknown;
}

export function createVfxRenderInspectSnapshot(
  input: VfxRenderInspectInput,
): VfxRenderInspectSnapshot {
  return {
    topology: input.topology,
    counters: { capacity: input.capacity, produced: input.produced, dropped: input.dropped },
    stageReadiness: input.stageReadiness,
    stageOutput: input.stageOutput ?? 'empty',
    providerReadiness: input.providerReadiness,
    gpuTiming: input.gpuTiming,
  } as const;
}

export interface BillboardAdvancedSample {
  readonly age: number;
  readonly lifetime: number;
  readonly particleDepth: number;
  readonly sceneDepth: number;
  readonly depthAvailable: boolean;
}

export function resolveBillboardAdvancedState(
  renderer: Extract<ParticleRendererSource, { readonly kind: 'billboard' }>,
  sample: BillboardAdvancedSample,
) {
  if (renderer.softParticle !== undefined && !sample.depthAvailable) {
    return err({
      code: 'vfx-renderer-depth-missing' as const,
      expected: 'a scene-depth provider for soft particles',
      hint: 'attach the scene-depth data interface or disable soft particles',
      detail: { path: 'renderer.softParticle' },
    });
  }
  const sheet = renderer.textureSheet;
  const frameCount = sheet?.frameCount ?? (sheet === undefined ? 1 : sheet.columns * sheet.rows);
  const frameIndex =
    sheet === undefined || sheet.frameRate === 0
      ? 0
      : Math.min(
          frameCount - 1,
          Math.max(0, Math.floor(Math.max(0, sample.age) * sheet.frameRate)),
        );
  const softParticleFade =
    renderer.softParticle === undefined
      ? 1
      : Math.max(
          0,
          Math.min(
            1,
            (sample.sceneDepth - sample.particleDepth) / renderer.softParticle.fadeDistance,
          ),
        );
  return ok({
    frameIndex,
    pivot: renderer.pivot ?? ([0, 0] as const),
    softParticleFade,
    sortingKey: renderer.sorting === 'back-to-front' ? sample.particleDepth : 0,
  });
}

export function topologyRecoveryHint(
  topology: ParticleTopologyKind,
  reason: 'capacity' | 'broken' | 'degenerate' | 'device',
): string {
  if (reason === 'capacity')
    return `${topology} capacity overflow was bounded; increase its explicit capacity`;
  if (reason === 'broken')
    return `${topology} continuity broke; inspect its explicit source key and keep the last valid segment`;
  if (reason === 'degenerate')
    return `${topology} produced no drawable segment; preserve zero output and inspect source endpoints`;
  return `${topology} device resources recovered from the last known good generation`;
}

interface GpuParticleFeatureOptions {
  readonly camera: { read(world: World): ParticleRenderCamera | undefined };
  readonly dataInterfaces?: Pick<VfxDataInterfaceRegistry, 'resolve'>;
  readonly material?: { read(world: World, guid: string): MaterialAsset | undefined };
  readonly mesh?: { read(world: World, guid: string): MeshAsset | undefined };
  readonly playerConsumption?: {
    readonly isEnabled: (world: World, player: EntityHandle) => boolean;
  };
}

interface ExtractedWorld {
  readonly world: World;
  readonly runtime: VfxGpuRuntime;
  readonly camera: ParticleRenderCamera;
  readonly intents: readonly VfxGpuTickIntent[];
}

interface ExtractedFrame {
  readonly worlds: readonly ExtractedWorld[];
  readonly frameNumber: number;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function vector(value: unknown, fallback: readonly number[], size: number): readonly number[] {
  return Array.isArray(value)
    ? Array.from({ length: size }, (_, index) => finite(value[index], fallback[index] ?? 0))
    : fallback;
}

function runtimeData(
  intent: VfxGpuTickIntent,
  camera: ParticleRenderCamera,
  material: MaterialAsset | undefined,
  localToWorld: Float32Array,
  renderer?: ParticleRendererSource,
  rendererIndex = 0,
): Uint8Array {
  const storage = new ArrayBuffer(RUNTIME_BYTES);
  const floats = new Float32Array(storage);
  const words = new Uint32Array(storage);
  floats[0] = intent.fixedDelta;
  words[1] = intent.phaseTick;
  words[2] = intent.seed;
  words[3] = intent.playCycle;
  words[4] = intent.emitter.capacity;
  words[5] = intent.spawnCount;
  words[6] = intent.firstParticleId;
  words[7] = intent.emitter.renderers.length;
  floats.set(camera.viewProjection, 8);
  floats.set(camera.right, 24);
  floats.set(camera.up, 28);
  const values = material?.values ?? {};
  floats.set(vector(values.baseColor, [1, 1, 1, 1], 4), 32);
  const emissive = vector(values.emissive, [0, 0, 0], 3);
  floats.set(emissive, 36);
  floats[39] = finite(values.emissiveIntensity, 0);
  floats[40] = finite(values.metallic, 0);
  floats[41] = finite(values.roughness, 0.5);
  floats[42] = finite(values.clearcoat, 0);
  floats[43] = finite(values.clearcoatRoughness, 0.5);
  floats.set(localToWorld, 44);
  words[60] = rendererIndex;
  words[61] = renderer?.kind === 'trail' ? renderer.historyLength : 0;
  words[62] =
    renderer?.kind === 'ribbon' || renderer?.kind === 'trail' || renderer?.kind === 'beam'
      ? renderer.capacity
      : intent.emitter.capacity;
  words[63] =
    renderer?.kind === 'billboard' && renderer.sorting === 'back-to-front'
      ? 2
      : renderer?.kind === 'billboard' && renderer.sorting === 'emitter'
        ? 1
        : 0;
  floats[64] =
    renderer?.kind === 'billboard'
      ? (renderer.pivot?.[0] ?? 0)
      : renderer?.kind === 'ribbon' || renderer?.kind === 'trail' || renderer?.kind === 'beam'
        ? (renderer.width ?? 0.1)
        : 0.1;
  floats[65] = renderer?.kind === 'billboard' ? (renderer.pivot?.[1] ?? 0) : 0;
  floats[66] = renderer?.kind === 'billboard' ? (renderer.softParticle?.fadeDistance ?? 0) : 0;
  const sheet = renderer?.kind === 'billboard' ? renderer.textureSheet : undefined;
  floats[68] = sheet?.columns ?? 1;
  floats[69] = sheet?.rows ?? 1;
  floats[70] = sheet?.frameRate ?? 0;
  floats[71] = sheet?.frameCount ?? (sheet === undefined ? 1 : sheet.columns * sheet.rows);
  return new Uint8Array(storage);
}

function emitterTransform(world: World, intent: VfxGpuTickIntent): Float32Array {
  if (intent.emitter.space === 'world') return IDENTITY_MATRIX;
  const transform = world.get(intent.player, Transform);
  return transform.ok ? transform.value.world : IDENTITY_MATRIX;
}

function emitterVisible(
  intent: VfxGpuTickIntent,
  camera: ParticleRenderCamera,
  localToWorld: Float32Array,
): boolean {
  const bounds = intent.emitter.bounds;
  const center =
    bounds.kind === 'sphere'
      ? bounds.center
      : ([
          (bounds.min[0] + bounds.max[0]) * 0.5,
          (bounds.min[1] + bounds.max[1]) * 0.5,
          (bounds.min[2] + bounds.max[2]) * 0.5,
        ] as const);
  const radius =
    bounds.kind === 'sphere'
      ? bounds.radius
      : Math.hypot(
          (bounds.max[0] - bounds.min[0]) * 0.5,
          (bounds.max[1] - bounds.min[1]) * 0.5,
          (bounds.max[2] - bounds.min[2]) * 0.5,
        );
  const matrix = (index: number): number => localToWorld[index] ?? 0;
  const worldCenter = new Float32Array([
    matrix(0) * center[0] + matrix(4) * center[1] + matrix(8) * center[2] + matrix(12),
    matrix(1) * center[0] + matrix(5) * center[1] + matrix(9) * center[2] + matrix(13),
    matrix(2) * center[0] + matrix(6) * center[1] + matrix(10) * center[2] + matrix(14),
  ]);
  const scale = Math.max(
    Math.hypot(matrix(0), matrix(1), matrix(2)),
    Math.hypot(matrix(4), matrix(5), matrix(6)),
    Math.hypot(matrix(8), matrix(9), matrix(10)),
  );
  const planes = frustum.fromViewProjection(frustum.create(), camera.viewProjection);
  return frustum.intersectsSphere(planes, worldCenter, radius * scale);
}

function resetData(size: number): Uint8Array {
  return new Uint8Array(size);
}

function requiresSceneDepth(intent: VfxGpuTickIntent): boolean {
  return (intent.emitter.reflection.dataInterfaces ?? []).some(
    (requirement) => requirement.kind === 'scene-depth',
  );
}

function planFailure(): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(IDENTITY, -1, 'plan', 'next-frame');
}

type PlanResource = RenderFeaturePlan['resources'][number];
type PlanPass = RenderFeaturePlan['passes'][number];

function planName(value: string, maxLength = 24): string {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9.-]/g, '-');
  return (normalized.length === 0 ? 'unnamed' : normalized).slice(0, maxLength);
}

function computeBindingEntries(
  intent: VfxGpuTickIntent,
  resources: Readonly<Record<number, string>>,
): readonly { readonly binding: number; readonly resource: string }[] {
  const declared = new Set(
    (intent.emitter.reflection.bindings[0]?.entries ?? [])
      .filter((entry) => entry.buffer !== undefined)
      .map((entry) => entry.binding),
  );
  return Object.entries(resources).flatMap(([binding, resource]) =>
    declared.has(Number(binding)) ? [{ binding: Number(binding), resource }] : [],
  );
}

function simulationDispatches(
  intent: VfxGpuTickIntent,
  stages: VfxValidatedStagePlan,
): Extract<PlanPass, { readonly kind: 'compute' }>['dispatches'] {
  const groups = Math.max(1, Math.ceil(intent.emitter.capacity / WORKGROUP_SIZE));
  return [
    { kind: 'direct', entryPoint: 'forgeax_vfx_spawn_main', workgroups: [groups] },
    { kind: 'direct', entryPoint: 'forgeax_vfx_update_main', workgroups: [groups] },
    ...stages.stages.map((stage) => ({
      kind: 'direct' as const,
      entryPoint: stage.entryPoint,
      workgroups: [groups] as const,
    })),
    { kind: 'direct', entryPoint: 'forgeax_vfx_scan_blocks_main', workgroups: [groups] },
    { kind: 'direct', entryPoint: 'forgeax_vfx_scan_block_offsets_main', workgroups: [1] },
    { kind: 'direct', entryPoint: 'forgeax_vfx_add_offsets_main', workgroups: [groups] },
    { kind: 'direct', entryPoint: 'forgeax_vfx_compact_main', workgroups: [groups] },
    {
      kind: 'direct',
      entryPoint: 'forgeax_vfx_event_main',
      workgroups: [Math.max(1, Math.ceil(eventInputCapacity(intent.emitter) / 64))],
    },
  ];
}

export function gpuParticleRenderFeature(
  options: GpuParticleFeatureOptions,
): RenderFeature<ExtractedFrame> {
  return {
    identity: IDENTITY,
    requiredCapabilities: ['compute', 'indirectDrawing'],
    requiredMaterialShaders: Object.values(PARTICLE_SHADER_IDENTIFIERS),
    extract: (context) => {
      const extracted: ExtractedWorld[] = [];
      for (const world of context.worlds) {
        if (!world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)) continue;
        const camera = options.camera.read(world);
        if (camera === undefined) continue;
        const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
        const intents = runtime.snapshot().filter((intent) => {
          if (options.playerConsumption?.isEnabled(world, intent.player) === false) return false;
          const requirements = intent.emitter.reflection.dataInterfaces ?? [];
          return (
            requirements.length === 0 ||
            options.dataInterfaces?.resolve(requirements, intent.instanceGeneration).ok === true
          );
        });
        extracted.push({ world, runtime, camera, intents });
      }
      return ok({ worlds: extracted, frameNumber: context.frameNumber });
    },
    plan: (frame, context) => {
      const resources: PlanResource[] = [];
      const passes: PlanPass[] = [];
      const dispatchedIntents = new Set<VfxGpuTickIntent>();
      const colorTarget =
        context.targets.find((candidate) => candidate.kind === 'color') ??
        context.targets.find((candidate) => candidate.kind === 'swapchain');
      const depthTarget = context.targets.find((candidate) => candidate.kind === 'depth');

      for (const [worldIndex, entry] of frame.worlds.entries()) {
        for (const [intentIndex, intent] of entry.intents.entries()) {
          if (!entry.runtime.isEmitterSessionEnabled(intent.player, intent.emitter.id)) continue;
          const localToWorld = emitterTransform(entry.world, intent);
          const visible = emitterVisible(intent, entry.camera, localToWorld);
          entry.runtime.setEmitterCameraVisibility(intent.player, intent.emitter.id, visible);
          if (!visible) continue;
          if (requiresSceneDepth(intent) && depthTarget === undefined) continue;

          const stagePlan = validatedStagePlan(
            intent.emitter.reflection.stages,
            intent.instanceGeneration,
          );
          if (!stagePlan.ok) return err(planFailure());

          const prefix = `vfx.w-${worldIndex}.i-${intentIndex}.${planName(intent.emitter.id)}`;
          const program = `${prefix}.compute-program`;
          const particles = `${prefix}.particles`;
          const runtime = `${prefix}.runtime`;
          const aliveIndices = `${prefix}.alive-indices`;
          const counters = `${prefix}.counters`;
          const indirect = `${prefix}.indirect`;
          const scratch = `${prefix}.scratch`;
          const sharedInstances = `${prefix}.shared-instances`;
          const eventInputs = `${prefix}.event-inputs`;
          const events = `${prefix}.events`;
          const bindings = `${prefix}.simulation-bindings`;
          const capacity = intent.emitter.capacity;
          const renderers = intent.emitter.renderers;
          const meshes = renderers.map((renderer) =>
            renderer.kind === 'mesh' ? options.mesh?.read(entry.world, renderer.mesh) : undefined,
          );
          const indirectWords = new Uint32Array(Math.max(1, renderers.length) * 5);

          for (const [rendererIndex, renderer] of renderers.entries()) {
            const mesh = meshes[rendererIndex];
            const submesh =
              renderer.kind === 'mesh' ? mesh?.submeshes[renderer.submesh ?? 0] : undefined;
            if (renderer.kind === 'mesh' && submesh === undefined) return err(planFailure());
            if (
              (renderer.kind === 'ribbon' ||
                renderer.kind === 'trail' ||
                renderer.kind === 'beam') &&
              !createTopologyResourcePlan(renderer).ok
            ) {
              return err(planFailure());
            }
            indirectWords[rendererIndex * 5] =
              renderer.kind === 'mesh'
                ? mesh?.indices === undefined
                  ? (submesh?.vertexCount ?? 0)
                  : (submesh?.indexCount ?? 0)
                : 6;
            indirectWords[rendererIndex * 5 + 2] =
              renderer.kind === 'mesh' && mesh?.indices !== undefined
                ? (submesh?.indexOffset ?? 0)
                : 0;
          }

          const scratchBytes = (capacity * 2 + Math.ceil(capacity / WORKGROUP_SIZE)) * 4;
          const eventInputBytes = Math.max(
            4,
            eventInputCapacity(intent.emitter) * VFX_EVENT_INPUT_BYTES,
          );
          const eventBytes = Math.max(4, eventCapacity(intent.emitter) * VFX_EVENT_BYTES);
          resources.push(
            {
              kind: 'compute-program',
              name: program,
              program: {
                wgsl: intent.emitter.wgsl,
                entryPoints: intent.emitter.reflection.entryPoints,
                bindings: intent.emitter.reflection.bindings,
              },
            },
            {
              kind: 'buffer',
              name: particles,
              size: capacity * PARTICLE_BYTES,
              usage: ['storage'],
              ...(intent.reset ? { data: resetData(capacity * PARTICLE_BYTES) } : {}),
            },
            { kind: 'buffer', name: aliveIndices, size: capacity * 4, usage: ['storage'] },
            {
              kind: 'buffer',
              name: counters,
              size: COUNTERS_BYTES,
              usage: ['storage'],
              ...(intent.reset ? { data: resetData(COUNTERS_BYTES) } : {}),
            },
            {
              kind: 'buffer',
              name: indirect,
              size: indirectWords.byteLength,
              usage: ['storage', 'indirect'],
              data: indirectWords,
            },
            {
              kind: 'buffer',
              name: scratch,
              size: scratchBytes,
              usage: ['storage'],
              ...(intent.reset ? { data: resetData(scratchBytes) } : {}),
            },
            {
              kind: 'buffer',
              name: sharedInstances,
              size: capacity * Math.max(BILLBOARD_INSTANCE_BYTES, MESH_INSTANCE_BYTES),
              usage: ['storage', 'vertex'],
            },
            {
              kind: 'buffer',
              name: eventInputs,
              size: eventInputBytes,
              usage: ['storage'],
              data: encodeEventInputs(intent),
            },
            {
              kind: 'buffer',
              name: events,
              size: eventBytes,
              usage: ['storage'],
              ...(intent.reset ? { data: resetData(eventBytes) } : {}),
            },
            {
              kind: 'buffer',
              name: runtime,
              size: RUNTIME_BYTES,
              usage: ['uniform'],
              data: runtimeData(intent, entry.camera, undefined, localToWorld),
            },
            {
              kind: 'compute-bindings',
              name: bindings,
              program,
              entries: computeBindingEntries(intent, {
                0: particles,
                1: runtime,
                2: aliveIndices,
                3: counters,
                4: indirect,
                5: scratch,
                6: sharedInstances,
                8: eventInputs,
                9: events,
              }),
            },
          );

          const entryPoints = new Set(intent.emitter.reflection.entryPoints);
          const dispatches = simulationDispatches(intent, stagePlan.value).filter((dispatch) =>
            entryPoints.has(dispatch.entryPoint),
          );
          if (dispatches.length > 0) {
            passes.push({
              kind: 'compute',
              name: `${prefix}.simulate`,
              program,
              bindings,
              dispatches,
            });
            dispatchedIntents.add(intent);
          }

          for (const [rendererIndex, renderer] of renderers.entries()) {
            const rendererPrefix = `${prefix}.renderer-${rendererIndex}`;
            const isBillboard = renderer.kind === 'billboard';
            const isTopology =
              renderer.kind === 'ribbon' || renderer.kind === 'trail' || renderer.kind === 'beam';
            const topologyPlan = isTopology ? createTopologyResourcePlan(renderer) : undefined;
            if (topologyPlan !== undefined && !topologyPlan.ok) return err(planFailure());
            const material = options.material?.read(entry.world, renderer.material);
            const materialPass = particleMaterialPass(renderer.kind, material);
            const mesh = meshes[rendererIndex];
            const submesh =
              renderer.kind === 'mesh' ? mesh?.submeshes[renderer.submesh ?? 0] : undefined;
            const indexFormat = mesh?.indices instanceof Uint32Array ? 'uint32' : 'uint16';
            const sceneDepthBinding = isBillboard
              ? particleMaterialSceneDepthBinding(
                  context.materialShaderBindingContract?.(materialPass.shader) ??
                    (materialPass.shader === PARTICLE_SHADER_IDENTIFIERS.billboard
                      ? 'view-and-scene-depth'
                      : undefined),
                )
              : undefined;
            const instances = `${rendererPrefix}.instances`;
            const history = `${rendererPrefix}.history`;
            const projectionRuntime = `${rendererPrefix}.runtime`;
            const projectionBindings = `${rendererPrefix}.compute-bindings`;
            const vertexLayout = isBillboard
              ? RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance
              : isTopology
                ? RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentInstance
                : RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance;
            const instanceBytes = isTopology
              ? (topologyPlan?.value.vertexBytes ?? 16)
              : capacity * (isBillboard ? BILLBOARD_INSTANCE_BYTES : MESH_INSTANCE_BYTES);
            const historyBytes =
              renderer.kind === 'trail'
                ? Math.max(16, renderer.capacity * renderer.historyLength * 16)
                : 16;

            resources.push(
              {
                kind: 'buffer',
                name: instances,
                size: instanceBytes,
                usage: ['storage', 'vertex'],
              },
              {
                kind: 'buffer',
                name: history,
                size: historyBytes,
                usage: ['storage'],
                ...(intent.reset ? { data: resetData(historyBytes) } : {}),
              },
              {
                kind: 'buffer',
                name: projectionRuntime,
                size: RUNTIME_BYTES,
                usage: ['uniform'],
                data: runtimeData(
                  { ...intent, fixedDelta: 0, spawnCount: 0 },
                  entry.camera,
                  material,
                  localToWorld,
                  renderer,
                  rendererIndex,
                ),
              },
              {
                kind: 'compute-bindings',
                name: projectionBindings,
                program,
                entries: computeBindingEntries(intent, {
                  0: particles,
                  1: projectionRuntime,
                  2: aliveIndices,
                  3: counters,
                  4: indirect,
                  5: history,
                  6: instances,
                  8: eventInputs,
                  9: events,
                }),
              },
            );

            const projectionDispatches: Extract<
              PlanPass,
              { readonly kind: 'compute' }
            >['dispatches'][number][] = [];
            const pushProjection = (entryPoint: string, workgroups: number): void => {
              if (!entryPoints.has(entryPoint)) return;
              projectionDispatches.push({
                kind: 'direct',
                entryPoint,
                workgroups: [Math.max(1, workgroups)],
              });
            };
            if (isBillboard && renderer.sorting === 'back-to-front') {
              pushProjection('forgeax_vfx_sort_main', 1);
            }
            if (renderer.kind === 'trail') {
              pushProjection(
                'forgeax_vfx_trail_history_main',
                Math.ceil(renderer.capacity / WORKGROUP_SIZE),
              );
            }
            const projectionCount =
              renderer.kind === 'trail'
                ? renderer.capacity * Math.max(1, renderer.historyLength - 1)
                : isTopology
                  ? renderer.capacity
                  : capacity;
            pushProjection(
              renderer.kind === 'billboard'
                ? 'forgeax_vfx_billboard_main'
                : renderer.kind === 'mesh'
                  ? 'forgeax_vfx_mesh_main'
                  : `forgeax_vfx_${renderer.kind}_main`,
              Math.ceil(projectionCount / WORKGROUP_SIZE),
            );
            if (projectionDispatches.length > 0) {
              passes.push({
                kind: 'compute',
                name: `${rendererPrefix}.project`,
                program,
                bindings: projectionBindings,
                dispatches: projectionDispatches,
              });
            }

            const graphicsProgram = `${rendererPrefix}.graphics-program`;
            const graphicsBindings = `${rendererPrefix}.graphics-bindings`;
            const vertexData = `${rendererPrefix}.vertex-data`;
            const renderState =
              isBillboard && depthTarget !== undefined
                ? { ...(materialPass.renderState ?? {}), depthWriteEnabled: false }
                : materialPass.renderState;
            resources.push(
              {
                kind: 'graphics-program',
                name: graphicsProgram,
                program: {
                  shader: materialPass.shader,
                  vertexLayout,
                  colorFormats: [colorTarget?.format ?? 'rgba8unorm-srgb'],
                  ...(depthTarget === undefined ? {} : { depthFormat: depthTarget.format }),
                  sampleCount: colorTarget?.sampleCount ?? 1,
                  topology: submesh?.topology ?? 'triangle-list',
                  ...(mesh?.indices === undefined ? {} : { indexFormat }),
                  ...(renderState === undefined ? {} : { renderState }),
                },
              },
              {
                kind: 'graphics-bindings',
                name: graphicsBindings,
                program: graphicsProgram,
                values: {
                  group: 0,
                  runtime: projectionRuntime,
                  instances,
                  ...(sceneDepthBinding === undefined ? {} : { sceneDepthBinding }),
                },
                ...(sceneDepthBinding !== undefined && depthTarget !== undefined
                  ? { logicalTargets: { sceneDepth: depthTarget.name } }
                  : {}),
              },
              { kind: 'vertex-data', name: vertexData, layout: vertexLayout, buffer: instances },
            );
            const drawBindings = [graphicsBindings];
            if (particleMaterialUsesBindings(material)) {
              const materialBindings = `${rendererPrefix}.material-bindings`;
              resources.push({
                kind: 'graphics-bindings',
                name: materialBindings,
                program: graphicsProgram,
                values: {
                  group: 1,
                  material: { world: worldIndex, guid: renderer.material },
                },
              });
              drawBindings.push(materialBindings);
            }

            const vertexBindings: { readonly slot: number; readonly resource: string }[] = [];
            let indexData:
              | { readonly resource: string; readonly format: 'uint16' | 'uint32' }
              | undefined;
            if (renderer.kind === 'mesh') {
              if (mesh === undefined) return err(planFailure());
              const geometryBuffer = `${rendererPrefix}.geometry-buffer`;
              const geometry = `${rendererPrefix}.geometry`;
              const geometryData = canonicalMeshVertices(mesh);
              resources.push(
                {
                  kind: 'buffer',
                  name: geometryBuffer,
                  size: geometryData.byteLength,
                  usage: ['vertex'],
                  data: geometryData,
                },
                {
                  kind: 'vertex-data',
                  name: geometry,
                  layout: vertexLayout,
                  buffer: geometryBuffer,
                },
              );
              vertexBindings.push(
                { slot: 0, resource: geometry },
                { slot: 1, resource: vertexData },
              );
              if (mesh.indices !== undefined) {
                const indexBuffer = `${rendererPrefix}.index-buffer`;
                const indices = `${rendererPrefix}.indices`;
                resources.push(
                  {
                    kind: 'buffer',
                    name: indexBuffer,
                    size: mesh.indices.byteLength,
                    usage: ['index'],
                    data: mesh.indices,
                  },
                  {
                    kind: 'index-data',
                    name: indices,
                    format: indexFormat,
                    buffer: indexBuffer,
                  },
                );
                indexData = { resource: indices, format: indexFormat };
              }
            } else {
              vertexBindings.push({ slot: 0, resource: vertexData });
            }

            passes.push({
              kind: 'raster',
              name: `${rendererPrefix}.raster`,
              colorAttachments: [
                {
                  target: colorTarget?.name ?? 'swapchain',
                  loadOp: 'load',
                  storeOp: 'store',
                },
              ],
              ...(depthTarget === undefined
                ? {}
                : {
                    depthStencilAttachment: {
                      target: depthTarget.name,
                      depthLoadOp: 'load',
                      depthStoreOp: 'store',
                    },
                  }),
              ...(sceneDepthBinding !== undefined && depthTarget !== undefined
                ? { sampledTargets: [depthTarget.name] }
                : {}),
              draws: [
                {
                  program: graphicsProgram,
                  bindings: drawBindings,
                  vertexData: vertexBindings,
                  ...(indexData === undefined ? {} : { indexData }),
                  draw: {
                    kind: indexData === undefined ? 'draw-indirect' : 'draw-indexed-indirect',
                    resource: indirect,
                    offset: rendererIndex * 20,
                  },
                },
              ],
            });
          }
        }
      }
      for (const entry of frame.worlds) {
        for (const intent of entry.intents) {
          if (dispatchedIntents.has(intent)) {
            entry.runtime.markEventDispatched(intent.player, intent.eventCounters);
          }
        }
        const lastIntent = entry.intents.at(-1);
        if (lastIntent !== undefined) entry.runtime.commit(lastIntent.sequence);
      }
      return ok<RenderFeaturePlan>({ resources, passes });
    },
  };
}
