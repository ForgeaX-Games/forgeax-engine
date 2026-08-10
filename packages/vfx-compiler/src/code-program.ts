import { createHash } from 'node:crypto';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { compileShader } from '@forgeax/engine-shader-compiler';
import type { BindGroupLayoutDescriptor, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import {
  PARTICLE_CODE_DEFAULT_MODULE_ID,
  type ParticleCodeSourceError,
  type ParticleEmitterSourceV2,
  type ParticleRendererSource,
  parseParticleEffectSourceV2,
} from '@forgeax/engine-vfx';

export const PARTICLE_CODE_PROGRAM_FORMAT = 'forgeax-vfx-program-2' as const;
export const PARTICLE_CODE_PROGRAM_ARTIFACT_KEY = 'particle-effect/program.json' as const;

export const PARTICLE_CODE_PRELUDE_MODULE_ID = 'forgeax_vfx::prelude' as const;

export const PARTICLE_CODE_PRELUDE = `#define_import_path forgeax_vfx::prelude
struct VfxParticle {
  position: vec4<f32>,
  velocity: vec4<f32>,
  color: vec4<f32>,
  size_rotation: vec4<f32>,
  age: f32,
  lifetime: f32,
  alive: u32,
  id: u32,
}

struct VfxSpawnContext {
  delta: f32,
  tick: u32,
  seed: u32,
  playCycle: u32,
  particleId: u32,
}

struct VfxUpdateContext {
  delta: f32,
  tick: u32,
  seed: u32,
  playCycle: u32,
  particleId: u32,
}

fn vfx_hash(value: u32) -> u32 {
  var x = value;
  x = ((x >> 16u) ^ x) * 0x45d9f3bu;
  x = ((x >> 16u) ^ x) * 0x45d9f3bu;
  return (x >> 16u) ^ x;
}

fn vfx_random_words(seed: u32, particleId: u32, tick: u32, sampleKey: u32) -> f32 {
  let bits = vfx_hash(seed ^ vfx_hash(particleId) ^ vfx_hash(tick) ^ vfx_hash(sampleKey));
  return f32(bits) / 4294967295.0;
}

fn vfx_random_spawn(ctx: VfxSpawnContext, sampleKey: u32) -> f32 {
  return vfx_random_words(ctx.seed ^ ctx.playCycle, ctx.particleId, ctx.tick, sampleKey);
}

fn vfx_random_update(ctx: VfxUpdateContext, sampleKey: u32) -> f32 {
  return vfx_random_words(ctx.seed ^ ctx.playCycle, ctx.particleId, ctx.tick, sampleKey);
}

fn vfx_integrate(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let position = (*particle).position.xyz + (*particle).velocity.xyz * ctx.delta;
  (*particle).position = vec4<f32>(position, (*particle).position.w);
}
`;

export const PARTICLE_CODE_DEFAULT_MODULE = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).velocity = vec4<f32>(0.0, 0.8, 0.0, 0.0);
  (*particle).color = vec4<f32>(0.2, 0.6, 1.0, 1.0);
  (*particle).size_rotation = vec4<f32>(0.22, 0.22, 0.0, 0.0);
  (*particle).lifetime = 2.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity = vec4<f32>((*particle).velocity.xyz + vec3<f32>(0.0, -0.4, 0.0) * ctx.delta, 0.0);
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let size = mix(0.22, 0.04, life);
  (*particle).size_rotation = vec4<f32>(size, size, 0.0, 0.0);
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.2, 0.6, 1.0), vec3<f32>(0.05, 0.2, 1.0), life), 1.0 - life);
}`;

const REQUIRED_SPAWN =
  /\bfn\s+vfx_spawn\s*\(\s*\w+\s*:\s*VfxSpawnContext\s*,\s*\w+\s*:\s*ptr\s*<\s*function\s*,\s*VfxParticle\s*>\s*\)/;
const REQUIRED_UPDATE =
  /\bfn\s+vfx_update\s*\(\s*\w+\s*:\s*VfxUpdateContext\s*,\s*\w+\s*:\s*ptr\s*<\s*function\s*,\s*VfxParticle\s*>\s*\)/;
const RESERVED = /@(group|binding|compute|vertex|fragment)\b|\bfn\s+forgeax_vfx_/;

function wgslCode(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');
}

const MANAGED_RUNTIME = `
struct ForgeaxVfxRuntime {
  delta: f32,
  tick: u32,
  seed: u32,
  playCycle: u32,
  capacity: u32,
  spawnCount: u32,
  firstParticleId: u32,
  rendererCount: u32,
  viewProjection: mat4x4<f32>,
  cameraRight: vec4<f32>,
  cameraUp: vec4<f32>,
  baseColor: vec4<f32>,
  emissiveIntensity: vec4<f32>,
  surface: vec4<f32>,
  localToWorld: mat4x4<f32>,
}

struct ForgeaxVfxCounters {
  aliveCount: atomic<u32>,
  droppedCount: atomic<u32>,
}

struct ForgeaxVfxIndirect {
  vertexOrIndexCount: u32,
  instanceCount: u32,
  firstVertexOrIndex: u32,
  baseVertex: i32,
  firstInstance: u32,
}

@group(0) @binding(0) var<storage, read_write> forgeax_vfx_particles: array<VfxParticle>;
@group(0) @binding(1) var<uniform> forgeax_vfx_runtime: ForgeaxVfxRuntime;
@group(0) @binding(2) var<storage, read_write> forgeax_vfx_alive_indices: array<u32>;
@group(0) @binding(3) var<storage, read_write> forgeax_vfx_counters: ForgeaxVfxCounters;
@group(0) @binding(4) var<storage, read_write> forgeax_vfx_indirect: array<ForgeaxVfxIndirect>;
@group(0) @binding(5) var<storage, read_write> forgeax_vfx_scratch: array<u32>;
@group(0) @binding(6) var<storage, read_write> forgeax_vfx_billboard_instances: array<f32>;
@group(0) @binding(7) var<storage, read_write> forgeax_vfx_mesh_instances: array<f32>;

@compute @workgroup_size(256)
fn forgeax_vfx_spawn_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= forgeax_vfx_runtime.capacity) { return; }
  if (forgeax_vfx_scratch[index] == 0u) {
    let deadRank = index - forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + index];
    if (deadRank < forgeax_vfx_runtime.spawnCount) {
      var particle = VfxParticle(
        vec4<f32>(0.0, 0.0, 0.0, 1.0),
        vec4<f32>(0.0),
        vec4<f32>(1.0),
        vec4<f32>(1.0, 1.0, 0.0, 0.0),
        0.0,
        1.0,
        1u,
        forgeax_vfx_runtime.firstParticleId + deadRank,
      );
      let ctx = VfxSpawnContext(
        forgeax_vfx_runtime.delta,
        forgeax_vfx_runtime.tick,
        forgeax_vfx_runtime.seed,
        forgeax_vfx_runtime.playCycle,
        particle.id,
      );
      vfx_spawn(ctx, &particle);
      forgeax_vfx_particles[index] = particle;
      forgeax_vfx_scratch[index] = 1u;
    }
  }
  if (index == 0u) {
    let freeCount = forgeax_vfx_runtime.capacity - atomicLoad(&forgeax_vfx_counters.aliveCount);
    atomicAdd(
      &forgeax_vfx_counters.droppedCount,
      forgeax_vfx_runtime.spawnCount - min(forgeax_vfx_runtime.spawnCount, freeCount),
    );
  }
}

@compute @workgroup_size(256)
fn forgeax_vfx_update_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= forgeax_vfx_runtime.capacity) { return; }
  var particle = forgeax_vfx_particles[index];
  if (forgeax_vfx_scratch[index] == 0u) { return; }
  let ctx = VfxUpdateContext(
    forgeax_vfx_runtime.delta,
    forgeax_vfx_runtime.tick,
    forgeax_vfx_runtime.seed,
    forgeax_vfx_runtime.playCycle,
    particle.id,
  );
  vfx_update(ctx, &particle);
  particle.age += forgeax_vfx_runtime.delta;
  if (particle.age >= particle.lifetime) {
    particle.alive = 0u;
  }
  forgeax_vfx_scratch[index] = select(0u, 1u, particle.alive != 0u);
  forgeax_vfx_particles[index] = particle;
}

var<workgroup> forgeax_vfx_scan_scratch: array<u32, 256>;

@compute @workgroup_size(256)
fn forgeax_vfx_scan_blocks_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  let index = invocation.x;
  let lane = local.x;
  var flag = 0u;
  if (index < forgeax_vfx_runtime.capacity) {
    flag = forgeax_vfx_scratch[index];
  }
  forgeax_vfx_scan_scratch[lane] = flag;
  workgroupBarrier();
  var offset = 1u;
  loop {
    if (offset >= 256u) { break; }
    var addend = 0u;
    if (lane >= offset) { addend = forgeax_vfx_scan_scratch[lane - offset]; }
    workgroupBarrier();
    forgeax_vfx_scan_scratch[lane] += addend;
    workgroupBarrier();
    offset *= 2u;
  }
  if (index < forgeax_vfx_runtime.capacity) {
    forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + index] = forgeax_vfx_scan_scratch[lane] - flag;
  }
  if (lane == 255u) {
    forgeax_vfx_scratch[forgeax_vfx_runtime.capacity * 2u + group.x] = forgeax_vfx_scan_scratch[lane];
  }
}

@compute @workgroup_size(1)
fn forgeax_vfx_scan_block_offsets_main() {
  let blockCount = (forgeax_vfx_runtime.capacity + 255u) / 256u;
  var sum = 0u;
  var block = 0u;
  loop {
    if (block >= blockCount) { break; }
    let scratchIndex = forgeax_vfx_runtime.capacity * 2u + block;
    let blockSum = forgeax_vfx_scratch[scratchIndex];
    forgeax_vfx_scratch[scratchIndex] = sum;
    sum += blockSum;
    block += 1u;
  }
}

@compute @workgroup_size(256)
fn forgeax_vfx_add_offsets_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  if (invocation.x >= forgeax_vfx_runtime.capacity) { return; }
  forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + invocation.x] +=
    forgeax_vfx_scratch[forgeax_vfx_runtime.capacity * 2u + group.x];
}

@compute @workgroup_size(256)
fn forgeax_vfx_compact_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index < forgeax_vfx_runtime.capacity && forgeax_vfx_scratch[index] != 0u) {
    forgeax_vfx_alive_indices[forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + index]] = index;
  }
  if (index == 0u) {
    let last = forgeax_vfx_runtime.capacity - 1u;
    let count = forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + last] + forgeax_vfx_scratch[last];
    atomicStore(&forgeax_vfx_counters.aliveCount, count);
    var renderer = 0u;
    loop {
      if (renderer >= forgeax_vfx_runtime.rendererCount) { break; }
      forgeax_vfx_indirect[renderer].instanceCount = count;
      renderer += 1u;
    }
  }
}

fn forgeax_vfx_project(position: vec3<f32>) -> vec3<f32> {
  let clip = forgeax_vfx_runtime.viewProjection * vec4<f32>(position, 1.0);
  let inverseW = select(1.0, 1.0 / clip.w, abs(clip.w) > 0.000001);
  return clip.xyz * inverseW;
}

fn forgeax_vfx_world_position(position: vec3<f32>) -> vec3<f32> {
  return (forgeax_vfx_runtime.localToWorld * vec4<f32>(position, 1.0)).xyz;
}

@compute @workgroup_size(256)
fn forgeax_vfx_billboard_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let rank = invocation.x;
  let aliveCount = atomicLoad(&forgeax_vfx_counters.aliveCount);
  if (rank >= aliveCount) { return; }
  let particle = forgeax_vfx_particles[forgeax_vfx_alive_indices[rank]];
  let worldPosition = forgeax_vfx_world_position(particle.position.xyz);
  let center = forgeax_vfx_project(worldPosition);
  let cosine = cos(particle.size_rotation.z);
  let sine = sin(particle.size_rotation.z);
  let rightAxis = forgeax_vfx_runtime.cameraRight.xyz * cosine + forgeax_vfx_runtime.cameraUp.xyz * sine;
  let upAxis = forgeax_vfx_runtime.cameraUp.xyz * cosine - forgeax_vfx_runtime.cameraRight.xyz * sine;
  let right = forgeax_vfx_project(
    worldPosition + rightAxis * particle.size_rotation.x,
  ) - center;
  let up = forgeax_vfx_project(
    worldPosition + upAxis * particle.size_rotation.y,
  ) - center;
  let base = rank * 23u;
  forgeax_vfx_billboard_instances[base] = center.x;
  forgeax_vfx_billboard_instances[base + 1u] = center.y;
  forgeax_vfx_billboard_instances[base + 2u] = center.z;
  forgeax_vfx_billboard_instances[base + 3u] = right.x;
  forgeax_vfx_billboard_instances[base + 4u] = right.y;
  forgeax_vfx_billboard_instances[base + 5u] = up.x;
  forgeax_vfx_billboard_instances[base + 6u] = up.y;
  forgeax_vfx_billboard_instances[base + 7u] = particle.color.x;
  forgeax_vfx_billboard_instances[base + 8u] = particle.color.y;
  forgeax_vfx_billboard_instances[base + 9u] = particle.color.z;
  forgeax_vfx_billboard_instances[base + 10u] = particle.color.w;
  forgeax_vfx_billboard_instances[base + 11u] = forgeax_vfx_runtime.baseColor.x;
  forgeax_vfx_billboard_instances[base + 12u] = forgeax_vfx_runtime.baseColor.y;
  forgeax_vfx_billboard_instances[base + 13u] = forgeax_vfx_runtime.baseColor.z;
  forgeax_vfx_billboard_instances[base + 14u] = forgeax_vfx_runtime.baseColor.w;
  forgeax_vfx_billboard_instances[base + 15u] = forgeax_vfx_runtime.emissiveIntensity.x;
  forgeax_vfx_billboard_instances[base + 16u] = forgeax_vfx_runtime.emissiveIntensity.y;
  forgeax_vfx_billboard_instances[base + 17u] = forgeax_vfx_runtime.emissiveIntensity.z;
  forgeax_vfx_billboard_instances[base + 18u] = forgeax_vfx_runtime.emissiveIntensity.w;
  forgeax_vfx_billboard_instances[base + 19u] = forgeax_vfx_runtime.surface.x;
  forgeax_vfx_billboard_instances[base + 20u] = forgeax_vfx_runtime.surface.y;
  forgeax_vfx_billboard_instances[base + 21u] = forgeax_vfx_runtime.surface.z;
  forgeax_vfx_billboard_instances[base + 22u] = forgeax_vfx_runtime.surface.w;
}

@compute @workgroup_size(256)
fn forgeax_vfx_mesh_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let rank = invocation.x;
  let aliveCount = atomicLoad(&forgeax_vfx_counters.aliveCount);
  if (rank >= aliveCount) { return; }
  let particle = forgeax_vfx_particles[forgeax_vfx_alive_indices[rank]];
  let center = forgeax_vfx_project(forgeax_vfx_world_position(particle.position.xyz));
  let scale = particle.size_rotation.x;
  let cosine = cos(particle.size_rotation.z);
  let sine = sin(particle.size_rotation.z);
  let right = forgeax_vfx_project(forgeax_vfx_world_position(
    particle.position.xyz + vec3<f32>(cosine * scale, sine * scale, 0.0),
  )) - center;
  let up = forgeax_vfx_project(forgeax_vfx_world_position(
    particle.position.xyz + vec3<f32>(-sine * scale, cosine * scale, 0.0),
  )) - center;
  let forward = forgeax_vfx_project(forgeax_vfx_world_position(particle.position.xyz + vec3<f32>(0.0, 0.0, scale))) - center;
  let base = rank * 28u;
  forgeax_vfx_mesh_instances[base] = center.x;
  forgeax_vfx_mesh_instances[base + 1u] = center.y;
  forgeax_vfx_mesh_instances[base + 2u] = center.z;
  forgeax_vfx_mesh_instances[base + 3u] = right.x;
  forgeax_vfx_mesh_instances[base + 4u] = right.y;
  forgeax_vfx_mesh_instances[base + 5u] = right.z;
  forgeax_vfx_mesh_instances[base + 6u] = up.x;
  forgeax_vfx_mesh_instances[base + 7u] = up.y;
  forgeax_vfx_mesh_instances[base + 8u] = up.z;
  forgeax_vfx_mesh_instances[base + 9u] = forward.x;
  forgeax_vfx_mesh_instances[base + 10u] = forward.y;
  forgeax_vfx_mesh_instances[base + 11u] = forward.z;
  forgeax_vfx_mesh_instances[base + 12u] = particle.color.x;
  forgeax_vfx_mesh_instances[base + 13u] = particle.color.y;
  forgeax_vfx_mesh_instances[base + 14u] = particle.color.z;
  forgeax_vfx_mesh_instances[base + 15u] = particle.color.w;
  forgeax_vfx_mesh_instances[base + 16u] = forgeax_vfx_runtime.baseColor.x;
  forgeax_vfx_mesh_instances[base + 17u] = forgeax_vfx_runtime.baseColor.y;
  forgeax_vfx_mesh_instances[base + 18u] = forgeax_vfx_runtime.baseColor.z;
  forgeax_vfx_mesh_instances[base + 19u] = forgeax_vfx_runtime.baseColor.w;
  forgeax_vfx_mesh_instances[base + 20u] = forgeax_vfx_runtime.emissiveIntensity.x;
  forgeax_vfx_mesh_instances[base + 21u] = forgeax_vfx_runtime.emissiveIntensity.y;
  forgeax_vfx_mesh_instances[base + 22u] = forgeax_vfx_runtime.emissiveIntensity.z;
  forgeax_vfx_mesh_instances[base + 23u] = forgeax_vfx_runtime.emissiveIntensity.w;
  forgeax_vfx_mesh_instances[base + 24u] = forgeax_vfx_runtime.surface.x;
  forgeax_vfx_mesh_instances[base + 25u] = forgeax_vfx_runtime.surface.y;
  forgeax_vfx_mesh_instances[base + 26u] = forgeax_vfx_runtime.surface.z;
  forgeax_vfx_mesh_instances[base + 27u] = forgeax_vfx_runtime.surface.w;
}
`;

export interface ParticleCodeModuleSet {
  readonly entry: string;
  readonly imports?: Readonly<Record<string, string>>;
}

export interface ParticleCodeProgramReflection {
  readonly hooks: readonly ['vfx_spawn', 'vfx_update'];
  readonly imports: readonly string[];
  readonly resources: readonly [
    'particles',
    'runtime',
    'aliveIndices',
    'counters',
    'indirect',
    'scratch',
    'billboardInstances',
    'meshInstances',
  ];
  readonly entryPoints: readonly [
    'forgeax_vfx_spawn_main',
    'forgeax_vfx_update_main',
    'forgeax_vfx_scan_blocks_main',
    'forgeax_vfx_scan_block_offsets_main',
    'forgeax_vfx_add_offsets_main',
    'forgeax_vfx_compact_main',
    'forgeax_vfx_billboard_main',
    'forgeax_vfx_mesh_main',
  ];
  readonly bindings: readonly BindGroupLayoutDescriptor[];
}

export interface CookedParticleCodeEmitter {
  readonly id: string;
  readonly capacity: number;
  readonly backend: ParticleEmitterSourceV2['backend'];
  readonly space: 'local' | 'world';
  readonly schedule: ParticleEmitterSourceV2['schedule'];
  readonly bounds: ParticleEmitterSourceV2['bounds'];
  readonly renderers: readonly ParticleRendererSource[];
  readonly simulationWhenCulled: 'continue' | 'pause' | 'restart-on-visible';
  readonly wgsl: string;
  readonly reflection: ParticleCodeProgramReflection;
}

export interface ParticleCodeProgram {
  readonly format: typeof PARTICLE_CODE_PROGRAM_FORMAT;
  readonly emitters: readonly CookedParticleCodeEmitter[];
}

export interface ParticleCodeProgramArtifact {
  readonly artifactKey: typeof PARTICLE_CODE_PROGRAM_ARTIFACT_KEY;
  readonly mimeType: 'application/vnd.forgeax.vfx-program+json';
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
  readonly program: ParticleCodeProgram;
}

export interface ParticleCodeEffectPayload {
  readonly kind: 'particle-effect';
  readonly schemaVersion: 2;
  readonly programFingerprint: string;
  readonly emitters: readonly { readonly id: string; readonly capacity: number }[];
}

export interface ParticleCodeCookProduct {
  readonly asset: ParticleCodeEffectPayload;
  readonly artifact: ParticleCodeProgramArtifact;
  readonly refs: readonly string[];
}

export interface ParticleCodeNativeCookInput {
  readonly guid: string;
  readonly source: unknown;
}

export interface ParticleCodeCompileError {
  readonly code:
    | 'vfx-hook-missing'
    | 'vfx-hook-invalid'
    | 'vfx-reserved-surface-conflict'
    | 'vfx-module-missing'
    | 'vfx-shader-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly emitterId: string;
    readonly module?: string;
    readonly hook?: 'vfx_spawn' | 'vfx_update';
    readonly causeCode?: string;
    readonly cause?: unknown;
  };
}

export type ParticleCodeCookError = ParticleCodeSourceError | ParticleCodeCompileError;

function compileError(
  code: ParticleCodeCompileError['code'],
  emitterId: string,
  expected: string,
  hint: string,
  detail: Omit<ParticleCodeCompileError['detail'], 'emitterId'> = {},
): ParticleCodeCompileError {
  return { code, expected, hint, detail: { emitterId, ...detail } };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function compileEmitter(
  emitter: ParticleEmitterSourceV2,
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
): Promise<Result<CookedParticleCodeEmitter, ParticleCodeCompileError>> {
  const moduleId = emitter.program.module;
  const module =
    moduleId === PARTICLE_CODE_DEFAULT_MODULE_ID
      ? { entry: PARTICLE_CODE_DEFAULT_MODULE }
      : modules[moduleId];
  if (module === undefined) {
    return err(
      compileError(
        'vfx-module-missing',
        emitter.id,
        `a readable WGSL module named ${moduleId}`,
        `add ${moduleId} to the shader source catalog and recook`,
        { module: moduleId },
      ),
    );
  }
  const entryCode = wgslCode(module.entry);
  if (RESERVED.test(entryCode)) {
    return err(
      compileError(
        'vfx-reserved-surface-conflict',
        emitter.id,
        'author code without bindings, shader stages, or forgeax_vfx_* symbols',
        'remove the reserved declaration; implement only vfx_spawn and vfx_update',
        { module: moduleId },
      ),
    );
  }
  for (const [importId, source] of Object.entries(module.imports ?? {})) {
    if (!RESERVED.test(wgslCode(source))) continue;
    return err(
      compileError(
        'vfx-reserved-surface-conflict',
        emitter.id,
        'author imports without bindings, shader stages, or forgeax_vfx_* symbols',
        `remove the reserved declaration from ${importId} and recook`,
        { module: importId },
      ),
    );
  }
  if (!REQUIRED_SPAWN.test(entryCode)) {
    return err(
      compileError(
        entryCode.includes('vfx_spawn') ? 'vfx-hook-invalid' : 'vfx-hook-missing',
        emitter.id,
        'fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>)',
        'add the exact vfx_spawn hook signature and recook',
        { hook: 'vfx_spawn', module: moduleId },
      ),
    );
  }
  if (!REQUIRED_UPDATE.test(entryCode)) {
    return err(
      compileError(
        entryCode.includes('vfx_update') ? 'vfx-hook-invalid' : 'vfx-hook-missing',
        emitter.id,
        'fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>)',
        'add the exact vfx_update hook signature and recook',
        { hook: 'vfx_update', module: moduleId },
      ),
    );
  }
  const imports = {
    [PARTICLE_CODE_PRELUDE_MODULE_ID]: PARTICLE_CODE_PRELUDE,
    ...(module.imports ?? {}),
  };
  const compiled = await compileShader(`${module.entry}\n${MANAGED_RUNTIME}`, {
    id: `forgeax_vfx_effect::${emitter.id}`,
    imports: imports as Record<string, string>,
  });
  if (!compiled.ok) {
    return err(
      compileError(
        'vfx-shader-invalid',
        emitter.id,
        'WGSL hooks that compose and validate against the managed VFX ABI',
        'inspect causeCode, repair the WGSL module/import, and recook',
        {
          module: moduleId,
          causeCode: compiled.error.code,
          cause: {
            message: compiled.error.message,
            hint: compiled.error.hint,
            lineNum: compiled.error.lineNum,
            linePos: compiled.error.linePos,
            detail: compiled.error.detail,
          },
        },
      ),
    );
  }
  return ok({
    id: emitter.id,
    capacity: emitter.capacity,
    backend: emitter.backend,
    space: emitter.space,
    schedule: emitter.schedule,
    bounds: emitter.bounds,
    renderers: emitter.renderers,
    simulationWhenCulled: emitter.simulationWhenCulled ?? 'continue',
    wgsl: compiled.value.wgsl,
    reflection: {
      hooks: ['vfx_spawn', 'vfx_update'],
      imports: Object.freeze([...compiled.value.deps].sort()),
      resources: [
        'particles',
        'runtime',
        'aliveIndices',
        'counters',
        'indirect',
        'scratch',
        'billboardInstances',
        'meshInstances',
      ],
      entryPoints: [
        'forgeax_vfx_spawn_main',
        'forgeax_vfx_update_main',
        'forgeax_vfx_scan_blocks_main',
        'forgeax_vfx_scan_block_offsets_main',
        'forgeax_vfx_add_offsets_main',
        'forgeax_vfx_compact_main',
        'forgeax_vfx_billboard_main',
        'forgeax_vfx_mesh_main',
      ],
      bindings: compiled.value.bindings,
    },
  });
}

export async function cookParticleCodeProgram(
  sourceValue: unknown,
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
): Promise<Result<ParticleCodeProgramArtifact, ParticleCodeCookError>> {
  const parsed = parseParticleEffectSourceV2(sourceValue);
  if (!parsed.ok) return parsed;
  const emitters: CookedParticleCodeEmitter[] = [];
  for (const emitter of parsed.value.emitters) {
    const compiled = await compileEmitter(emitter, modules);
    if (!compiled.ok) return compiled;
    emitters.push(compiled.value);
  }
  const program: ParticleCodeProgram = {
    format: PARTICLE_CODE_PROGRAM_FORMAT,
    emitters,
  };
  const text = canonical(program);
  const bytes = new TextEncoder().encode(text);
  return ok({
    artifactKey: PARTICLE_CODE_PROGRAM_ARTIFACT_KEY,
    mimeType: 'application/vnd.forgeax.vfx-program+json',
    bytes,
    fingerprint: createHash('sha256').update(bytes).digest('hex'),
    program,
  });
}

export async function cookParticleCodeEffect(
  sourceValue: unknown,
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
): Promise<Result<ParticleCodeCookProduct, ParticleCodeCookError>> {
  const artifact = await cookParticleCodeProgram(sourceValue, modules);
  if (!artifact.ok) return artifact;
  const refs = new Set<string>();
  for (const emitter of artifact.value.program.emitters) {
    for (const renderer of emitter.renderers) {
      refs.add(renderer.material);
      if (renderer.kind === 'mesh') refs.add(renderer.mesh);
    }
  }
  return ok({
    asset: {
      kind: 'particle-effect',
      schemaVersion: 2,
      programFingerprint: artifact.value.fingerprint,
      emitters: artifact.value.program.emitters.map(({ id, capacity }) => ({ id, capacity })),
    },
    artifact: artifact.value,
    refs: Object.freeze([...refs].sort()),
  });
}

export function createParticleCodeNativeCooker(
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
): NativeCooker<ParticleCodeEffectPayload, ParticleCodeNativeCookInput> {
  return {
    key: 'particle-effect',
    async cook({ guid, source }) {
      const cooked = await cookParticleCodeEffect(source, modules);
      if (!cooked.ok) throw new Error(cooked.error.hint);
      return {
        guid,
        payload: cooked.value.asset,
        refs: cooked.value.refs,
        artifacts: {
          [cooked.value.artifact.artifactKey]: {
            mediaType: cooked.value.artifact.mimeType,
            bytes: cooked.value.artifact.bytes,
          },
        },
        inputFingerprint: cooked.value.artifact.fingerprint,
      };
    },
  };
}
