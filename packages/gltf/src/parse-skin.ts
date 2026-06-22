// parse-skin.ts - glTF skin parser (feat-20260523-skin-skeleton-animation M0).
//
// Implements parseSkin(): parses glTF `skins[]` array into GltfSkeletonRecord[]
// with IBM (inverse bind matrices) and jointPaths (Name-component path from
// scene root). Used by parseGltfWithBin to populate GltfDoc.
//
// Decision anchors:
//   - plan-strategy D-1 (3-asset separation: IBM / skin binding / animation clip)
//   - plan-strategy D-2 (skin index dedupe via reimport reuse managed by toAssetPack)
//   - requirements AC-03 (skin index dedupe), AC-05 (jointPaths + Name missing fail-fast)
//   - requirements AC-10 (IR extension), AC-27 (BindPose static AABB)
//   - plan-strategy D-11 (BindPose AABB importer-phase, per-frame zero cost)
//   - charter P3 (fail-fast on invalid data)

import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';

/** Maximum joints per skin (glTF spec practical limit). */
const MAX_JOINTS = 256;

/**
 * Skeleton intermediate representation produced by parseSkin.
 *
 * Each entry corresponds to one glTF skin[] index. `jointPaths` is a
 * parallel array to the skeleton's joints; each path is the sequence of
 * Name-component values from the scene root to the joint node.
 */
export interface GltfSkeletonRecord {
  /** Number of joints in this skeleton (= IBM length / 16). */
  readonly jointCount: number;
  /** Inverse bind matrices, Float32Array of length jointCount * 16. */
  readonly inverseBindMatrices: Float32Array;
  /** Per-joint Name path from scene root (parallel to joints array). */
  readonly jointPaths: readonly string[];
}

interface SkinJson {
  readonly name?: string;
  readonly joints: readonly number[];
  readonly inverseBindMatrices?: number;
}

interface NodeJson {
  readonly name?: string;
  readonly mesh?: number;
  readonly children?: readonly number[];
  readonly skin?: number;
}

interface AccessorJson {
  readonly bufferView?: number;
  readonly componentType: number;
  readonly type: string;
  readonly count: number;
  readonly byteOffset?: number;
}

interface BufferViewJson {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
}

/** Build a column-major mat4 identity Float32Array (16 floats). */
function identityMat4(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** Decode a MAT4 F32 accessor into a Float32Array of N*16 floats. */
function decodeMat4Accessor(
  accessorIndex: number,
  accessor: AccessorJson,
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<Float32Array, GltfError> {
  if (accessor.type !== 'MAT4' || accessor.componentType !== 5126) {
    return err(
      gltfErr('gltf-accessor-type-mismatch', { accessorIndex, reason: 'unknownComponentType' }),
    );
  }
  const bvIndex = accessor.bufferView;
  if (bvIndex === undefined) {
    return err(
      gltfErr('gltf-buffer-out-of-bounds', {
        accessor: accessorIndex,
        byteOffset: 0,
        byteLength: 0,
        bufferIndex: 0,
      }),
    );
  }
  const bv = bufferViews[bvIndex];
  if (bv === undefined) {
    return err(
      gltfErr('gltf-buffer-out-of-bounds', {
        accessor: accessorIndex,
        byteOffset: 0,
        byteLength: 0,
        bufferIndex: bvIndex,
      }),
    );
  }
  const buf = buffers[bv.buffer];
  if (buf === undefined) {
    return err(
      gltfErr('gltf-buffer-out-of-bounds', {
        accessor: accessorIndex,
        byteOffset: bv.byteOffset ?? 0,
        byteLength: bv.byteLength,
        bufferIndex: bv.buffer,
      }),
    );
  }
  const elementSize = 16 * 4; // 16 floats * 4 bytes each
  const totalBytes = elementSize * accessor.count;
  const absoluteOffset = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (absoluteOffset + totalBytes > buf.byteLength) {
    return err(
      gltfErr('gltf-buffer-out-of-bounds', {
        accessor: accessorIndex,
        byteOffset: absoluteOffset,
        byteLength: totalBytes,
        bufferIndex: bv.buffer,
      }),
    );
  }
  const out = new Float32Array(accessor.count * 16);
  const src = new Float32Array(buf.buffer, buf.byteOffset + absoluteOffset, out.length);
  out.set(src);
  return ok(out);
}

/**
 * Build the jointPath for a single joint: find the Name-component path from
 * the root of the scene graph to the joint node.
 *
 * Uses recursive BFS-like upward traversal: for each joint node index,
 * find the node's name and verify it's reachable from root.
 * Returns the sequence of names from root to joint.
 *
 * On first miss (node has no name), emits 'gltf-skin-joint-name-missing'.
 */
function resolveJointPath(
  nodeIndex: number,
  nodes: readonly NodeJson[],
  skinIndex: number,
  jointPathIndex: number,
): Result<readonly string[], GltfError> {
  // Build parent map by walking all nodes' children arrays.
  const parentOf = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n === undefined) continue;
    for (const child of n.children ?? []) {
      parentOf.set(child, i);
    }
  }

  // Walk upward from the joint node to find the path from root.
  // Then reverse to get root->joint order.
  const pathReversed: string[] = [];
  let current = nodeIndex;
  while (true) {
    const node = nodes[current];
    if (node === undefined) break;

    const name = node.name;
    if (name === undefined || name === '') {
      return err(
        gltfErr('gltf-skin-joint-name-missing', { skinIndex, jointPathIndex, nodeIndex: current }),
      );
    }
    pathReversed.push(name);

    const parent = parentOf.get(current);
    if (parent === undefined) break;
    current = parent;
  }

  return ok(pathReversed.reverse());
}

/**
 * Parse glTF skins[] array into GltfSkeletonRecord[].
 *
 * For each skin:
 * 1. Decode IBM accessor (or fill identity if absent)
 * 2. Resolve jointPaths from scene node hierarchy
 * 3. Fail-fast on joint count > MAX_JOINTS or missing joint names
 */
export function parseSkin(
  skinsJson: readonly SkinJson[] | undefined,
  nodesJson: readonly NodeJson[],
  accessors: readonly AccessorJson[],
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<readonly GltfSkeletonRecord[], GltfError> {
  if (skinsJson === undefined || skinsJson.length === 0) {
    return ok([]);
  }

  const records: GltfSkeletonRecord[] = [];

  for (let skinIdx = 0; skinIdx < skinsJson.length; skinIdx++) {
    const skin = skinsJson[skinIdx];
    if (skin === undefined) continue;

    const joints = skin.joints;
    if (joints.length > MAX_JOINTS) {
      return err(
        gltfErr('gltf-skin-joint-count-exceeded', {
          skinIndex: skinIdx,
          jointCount: joints.length,
          maxJoints: MAX_JOINTS,
        }),
      );
    }

    // Decode IBM, or fill identity matrix.
    let ibm: Float32Array;
    if (skin.inverseBindMatrices !== undefined) {
      const ibmAccIdx = skin.inverseBindMatrices;
      const ibmAcc = accessors[ibmAccIdx];
      if (ibmAcc === undefined) {
        return err(
          gltfErr('gltf-buffer-out-of-bounds', {
            accessor: ibmAccIdx,
            byteOffset: 0,
            byteLength: 0,
            bufferIndex: 0,
          }),
        );
      }
      const ibmResult = decodeMat4Accessor(ibmAccIdx, ibmAcc, bufferViews, buffers);
      if (!ibmResult.ok) return err(ibmResult.error);
      ibm = ibmResult.value;
    } else {
      // Fill identity: each joint gets a 4x4 identity.
      ibm = new Float32Array(joints.length * 16);
      for (let j = 0; j < joints.length; j++) {
        ibm.set(identityMat4(), j * 16);
      }
    }

    // Resolve jointPaths.
    const jointPaths: string[] = [];
    for (let j = 0; j < joints.length; j++) {
      const jointNodeIndex = joints[j];
      if (jointNodeIndex === undefined) continue;
      const pathResult = resolveJointPath(jointNodeIndex, nodesJson, skinIdx, j);
      if (!pathResult.ok) return err(pathResult.error);
      jointPaths.push(pathResult.value.join('/'));
    }

    records.push({
      jointCount: joints.length,
      inverseBindMatrices: ibm,
      jointPaths,
    });
  }

  return ok(records);
}

/**
 * Compute the BindPose static AABB for a skinned mesh's vertex positions.
 *
 * At bind pose, joint_bind = IBM^{-1}, so skinning collapses:
 *   world_pos = Sum(w_i * joint_bind_i * IBM_i * local_pos) = local_pos
 * Therefore the BindPose AABB is simply the local position bounds.
 *
 * Per-frame zero cost: stored in mesh asset metadata at importer time.
 * Dynamic AABB for animated poses is deferred to OOS-skin-dyn-bounds.
 *
 * Returns { min: [x,y,z], max: [x,y,z] } or undefined if positions is empty.
 */
export function computeBindPoseAABB(positions: Float32Array):
  | {
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    }
  | undefined {
  if (positions.length < 3) return undefined;
  let minX = positions[0] ?? 0;
  let minY = positions[1] ?? 0;
  let minZ = positions[2] ?? 0;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (let i = 3; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Re-export MAX_JOINTS for use by downstream modules. */
export { MAX_JOINTS };
