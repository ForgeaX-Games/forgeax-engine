// @forgeax/engine-gltf - runtime glTF 2.0 importer (Tier-B subset).
//
// M2 surface: pure-function pipeline `parseGlb` / `parseGltf` /
// `toAssetPack` plus helpers `parseGltfHeader` / `parseGlbChunks` /
// `decodeAccessor` / `decomposeNodeTransform` / `subAssetKey` /
// `reimportReuseMeta` / `checkExtensions`.
// M3 adds the file-entry stubs `parseGltfFromFile` / `parseGlbFromFile`.
//
// Surface contract anchors:
// - plan-strategy section 3.1 (component map gltf_pkg.Pure / Helpers / Errors)
// - plan-strategy section 8 "Naming convention" (parseGlb / parseGltf /
//   toAssetPack lowercase camel; gltf word lowercase)
// - GltfErrorCode closed union + GltfErrorDetail discriminated
//   detail live in @forgeax/engine-types as the SSOT (decision section
//   2.3); the single-import surface re-exports them here.

export const GLTF_PACKAGE_VERSION = '0.0.0';

// Sub-asset POD SSOT re-exports (from @forgeax/engine-types; replaces
// the old unprefixed Ir types which are now Gltf-prefixed exports above).
export type {
  AnimationChannelPod,
  AnimationClipPod,
  AnimationSamplerPod,
  MaterialPod,
  MeshPod,
  MeshSubmeshPod,
  SceneEntityPod,
  ScenePod,
  SkeletonPod,
  SkinPod,
  SkinVertexInfluencePod,
  TexturePod,
} from '@forgeax/engine-types';
export type { GltfBridgeContext, MaterialBridgeContext } from './bridge.js';
// Bridge: gltfDocToSceneAsset + toMaterialAsset + meshIrToMeshAsset (SSOT for
// hello-gltf + hello-gltf-instancing, feat-20260518 M3 w9; M3 Tier-C material
// bridge; meshIrToMeshAsset excised from the hello-gltf demo in
// feat-20260603-asset-import-loader-injection M2 w19).
export { gltfDocToSceneAsset, meshIrToMeshAsset, toMaterialAsset } from './bridge.js';
export type { ExtensionsCheckResult, GltfExtensionsJson } from './check-extensions.js';
// KHR extensions gate (w14).
export { checkExtensions, EXTENSION_ALLOWLIST } from './check-extensions.js';
export type {
  AccessorJson,
  AccessorRole,
  BufferViewJson,
  ComponentTypeId,
  DecodeAccessorInput,
  DecodedAccessor,
} from './decode-accessor.js';
// Accessor decoder (w9).
export { COMPONENT_TYPE, decodeAccessor } from './decode-accessor.js';
export type {
  GltfAccessorTypeMismatchDetail,
  GltfAnimationCubicsplineUnsupportedDetail,
  GltfBufferOutOfBoundsDetail,
  GltfError,
  GltfErrorCode,
  GltfErrorDetail,
  GltfExtensionUnsupportedDetail,
  GltfImageExtractFailedDetail,
  GltfImageMimeUnsupportedDetail,
  GltfInstancingCountMismatchDetail,
  GltfMalformedHeaderDetail,
  GltfMetaMissingDetail,
  GltfMorphUnsupportedDetail,
  GltfSkinAttrAsymmetricDetail,
  GltfSkinJointCountExceededDetail,
  GltfSkinJointNameMissingDetail,
  GltfTextureLoadFailedDetail,
  GltfVersionUnsupportedDetail,
  Result,
} from './errors.js';
// Errors / Result alias / factory (errors.ts SSOT re-exports).
export { err, GLTF_ERROR_HINTS, gltfErr, ok } from './errors.js';
// gltfImporter: the build-time `{ key: 'gltf', import }` Importer
// (feat-20260603-asset-import-loader-injection M2 / w19).
export { gltfImporter } from './gltf-importer.js';
export type { GlbChunks } from './parse-glb-chunks.js';
// Header / chunk parsers (w8).
export { parseGlbChunks, parseGltfHeader } from './parse-glb-chunks.js';
export type {
  ExternalLoader,
  GltfDiagnosticsIr,
  GltfDoc,
  GltfImageIr,
  GltfMaterialIr,
  GltfMeshIr,
  GltfNodeIr,
  GltfSamplerIr,
  GltfSceneIr,
  GltfTextureIr,
  MeshJson,
  MeshPrimitiveJson,
  NodeInstancingIr,
} from './parse-gltf.js';
// Main pipeline (w15 + w17) + file-entry wrappers (w19).
export { parseGlb, parseGltf, toAssetPack } from './parse-gltf.js';
// File-entry wrappers (parseGltfFromFile / parseGlbFromFile) live in
// `./node-file-entry.ts` and ship under the `./node` sub-entry to keep
// the main entry browser-clean -- they touch `node:fs/promises` /
// `node:path` via dynamic import and would otherwise trip vite's "module
// externalized for browser compatibility" warning when consumers bundle
// the demo for the browser. Node consumers:
//
//     import { parseGltfFromFile } from '@forgeax/engine-gltf/node';
export type { GltfHeaderJson } from './parse-gltf-header.js';
export type {
  GltfDocItem,
  GltfMetaJson,
  GltfSubAssetEntry,
  ReimportReuseResult,
  SubAssetKey,
} from './reimport-reuse-meta.js';
// Sub-asset key + reimport-reuse algorithm (w13).
export {
  reimportReuseMeta,
  subAssetKey,
} from './reimport-reuse-meta.js';
export type {
  DecomposedTransform,
  NodeTransformJson,
  TransformDiagnostics,
  Vec3Tuple,
  Vec4Tuple,
} from './transform.js';
// Node transform decomposer (w11).
export { decomposeNodeTransform } from './transform.js';
