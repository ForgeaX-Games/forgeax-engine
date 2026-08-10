import {
  err,
  type MaterialAsset,
  type MaterialRenderState,
  type MeshAsset,
  ok,
  type Result,
} from '@forgeax/engine-types';
import type { ParticleRendererSource } from '@forgeax/engine-vfx';

export const PARTICLE_SHADER_IDENTIFIERS = Object.freeze({
  billboard: 'forgeax::vfx-render.particles.billboard',
  mesh: 'forgeax::vfx-render.particles.mesh',
  ribbon: 'forgeax::vfx-render.particles.ribbon',
  trail: 'forgeax::vfx-render.particles.trail',
  beam: 'forgeax::vfx-render.particles.beam',
});

export interface TopologyResourcePlan {
  readonly topology: 'ribbon' | 'trail' | 'beam';
  readonly capacity: number;
  readonly vertexBytes: number;
  readonly indexBytes: number;
  readonly indirectBytes: number;
  readonly resourceKey: string;
  readonly historyLength?: number;
  readonly stripKey?: 'alive-index';
  readonly endpointField?: 'velocity';
}

export interface TopologyResourceError {
  readonly code: 'vfx-topology-resource-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly path: string };
}

export function createTopologyResourcePlan(
  renderer: unknown,
): Result<TopologyResourcePlan, TopologyResourceError> {
  if (renderer === null || typeof renderer !== 'object' || Array.isArray(renderer))
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: 'a topology renderer object',
      hint: 'declare a ribbon, trail, or beam renderer',
      detail: { path: 'renderer' },
    });
  const value = renderer as Partial<ParticleRendererSource> & Record<string, unknown>;
  if (value.kind !== 'ribbon' && value.kind !== 'trail' && value.kind !== 'beam')
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: 'ribbon, trail, or beam',
      hint: 'do not alias topology output to billboard or mesh',
      detail: { path: 'renderer.kind' },
    });
  if (
    typeof value.capacity !== 'number' ||
    !Number.isInteger(value.capacity) ||
    value.capacity <= 0 ||
    value.capacity > 65536
  )
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: 'capacity in the range 1..65536',
      hint: 'bound topology resources before allocating them',
      detail: { path: 'renderer.capacity' },
    });
  const capacity = value.capacity;
  if (value.kind === 'ribbon' && value.stripKey !== 'alive-index')
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: "stripKey 'alive-index'",
      hint: 'use the managed alive-list order until a custom WGSL topology stage owns grouping',
      detail: { path: 'renderer.stripKey' },
    });
  if (
    value.kind === 'trail' &&
    (typeof value.historyLength !== 'number' ||
      !Number.isInteger(value.historyLength) ||
      value.historyLength <= 0 ||
      value.historyLength > 256)
  )
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: 'historyLength in the range 1..256',
      hint: 'bound trail history storage',
      detail: { path: 'renderer.historyLength' },
    });
  if (value.kind === 'beam' && value.endpointField !== 'velocity')
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: "endpointField 'velocity'",
      hint: 'use the managed velocity endpoint until a custom WGSL topology stage owns endpoints',
      detail: { path: 'renderer.endpointField' },
    });
  const vertexStride = 12 * 4;
  const segments =
    value.kind === 'trail' ? capacity * Math.max(1, (value.historyLength as number) - 1) : capacity;
  return ok({
    topology: value.kind,
    capacity,
    vertexBytes: Math.max(vertexStride, segments * vertexStride),
    indexBytes: 0,
    indirectBytes: 20,
    resourceKey: `vfx-topology-${value.kind}`,
    ...(value.kind === 'ribbon' ? { stripKey: 'alive-index' as const } : {}),
    ...(value.kind === 'trail' ? { historyLength: value.historyLength as number } : {}),
    ...(value.kind === 'beam' ? { endpointField: 'velocity' as const } : {}),
  });
}

export interface TopologyCapacityInput {
  readonly requested: number;
  readonly produced: number;
  readonly degenerate?: number;
}

export function topologyCapacitySnapshot(plan: TopologyResourcePlan, input: TopologyCapacityInput) {
  const produced = Math.max(0, Math.min(plan.capacity, input.produced));
  const requested = Math.max(0, input.requested);
  return {
    topology: plan.topology,
    capacity: plan.capacity,
    produced,
    dropped: Math.max(0, requested - produced),
    overflow: Math.max(0, requested - plan.capacity),
    degenerate: Math.max(0, input.degenerate ?? 0),
  } as const;
}

export interface ParticleMaterialPass {
  readonly shader: string;
  readonly renderState?: MaterialRenderState;
}

/**
 * Resolve the one material pass that is meaningful for a particle projection.
 * A regular Forward pass is intentionally ignored: VFX vertex layouts are a
 * different contract, so silently accepting it would compile the wrong input
 * shape and make authored particle shaders appear to work while never running.
 */
export function particleMaterialPass(
  kind: 'billboard' | 'mesh' | 'ribbon' | 'trail' | 'beam',
  material: MaterialAsset | undefined,
): ParticleMaterialPass {
  const pass = material?.passes?.find((candidate) => candidate.name === `particle-${kind}`);
  return {
    shader: pass?.program.module ?? PARTICLE_SHADER_IDENTIFIERS[kind],
    ...(pass?.renderState === undefined
      ? {}
      : { renderState: pass.renderState as MaterialRenderState }),
  };
}

/** True when the authored particle shader consumes the standard material bind group. */
export function particleMaterialUsesBindings(material: MaterialAsset | undefined): boolean {
  return (material?.parameters?.length ?? 0) > 0;
}

function floatAttribute(value: ArrayBuffer | Float32Array | Uint16Array | undefined): Float32Array {
  if (value instanceof Float32Array) return value;
  if (value instanceof Uint16Array) return Float32Array.from(value);
  return value === undefined ? new Float32Array() : new Float32Array(value);
}

export function canonicalMeshVertices(mesh: MeshAsset): Float32Array {
  if (mesh.vertices.length > 0 && mesh.vertices.length % 12 === 0) return mesh.vertices;
  const positions = floatAttribute(mesh.attributes.position);
  const vertexCount = Math.floor(positions.length / 3);
  const normals = floatAttribute(mesh.attributes.normal);
  const uvs = floatAttribute(mesh.attributes.uv);
  const tangents = floatAttribute(mesh.attributes.tangent);
  const result = new Float32Array(vertexCount * 12);
  for (let index = 0; index < vertexCount; index += 1) {
    const target = index * 12;
    result.set(positions.subarray(index * 3, index * 3 + 3), target);
    result.set(
      normals.length >= index * 3 + 3 ? normals.subarray(index * 3, index * 3 + 3) : [0, 0, 1],
      target + 3,
    );
    result.set(
      uvs.length >= index * 2 + 2 ? uvs.subarray(index * 2, index * 2 + 2) : [0, 0],
      target + 6,
    );
    result.set(
      tangents.length >= index * 4 + 4 ? tangents.subarray(index * 4, index * 4 + 4) : [1, 0, 0, 1],
      target + 8,
    );
  }
  return result;
}
