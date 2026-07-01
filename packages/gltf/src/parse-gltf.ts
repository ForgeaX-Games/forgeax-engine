// parse-gltf.ts - JSON-side glTF importer entry (w17).
//
// w17 lands the full parseGltf main function plus parseGlb / toAssetPack
// siblings. The helpers exported here include both the surface API
// (parseGltf / parseGlb / toAssetPack) and a few mesh / scene utilities
// the main path uses internally.

import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { checkExtensions, type GltfExtensionsJson } from './check-extensions.js';
import {
  type AccessorJson,
  type BufferViewJson,
  COMPONENT_TYPE,
  decodeAccessor,
} from './decode-accessor.js';
import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';
import { type GltfAnimationClipRecord, parseAnimation } from './parse-animation.js';
import { parseGlbChunks } from './parse-glb-chunks.js';
import { parseGltfHeader } from './parse-gltf-header.js';
import { type GltfSkeletonRecord, parseSkin } from './parse-skin.js';
import {
  type GltfDocItem,
  type GltfMetaJson,
  type GltfSubAssetEntry,
  reimportReuseMeta,
} from './reimport-reuse-meta.js';
import { type DecomposedTransform, decomposeNodeTransform } from './transform.js';

export interface MeshPrimitiveJson {
  readonly attributes?: Record<string, number>;
  readonly indices?: number;
  readonly material?: number;
  readonly mode?: number;
  readonly targets?: ReadonlyArray<Record<string, number>>;
}

export interface MeshJson {
  readonly name?: string;
  readonly primitives: readonly MeshPrimitiveJson[];
}

// === Tier-B v1 IR (GltfDoc) ===
//
// Shape: a denormalised view of the parsed glTF JSON, post-validation,
// suitable for downstream `toAssetPack` and runtime AssetRegistry
// hand-off. Math types are POD (number tuples), no Vec3/Quat brand at
// the boundary (charter proposition 5).

interface InstancingAttributes {
  readonly TRANSLATION?: number;
  readonly ROTATION?: number;
  readonly SCALE?: number;
}

/**
 * Decode EXT_mesh_gpu_instancing attributes for a single node.
 *
 * Cross-validates that all present TRS accessor counts agree (spec
 * MUST clause "Extending nodes with instance attributes"). Missing
 * accessors fall back to identity (translation=(0,0,0),
 * rotation=(0,0,0,1), scale=(1,1,1)). Composes N column-major mat4 via
 * @forgeax/engine-math `mat4.compose`, packing them into a single
 * Float32Array of length N*16. Pure function: no fs / fetch / throw.
 */
function decodeNodeInstancing(
  nodeIndex: number,
  attributes: InstancingAttributes,
  accessors: readonly AccessorJson[],
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<NodeInstancingIr, GltfError> {
  const tIdx = attributes.TRANSLATION;
  const rIdx = attributes.ROTATION;
  const sIdx = attributes.SCALE;

  let count: number | undefined;
  const setOrCheck = (label: 'TRANSLATION' | 'ROTATION' | 'SCALE', n: number): GltfError | null => {
    if (count === undefined) {
      count = n;
      return null;
    }
    if (n !== count) {
      return gltfErr('gltf-instancing-count-mismatch', {
        nodeIndex,
        accessor: label,
        expectedCount: count,
        actualCount: n,
      });
    }
    return null;
  };

  let tValues: Float32Array | undefined;
  if (tIdx !== undefined) {
    const acc = accessors[tIdx];
    if (acc === undefined) return err(unknownAccessor(tIdx));
    const e = setOrCheck('TRANSLATION', acc.count);
    if (e !== null) return err(e);
    const decoded = decodeAttributeAccessor(tIdx, acc, bufferViews, buffers);
    if (!decoded.ok) return err(decoded.error);
    tValues = decoded.value;
  }
  let rValues: Float32Array | undefined;
  if (rIdx !== undefined) {
    const acc = accessors[rIdx];
    if (acc === undefined) return err(unknownAccessor(rIdx));
    const e = setOrCheck('ROTATION', acc.count);
    if (e !== null) return err(e);
    const decoded = decodeAttributeAccessor(rIdx, acc, bufferViews, buffers);
    if (!decoded.ok) return err(decoded.error);
    rValues = decoded.value;
  }
  let sValues: Float32Array | undefined;
  if (sIdx !== undefined) {
    const acc = accessors[sIdx];
    if (acc === undefined) return err(unknownAccessor(sIdx));
    const e = setOrCheck('SCALE', acc.count);
    if (e !== null) return err(e);
    const decoded = decodeAttributeAccessor(sIdx, acc, bufferViews, buffers);
    if (!decoded.ok) return err(decoded.error);
    sValues = decoded.value;
  }

  const n = count ?? 0;
  const transforms = new Float32Array(n * 16);
  const tmp = mat4.create();
  const tv = vec3.create();
  const rv = quat.create();
  rv[3] = 1;
  const sv = vec3.create(1, 1, 1);
  for (let i = 0; i < n; i++) {
    if (tValues !== undefined) {
      tv[0] = tValues[i * 3] ?? 0;
      tv[1] = tValues[i * 3 + 1] ?? 0;
      tv[2] = tValues[i * 3 + 2] ?? 0;
    } else {
      tv[0] = 0;
      tv[1] = 0;
      tv[2] = 0;
    }
    if (rValues !== undefined) {
      rv[0] = rValues[i * 4] ?? 0;
      rv[1] = rValues[i * 4 + 1] ?? 0;
      rv[2] = rValues[i * 4 + 2] ?? 0;
      rv[3] = rValues[i * 4 + 3] ?? 1;
    } else {
      rv[0] = 0;
      rv[1] = 0;
      rv[2] = 0;
      rv[3] = 1;
    }
    if (sValues !== undefined) {
      sv[0] = sValues[i * 3] ?? 1;
      sv[1] = sValues[i * 3 + 1] ?? 1;
      sv[2] = sValues[i * 3 + 2] ?? 1;
    } else {
      sv[0] = 1;
      sv[1] = 1;
      sv[2] = 1;
    }
    mat4.compose(tmp, tv, rv, sv);
    for (let k = 0; k < 16; k++) {
      transforms[i * 16 + k] = tmp[k] ?? 0;
    }
  }

  return ok({ count: n, transforms });
}

function unknownAccessor(accessorIndex: number): GltfError {
  return gltfErr('gltf-accessor-type-mismatch', {
    accessorIndex,
    reason: 'unknownComponentType',
  });
}

function decodeAttributeAccessor(
  accessorIndex: number,
  accessor: AccessorJson,
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<Float32Array, GltfError> {
  const view = bufferViews[accessor.bufferView ?? -1];
  if (view === undefined) return err(unknownAccessor(accessorIndex));
  const buf = buffers[view.buffer];
  if (buf === undefined) return err(unknownAccessor(accessorIndex));
  const decoded = decodeAccessor({
    accessorIndex,
    accessor,
    bufferView: view,
    buffer: buf,
    role: 'attribute',
  });
  if (!decoded.ok) return err(decoded.error);
  if (decoded.value.kind !== 'f32') return err(unknownAccessor(accessorIndex));
  return ok(decoded.value.data);
}

export interface GltfMeshIr {
  readonly name?: string;
  readonly positions: Float32Array;
  readonly normals?: Float32Array;
  readonly texcoord0?: Float32Array;
  /** TEXCOORD_1 per-vertex UV set 1 (Float32Array, 2 per vertex). feat-20260629-multi-uv-set-support m1-w2. */
  readonly texcoord1?: Float32Array;
  /** TEXCOORD_2 per-vertex UV set 2 (Float32Array, 2 per vertex). */
  readonly texcoord2?: Float32Array;
  /** TEXCOORD_3 per-vertex UV set 3 (Float32Array, 2 per vertex). */
  readonly texcoord3?: Float32Array;
  /** TEXCOORD_4 per-vertex UV set 4 (Float32Array, 2 per vertex). */
  readonly texcoord4?: Float32Array;
  /** TEXCOORD_5 per-vertex UV set 5 (Float32Array, 2 per vertex). */
  readonly texcoord5?: Float32Array;
  /** TEXCOORD_6 per-vertex UV set 6 (Float32Array, 2 per vertex). */
  readonly texcoord6?: Float32Array;
  /** TEXCOORD_7 per-vertex UV set 7 (Float32Array, 2 per vertex). */
  readonly texcoord7?: Float32Array;
  readonly tangents?: Float32Array;
  /** JOINTS_0 per-vertex joint indices (Uint16Array, 4 per vertex). UBYTE source is width-converted to U16 at parse time (D-3). */
  readonly joints0?: Uint16Array;
  /** WEIGHTS_0 per-vertex skin weights (Float32Array, 4 per vertex). */
  readonly weights0?: Float32Array;
  /**
   * Optional per-glTF-spec: when omitted, primitive declares non-indexed
   * geometry (vertex buffer is consumed in vertex order, every 3 verts =
   * 1 triangle for triangle-list). bridge.ts handles undefined by routing
   * MeshAsset.indices to undefined and submesh.indexCount=0 (vertexCount
   * carries the draw count for `pass.draw(vertexCount)`).
   * bug-20260612 hello-skin visual layered gate: prior shape coerced
   * undefined into Uint16Array(0) and tripped MeshAsset.indices !==
   * undefined branches downstream into drawIndexed(0).
   * U16 (incl. widened U8) or U32 — width preserved from the source accessor;
   * bridge.ts narrows U32 to U16 when the merged maxIndex fits.
   */
  readonly indices?: Uint16Array | Uint32Array;
  readonly materialIndex: number | null;
  /**
   * Owning glTF mesh index in the original document (`gltf.meshes[meshIndex]`).
   * After OOS-7 flattening, multiple GltfMeshIr entries may share the same
   * meshIndex (one per primitive). Bridge layer uses this to filter material
   * collection per node, fixing the verify-r1 charter-defect where multi
   * glTF-mesh documents would silently misalign materials across nodes.
   */
  readonly meshIndex: number;
}

export interface GltfTextureIr {
  readonly sampler?: number;
  readonly source: number;
  readonly name?: string;
}

export interface GltfImageIr {
  readonly uri?: string;
  readonly mimeType?: string;
  readonly bufferView?: number;
  readonly name?: string;
}

export interface GltfSamplerIr {
  readonly magFilter?: number;
  readonly minFilter?: number;
  readonly wrapS: number;
  readonly wrapT: number;
  readonly name?: string;
}

export interface GltfMaterialIr {
  readonly name?: string;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly baseColorTexture?: number;
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly metallicRoughnessTexture?: number;
  readonly normalTexture?: number;
}

export interface NodeInstancingIr {
  /** Number of instances. All TRS attribute accessors share this count. */
  readonly count: number;
  /** N column-major mat4 transforms packed into one Float32Array (length = N*16). */
  readonly transforms: Float32Array;
}

export interface GltfNodeIr {
  readonly name?: string;
  readonly transform: DecomposedTransform;
  readonly meshIndex: number | null;
  /** Valid when node carries `skin` reference. Null when no skin. */
  readonly skinIndex: number | null;
  readonly children: readonly number[];
  /** Present when node carries EXT_mesh_gpu_instancing (feat-20260518). */
  readonly instancing?: NodeInstancingIr;
  /** glTF camera index. Null when the node does not reference a camera. */
  readonly camera: number | null;
}

export interface GltfSceneIr {
  readonly name?: string;
  readonly nodes: readonly number[];
}

export interface GltfDiagnosticsIr {
  readonly nodeNames: readonly string[];
  readonly unsupportedExtensions: readonly string[];
  readonly matrixTrsCoexistNodes: readonly number[];
}

export interface GltfDoc {
  readonly meshes: readonly GltfMeshIr[];
  readonly materials: readonly GltfMaterialIr[];
  readonly nodes: readonly GltfNodeIr[];
  readonly scenes: readonly GltfSceneIr[];
  readonly textures: readonly GltfTextureIr[] | undefined;
  readonly images: readonly GltfImageIr[] | undefined;
  readonly samplers: readonly GltfSamplerIr[] | undefined;
  readonly skeletons: readonly GltfSkeletonRecord[];
  readonly animationClips: readonly GltfAnimationClipRecord[];
  readonly defaultSceneIndex: number;
  readonly diagnostics: GltfDiagnosticsIr;
  /**
   * Original glTF-mesh-index -> number of primitives that mesh expanded into
   * (feat-20260608 round-2). parseGltf flattens N glTF meshes with M_i
   * primitives into sum(M_i) GltfMeshIr entries; this map preserves the M_i so
   * downstream consumers (gltfDocToSceneAsset's `meshPrimitiveCount` param)
   * can map a glTF mesh index back to the flat-GltfMeshIr offset range without
   * re-parsing JSON.
   *
   * Optional for backwards compatibility with hand-constructed test
   * fixtures; producers from parseGltf / parseGlb always populate it.
   */
  readonly meshPrimitiveCount?: ReadonlyMap<number, number>;
}

interface BuffersJson {
  readonly byteLength: number;
  readonly uri?: string;
}

interface RootGltfJson extends GltfExtensionsJson {
  readonly asset?: { readonly version?: string };
  readonly scene?: number;
  readonly scenes?: ReadonlyArray<{ readonly name?: string; readonly nodes?: readonly number[] }>;
  readonly nodes?: ReadonlyArray<{
    readonly name?: string;
    readonly mesh?: number;
    readonly skin?: number;
    readonly camera?: number;
    readonly children?: readonly number[];
    readonly matrix?: readonly number[];
    readonly translation?: readonly number[];
    readonly rotation?: readonly number[];
    readonly scale?: readonly number[];
    readonly extensions?: {
      readonly EXT_mesh_gpu_instancing?: {
        readonly attributes?: {
          readonly TRANSLATION?: number;
          readonly ROTATION?: number;
          readonly SCALE?: number;
        };
      };
    };
  }>;
  readonly skins?: ReadonlyArray<{
    readonly name?: string;
    readonly joints: readonly number[];
    readonly inverseBindMatrices?: number;
  }>;
  readonly meshes?: readonly MeshJson[];
  readonly materials?: ReadonlyArray<{
    readonly name?: string;
    readonly pbrMetallicRoughness?: {
      readonly baseColorFactor?: readonly number[];
      readonly baseColorTexture?: { readonly index: number };
      readonly metallicFactor?: number;
      readonly roughnessFactor?: number;
      readonly metallicRoughnessTexture?: { readonly index: number };
    };
    readonly normalTexture?: { readonly index: number };
  }>;
  readonly textures?: ReadonlyArray<{
    readonly sampler?: number;
    readonly source?: number;
    readonly name?: string;
  }>;
  readonly images?: ReadonlyArray<{
    readonly uri?: string;
    readonly mimeType?: string;
    readonly bufferView?: number;
    readonly name?: string;
  }>;
  readonly samplers?: ReadonlyArray<{
    readonly magFilter?: number;
    readonly minFilter?: number;
    readonly wrapS?: number;
    readonly wrapT?: number;
    readonly name?: string;
  }>;
  readonly accessors?: readonly AccessorJson[];
  readonly bufferViews?: readonly BufferViewJson[];
  readonly buffers?: readonly BuffersJson[];
  readonly animations?: ReadonlyArray<{
    readonly name?: string;
    readonly channels: ReadonlyArray<{
      readonly sampler: number;
      readonly target: {
        readonly node?: number;
        readonly path: string;
      };
    }>;
    readonly samplers: ReadonlyArray<{
      readonly input: number;
      readonly output: number;
      readonly interpolation?: string;
    }>;
  }>;
}

export type ExternalLoader = (uri: string) => Promise<ArrayBuffer>;

// data:application/octet-stream;base64,XXXX or data:*;base64,XXXX
const DATA_URI_BASE64_RE = /^data:[^;,]*(?:;[^,;]+)*;base64,(.*)$/;

// Browser-friendly base64 decoder. atob handles standard ASCII base64
// strings; padding is preserved by `data:` URIs so no extra normalisation
// is required. (Buffer.from would force a Node dependency on this file
// and break the package's "ship to browser" property.)
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function resolveBuffer(
  buf: BuffersJson,
  externalLoader: ExternalLoader,
  binChunk: Uint8Array | undefined,
): Promise<Uint8Array> {
  if (buf.uri === undefined) {
    // GLB BIN chunk slot.
    if (binChunk === undefined) {
      throw new Error('parseGltf: buffer 0 has no uri and no GLB BIN chunk available');
    }
    return binChunk;
  }
  const dataMatch = DATA_URI_BASE64_RE.exec(buf.uri);
  if (dataMatch !== null) {
    return decodeBase64(dataMatch[1] ?? '');
  }
  const arrayBuffer = await externalLoader(buf.uri);
  return new Uint8Array(arrayBuffer);
}

interface ParseGltfInternalsContext {
  readonly externalLoader: ExternalLoader;
  readonly binChunk?: Uint8Array;
  readonly filePath: string;
}

async function parseGltfWithBin(
  json: RootGltfJson,
  ctx: ParseGltfInternalsContext,
): Promise<Result<GltfDoc, GltfError>> {
  const headerResult = parseGltfHeader(json, ctx.filePath);
  if (!headerResult.ok) return err(headerResult.error);

  const extResult = checkExtensions(json);
  if (!extResult.ok) return err(extResult.error);
  const unsupportedExtensions = extResult.value.unsupportedUsed;

  const meshesJson = json.meshes ?? [];

  // Resolve buffers (data: URI / external / GLB BIN chunk).
  const buffersJson = json.buffers ?? [];
  const buffers: Uint8Array[] = [];
  for (let i = 0; i < buffersJson.length; i++) {
    const bufJson = buffersJson[i];
    if (bufJson === undefined) continue;
    try {
      const bytes = await resolveBuffer(bufJson, ctx.externalLoader, ctx.binChunk);
      buffers.push(bytes);
    } catch (_e) {
      return err(
        gltfErr('gltf-malformed-header', {
          filePath: ctx.filePath,
          byteOffset: 0,
        }),
      );
    }
  }

  const accessors = json.accessors ?? [];
  const bufferViews = json.bufferViews ?? [];

  const meshes: GltfMeshIr[] = [];
  // feat-20260608 round-2: surface the original-glTF-mesh primitive counts so
  // build-time consumers (gltfImporter scene arm) can hand them to
  // gltfDocToSceneAsset's `meshPrimitiveCount` parameter without re-parsing
  // the JSON. Without this, importGltf at gltf-importer.ts ~272 walks the
  // already-flattened doc.meshes (one entry per primitive) and cannot
  // reconstruct the gltfMesh -> primitiveCount map; the bridge then uses
  // identity (gltfMeshIdx == flatIdx) and any multi-primitive .gltf imports
  // misindex meshes after the first primitive.
  const meshPrimitiveCount = new Map<number, number>();
  for (let meshIndex = 0; meshIndex < meshesJson.length; meshIndex++) {
    const meshJson = meshesJson[meshIndex];
    if (meshJson === undefined) continue;
    meshPrimitiveCount.set(meshIndex, meshJson.primitives.length);
    for (const prim of meshJson.primitives) {
      if (prim === undefined) continue;
      const positionAccessorIndex = prim.attributes?.POSITION;
      if (positionAccessorIndex === undefined) {
        return err(
          gltfErr('gltf-accessor-type-mismatch', {
            accessorIndex: -1,
            reason: 'unknownComponentType',
          }),
        );
      }
      const positionAccessor = accessors[positionAccessorIndex];
      const positionBufferView = bufferViews[positionAccessor?.bufferView ?? -1];
      if (positionAccessor === undefined || positionBufferView === undefined) {
        return err(
          gltfErr('gltf-buffer-out-of-bounds', {
            accessor: positionAccessorIndex,
            byteOffset: 0,
            byteLength: 0,
            bufferIndex: positionBufferView?.buffer ?? 0,
          }),
        );
      }
      const positionBuffer = buffers[positionBufferView.buffer];
      if (positionBuffer === undefined) {
        return err(
          gltfErr('gltf-buffer-out-of-bounds', {
            accessor: positionAccessorIndex,
            byteOffset: positionBufferView.byteOffset ?? 0,
            byteLength: positionBufferView.byteLength,
            bufferIndex: positionBufferView.buffer,
          }),
        );
      }
      const positionDecoded = decodeAccessor({
        accessorIndex: positionAccessorIndex,
        accessor: positionAccessor,
        bufferView: positionBufferView,
        buffer: positionBuffer,
        role: 'attribute',
      });
      if (!positionDecoded.ok) return err(positionDecoded.error);
      if (positionDecoded.value.kind !== 'f32') {
        return err(
          gltfErr('gltf-accessor-type-mismatch', {
            accessorIndex: positionAccessorIndex,
            reason: 'unknownComponentType',
          }),
        );
      }
      const positionsDecoded = positionDecoded.value.data;
      // Re-allocate over a fresh ArrayBuffer so the GltfMeshIr.positions type
      // (`Float32Array<ArrayBuffer>`) holds without ArrayBufferLike leakage.
      const positions = new Float32Array(positionsDecoded.length);
      positions.set(positionsDecoded);

      // Decode optional vertex attributes: NORMAL (VEC3), TEXCOORD_0 (VEC2),
      // TANGENT (VEC4). Each uses the existing decodeAttributeAccessor helper.
      // Missing attributes leave the GltfMeshIr field undefined.
      const attrs = prim.attributes ?? {};

      let normals: Float32Array | undefined;
      const normalIdx = attrs.NORMAL;
      if (normalIdx !== undefined) {
        const acc = accessors[normalIdx];
        if (acc !== undefined) {
          const decoded = decodeAttributeAccessor(normalIdx, acc, bufferViews, buffers);
          if (decoded.ok) {
            const src = decoded.value;
            const owned = new Float32Array(src.length);
            owned.set(src);
            normals = owned;
          }
        }
      }

      let texcoord0: Float32Array | undefined;
      const texIdx = attrs.TEXCOORD_0;
      if (texIdx !== undefined) {
        const acc = accessors[texIdx];
        if (acc !== undefined) {
          const decoded = decodeAttributeAccessor(texIdx, acc, bufferViews, buffers);
          if (decoded.ok) {
            const src = decoded.value;
            const owned = new Float32Array(src.length);
            owned.set(src);
            texcoord0 = owned;
          }
        }
      }

      // feat-20260629-multi-uv-set-support m1-w2: decode TEXCOORD_1..7
      // using the same decodeAttributeAccessor→Float32Array pattern.
      // Missing accessor → field stays undefined (no error, mirrors TEXCOORD_0).
      // componentType non-FLOAT → decodeAttributeAccessor returns error already.
      let texcoord1: Float32Array | undefined;
      let texcoord2: Float32Array | undefined;
      let texcoord3: Float32Array | undefined;
      let texcoord4: Float32Array | undefined;
      let texcoord5: Float32Array | undefined;
      let texcoord6: Float32Array | undefined;
      let texcoord7: Float32Array | undefined;
      for (let k = 1; k <= 7; k++) {
        const tcIdx = attrs[`TEXCOORD_${k}`];
        if (tcIdx === undefined) continue;
        const acc = accessors[tcIdx];
        if (acc !== undefined) {
          const decoded = decodeAttributeAccessor(tcIdx, acc, bufferViews, buffers);
          if (decoded.ok) {
            const src = decoded.value;
            const owned = new Float32Array(src.length);
            owned.set(src);
            if (k === 1) texcoord1 = owned;
            else if (k === 2) texcoord2 = owned;
            else if (k === 3) texcoord3 = owned;
            else if (k === 4) texcoord4 = owned;
            else if (k === 5) texcoord5 = owned;
            else if (k === 6) texcoord6 = owned;
            else texcoord7 = owned;
          }
        }
      }

      let tangents: Float32Array | undefined;
      const tanIdx = attrs.TANGENT;
      if (tanIdx !== undefined) {
        const acc = accessors[tanIdx];
        if (acc !== undefined) {
          const decoded = decodeAttributeAccessor(tanIdx, acc, bufferViews, buffers);
          if (decoded.ok) {
            const src = decoded.value;
            const owned = new Float32Array(src.length);
            owned.set(src);
            tangents = owned;
          }
        }
      }

      // JOINTS_0 / WEIGHTS_0 (feat-20260611 M1 w1): paired skinning attributes.
      // glTF 2.0 spec section 3.7.2.1 requires the pair to appear together for
      // any skinned primitive; lone presence -> gltf-skin-attr-asymmetric.
      // JOINTS_0 componentType: UBYTE(5121) widen->U16 via decodeAccessor
      // role='joints' (D-3 width-convert at parse), or USHORT(5123) standard
      // U16 path. WEIGHTS_0 componentType: FLOAT(5126) standard F32 path.
      const jointsIdx = attrs.JOINTS_0;
      const weightsIdx = attrs.WEIGHTS_0;
      const hasJoints = jointsIdx !== undefined;
      const hasWeights = weightsIdx !== undefined;
      if (hasJoints !== hasWeights) {
        const primitiveIndex = meshJson.primitives.indexOf(prim);
        return err(
          gltfErr('gltf-skin-attr-asymmetric', {
            meshIndex,
            primitiveIndex,
            hasJoints,
            hasWeights,
          }),
        );
      }
      let joints0: Uint16Array | undefined;
      let weights0: Float32Array | undefined;
      if (hasJoints && hasWeights) {
        const jointsAccessor = accessors[jointsIdx as number];
        const jointsBufferView = bufferViews[jointsAccessor?.bufferView ?? -1];
        if (jointsAccessor === undefined || jointsBufferView === undefined) {
          return err(unknownAccessor(jointsIdx as number));
        }
        const jointsBuffer = buffers[jointsBufferView.buffer];
        if (jointsBuffer === undefined) return err(unknownAccessor(jointsIdx as number));
        const jointsDecoded = decodeAccessor({
          accessorIndex: jointsIdx as number,
          accessor: jointsAccessor,
          bufferView: jointsBufferView,
          buffer: jointsBuffer,
          role: 'joints',
        });
        if (!jointsDecoded.ok) return err(jointsDecoded.error);
        if (jointsDecoded.value.kind !== 'u16') {
          return err(
            gltfErr('gltf-accessor-type-mismatch', {
              accessorIndex: jointsIdx as number,
              reason: 'unknownComponentType',
            }),
          );
        }
        const src = jointsDecoded.value.data;
        const owned = new Uint16Array(src.length);
        owned.set(src);
        joints0 = owned;

        const weightsAccessor = accessors[weightsIdx as number];
        const weightsBufferView = bufferViews[weightsAccessor?.bufferView ?? -1];
        if (weightsAccessor === undefined || weightsBufferView === undefined) {
          return err(unknownAccessor(weightsIdx as number));
        }
        const weightsBuffer = buffers[weightsBufferView.buffer];
        if (weightsBuffer === undefined) return err(unknownAccessor(weightsIdx as number));
        const weightsDecoded = decodeAccessor({
          accessorIndex: weightsIdx as number,
          accessor: weightsAccessor,
          bufferView: weightsBufferView,
          buffer: weightsBuffer,
          role: 'attribute',
        });
        if (!weightsDecoded.ok) return err(weightsDecoded.error);
        if (weightsDecoded.value.kind !== 'f32') {
          return err(
            gltfErr('gltf-accessor-type-mismatch', {
              accessorIndex: weightsIdx as number,
              reason: 'unknownComponentType',
            }),
          );
        }
        const wsrc = weightsDecoded.value.data;
        const wowned = new Float32Array(wsrc.length);
        wowned.set(wsrc);
        weights0 = wowned;
      }

      // bug-20260612 hello-skin visual layered gate: glTF spec marks
      // primitive.indices optional; undefined means non-indexed geometry.
      // Leave indices undefined here; bridge.ts handles the non-indexed
      // path by routing MeshAsset.indices to undefined.
      let indices: Uint16Array | Uint32Array | undefined;
      if (prim.indices !== undefined) {
        const indexAccessor = accessors[prim.indices];
        const indexBufferView = bufferViews[indexAccessor?.bufferView ?? -1];
        if (indexAccessor === undefined || indexBufferView === undefined) {
          return err(
            gltfErr('gltf-buffer-out-of-bounds', {
              accessor: prim.indices,
              byteOffset: 0,
              byteLength: 0,
              bufferIndex: indexBufferView?.buffer ?? 0,
            }),
          );
        }
        const indexBuffer = buffers[indexBufferView.buffer];
        if (indexBuffer === undefined) {
          return err(
            gltfErr('gltf-buffer-out-of-bounds', {
              accessor: prim.indices,
              byteOffset: indexBufferView.byteOffset ?? 0,
              byteLength: indexBufferView.byteLength,
              bufferIndex: indexBufferView.buffer,
            }),
          );
        }
        const indexDecoded = decodeAccessor({
          accessorIndex: prim.indices,
          accessor: indexAccessor,
          bufferView: indexBufferView,
          buffer: indexBuffer,
          role: 'indices',
        });
        if (!indexDecoded.ok) return err(indexDecoded.error);
        if (indexDecoded.value.kind === 'u16') {
          // Re-allocate over a fresh ArrayBuffer so the GltfMeshIr.indices type
          // (`Uint16Array<ArrayBuffer>`) holds without the underlying
          // SharedArrayBuffer-friendly ArrayBufferLike slot leaking through.
          const src = indexDecoded.value.data;
          const owned = new Uint16Array(src.length);
          owned.set(src);
          indices = owned;
        } else if (indexDecoded.value.kind === 'u32') {
          // U32 indices ride through end-to-end: MeshAsset.indices is
          // `Uint16Array | Uint32Array`, mesh-bin serializes iwidth=4, and
          // the GPU runtime auto-selects 'uint32' via `instanceof Uint32Array`
          // (createRenderer.ts). bridge.ts merges by value, so small meshes
          // whose maxIndex < 65536 are losslessly narrowed to Uint16 there.
          // Re-allocate over a fresh ArrayBuffer for the same reason as u16.
          const src = indexDecoded.value.data;
          const owned = new Uint32Array(src.length);
          owned.set(src);
          indices = owned;
        } else {
          return err(
            gltfErr('gltf-accessor-type-mismatch', {
              accessorIndex: prim.indices,
              reason: 'unknownComponentType',
            }),
          );
        }
      }

      const meshIr: GltfMeshIr = {
        ...(meshJson.name === undefined ? {} : { name: meshJson.name }),
        positions,
        ...(normals === undefined ? {} : { normals }),
        ...(texcoord0 === undefined ? {} : { texcoord0 }),
        ...(texcoord1 === undefined ? {} : { texcoord1 }),
        ...(texcoord2 === undefined ? {} : { texcoord2 }),
        ...(texcoord3 === undefined ? {} : { texcoord3 }),
        ...(texcoord4 === undefined ? {} : { texcoord4 }),
        ...(texcoord5 === undefined ? {} : { texcoord5 }),
        ...(texcoord6 === undefined ? {} : { texcoord6 }),
        ...(texcoord7 === undefined ? {} : { texcoord7 }),
        ...(tangents === undefined ? {} : { tangents }),
        ...(joints0 === undefined ? {} : { joints0 }),
        ...(weights0 === undefined ? {} : { weights0 }),
        ...(indices === undefined ? {} : { indices }),
        materialIndex: prim.material ?? null,
        meshIndex,
      };
      meshes.push(meshIr);
    }
  }

  // Textures, images, samplers (Tier-C: parse top-level arrays).
  const texturesJson = json.textures ?? [];
  const textures: GltfTextureIr[] = [];
  for (const texJson of texturesJson) {
    const texIr: GltfTextureIr = {
      source: texJson.source ?? -1,
      ...(texJson.sampler === undefined ? {} : { sampler: texJson.sampler }),
      ...(texJson.name === undefined ? {} : { name: texJson.name }),
    };
    textures.push(texIr);
  }

  const imagesJson = json.images ?? [];
  const images: GltfImageIr[] = [];
  for (const imgJson of imagesJson) {
    const mimeType = imgJson.mimeType;
    if (mimeType !== undefined && mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
      return err(gltfErr('gltf-image-mime-unsupported', { mimeType }));
    }
    const imgIr: GltfImageIr = {
      ...(imgJson.uri === undefined ? {} : { uri: imgJson.uri }),
      ...(imgJson.mimeType === undefined ? {} : { mimeType: imgJson.mimeType }),
      ...(imgJson.bufferView === undefined ? {} : { bufferView: imgJson.bufferView }),
      ...(imgJson.name === undefined ? {} : { name: imgJson.name }),
    };
    images.push(imgIr);
  }

  // Load external image URIs via externalLoader.
  for (const img of images) {
    if (img.uri !== undefined) {
      const dataMatch = DATA_URI_BASE64_RE.exec(img.uri);
      if (dataMatch !== null) continue; // data: URI, skip external load
      try {
        await ctx.externalLoader(img.uri);
      } catch (_e) {
        return err(gltfErr('gltf-texture-load-failed', { uri: img.uri }));
      }
    }
  }

  const samplersJson = json.samplers ?? [];
  const samplers: GltfSamplerIr[] = [];
  for (const sampJson of samplersJson) {
    samplers.push({
      ...(sampJson.magFilter === undefined ? {} : { magFilter: sampJson.magFilter }),
      ...(sampJson.minFilter === undefined ? {} : { minFilter: sampJson.minFilter }),
      wrapS: sampJson.wrapS ?? 10497, // REPEAT (glTF default)
      wrapT: sampJson.wrapT ?? 10497,
      ...(sampJson.name === undefined ? {} : { name: sampJson.name }),
    });
  }

  // Materials (Tier-C subset: pbrMetallicRoughness 6 fields + normalTexture).
  const materialsJson = json.materials ?? [];
  const materials: GltfMaterialIr[] = [];
  for (const matJson of materialsJson) {
    const pbr = matJson.pbrMetallicRoughness;
    const baseColor = pbr?.baseColorFactor ?? [1, 1, 1, 1];
    const baseColor4: readonly [number, number, number, number] = [
      baseColor[0] ?? 1,
      baseColor[1] ?? 1,
      baseColor[2] ?? 1,
      baseColor[3] ?? 1,
    ];

    materials.push({
      ...(matJson.name === undefined ? {} : { name: matJson.name }),
      baseColorFactor: baseColor4,
      metallicFactor: pbr?.metallicFactor ?? 1.0,
      roughnessFactor: pbr?.roughnessFactor ?? 1.0,
      ...(pbr?.baseColorTexture === undefined
        ? {}
        : { baseColorTexture: pbr.baseColorTexture.index }),
      ...(pbr?.metallicRoughnessTexture === undefined
        ? {}
        : { metallicRoughnessTexture: pbr.metallicRoughnessTexture.index }),
      ...(matJson.normalTexture === undefined
        ? {}
        : { normalTexture: matJson.normalTexture.index }),
    });
  }

  // Nodes + diagnostics.
  const diagnostics = {
    nodeNames: [] as string[],
    unsupportedExtensions: [...unsupportedExtensions] as string[],
    matrixTrsCoexistNodes: [] as number[],
  };
  const nodes: GltfNodeIr[] = [];
  const nodesJson = json.nodes ?? [];
  for (let nodeIndex = 0; nodeIndex < nodesJson.length; nodeIndex++) {
    const nodeJson = nodesJson[nodeIndex];
    if (nodeJson === undefined) continue;
    const transform = decomposeNodeTransform(nodeJson, nodeIndex, diagnostics);
    if (nodeJson.name !== undefined) diagnostics.nodeNames.push(nodeJson.name);
    const instancingExt = nodeJson.extensions?.EXT_mesh_gpu_instancing;
    let instancing: NodeInstancingIr | undefined;
    if (instancingExt !== undefined) {
      const instancingResult = decodeNodeInstancing(
        nodeIndex,
        instancingExt.attributes ?? {},
        accessors,
        bufferViews,
        buffers,
      );
      if (!instancingResult.ok) return err(instancingResult.error);
      instancing = instancingResult.value;
    }
    nodes.push({
      ...(nodeJson.name === undefined ? {} : { name: nodeJson.name }),
      transform,
      meshIndex: nodeJson.mesh ?? null,
      skinIndex: nodeJson.skin ?? null,
      children: nodeJson.children ?? [],
      camera: nodeJson.camera ?? null,
      ...(instancing === undefined ? {} : { instancing }),
    });
  }

  // Scenes.
  const scenesJson = json.scenes ?? [];
  const scenes: GltfSceneIr[] = scenesJson.map((s) => ({
    ...(s.name === undefined ? {} : { name: s.name }),
    nodes: s.nodes ?? [],
  }));
  const defaultSceneIndex = json.scene ?? 0;

  // Skins (feat-20260523-skin-skeleton-animation M0).
  const skinsJson = json.skins;
  const skinResult = parseSkin(skinsJson, nodesJson, accessors, bufferViews, buffers);
  if (!skinResult.ok) return err(skinResult.error);
  const skeletons = skinResult.value;

  // Animations (feat-20260523-skin-skeleton-animation M0).
  const animationsJson = json.animations;
  const animResult = parseAnimation(animationsJson, nodesJson, accessors, bufferViews, buffers);
  if (!animResult.ok) return err(animResult.error);
  const animationClips = animResult.value;

  return ok({
    meshes,
    materials,
    nodes,
    scenes,
    skeletons,
    animationClips,
    textures: textures.length > 0 ? textures : undefined,
    images: images.length > 0 ? images : undefined,
    samplers: samplers.length > 0 ? samplers : undefined,
    defaultSceneIndex,
    diagnostics: {
      nodeNames: diagnostics.nodeNames,
      unsupportedExtensions: diagnostics.unsupportedExtensions,
      matrixTrsCoexistNodes: diagnostics.matrixTrsCoexistNodes,
    },
    meshPrimitiveCount,
  });
}

/**
 * Parse a glTF 2.0 JSON document. The `externalLoader` resolves
 * `buffers[].uri` references that are NOT data: URIs (callers in Node
 * land typically wrap fs.readFile; browser callers wrap fetch).
 *
 * Pure function modulo `externalLoader` (caller-provided I/O is the
 * only side effect). No global state, no fs / network direct call.
 */
export async function parseGltf(
  json: unknown,
  externalLoader: ExternalLoader,
  filePath: string,
): Promise<Result<GltfDoc, GltfError>> {
  if (json === null || typeof json !== 'object') {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 0,
      }),
    );
  }
  return parseGltfWithBin(json as RootGltfJson, {
    externalLoader,
    filePath,
  });
}

/**
 * Parse a GLB 2.0 binary container: split into JSON + BIN chunks via
 * `parseGlbChunks`, then run the JSON document through `parseGltf` with
 * the BIN chunk wired in as buffer-0 backing storage.
 */
export async function parseGlb(
  buffer: ArrayBuffer,
  filePath: string,
): Promise<Result<GltfDoc, GltfError>> {
  const chunksResult = parseGlbChunks(buffer, filePath);
  if (!chunksResult.ok) return err(chunksResult.error);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(chunksResult.value.jsonChunk));
  } catch (_e) {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 12,
      }),
    );
  }
  if (json === null || typeof json !== 'object') {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 12,
      }),
    );
  }
  const externalLoader: ExternalLoader = async (uri: string) => {
    throw new Error(`parseGlb: GLB containers must not reference external URIs (got ${uri})`);
  };
  return parseGltfWithBin(json as RootGltfJson, {
    externalLoader,
    ...(chunksResult.value.binChunk === undefined ? {} : { binChunk: chunksResult.value.binChunk }),
    filePath,
  });
}

/**
 * Project a parsed `GltfDoc` into the disk-shape `<source>.meta.json` plus
 * the freshly minted `subAssets[]` list (UUIDv7 + reimport-reuse-meta
 * two-stage match per plan-strategy section 2.4).
 *
 * `existingMeta` is the previously-written `<source>.meta.json` parsed back
 * into memory (callers typically read + JSON.parse it before invoking).
 * `undefined` triggers first-pass full-fresh GUID minting.
 *
 * Sub-asset ordering: meshes first, then materials, then scenes - the
 * order is stable across reimports so AC-13 byte-identical holds when
 * source content does not change.
 */
export function toAssetPack(
  doc: GltfDoc,
  existingMeta: GltfMetaJson | undefined,
  source: string,
): { readonly meta: GltfMetaJson; readonly subAssets: readonly GltfSubAssetEntry[] } {
  const items: GltfDocItem[] = [];
  // Mesh sub-assets are keyed on the *original glTF mesh-index*, not on the
  // flat GltfMeshIr index. parseGltf flattens N glTF meshes with M_i primitives
  // into sum(M_i) GltfMeshIr rows (each carries its owning meshIndex). The
  // gltfImporter merges all primitives sharing a meshIndex into one MeshAsset
  // with M_i Submesh entries (one per primitive), so the meta sidecar must
  // emit exactly one `kind: 'mesh'` row per unique meshIndex — not one per
  // flat GltfMeshIr row, which would over-emit M_i sub-assets per glTF mesh and
  // desynchronise from runtime MeshRenderer.materials[].length.
  const seenMeshIndices = new Set<number>();
  for (const m of doc.meshes) {
    if (m === undefined) continue;
    if (seenMeshIndices.has(m.meshIndex)) continue;
    seenMeshIndices.add(m.meshIndex);
    items.push({
      kind: 'mesh',
      sourceIndex: m.meshIndex,
      ...(m.name === undefined ? {} : { name: m.name }),
    });
  }
  for (let i = 0; i < doc.materials.length; i++) {
    const m = doc.materials[i];
    if (m === undefined) continue;
    items.push({
      kind: 'material',
      sourceIndex: i,
      ...(m.name === undefined ? {} : { name: m.name }),
    });
  }
  for (let i = 0; i < doc.scenes.length; i++) {
    const s = doc.scenes[i];
    if (s === undefined) continue;
    items.push({
      kind: 'scene',
      sourceIndex: i,
      ...(s.name === undefined ? {} : { name: s.name }),
    });
  }
  // Texture sub-assets — one entry per `images[]` row (feat-20260608 M3 D-3,
  // requirements G-2 / AC-13). Orphan images (declared but unreferenced by
  // any `textures[]` row) still produce a sub-asset; the importer assigns
  // them colorSpace 'linear' (no colour-encoded purpose inferable). Without
  // this loop the meta carries no `kind: 'texture'` row, AssetRegistry
  // never imports the bytes, and the runtime renders a white box (G-2).
  const images = doc.images ?? [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img === undefined) continue;
    items.push({
      kind: 'texture',
      sourceIndex: i,
      ...(img.name === undefined ? {} : { name: img.name }),
    });
  }
  // Skeletons (feat-20260523-skin-skeleton-animation M0).
  for (let i = 0; i < doc.skeletons.length; i++) {
    items.push({ kind: 'skeleton', sourceIndex: i });
  }
  // Skin bindings (feat-20260523-skin-skeleton-animation M0).
  // Emit one skin sub-asset per GltfSkeletonRecord (1:1 mapping).
  for (let i = 0; i < doc.skeletons.length; i++) {
    items.push({ kind: 'skin', sourceIndex: i });
  }
  // Animation clips (feat-20260523-skin-skeleton-animation M0).
  for (let i = 0; i < doc.animationClips.length; i++) {
    items.push({ kind: 'animation-clip', sourceIndex: i });
  }

  const reuse = reimportReuseMeta(items, existingMeta);
  const meta: GltfMetaJson = {
    schemaVersion: 1,
    kind: 'external-asset-package',
    importer: 'gltf',
    source,
    subAssets: reuse.subAssets,
    importSettings: {
      defaultSceneIndex: doc.defaultSceneIndex,
      diagnostics: {
        nodeNames: doc.diagnostics.nodeNames,
        unsupportedExtensions: doc.diagnostics.unsupportedExtensions,
        matrixTrsCoexistNodes: doc.diagnostics.matrixTrsCoexistNodes,
      },
    },
  };
  return { meta, subAssets: reuse.subAssets };
}

// Suppress unused-import warning; COMPONENT_TYPE is re-exported so
// downstream consumers can grep the constants table from a single
// import. (TS strict mode would otherwise drop the binding.)
export { COMPONENT_TYPE };
