import type { MaterialAsset, MaterialRenderState, MeshAsset } from '@forgeax/engine-types';

export const PARTICLE_SHADER_IDENTIFIERS = Object.freeze({
  billboard: 'forgeax::vfx-render.particles.billboard',
  mesh: 'forgeax::vfx-render.particles.mesh',
});

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
  kind: 'billboard' | 'mesh',
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
