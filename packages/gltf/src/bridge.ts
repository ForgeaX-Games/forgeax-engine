// bridge.ts - public gltfDocToSceneAsset SSOT (M3 w9 / feat-20260518).
//
// Excises the previously inline 80-line implementation in
// apps/hello/gltf/src/main.ts. AI users get a single import path:
//
// ```ts
// import { gltfDocToSceneAsset, toMaterialAsset } from '@forgeax/engine-gltf';
// const scene = gltfDocToSceneAsset(doc, { meshHandles, materialHandles });
// ```
//
// Pure function: no fs, no fetch, no throw. Walks the default scene's
// node graph depth-first, accumulating world transforms for children (B3).
// Handles for mesh / material come from caller-supplied Map lookups so the
// bridge stays runtime-agnostic.
//
// feat-20260608-mesh-multi-section-primitive-multi-material-slot M3 / w13+w15:
// (B1) N prim per glTF mesh merged into 1 entity with MeshRenderer.materials[]
// (B2) visit recursively walks ir.children
// (B3) child world pos accumulates parent transform
// (B6) camera detection via GltfNodeIr.camera field (not legacy nodes[1] heuristic)

import type { Mat4 } from '@forgeax/engine-math';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import type {
  Handle,
  LocalEntityId,
  MaterialAsset,
  MaterialPassDescriptor,
  MeshAsset,
  RenderQueue,
  SceneAsset,
  SceneEntity,
  Submesh,
} from '@forgeax/engine-types';
import type { GltfDoc, GltfMaterialIr, GltfMeshIr, GltfNodeIr } from './parse-gltf.js';

/** Canonical interleaved vertex stride for the unskinned 4-attribute layout. */
const FLOATS_PER_VERTEX_12 = 12;
/**
 * Skinned 6-attribute interleaved stride: 12 floats (position/normal/uv/tangent)
 * + 4 uint16 joints reinterpreted as 2 floats + 4 float32 weights = 18 floats.
 * Skin index is written via a Uint16Array view aliasing the same buffer at the
 * 12-float offset (4 uint16 = 8 bytes = 2 float32 slots), preserving the
 * naturally aligned vertex layout WebGPU consumes via the 6-attribute
 * `deriveVertexBufferLayout` output.
 */
const FLOATS_PER_VERTEX_18 = 18;
/** Canonical base float offsets for UV1 start in interleaved (unskinned / skinned). */
const UV1_OFFSET_UNSKINNED = FLOATS_PER_VERTEX_12;
const UV1_OFFSET_SKINNED = FLOATS_PER_VERTEX_18;

/**
 * Convert one or more parsed `GltfMeshIr` primitives sharing the same glTF
 * mesh-index into a single runtime `MeshAsset` POD. Each primitive becomes one
 * `Submesh` row; per-primitive vertex data is concatenated into one big
 * interleaved vertex buffer (12 floats / vertex for unskinned meshes; 18 floats
 * / vertex when any primitive carries `joints0` + `weights0`), and per-primitive
 * index buffers are concatenated into one big index buffer. Each submesh's
 * indices are biased by the running vertex offset so they reference vertices
 * within the merged buffer.
 *
 * Per-MeshAsset stride decision (D-2): if any primitive contains skin
 * attributes, the entire MeshAsset is promoted to 18-float stride and
 * unskinned primitives' skin slots are zero-filled (joints {0,0,0,0} +
 * weights {0,0,0,0}). This avoids splitting one glTF mesh into multiple
 * MeshAsset rows when a model mixes skinned and unskinned primitives.
 *
 * AI users get a 1-to-1 mapping with `MeshRenderer.materials[]`: the i-th
 * submesh is the i-th primitive of the i-th material slot.
 *
 * Pure function (no fs / fetch / registry). Missing attributes fall back to
 * identity defaults per primitive: normal -> +Y, uv -> 0, tangent -> +X with
 * w=1.
 *
 * Throws on empty input — every glTF mesh has at least one primitive, and an
 * empty array would produce a `mesh-asset-submeshes-empty` AssetError at
 * register time anyway. Caller (gltfImporter / smoke driver) is responsible
 * for grouping by `meshIr.meshIndex` before calling.
 */
export function meshIrToMeshAsset(prims: readonly GltfMeshIr[]): MeshAsset {
  if (prims.length === 0) {
    throw new Error(
      'meshIrToMeshAsset: empty primitives array; pass at least one GltfMeshIr (every glTF mesh has >= 1 primitive)',
    );
  }
  let totalVertexCount = 0;
  let totalIndexCount = 0;
  let hasAnySkin = false;
  let hasAnyIndices = false;
  // feat-20260629-multi-uv-set-support m1-w3: scan for max UV set count across
  // all primitives so the merged interleaved stride accommodates the widest one.
  let uvSetCount = 1; // always at least texcoord0 slot
  for (const p of prims) {
    const primVc = p.positions.length / 3;
    totalVertexCount += primVc;
    if (p.indices !== undefined) {
      totalIndexCount += p.indices.length;
      hasAnyIndices = true;
    } else {
      totalIndexCount += primVc;
    }
    if (p.joints0 !== undefined && p.weights0 !== undefined) hasAnySkin = true;
    // Count present UV sets in this primitive.
    for (let k = 7; k >= 1; k--) {
      const key = `texcoord${k}` as keyof GltfMeshIr;
      if (p[key] !== undefined) {
        uvSetCount = Math.max(uvSetCount, k + 1);
        break;
      }
    }
  }

  const FLOATS_PER_VERTEX_BASE = hasAnySkin ? FLOATS_PER_VERTEX_18 : FLOATS_PER_VERTEX_12;
  const UV1_OFFSET = hasAnySkin ? UV1_OFFSET_SKINNED : UV1_OFFSET_UNSKINNED;
  // Dynamic stride: base + (uvSetCount - 1) * 2 extra floats for uv1..uvK
  const FLOATS_PER_VERTEX = FLOATS_PER_VERTEX_BASE + (uvSetCount - 1) * 2;
  const interleaved = new Float32Array(totalVertexCount * FLOATS_PER_VERTEX);
  const positionsCat = new Float32Array(totalVertexCount * 3);
  const normalsCat = new Float32Array(totalVertexCount * 3);
  const uvsCat = new Float32Array(totalVertexCount * 2);
  const tangentsCat = new Float32Array(totalVertexCount * 4);
  // feat-20260629-multi-uv-set-support m1-w3: per-UV-set standalone typed arrays
  // for MeshAsset.attributes (uv1..uvK). Allocated only when uvSetCount > 1.
  const uvCats: Float32Array[] = [];
  for (let k = 1; k < uvSetCount; k++) {
    uvCats.push(new Float32Array(totalVertexCount * 2));
  }
  // D-2 / w8: when promoted to 18-float stride, allocate parallel skinIndex
  // (Uint16Array, 4 per vertex) and skinWeight (Float32Array, 4 per vertex)
  // standalone arrays for MeshAsset.attributes. The interleaved buffer carries
  // the same data at offset 12..15 (uint16x4 via aliased view) + 16..19
  // (float32x4) for GPU upload.
  const skinIndicesCat = hasAnySkin ? new Uint16Array(totalVertexCount * 4) : undefined;
  const skinWeightsCat = hasAnySkin ? new Float32Array(totalVertexCount * 4) : undefined;
  // Aliased Uint16Array view over the interleaved Float32Array buffer. Used
  // only when hasAnySkin === true; writes 4 uint16 values per vertex starting
  // at byte offset (dst + 12) * 4, where dst is the per-vertex Float32 cursor.
  const interleavedU16 = hasAnySkin ? new Uint16Array(interleaved.buffer) : undefined;
  // Multi-primitive merge biases each primitive's index range by the running
  // vertex offset, so the merged max index is `totalVertexCount - 1`. When a
  // glTF mesh has > 65535 vertices across all primitives (common for
  // moderately complex scenes like Sponza at ~192k verts), Uint16 overflows
  // and we must widen to Uint32. WebGPU's setIndexBuffer takes 'uint16' or
  // 'uint32' (auto-selected by the runtime via TypedArray.constructor); both
  // are supported by every WebGPU device.
  // bug-20260612 hello-skin visual layered gate: when no primitive carries
  // indices (glTF non-indexed geometry per spec — primitive.indices optional),
  // route MeshAsset.indices to undefined so the runtime takes the
  // pass.draw(vertexCount) non-indexed path. Mixed bags (some prims indexed,
  // some not) synthesize identity indices for the non-indexed prims so the
  // merged MeshAsset stays single-index-buffer. hasAnyIndices === false
  // skips the index buffer allocation entirely.
  const useUint32 = totalVertexCount > 0xffff;
  const indices: Uint16Array | Uint32Array | undefined = !hasAnyIndices
    ? undefined
    : useUint32
      ? new Uint32Array(totalIndexCount)
      : new Uint16Array(totalIndexCount);
  const submeshes: Submesh[] = [];

  let vertexCursor = 0;
  let indexCursor = 0;
  for (const mesh of prims) {
    const primVertexCount = mesh.positions.length / 3;
    const primIndexCount = mesh.indices === undefined ? 0 : mesh.indices.length;
    for (let i = 0; i < primVertexCount; i++) {
      const dst = (vertexCursor + i) * FLOATS_PER_VERTEX;
      const p = i * 3;
      interleaved[dst + 0] = mesh.positions[p + 0] as number;
      interleaved[dst + 1] = mesh.positions[p + 1] as number;
      interleaved[dst + 2] = mesh.positions[p + 2] as number;
      positionsCat[(vertexCursor + i) * 3 + 0] = mesh.positions[p + 0] as number;
      positionsCat[(vertexCursor + i) * 3 + 1] = mesh.positions[p + 1] as number;
      positionsCat[(vertexCursor + i) * 3 + 2] = mesh.positions[p + 2] as number;
      if (mesh.normals !== undefined) {
        const n = i * 3;
        interleaved[dst + 3] = mesh.normals[n + 0] as number;
        interleaved[dst + 4] = mesh.normals[n + 1] as number;
        interleaved[dst + 5] = mesh.normals[n + 2] as number;
        normalsCat[(vertexCursor + i) * 3 + 0] = mesh.normals[n + 0] as number;
        normalsCat[(vertexCursor + i) * 3 + 1] = mesh.normals[n + 1] as number;
        normalsCat[(vertexCursor + i) * 3 + 2] = mesh.normals[n + 2] as number;
      } else {
        interleaved[dst + 3] = 0;
        interleaved[dst + 4] = 1;
        interleaved[dst + 5] = 0;
        normalsCat[(vertexCursor + i) * 3 + 1] = 1;
      }
      if (mesh.texcoord0 !== undefined) {
        const t = i * 2;
        interleaved[dst + 6] = mesh.texcoord0[t + 0] as number;
        interleaved[dst + 7] = mesh.texcoord0[t + 1] as number;
        uvsCat[(vertexCursor + i) * 2 + 0] = mesh.texcoord0[t + 0] as number;
        uvsCat[(vertexCursor + i) * 2 + 1] = mesh.texcoord0[t + 1] as number;
      }
      if (mesh.tangents !== undefined) {
        const g = i * 4;
        interleaved[dst + 8] = mesh.tangents[g + 0] as number;
        interleaved[dst + 9] = mesh.tangents[g + 1] as number;
        interleaved[dst + 10] = mesh.tangents[g + 2] as number;
        interleaved[dst + 11] = mesh.tangents[g + 3] as number;
        tangentsCat[(vertexCursor + i) * 4 + 0] = mesh.tangents[g + 0] as number;
        tangentsCat[(vertexCursor + i) * 4 + 1] = mesh.tangents[g + 1] as number;
        tangentsCat[(vertexCursor + i) * 4 + 2] = mesh.tangents[g + 2] as number;
        tangentsCat[(vertexCursor + i) * 4 + 3] = mesh.tangents[g + 3] as number;
      } else {
        interleaved[dst + 8] = 1;
        interleaved[dst + 9] = 0;
        interleaved[dst + 10] = 0;
        interleaved[dst + 11] = 1;
        tangentsCat[(vertexCursor + i) * 4 + 0] = 1;
        tangentsCat[(vertexCursor + i) * 4 + 3] = 1;
      }
      // D-2 / w8: when the MeshAsset is promoted to 18-float stride, write
      // joints (uint16x4 occupies 8 bytes = float slots dst+12..13, written via
      // the aliased Uint16 view starting at u16 index (dst+12)*2) and weights
      // (float32x4 at float slots dst+14..17). Total per-vertex stride is
      // 18 floats = 72 bytes, matching deriveVertexBufferLayout's offset table
      // (position 0 / normal 12 / uv 24 / tangent 32 / skinIndex 48 / skinWeight 56).
      // Unskinned primitives in a mixed MeshAsset zero-fill both slots
      // implicitly — Float32Array / Uint16Array default to 0 and we never
      // touched dst+12..17 in the unskinned branch.
      if (hasAnySkin && skinIndicesCat !== undefined && skinWeightsCat !== undefined) {
        const u16Base = (dst + 12) * 2; // float slot 12 starts at u16 index 24 within this vertex
        const skinDst = (vertexCursor + i) * 4;
        if (mesh.joints0 !== undefined && mesh.weights0 !== undefined) {
          const j = i * 4;
          const j0 = mesh.joints0[j + 0] as number;
          const j1 = mesh.joints0[j + 1] as number;
          const j2 = mesh.joints0[j + 2] as number;
          const j3 = mesh.joints0[j + 3] as number;
          (interleavedU16 as Uint16Array)[u16Base + 0] = j0;
          (interleavedU16 as Uint16Array)[u16Base + 1] = j1;
          (interleavedU16 as Uint16Array)[u16Base + 2] = j2;
          (interleavedU16 as Uint16Array)[u16Base + 3] = j3;
          skinIndicesCat[skinDst + 0] = j0;
          skinIndicesCat[skinDst + 1] = j1;
          skinIndicesCat[skinDst + 2] = j2;
          skinIndicesCat[skinDst + 3] = j3;
          const w0 = mesh.weights0[j + 0] as number;
          const w1 = mesh.weights0[j + 1] as number;
          const w2 = mesh.weights0[j + 2] as number;
          const w3 = mesh.weights0[j + 3] as number;
          interleaved[dst + 14] = w0;
          interleaved[dst + 15] = w1;
          interleaved[dst + 16] = w2;
          interleaved[dst + 17] = w3;
          skinWeightsCat[skinDst + 0] = w0;
          skinWeightsCat[skinDst + 1] = w1;
          skinWeightsCat[skinDst + 2] = w2;
          skinWeightsCat[skinDst + 3] = w3;
        }
        // else: unskinned primitive in mixed MeshAsset; zero-fill is implicit
        // because Float32Array / Uint16Array initialize to 0 and the
        // interleaved view never touched dst+12..17 above.
      }
      // feat-20260629-multi-uv-set-support m1-w3: write uv1..uvK after skin data.
      // Canonical interleaved order: position/normal/uv/tangent/skinIndex/skinWeight/uv1..uv7.
      // UV1 starts at offset UV1_OFFSET (12 for unskinned, 18 for skinned) in float slots.
      // Each additional UV set 2F. Missing texcoordK → zero-fill (plan-strategy M1).
      for (let k = 1; k < uvSetCount; k++) {
        const uvKey = `texcoord${k}` as keyof GltfMeshIr;
        const interleavedOffset = UV1_OFFSET + (k - 1) * 2;
        const catIdx = k - 1;
        const cat = uvCats[catIdx] as Float32Array;
        const catDst = (vertexCursor + i) * 2;
        const srcArr = mesh[uvKey] as Float32Array | undefined;
        if (srcArr !== undefined) {
          const t = i * 2;
          interleaved[dst + interleavedOffset + 0] = srcArr[t + 0] as number;
          interleaved[dst + interleavedOffset + 1] = srcArr[t + 1] as number;
          cat[catDst + 0] = srcArr[t + 0] as number;
          cat[catDst + 1] = srcArr[t + 1] as number;
        }
        // else: zero-fill (implicit — Float32Array defaults to 0)
      }
    }
    // Bias each submesh's indices by the running vertex offset so they
    // reference into the merged vertex buffer rather than the per-primitive
    // local 0-base. When the merged MeshAsset is non-indexed (hasAnyIndices
    // === false → `indices` is undefined here), skip the bias loop and
    // emit a vertex-only submesh (indexCount=0; runtime dispatches via
    // `pass.draw(vertexCount)`). When mixed (some prims indexed, this one
    // not), synthesize identity indices [vertexCursor..+primVertexCount-1]
    // so the merged single-index-buffer contract holds.
    if (indices !== undefined) {
      if (mesh.indices !== undefined) {
        for (let i = 0; i < primIndexCount; i++) {
          const src = mesh.indices[i] as number;
          indices[indexCursor + i] = src + vertexCursor;
        }
        submeshes.push({
          indexOffset: indexCursor,
          indexCount: primIndexCount,
          vertexCount: primVertexCount,
          topology: 'triangle-list',
        });
        indexCursor += primIndexCount;
      } else {
        // mixed bag: synthesize identity indices for this non-indexed prim
        for (let i = 0; i < primVertexCount; i++) {
          indices[indexCursor + i] = vertexCursor + i;
        }
        submeshes.push({
          indexOffset: indexCursor,
          indexCount: primVertexCount,
          vertexCount: primVertexCount,
          topology: 'triangle-list',
        });
        indexCursor += primVertexCount;
      }
    } else {
      // pure non-indexed mesh: indexCount=0, vertexCount carries draw count.
      submeshes.push({
        indexOffset: 0,
        indexCount: 0,
        vertexCount: primVertexCount,
        topology: 'triangle-list',
      });
    }
    vertexCursor += primVertexCount;
  }

  return {
    kind: 'mesh',
    vertices: interleaved,
    ...(indices === undefined ? {} : { indices }),
    submeshes,
    attributes: {
      position: positionsCat,
      normal: normalsCat,
      uv: uvsCat,
      tangent: tangentsCat,
      ...(skinIndicesCat === undefined ? {} : { skinIndex: skinIndicesCat }),
      ...(skinWeightsCat === undefined ? {} : { skinWeight: skinWeightsCat }),
      // feat-20260629-multi-uv-set-support m1-w3: per-UV-set standalone arrays
      ...Object.fromEntries(uvCats.map((cat, idx) => [`uv${idx + 1}`, cat])),
    },
  };
}

export interface GltfBridgeContext {
  /** glTF mesh index -> registry MeshAsset handle (multi-submesh). */
  readonly meshHandles: ReadonlyMap<number, Handle<'MeshAsset', 'shared'>>;
  /** glTF material index -> registry MaterialAsset handle. */
  readonly materialHandles: ReadonlyMap<number, Handle<'MaterialAsset', 'shared'>>;
  /**
   * glTF skin index -> SkeletonAsset GUID (string form). When a GltfNodeIr carries
   * a skin reference, the bridge emits `Skin: { skeleton: <guid-string> }` on
   * that node's entity; AssetRegistry._resolveSceneGuids resolves the GUID to
   * a runtime Handle at instantiate time (same protocol as MeshFilter and
   * MeshRenderer.materials[]). Optional — skinless glTFs pass an empty Map
   * (or omit the field) and the bridge does not emit Skin.
   *
   * tweak-20260611 M6 / D-7: emitting Skin from the bridge means the standard
   * loadByGuid<SceneAsset> + instantiate path Just Works for skinned glTF;
   * demos no longer need to runtime-parseGlb + post-load patch the SceneAsset.
   * postSpawnResolveJoints (called from AssetRegistry.instantiate) walks the
   * matching SkinAsset.jointPaths against the spawn subtree to fill Skin.joints[].
   */
  readonly skeletonGuidBySkinIndex?: ReadonlyMap<number, string>;
}

interface MutableSceneEntity {
  localId: LocalEntityId;
  components: Record<string, Record<string, unknown>>;
  /** Index into the external `nodes` array, set after push for ChildOf wiring. */
  localIdx: number;
}

/**
 * Convert a local TRS (translation, rotation quat, scale) into a Mat4.
 * Uses @forgeax/engine-math out-param style. `out` is mutated in place.
 */
function composeMat4(
  out: Mat4,
  tx: number,
  ty: number,
  tz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const t = vec3.create(tx, ty, tz);
  const r = quat.create();
  r[0] = qx;
  r[1] = qy;
  r[2] = qz;
  r[3] = qw;
  const s = vec3.create(sx, sy, sz);
  mat4.compose(out, t, r, s);
}

/**
 * Convert a parsed GltfDoc into a SceneAsset POD. Caller supplies registry
 * handles via `ctx`; the bridge does no registration of its own.
 *
 * Visits the default scene's nodes depth-first, accumulating world-space
 * transforms from parent to child (B3). Assigns sequential LocalEntityId in
 * document order for reimport-stable identity. Camera nodes are detected by
 * GltfNodeIr.camera (B6 fix).
 *
 * B1: each glTF mesh's N primitives are merged into a single entity.
 * The caller provides `ctx.meshHandles` keyed by glTF mesh index, where each
 * handle points to a MeshAsset whose `submeshes` already span all primitives.
 * `ctx.materialHandles` is keyed by glTF material index; the bridge assembles a
 * `MeshRenderer.materials[]` array from the primitives' materialIndex values
 * in the order they appear in `doc.meshes`.
 *
 * B2: visit recursively walks `ir.children`.
 *
 * D-2 (empty container): transform-only nodes (no mesh, no camera) produce
 * an entity with just Transform + optionally a Name component, preserving the
 * hierarchy for animation/picking hooks.
 */
export function gltfDocToSceneAsset(doc: GltfDoc, ctx: GltfBridgeContext): SceneAsset {
  const sceneIr = doc.scenes[doc.defaultSceneIndex];
  const resultNodes: MutableSceneEntity[] = [];
  if (sceneIr === undefined) return { kind: 'scene', entities: [] };

  // Per-node world matrix accumulator (B3 fix).
  const parentWorld = mat4.create();
  mat4.identity(parentWorld);
  const currentWorld = mat4.create();
  const localMat = mat4.create();

  // bug-20260613: SceneAsset entities also emit ChildOf when a glTF node has a
  // parent (line 547 below). Runtime propagateTransforms then derives
  // Transform.world via `parent.world * compose(child.local TRS)`. If we
  // wrote the *world* TRS into Transform here, every child node would get
  // baked twice -- once at importer time and again at propagate time --
  // collapsing the skin so vertices fly to (parent.world)^2 space and the
  // mesh appears as a scrambled silhouette. Mirror GltfNodeIr.transform's local
  // TRS verbatim; propagateTransforms is the single accumulation path.
  const pushLocalTransform = (
    transform: import('./transform.js').DecomposedTransform,
  ): Record<string, unknown> => ({
    posX: transform.translation[0] ?? 0,
    posY: transform.translation[1] ?? 0,
    posZ: transform.translation[2] ?? 0,
    quatX: transform.rotation[0] ?? 0,
    quatY: transform.rotation[1] ?? 0,
    quatZ: transform.rotation[2] ?? 0,
    quatW: transform.rotation[3] ?? 1,
    scaleX: transform.scale[0] ?? 1,
    scaleY: transform.scale[1] ?? 1,
    scaleZ: transform.scale[2] ?? 1,
  });

  const visit = (gltfNodeIdx: number, parentLocalIdx: number | null): void => {
    const ir = doc.nodes[gltfNodeIdx];
    if (ir === undefined) return;

    // Compute local transform matrix
    composeMat4(
      localMat,
      ir.transform.translation[0] ?? 0,
      ir.transform.translation[1] ?? 0,
      ir.transform.translation[2] ?? 0,
      ir.transform.rotation[0] ?? 0,
      ir.transform.rotation[1] ?? 0,
      ir.transform.rotation[2] ?? 0,
      ir.transform.rotation[3] ?? 1,
      ir.transform.scale[0] ?? 1,
      ir.transform.scale[1] ?? 1,
      ir.transform.scale[2] ?? 1,
    );

    // Accumulate world transform (B3: parent * local)
    if (parentLocalIdx === null) {
      // Root node: world = local
      for (let i = 0; i < 16; i++) {
        currentWorld[i] = localMat[i] ?? 0;
      }
    } else {
      mat4.multiply(currentWorld, parentWorld, localMat);
    }

    // B6: detect camera via GltfNodeIr.camera field (not legacy heuristic)
    const isCamera = ir.camera !== null;

    // D-2: empty container rule
    // - mesh node: MeshFilter + MeshRenderer
    // - camera node: Camera (standalone entity)
    // - transform-only node (no mesh, no camera): Transform-only entity to preserve hierarchy
    const hasMesh = ir.meshIndex !== null;

    // Always produce a node for every glTF node (preserves hierarchy).
    // Transform-only nodes carry just Transform + optionally Name.
    const components: Record<string, Record<string, unknown>> = {
      Transform: pushLocalTransform(ir.transform),
    };

    if (ir.name !== undefined && ir.name !== '') {
      components.Name = { value: ir.name };
    }

    if (hasMesh) {
      const meshHandle = ctx.meshHandles.get(ir.meshIndex as number);
      if (meshHandle !== undefined) {
        components.MeshFilter = { assetHandle: meshHandle };
      }
      // tweak-20260611 M6: when this node references a glTF skin, stamp a
      // Skin component carrying the SkeletonAsset GUID as a string. The
      // runtime AssetRegistry._resolveSceneGuids resolves the string to a
      // Handle at instantiate time (same protocol as MeshFilter/MeshRenderer).
      // postSpawnResolveJoints (called from AssetRegistry.instantiate) then
      // fills Skin.joints[] by walking the matching SkinAsset.jointPaths
      // against the spawn subtree's Name index.
      if (ir.skinIndex !== null && ctx.skeletonGuidBySkinIndex !== undefined) {
        const skeletonGuid = ctx.skeletonGuidBySkinIndex.get(ir.skinIndex);
        if (skeletonGuid !== undefined) {
          components.Skin = { skeleton: skeletonGuid };
        }
      }
      // B1: collect one material handle per primitive belonging to THIS
      // node's glTF mesh (filter by meshIr.meshIndex === ir.meshIndex), in
      // the same order primitives are emitted in `doc.meshes`. The merged
      // MeshAsset built by `meshIrToMeshAsset` walks the same filter in the
      // same order to produce one Submesh per primitive, so submeshes[i]
      // pairs with materials[i] positionally (AGENTS.md §Component naming
      // "positional materials[i] <-> submeshes[i]" + #317 multi-material
      // contract).
      //
      // A primitive with materialIndex===null (or one whose ctx.materialHandles
      // lookup misses) gets a synthetic missing-handle entry: dropping it
      // would desynchronise materials[].length vs submeshes[].length and
      // trigger the fail-fast `mesh-renderer-material-count-mismatch` at
      // register time. Falling back to the first available material handle
      // for the same mesh keeps the count alignment without inventing a
      // shared default-material handle (Tier-B scope; Sponza / BoxTextured
      // every primitive carries an explicit material so this fallback path
      // is exercised only by under-specified glTFs).
      const materialHandles: unknown[] = [];
      let firstMatHandle: unknown | undefined;
      for (const meshIr of doc.meshes) {
        if (meshIr.meshIndex !== (ir.meshIndex as number)) continue;
        const matIdx = meshIr.materialIndex;
        let handle: unknown | undefined;
        if (matIdx !== null) {
          handle = ctx.materialHandles.get(matIdx);
        }
        if (handle !== undefined) {
          firstMatHandle = handle;
          break;
        }
      }
      for (const meshIr of doc.meshes) {
        if (meshIr.meshIndex !== (ir.meshIndex as number)) continue;
        const matIdx = meshIr.materialIndex;
        let handle: unknown | undefined;
        if (matIdx !== null) {
          handle = ctx.materialHandles.get(matIdx);
        }
        if (handle === undefined) handle = firstMatHandle;
        if (handle !== undefined) materialHandles.push(handle);
      }
      if (materialHandles.length > 0) {
        components.MeshRenderer = { materials: materialHandles };
      }
    }

    // Instances on the same entity as MeshFilter/MeshRenderer.
    if (ir.instancing !== undefined) {
      components.Instances = { transforms: ir.instancing.transforms };
    }

    if (isCamera) {
      // B6: camera node detected via GltfNodeIr.camera (not heuristic).
      // Camera component sits alongside Transform (and Name if present).
      components.Camera = {
        fov: 0.7853981633974483,
        aspect: 1.7777777777777777,
        near: 0.1,
        far: 100,
      };
    }

    const localIdx = resultNodes.length;
    const node: MutableSceneEntity = {
      localId: localIdx as LocalEntityId,
      components,
      localIdx,
    };

    // ChildOf wiring: if this node has a parent, add ChildOf component
    if (parentLocalIdx !== null) {
      node.components.ChildOf = { parent: parentLocalIdx as LocalEntityId };
    }

    resultNodes.push(node);

    // B2: recursively visit children with accumulated world matrix.
    // B3: set parentWorld to this node's world matrix so children multiply
    // correctly (parent * childLocal = childWorld).
    const savedParent = mat4.clone(parentWorld);
    for (let i = 0; i < 16; i++) parentWorld[i] = currentWorld[i] ?? 0;

    for (const childIdx of ir.children) {
      visit(childIdx, localIdx);
    }

    // Restore parent world after visiting all children
    for (let i = 0; i < 16; i++) parentWorld[i] = savedParent[i] ?? 0;
  };

  for (const rootIdx of sceneIr.nodes) visit(rootIdx, null);

  const frozen: SceneEntity[] = resultNodes.map((n) => ({
    localId: n.localId,
    components: n.components,
  }));
  return { kind: 'scene', entities: frozen };
}

/** Internal helper: mark GltfNodeIr usable so future surface evolutions stay typed. */
export type _NodeIrAlias = GltfNodeIr;

export interface MaterialBridgeContext {
  /** glTF texture index -> registry TextureAsset handle. */
  readonly textureHandles?: ReadonlyMap<number, Handle<'TextureAsset', 'shared'>>;
  /** glTF sampler index -> registry SamplerAsset handle. */
  readonly samplerHandles?: ReadonlyMap<number, Handle<'SamplerAsset', 'shared'>>;
  /**
   * feat-20260611 w17-a: when any primitive consuming this material carries
   * JOINTS_0 + WEIGHTS_0, the cooker passes `skinned: true` so the emitted
   * MaterialAsset's pass[0].shader is `forgeax::pbr-skin` instead of
   * `forgeax::default-standard-pbr`. The cooker (gltf-importer) is the only
   * site with full mesh<->material wiring info; routing here keeps shader
   * choice content-driven (not user-driven, per Q4 — runtime fail-fast in
   * render-system-extract remains the reverse-direction safety net).
   */
  readonly skinned?: boolean;
}

/**
 * Convert a parsed GltfMaterialIr into a pass-based MaterialAsset POD
 * (feat-20260526-material-asset-multipass-renderstate M4 / w29).
 *
 * Maps glTF material fields to paramValues:
 *
 * | glTF field               | param key                |
 * |:-------------------------|:-------------------------|
 * | baseColorFactor          | baseColor                |
 * | metallicFactor           | metallic                 |
 * | roughnessFactor          | roughness                |
 * | baseColorTexture (index) | baseColorTexture         |
 * | metallicRoughnessTexture | metallicRoughnessTexture |
 * | normalTexture (index)    | normalTexture            |
 *
 * The output MaterialAsset uses `forgeax::default-standard-pbr` shader
 * in a single Forward pass at RenderQueue.Geometry.
 *
 * Caller provides registry handles via `ctx`; the bridge does no registration
 * of its own. AI users compose this with `AssetRegistry.register`:
 *
 * ```ts
 * const matAsset = toMaterialAsset(materialIr, {
 *   textureHandles: buildTextureHandleMap(),
 *   samplerHandles: buildSamplerHandleMap(),
 * });
 * const h = assets.register<MaterialAsset>(matAsset);
 * ```
 */
export function toMaterialAsset(mat: GltfMaterialIr, ctx?: MaterialBridgeContext): MaterialAsset {
  const paramValues: Record<string, unknown> = {
    baseColor: mat.baseColorFactor.slice(0, 3) as [number, number, number],
    metallic: mat.metallicFactor,
    roughness: mat.roughnessFactor,
  };

  if (ctx?.textureHandles !== undefined) {
    if (mat.baseColorTexture !== undefined) {
      const h = ctx.textureHandles.get(mat.baseColorTexture);
      if (h !== undefined) paramValues.baseColorTexture = h;
    }
    if (mat.metallicRoughnessTexture !== undefined) {
      const h = ctx.textureHandles.get(mat.metallicRoughnessTexture);
      if (h !== undefined) paramValues.metallicRoughnessTexture = h;
    }
    if (mat.normalTexture !== undefined) {
      const h = ctx.textureHandles.get(mat.normalTexture);
      if (h !== undefined) paramValues.normalTexture = h;
    }
  }

  if (ctx?.samplerHandles !== undefined && ctx.samplerHandles.size > 0) {
    const firstSampler = ctx.samplerHandles.values().next();
    if (firstSampler.value !== undefined) {
      paramValues.sampler = firstSampler.value;
    }
  }

  const shader = ctx?.skinned === true ? 'forgeax::pbr-skin' : 'forgeax::default-standard-pbr';

  // UV-set tiling: glTF `baseColorTexture.texCoord` selects which vertex UV set
  // the material's textures sample. The built-in PBR now declares a second UV
  // set (@location(6) uv1) and honors a per-material `uvSet` selector in the
  // material UBO (feat-city-glb multi-UV tiling). We emit the selector when the
  // material samples a non-zero set (default 0 -> set 0, byte-identical to the
  // prior single-UV path). A single per-material selector suffices: within a
  // glTF material every textured slot shares one texCoord in practice (verified
  // on the UE5 city_Sample asset -- 433/452 materials at texCoord=1, zero with
  // slots split across sets); glTF's theoretical per-slot texCoord divergence is
  // a future extension. Sets >=2 clamp to set 1 (the shader forwards uv0/uv1).
  if (mat.baseColorTexCoord !== undefined && mat.baseColorTexCoord > 0) {
    paramValues.uvSet = mat.baseColorTexCoord;
  }

  // feat: map glTF alphaMode to render state. BLEND -> straight (non-
  // premultiplied) alpha blend + Transparent queue (glTF BLEND is straight
  // alpha; the PBR fs outputs baseColor.a * sample.a un-premultiplied). The
  // presence of renderState.blend is the runtime's SSOT for transparent
  // routing (back-to-front sort + composite). OPAQUE / MASK stay in the
  // opaque Geometry queue. (MASK alpha-testing needs a shader discard the
  // built-in PBR does not yet implement; routed opaque for now.)
  const isBlend = mat.alphaMode === 'BLEND';
  const straightAlphaBlend = {
    color: {
      srcFactor: 'src-alpha' as const,
      dstFactor: 'one-minus-src-alpha' as const,
      operation: 'add' as const,
    },
    alpha: {
      srcFactor: 'one' as const,
      dstFactor: 'one-minus-src-alpha' as const,
      operation: 'add' as const,
    },
  };

  // feat-city-glb Bug 5: transparent (BLEND) materials read but do NOT write
  // depth (`depthWriteEnabled: false`), matching the engine's own transparent
  // convention (learn-render 4.3 blending window material). glTF decals are
  // frequently coplanar with the opaque surface they overlay (e.g. a crosswalk
  // decal on the road); writing depth would z-fight / self-occlude. Back-to-
  // front ordering is handled by the Transparent queue + transparent sort.
  const pass: MaterialPassDescriptor = {
    name: 'Forward',
    shader,
    tags: { LightMode: 'Forward' },
    queue: (isBlend ? 3000 : 2000) as RenderQueue,
    ...(isBlend ? { renderState: { blend: straightAlphaBlend, depthWriteEnabled: false } } : {}),
  };

  return {
    kind: 'material',
    passes: [pass],
    paramValues,
  };
}
