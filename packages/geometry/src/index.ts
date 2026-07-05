// @forgeax/engine-geometry - single-import barrel.
//
// AI users get the 6 procedural geometry factories under one namespace import,
// each returning `Result<MeshAsset, AssetError>` (charter F1 single-entry
// indexability; P3 explicit failure). Alongside them: the vertex attribute
// layout SSOT (deriveVertexBufferLayout / buildMeshAttributeMapForUvSets /
// GpuVertexBufferLayoutEntry) and the tangent helper (computeTangentVec4)
// consumed by the runtime pipeline + material layers.
//
// Attribute layout (all factories): position (3 floats) + normal (3 floats) +
// uv (2 floats), expanded to the 12-float runtime layout (adds tangent vec4)
// by meshFromInterleaved / PROCEDURAL_FLOATS_PER_VERTEX.

export {
  createBoxGeometry,
  meshFromInterleaved,
  PROCEDURAL_FLOATS_PER_VERTEX,
} from './box';
export { createConeGeometry } from './cone';
export { createCylinderGeometry } from './cylinder';
export { createPlaneGeometry } from './plane';
export { createSphereGeometry } from './sphere';
export { computeTangentVec4 } from './tangent';
export { createTorusGeometry } from './torus';
export {
  buildMeshAttributeMapForUvSets,
  deriveVertexBufferLayout,
  type GpuVertexBufferLayoutEntry,
} from './vertex-attribute-layout';
