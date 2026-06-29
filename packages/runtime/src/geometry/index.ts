// @forgeax/engine-runtime/geometry - 6 procedural geometry factories (M3 / w8).
//
// Single-import barrel per plan-strategy §M3 + D-P5. AI users get
// `createBoxGeometry` ... `createTorusGeometry` under one namespace import,
// each returning `Result<MeshAsset, AssetError>` (charter proposition 1
// progressive disclosure; proposition 4 explicit failure).
//
// Attribute layout (all factories): position (3 floats) + normal (3 floats) +
// uv (2 floats); the `attributes: VertexAttributeMap` field in each returned
// MeshAsset binds Float32Array views over these ranges per lowercase key
// (requirements §G7 + §AC-15 closed 6-key set).

export { createBoxGeometry, meshFromInterleaved } from './box';
export { createConeGeometry } from './cone';
export { createCylinderGeometry } from './cylinder';
export { createPlaneGeometry } from './plane';
export { createSphereGeometry } from './sphere';
export { createTorusGeometry } from './torus';
