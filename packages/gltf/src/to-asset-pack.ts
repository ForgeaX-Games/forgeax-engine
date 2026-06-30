// to-asset-pack.ts - toAssetPack re-export shell (w17).
//
// `toAssetPack` itself lives in parse-gltf.ts (shares the GltfDoc IR
// closure with parseGltf / parseGlb). This file is the named entry point
// listed in plan-tasks.json target files; it re-exports the surface so
// the package layout matches plan-strategy section 3.1 / gltf_pkg.Pure.

export { toAssetPack } from './parse-gltf.js';
