// parse-glb.ts - GLB-entry re-export shell (w17 + w19).
//
// `parseGlb` itself lives in parse-gltf.ts (so it shares a single module
// closure with `parseGltf` + `toAssetPack` and avoids circular imports).
// This file is the named entry point listed in plan-tasks.json target
// files; it re-exports the surface so the package layout matches the
// component map in plan-strategy section 3.1 / gltf_pkg.Pure.
//
// w19 adds the `parseGlbFromFile` file-entry shell which performs the
// sidecar `<source>.meta.json` stat pre-step (plan-strategy section 2.8
// path a) before delegating to the pure `parseGlb` core. The file-entry
// wrapper now lives in `node-file-entry.ts` and ships under the
// `@forgeax/engine-gltf/node` sub-entry (browser-bundle hygiene).

export type { ExternalLoader, GltfDoc } from './parse-gltf.js';
export { parseGlb } from './parse-gltf.js';
