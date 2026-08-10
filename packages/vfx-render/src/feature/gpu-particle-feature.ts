import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { frustum } from '@forgeax/engine-math';
import {
  RENDER_FEATURE_VERTEX_LAYOUTS,
  type RenderFeature,
  type RenderFeatureDrawRecord,
  type RenderFeatureGpuBindingsRef,
  type RenderFeatureGpuBufferRef,
  type RenderFeatureGpuProgramRef,
  type RenderFeaturePreparationFailedError,
  RenderFeatureStageFailedError,
  type RenderFeatureTargetHandle,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { err, type MaterialAsset, type MeshAsset, ok } from '@forgeax/engine-types';
import {
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  type VfxGpuTickIntent,
} from '@forgeax/engine-vfx';
import type { ParticleRenderCamera } from './camera.js';
import {
  canonicalMeshVertices,
  PARTICLE_SHADER_IDENTIFIERS,
  particleMaterialPass,
  particleMaterialUsesBindings,
} from './particle-resources.js';

const IDENTITY = 'forgeax.vfx-render.gpu-particles';
const WORKGROUP_SIZE = 256;
const PARTICLE_BYTES = 80;
const BILLBOARD_INSTANCE_BYTES = 23 * 4;
const MESH_INSTANCE_BYTES = 28 * 4;
const RUNTIME_BYTES = 60 * 4;
const MAX_TICK_RINGS = 8;
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

interface GpuParticleFeatureOptions {
  readonly camera: { read(world: World): ParticleRenderCamera | undefined };
  readonly material?: { read(world: World, guid: string): MaterialAsset | undefined };
  readonly mesh?: { read(world: World, guid: string): MeshAsset | undefined };
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

interface GpuRefs {
  readonly program: RenderFeatureGpuProgramRef;
  readonly particles: RenderFeatureGpuBufferRef;
  readonly aliveIndices: RenderFeatureGpuBufferRef;
  readonly counters: RenderFeatureGpuBufferRef;
  readonly indirect: RenderFeatureGpuBufferRef;
  readonly scratch: RenderFeatureGpuBufferRef;
  readonly billboardInstances: RenderFeatureGpuBufferRef;
  readonly meshInstances: RenderFeatureGpuBufferRef;
}

interface TickRing {
  readonly runtime: RenderFeatureGpuBufferRef;
  readonly bindings: RenderFeatureGpuBindingsRef;
}

interface RendererProjection {
  readonly kind: 'billboard' | 'mesh';
  readonly ring: TickRing;
  readonly instances: RenderFeatureGpuBufferRef;
}

interface EmitterState {
  readonly world: World;
  readonly player: EntityHandle;
  readonly emitterId: string;
  readonly fingerprint: string;
  readonly capacity: number;
  readonly names: string;
  refs?: GpuRefs;
  rings: TickRing[];
  projections: RendererProjection[];
  colorTarget: RenderFeatureTargetHandle | undefined;
  depthTarget: RenderFeatureTargetHandle | undefined;
  indirectInitialized: boolean;
  culled: boolean;
  lastIntent?: VfxGpuTickIntent;
  draws: RenderFeatureDrawRecord[];
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
): Uint8Array {
  const storage = new ArrayBuffer(RUNTIME_BYTES);
  const floats = new Float32Array(storage);
  const words = new Uint32Array(storage);
  floats[0] = intent.fixedDelta;
  words[1] = intent.tick;
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

function target(
  targets: readonly RenderFeatureTargetHandle[],
  kind: 'scene-color' | 'scene-depth',
): RenderFeatureTargetHandle | undefined {
  return targets.find((entry) => entry.kind === kind);
}

export function gpuParticleRenderFeature(
  options: GpuParticleFeatureOptions,
): RenderFeature<ExtractedFrame> {
  const worldIds = new WeakMap<World, number>();
  let nextWorldId = 0;
  const states = new Map<string, EmitterState>();
  const keyOf = (world: World, intent: VfxGpuTickIntent): string => {
    let worldId = worldIds.get(world);
    if (worldId === undefined) {
      worldId = nextWorldId++;
      worldIds.set(world, worldId);
    }
    return `${worldId}:${intent.player}:${intent.emitter.id}`;
  };
  const stateFor = (world: World, intent: VfxGpuTickIntent): EmitterState => {
    const key = keyOf(world, intent);
    let state = states.get(key);
    if (state !== undefined && state.fingerprint !== intent.programFingerprint) {
      states.delete(key);
      state = undefined;
    }
    if (state !== undefined) return state;
    const fingerprint = intent.programFingerprint.slice(0, 12).replaceAll(':', '_');
    state = {
      world,
      player: intent.player,
      emitterId: intent.emitter.id,
      fingerprint: intent.programFingerprint,
      capacity: intent.emitter.capacity,
      names: `gpu.${key.replaceAll(':', '.')}.${fingerprint}`,
      rings: [],
      projections: [],
      draws: [],
      colorTarget: undefined,
      depthTarget: undefined,
      indirectInitialized: false,
      culled: false,
    };
    states.set(key, state);
    return state;
  };

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
        extracted.push({ world, runtime, camera, intents: runtime.snapshot() });
      }
      return ok({ worlds: extracted, frameNumber: context.frameNumber });
    },
    prepare: (frame, context) => {
      const gpu = context.gpu;
      if (gpu === undefined) {
        return err(new RenderFeatureStageFailedError(IDENTITY, -1, 'prepare', 'renderer-recover'));
      }
      // Kick every newly observed WGSL module before awaiting the next frame.
      // Shader-module creation is asynchronous in the browser RHI; returning on
      // the first pending module serialized effect startup across emitters and
      // could outlive a short authored burst on a slow runner.
      let pendingProgramError: RenderFeaturePreparationFailedError | undefined;
      for (const entry of frame.worlds) {
        for (const intent of entry.intents) {
          const state = stateFor(entry.world, intent);
          const program = gpu.prepareProgram(`${state.names}.program`, {
            wgsl: intent.emitter.wgsl,
            entryPoints: intent.emitter.reflection.entryPoints,
            bindings: intent.emitter.reflection.bindings,
          });
          if (program.ok) continue;
          if (
            program.error.code !== 'render-feature-preparation-failed' ||
            program.error.detail.recovery !== 'next-frame'
          ) {
            return program;
          }
          pendingProgramError ??= program.error;
        }
      }
      if (pendingProgramError !== undefined) return err(pendingProgramError);
      let pendingGraphicsError: RenderFeaturePreparationFailedError | undefined;
      for (const entry of frame.worlds) {
        for (const intent of entry.intents) {
          const state = stateFor(entry.world, intent);
          if (intent.reset) state.indirectInitialized = false;
          state.lastIntent = intent;
          const base = state.names;
          const program = gpu.prepareProgram(`${base}.program`, {
            wgsl: intent.emitter.wgsl,
            entryPoints: intent.emitter.reflection.entryPoints,
            bindings: intent.emitter.reflection.bindings,
          });
          if (!program.ok) return program;
          const prepare = (
            name: string,
            size: number,
            usage: readonly ('storage' | 'uniform' | 'indirect' | 'vertex')[],
            data?: ArrayBufferView,
          ) =>
            gpu.prepareBuffer(`${base}.${name}`, {
              size,
              usage,
              ...(data === undefined ? {} : { data }),
            });
          const particles = prepare(
            'particles',
            state.capacity * PARTICLE_BYTES,
            ['storage'],
            intent.reset ? resetData(state.capacity * PARTICLE_BYTES) : undefined,
          );
          if (!particles.ok) return particles;
          const aliveIndices = prepare('alive-indices', state.capacity * 4, ['storage']);
          if (!aliveIndices.ok) return aliveIndices;
          const counters = prepare(
            'counters',
            8,
            ['storage'],
            intent.reset ? resetData(8) : undefined,
          );
          if (!counters.ok) return counters;
          const indirect = prepare('indirect', Math.max(1, intent.emitter.renderers.length) * 20, [
            'storage',
            'indirect',
          ]);
          if (!indirect.ok) return indirect;
          const scratchBytes =
            (state.capacity * 2 + Math.ceil(state.capacity / WORKGROUP_SIZE)) * 4;
          const scratch = prepare(
            'scratch',
            scratchBytes,
            ['storage'],
            intent.reset ? resetData(scratchBytes) : undefined,
          );
          if (!scratch.ok) return scratch;
          const billboardInstances = prepare(
            'billboard-instances',
            state.capacity * BILLBOARD_INSTANCE_BYTES,
            ['storage', 'vertex'],
          );
          if (!billboardInstances.ok) return billboardInstances;
          const meshInstances = prepare('mesh-instances', state.capacity * MESH_INSTANCE_BYTES, [
            'storage',
            'vertex',
          ]);
          if (!meshInstances.ok) return meshInstances;
          state.refs = {
            program: program.value,
            particles: particles.value,
            aliveIndices: aliveIndices.value,
            counters: counters.value,
            indirect: indirect.value,
            scratch: scratch.value,
            billboardInstances: billboardInstances.value,
            meshInstances: meshInstances.value,
          };
          const ringIndex = intent.tick % MAX_TICK_RINGS;
          const runtime = gpu.prepareBuffer(`${base}.runtime.${ringIndex}`, {
            size: RUNTIME_BYTES,
            usage: ['uniform'],
            data: runtimeData(
              intent,
              entry.camera,
              undefined,
              emitterTransform(entry.world, intent),
            ),
          });
          if (!runtime.ok) return runtime;
          const refs = state.refs;
          const bindings = gpu.prepareBindings(`${base}.bindings.${ringIndex}`, {
            program: refs.program,
            entries: [
              { binding: 0, buffer: refs.particles },
              { binding: 1, buffer: runtime.value },
              { binding: 2, buffer: refs.aliveIndices },
              { binding: 3, buffer: refs.counters },
              { binding: 4, buffer: refs.indirect },
              { binding: 5, buffer: refs.scratch },
              { binding: 6, buffer: refs.billboardInstances },
              { binding: 7, buffer: refs.meshInstances },
            ],
          });
          if (!bindings.ok) return bindings;
          state.rings[ringIndex] = { runtime: runtime.value, bindings: bindings.value };
        }
      }

      for (const [key, state] of states) {
        const extracted = frame.worlds.find((entry) => entry.world === state.world);
        if (extracted === undefined || !extracted.runtime.hasPlayer(state.player)) {
          states.delete(key);
          continue;
        }
        const intent = state.lastIntent;
        const refs = state.refs;
        if (intent === undefined || refs === undefined) continue;
        const retained = gpu.retainBindings([
          ...state.rings.flatMap((ring) => (ring === undefined ? [] : [ring.bindings])),
          ...state.projections.map((projection) => projection.ring.bindings),
        ]);
        if (!retained.ok) return retained;
        const renderers = intent.emitter.renderers;
        if (renderers.length === 0) continue;
        const localToWorld = emitterTransform(state.world, intent);
        const visible = emitterVisible(intent, extracted.camera, localToWorld);
        extracted.runtime.setEmitterVisibility(state.player, state.emitterId, visible);
        const currentIntents = extracted.intents.filter(
          (candidate) =>
            candidate.player === state.player && candidate.emitter.id === state.emitterId,
        );
        if (!visible) {
          state.culled = true;
          state.projections = [];
          state.draws = [];
          continue;
        }
        if (
          state.culled &&
          intent.emitter.simulationWhenCulled === 'restart-on-visible' &&
          !currentIntents.some((candidate) => candidate.reset)
        ) {
          state.projections = [];
          state.draws = [];
          continue;
        }
        state.culled = false;
        const colorTarget = target(context.targets, 'scene-color');
        const depthTarget = target(context.targets, 'scene-depth');
        const meshes = renderers.map((renderer) =>
          renderer.kind === 'mesh' ? options.mesh?.read(state.world, renderer.mesh) : undefined,
        );
        if (
          renderers.some(
            (renderer, index) =>
              renderer.kind === 'mesh' &&
              meshes[index]?.submeshes[renderer.submesh ?? 0] === undefined,
          )
        ) {
          return err(new RenderFeatureStageFailedError(IDENTITY, -1, 'prepare', 'next-frame'));
        }
        const indirectWords = new Uint32Array(renderers.length * 5);
        for (const [index, renderer] of renderers.entries()) {
          const mesh = meshes[index];
          const submesh =
            renderer.kind === 'mesh' ? mesh?.submeshes[renderer.submesh ?? 0] : undefined;
          indirectWords[index * 5] =
            renderer.kind === 'billboard'
              ? 6
              : mesh?.indices === undefined
                ? (submesh?.vertexCount ?? 0)
                : (submesh?.indexCount ?? 0);
          indirectWords[index * 5 + 2] =
            renderer.kind === 'mesh' && mesh?.indices !== undefined
              ? (submesh?.indexOffset ?? 0)
              : 0;
        }
        const indirectInit = gpu.prepareBuffer(`${state.names}.indirect`, {
          size: Math.max(1, renderers.length) * 20,
          usage: ['storage', 'indirect'],
          ...(state.indirectInitialized ? {} : { data: indirectWords }),
        });
        if (!indirectInit.ok) return indirectInit;
        state.indirectInitialized = true;
        const draws: RenderFeatureDrawRecord[] = [];
        const projections: RendererProjection[] = [];
        for (const [rendererIndex, renderer] of renderers.entries()) {
          const isBillboard = renderer.kind === 'billboard';
          const mesh = meshes[rendererIndex];
          const submesh =
            renderer.kind === 'mesh' ? mesh?.submeshes[renderer.submesh ?? 0] : undefined;
          const indexFormat =
            mesh?.indices instanceof Uint32Array ? ('uint32' as const) : ('uint16' as const);
          const material = options.material?.read(state.world, renderer.material);
          const materialPass = particleMaterialPass(renderer.kind, material);
          const projectionInstances = gpu.prepareBuffer(
            `${state.names}.renderer.${rendererIndex}.instances`,
            {
              size: state.capacity * (isBillboard ? BILLBOARD_INSTANCE_BYTES : MESH_INSTANCE_BYTES),
              usage: ['storage', 'vertex'],
            },
          );
          if (!projectionInstances.ok) return projectionInstances;
          const projectionRuntime = gpu.prepareBuffer(
            `${state.names}.renderer.${rendererIndex}.runtime`,
            {
              size: RUNTIME_BYTES,
              usage: ['uniform'],
              data: runtimeData(
                { ...intent, fixedDelta: 0, spawnCount: 0 },
                extracted.camera,
                material,
                localToWorld,
              ),
            },
          );
          if (!projectionRuntime.ok) return projectionRuntime;
          const projectionBindings = gpu.prepareBindings(
            `${state.names}.renderer.${rendererIndex}.bindings`,
            {
              program: refs.program,
              entries: [
                { binding: 0, buffer: refs.particles },
                { binding: 1, buffer: projectionRuntime.value },
                { binding: 2, buffer: refs.aliveIndices },
                { binding: 3, buffer: refs.counters },
                { binding: 4, buffer: refs.indirect },
                { binding: 5, buffer: refs.scratch },
                {
                  binding: 6,
                  buffer: isBillboard ? projectionInstances.value : refs.billboardInstances,
                },
                {
                  binding: 7,
                  buffer: isBillboard ? refs.meshInstances : projectionInstances.value,
                },
              ],
            },
          );
          if (!projectionBindings.ok) return projectionBindings;
          projections.push({
            kind: renderer.kind,
            instances: projectionInstances.value,
            ring: { runtime: projectionRuntime.value, bindings: projectionBindings.value },
          });
          const pipeline = context.graphics.preparePipeline(
            `${state.names}.renderer.${rendererIndex}.${renderer.kind}.pipeline`,
            {
              shader: materialPass.shader,
              vertexLayout: isBillboard
                ? RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance
                : RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance,
              colorFormats: [colorTarget?.format ?? 'rgba8unorm-srgb'],
              ...(depthTarget === undefined ? {} : { depthFormat: depthTarget.format }),
              sampleCount: colorTarget?.sampleCount ?? 1,
              topology: submesh?.topology ?? 'triangle-list',
              ...(mesh?.indices === undefined ? {} : { indexFormat }),
              ...(materialPass.renderState !== undefined
                ? { renderState: materialPass.renderState }
                : isBillboard
                  ? {
                      renderState: {
                        cullMode: 'none',
                        depthCompare: 'less-equal',
                        depthWriteEnabled: renderer.blend === 'opaque-cutout',
                        ...(renderer.blend === 'opaque-cutout'
                          ? {}
                          : {
                              blend: {
                                color: {
                                  srcFactor: 'one',
                                  dstFactor:
                                    renderer.blend === 'additive' ? 'one' : 'one-minus-src-alpha',
                                  operation: 'add',
                                },
                                alpha: {
                                  srcFactor: 'one',
                                  dstFactor: 'one-minus-src-alpha',
                                  operation: 'add',
                                },
                              },
                            }),
                      },
                    }
                  : {}),
            },
          );
          if (!pipeline.ok) {
            if (
              pipeline.error.code !== 'render-feature-preparation-failed' ||
              pipeline.error.detail.recovery !== 'next-frame'
            ) {
              return pipeline;
            }
            pendingGraphicsError ??= pipeline.error;
            continue;
          }
          const graphicsBindings = context.graphics.prepareBindings(
            `${state.names}.renderer.${rendererIndex}.${renderer.kind}.binding`,
            {
              pipeline: pipeline.value,
              values: { group: 0 },
            },
          );
          if (!graphicsBindings.ok) return graphicsBindings;
          const materialBindings = !particleMaterialUsesBindings(material)
            ? undefined
            : context.graphics.prepareBindings(
                `${state.names}.renderer.${rendererIndex}.${renderer.kind}.material-binding`,
                {
                  pipeline: pipeline.value,
                  values: {
                    group: 1,
                    material: {
                      world: frame.worlds.findIndex((entry) => entry.world === state.world),
                      guid: renderer.material,
                    },
                  },
                },
              );
          if (materialBindings !== undefined && !materialBindings.ok) return materialBindings;
          const drawBindings = [
            graphicsBindings.value,
            ...(materialBindings === undefined ? [] : [materialBindings.value]),
          ];
          if (isBillboard) {
            const vertexData = context.graphics.prepareVertexData(
              `${state.names}.billboard.vertices`,
              {
                layout: RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance,
                buffer: projectionInstances.value,
              },
            );
            if (!vertexData.ok) return vertexData;
            draws.push({
              kind: 'draw-indirect',
              pipeline: pipeline.value,
              bindings: drawBindings,
              vertexData: [{ slot: 0, resource: vertexData.value }],
              command: { buffer: refs.indirect, offset: rendererIndex * 20 },
            });
            continue;
          }
          if (mesh === undefined) {
            return err(new RenderFeatureStageFailedError(IDENTITY, -1, 'prepare', 'next-frame'));
          }
          const geometryData = canonicalMeshVertices(mesh);
          const geometryBuffer = gpu.prepareBuffer(
            `${state.names}.renderer.${rendererIndex}.mesh.geometry-buffer`,
            {
              size: geometryData.byteLength,
              usage: ['vertex'],
              data: geometryData,
            },
          );
          if (!geometryBuffer.ok) return geometryBuffer;
          const geometry = context.graphics.prepareVertexData(
            `${state.names}.renderer.${rendererIndex}.mesh.geometry`,
            {
              layout: RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance,
              buffer: geometryBuffer.value,
            },
          );
          if (!geometry.ok) return geometry;
          const instances = context.graphics.prepareVertexData(
            `${state.names}.renderer.${rendererIndex}.mesh.instances`,
            {
              layout: RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance,
              buffer: projectionInstances.value,
            },
          );
          if (!instances.ok) return instances;
          const indexBuffer =
            mesh.indices === undefined
              ? undefined
              : gpu.prepareBuffer(`${state.names}.renderer.${rendererIndex}.mesh.index-buffer`, {
                  size: mesh.indices.byteLength,
                  usage: ['index'],
                  data: mesh.indices,
                });
          if (indexBuffer !== undefined && !indexBuffer.ok) return indexBuffer;
          const indices =
            indexBuffer === undefined
              ? undefined
              : context.graphics.prepareIndexData(
                  `${state.names}.renderer.${rendererIndex}.mesh.indices`,
                  {
                    format: indexFormat,
                    buffer: indexBuffer.value,
                  },
                );
          if (indices !== undefined && !indices.ok) return indices;
          draws.push(
            indices === undefined
              ? {
                  kind: 'draw-indirect',
                  pipeline: pipeline.value,
                  bindings: drawBindings,
                  vertexData: [
                    { slot: 0, resource: geometry.value },
                    { slot: 1, resource: instances.value },
                  ],
                  command: { buffer: refs.indirect, offset: rendererIndex * 20 },
                }
              : {
                  kind: 'draw-indexed-indirect',
                  pipeline: pipeline.value,
                  bindings: drawBindings,
                  vertexData: [
                    { slot: 0, resource: geometry.value },
                    { slot: 1, resource: instances.value },
                  ],
                  indexData: { resource: indices.value, format: indexFormat },
                  command: { buffer: refs.indirect, offset: rendererIndex * 20 },
                },
          );
        }
        state.projections = projections;
        state.draws = draws;
        state.colorTarget = colorTarget;
        state.depthTarget = depthTarget;
      }
      if (pendingGraphicsError !== undefined) return err(pendingGraphicsError);
      return ok(undefined);
    },
    contribute: (frame, context) => {
      for (const state of states.values()) {
        const refs = state.refs;
        const firstProjection = state.projections[0];
        if (refs === undefined) continue;
        const extracted = frame.worlds.find((entry) => entry.world === state.world);
        if (extracted === undefined) continue;
        const intents = extracted.intents.filter(
          (intent) => intent.player === state.player && intent.emitter.id === state.emitterId,
        );
        const groups = Math.ceil(state.capacity / WORKGROUP_SIZE);
        const dispatches = intents.flatMap((intent) => {
          const bindings = state.rings[intent.tick % MAX_TICK_RINGS]?.bindings;
          if (bindings === undefined) return [];
          return [
            { entryPoint: 'forgeax_vfx_spawn_main', workgroups: [groups] as const, bindings },
            { entryPoint: 'forgeax_vfx_update_main', workgroups: [groups] as const, bindings },
            { entryPoint: 'forgeax_vfx_scan_blocks_main', workgroups: [groups] as const, bindings },
            {
              entryPoint: 'forgeax_vfx_scan_block_offsets_main',
              workgroups: [1] as const,
              bindings,
            },
            { entryPoint: 'forgeax_vfx_add_offsets_main', workgroups: [groups] as const, bindings },
            { entryPoint: 'forgeax_vfx_compact_main', workgroups: [groups] as const, bindings },
          ];
        });
        for (const projection of state.projections) {
          dispatches.push({
            entryPoint:
              projection.kind === 'billboard'
                ? 'forgeax_vfx_billboard_main'
                : 'forgeax_vfx_mesh_main',
            workgroups: [groups],
            bindings: projection.ring.bindings,
          });
        }
        const passBindings =
          firstProjection?.ring.bindings ??
          intents
            .map((intent) => state.rings[intent.tick % MAX_TICK_RINGS]?.bindings)
            .find((bindings) => bindings !== undefined);
        if (passBindings === undefined || dispatches.length === 0) continue;
        const computePassIdentity = `${state.names}.simulate-and-project`;
        const compute = context.staging.addComputePass(computePassIdentity, {
          program: refs.program,
          bindings: passBindings,
          dispatches,
        });
        if (!compute.ok) return compute;
        if (state.draws.length > 0) {
          const draw = context.staging.addGraphicsPass(
            `${state.names}.draw`,
            {
              attachments: {
                colors: [
                  {
                    resource: state.colorTarget ?? 'swapchain',
                    format: state.colorTarget?.format ?? 'rgba8unorm-srgb',
                    loadOp: 'load',
                    storeOp: 'store',
                  },
                ],
                ...(state.depthTarget === undefined
                  ? {}
                  : {
                      depthStencil: {
                        resource: state.depthTarget,
                        format: state.depthTarget.format,
                        depthLoadOp: 'load' as const,
                        depthStoreOp: 'store' as const,
                      },
                    }),
              },
              draws: state.draws,
            },
            { dependsOn: [{ featureIdentity: IDENTITY, passIdentity: computePassIdentity }] },
          );
          if (!draw.ok) return draw;
        }
      }
      for (const entry of frame.worlds) {
        const last = entry.intents.at(-1);
        if (last !== undefined) entry.runtime.commit(last.sequence);
      }
      return ok(undefined);
    },
    recover: () => {
      for (const state of states.values()) {
        if (!state.world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)) continue;
        state.world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY).reset(state.player);
      }
      states.clear();
      return ok(undefined);
    },
    dispose: () => {
      states.clear();
      return ok(undefined);
    },
  };
}
