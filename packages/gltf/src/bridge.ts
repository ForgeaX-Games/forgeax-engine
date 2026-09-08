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

import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import type { Mat4 } from '@forgeax/engine-math';
import { box3, mat4, quat, vec3 } from '@forgeax/engine-math';
import { AssetGuid as AssetGuidCodec } from '@forgeax/engine-pack/guid';
import type {
  AssetGuid,
  Handle,
  LocalEntityId,
  MaterialAsset,
  MaterialError,
  MaterialTextureValue,
  MeshAsset,
  MeshMaterialSlot,
  MorphTarget,
  RenderQueue,
  Result,
  SceneAsset,
  SceneEntity,
  Submesh,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { createMaterialError, err, type GltfError, gltfErr, ok } from './errors.js';
import type {
  GltfDoc,
  GltfMaterialIr,
  GltfMeshIr,
  GltfNodeIr,
  GltfPunctualLightIr,
  GltfTextureInfoIr,
} from './parse-gltf.js';

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
 * Invalid source data is returned as a typed `GltfError`; callers must branch
 * on `Result.ok` before publishing a MeshAsset. Caller (gltfImporter / smoke
 * driver) is responsible for grouping by `meshIr.meshIndex` before calling.
 */
export function meshIrToMeshAsset(
  prims: readonly GltfMeshIr[],
  materials: {
    readonly guidByIndex?: ReadonlyMap<number, string>;
    readonly nameByIndex?: ReadonlyMap<number, string>;
    readonly sourceKeyByIndex?: ReadonlyMap<number, string>;
  } = {},
): Result<MeshAsset, GltfError> {
  if (prims.length === 0) {
    return err(
      gltfErr('gltf-mesh-bridge-invalid', {
        reason: 'empty-input',
        primitiveCount: 0,
      }),
    );
  }
  let totalVertexCount = 0;
  let totalIndexCount = 0;
  let hasAnySkin = false;
  const hasAnyColor = prims.some((p) => p.colors0 !== undefined);
  let hasAnyIndices = false;
  // feat-20260629-multi-uv-set-support m1-w3: derive the widest canonical UV
  // key list across all primitives so the geometry projection accommodates it.
  let widestUvIndex = 0;
  const morphTargetCount = prims[0]?.morphTargets?.length ?? 0;
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
    if ((p.morphTargets?.length ?? 0) !== morphTargetCount) {
      return err(
        gltfErr('gltf-mesh-bridge-invalid', {
          meshIndex: p.meshIndex,
          primitiveIndex: prims.indexOf(p),
          reason: 'morph-count-mismatch',
          expectedTargetCount: morphTargetCount,
          actualTargetCount: p.morphTargets?.length ?? 0,
        }),
      );
    }
    // Count present UV sets in this primitive.
    for (let k = 7; k >= 1; k--) {
      const key = `texcoord${k}` as keyof GltfMeshIr;
      if (p[key] !== undefined) {
        widestUvIndex = Math.max(widestUvIndex, k);
        break;
      }
    }
  }

  const uvKeys = Array.from({ length: widestUvIndex }, (_, index) => `uv${index + 1}`);

  const positionsCat = new Float32Array(totalVertexCount * 3);
  const normalsCat = new Float32Array(totalVertexCount * 3);
  const uvsCat = new Float32Array(totalVertexCount * 2);
  const tangentsCat = new Float32Array(totalVertexCount * 4);
  const colorsCat = hasAnyColor ? new Float32Array(totalVertexCount * 4) : undefined;
  const morphTargets: MorphTarget[] = Array.from({ length: morphTargetCount }, (_, targetIndex) => {
    const source = prims[0]?.morphTargets?.[targetIndex];
    return {
      ...(source?.position === undefined
        ? {}
        : { position: new Float32Array(totalVertexCount * 3) }),
      ...(source?.normal === undefined ? {} : { normal: new Float32Array(totalVertexCount * 3) }),
      ...(source?.tangent === undefined ? {} : { tangent: new Float32Array(totalVertexCount * 4) }),
    };
  });
  // feat-20260629-multi-uv-set-support m1-w3: per-UV-set standalone typed arrays
  // for MeshAsset.attributes (uv1..uvK). Allocated only for imported sets.
  const uvCats = uvKeys.map(() => new Float32Array(totalVertexCount * 2));
  // D-2 / w8: when promoted to a skinned projection, retain canonical
  // standalone arrays; the geometry packer owns the interleaved GPU bytes.
  const skinIndicesCat = hasAnySkin ? new Uint16Array(totalVertexCount * 4) : undefined;
  const skinWeightsCat = hasAnySkin ? new Float32Array(totalVertexCount * 4) : undefined;
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
  const materialSlots: MeshMaterialSlot[] = [];
  const slotByMaterial = new Map<number | null, number>();
  const usedNames = new Set<string>();
  const uniqueSlotName = (base: string): string => {
    let candidate = base.trim() || 'Material';
    let suffix = 2;
    while (usedNames.has(candidate)) candidate = `${base}_${suffix++}`;
    usedNames.add(candidate);
    return candidate;
  };
  const slotFor = (materialIndex: number | null): number => {
    const existing = slotByMaterial.get(materialIndex);
    if (existing !== undefined) return existing;
    const slotIndex = materialSlots.length;
    const guid = materialIndex === null ? undefined : materials.guidByIndex?.get(materialIndex);
    const parsed = guid === undefined ? undefined : AssetGuidCodec.parse(guid);
    materialSlots.push({
      slotName: uniqueSlotName(
        materialIndex === null
          ? 'Default'
          : (materials.nameByIndex?.get(materialIndex) ?? `Material_${materialIndex}`),
      ),
      sourceKey:
        materialIndex === null
          ? 'gltf:default'
          : (materials.sourceKeyByIndex?.get(materialIndex) ?? `gltf:material:${materialIndex}`),
      ...(parsed?.ok ? { defaultMaterial: parsed.value } : {}),
    });
    slotByMaterial.set(materialIndex, slotIndex);
    return slotIndex;
  };

  let vertexCursor = 0;
  let indexCursor = 0;
  for (const mesh of prims) {
    const materialSlot = slotFor(mesh.materialIndex);
    const primVertexCount = mesh.positions.length / 3;
    const primIndexCount = mesh.indices === undefined ? 0 : mesh.indices.length;
    if (mesh.colors0 !== undefined && mesh.colors0.length !== primVertexCount * 4) {
      return err(
        gltfErr('gltf-mesh-bridge-invalid', {
          meshIndex: mesh.meshIndex,
          primitiveIndex: prims.indexOf(mesh),
          reason: 'color-cardinality',
          semantic: 'COLOR_0',
          vertexCount: primVertexCount,
          expectedLength: primVertexCount * 4,
          actualLength: mesh.colors0.length,
        }),
      );
    }
    for (let i = 0; i < primVertexCount; i++) {
      const p = i * 3;
      positionsCat[(vertexCursor + i) * 3 + 0] = mesh.positions[p + 0] as number;
      positionsCat[(vertexCursor + i) * 3 + 1] = mesh.positions[p + 1] as number;
      positionsCat[(vertexCursor + i) * 3 + 2] = mesh.positions[p + 2] as number;
      if (mesh.normals !== undefined) {
        const n = i * 3;
        normalsCat[(vertexCursor + i) * 3 + 0] = mesh.normals[n + 0] as number;
        normalsCat[(vertexCursor + i) * 3 + 1] = mesh.normals[n + 1] as number;
        normalsCat[(vertexCursor + i) * 3 + 2] = mesh.normals[n + 2] as number;
      } else {
        normalsCat[(vertexCursor + i) * 3 + 1] = 1;
      }
      if (mesh.texcoord0 !== undefined) {
        const t = i * 2;
        uvsCat[(vertexCursor + i) * 2 + 0] = mesh.texcoord0[t + 0] as number;
        uvsCat[(vertexCursor + i) * 2 + 1] = mesh.texcoord0[t + 1] as number;
      }
      if (mesh.tangents !== undefined) {
        const g = i * 4;
        tangentsCat[(vertexCursor + i) * 4 + 0] = mesh.tangents[g + 0] as number;
        tangentsCat[(vertexCursor + i) * 4 + 1] = mesh.tangents[g + 1] as number;
        tangentsCat[(vertexCursor + i) * 4 + 2] = mesh.tangents[g + 2] as number;
        tangentsCat[(vertexCursor + i) * 4 + 3] = mesh.tangents[g + 3] as number;
      } else {
        tangentsCat[(vertexCursor + i) * 4 + 0] = 1;
        tangentsCat[(vertexCursor + i) * 4 + 3] = 1;
      }
      if (colorsCat !== undefined) {
        const colorDst = (vertexCursor + i) * 4;
        const colorSrc = i * 4;
        if (mesh.colors0 === undefined) {
          colorsCat[colorDst + 0] = 1;
          colorsCat[colorDst + 1] = 1;
          colorsCat[colorDst + 2] = 1;
          colorsCat[colorDst + 3] = 1;
        } else {
          colorsCat[colorDst + 0] = mesh.colors0[colorSrc + 0] as number;
          colorsCat[colorDst + 1] = mesh.colors0[colorSrc + 1] as number;
          colorsCat[colorDst + 2] = mesh.colors0[colorSrc + 2] as number;
          colorsCat[colorDst + 3] = mesh.colors0[colorSrc + 3] as number;
        }
      }
      for (let targetIndex = 0; targetIndex < morphTargetCount; targetIndex++) {
        const source = mesh.morphTargets?.[targetIndex];
        const target = morphTargets[targetIndex] as MorphTarget;
        const vertex = vertexCursor + i;
        if (source?.position !== undefined && target.position !== undefined) {
          target.position.set(source.position.subarray(i * 3, i * 3 + 3), vertex * 3);
        }
        if (source?.normal !== undefined && target.normal !== undefined) {
          target.normal.set(source.normal.subarray(i * 3, i * 3 + 3), vertex * 3);
        }
        if (source?.tangent !== undefined && target.tangent !== undefined) {
          target.tangent.set(source.tangent.subarray(i * 4, i * 4 + 4), vertex * 4);
        }
      }
      // D-2 / w8: when the MeshAsset is promoted to a skinned projection,
      // retain both canonical standalone arrays. The geometry packer writes
      // their typed values into the canonical interleaved byte layout once.
      if (hasAnySkin && skinIndicesCat !== undefined && skinWeightsCat !== undefined) {
        const skinDst = (vertexCursor + i) * 4;
        if (mesh.joints0 !== undefined && mesh.weights0 !== undefined) {
          const j = i * 4;
          const j0 = mesh.joints0[j + 0] as number;
          const j1 = mesh.joints0[j + 1] as number;
          const j2 = mesh.joints0[j + 2] as number;
          const j3 = mesh.joints0[j + 3] as number;
          skinIndicesCat[skinDst + 0] = j0;
          skinIndicesCat[skinDst + 1] = j1;
          skinIndicesCat[skinDst + 2] = j2;
          skinIndicesCat[skinDst + 3] = j3;
          const w0 = mesh.weights0[j + 0] as number;
          const w1 = mesh.weights0[j + 1] as number;
          const w2 = mesh.weights0[j + 2] as number;
          const w3 = mesh.weights0[j + 3] as number;
          skinWeightsCat[skinDst + 0] = w0;
          skinWeightsCat[skinDst + 1] = w1;
          skinWeightsCat[skinDst + 2] = w2;
          skinWeightsCat[skinDst + 3] = w3;
        }
        // else: unskinned primitive in a mixed MeshAsset; typed arrays remain
        // zero-filled, which is the canonical fallback.
      }
      // feat-20260629-multi-uv-set-support m1-w3: write uv1..uvK after skin data.
      // Canonical interleaved order: position/normal/uv/tangent/skinIndex/skinWeight/uv1..uv7.
      // UV1 starts at offset UV1_OFFSET (12 for unskinned, 18 for skinned) in float slots.
      // Each additional UV set 2F. Missing texcoordK → zero-fill (plan-strategy M1).
      for (let k = 1; k <= uvKeys.length; k++) {
        const uvKey = `texcoord${k}` as keyof GltfMeshIr;
        const catIdx = k - 1;
        const cat = uvCats[catIdx] as Float32Array;
        const catDst = (vertexCursor + i) * 2;
        const srcArr = mesh[uvKey] as Float32Array | undefined;
        if (srcArr !== undefined) {
          const t = i * 2;
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
          materialSlot,
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
          materialSlot,
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
        materialSlot,
      });
    }
    vertexCursor += primVertexCount;
  }

  const attributes: VertexAttributeMap = {
    position: positionsCat,
    normal: normalsCat,
    uv: uvsCat,
    tangent: tangentsCat,
    ...(colorsCat === undefined ? {} : { color: colorsCat }),
    ...(skinIndicesCat === undefined ? {} : { skinIndex: skinIndicesCat }),
    ...(skinWeightsCat === undefined ? {} : { skinWeight: skinWeightsCat }),
    ...Object.fromEntries(uvCats.map((cat, idx) => [`uv${idx + 1}`, cat])),
  };
  const packed = packInterleavedVertexAttributes(attributes, totalVertexCount);
  if (!packed.ok) {
    return err(
      gltfErr('gltf-mesh-bridge-invalid', {
        meshIndex: prims[0]?.meshIndex ?? -1,
        reason: 'layout-invalid',
        cause: packed.error.detail,
      }),
    );
  }

  return ok({
    kind: 'mesh',
    vertices: packed.value.vertices,
    ...(indices === undefined ? {} : { indices }),
    submeshes,
    materialSlots,
    aabb: box3.fromPositions(box3.create(), positionsCat),
    attributes,
    ...(morphTargetCount === 0 ? {} : { morphTargets }),
    ...(prims[0]?.morphWeights === undefined
      ? {}
      : { morphWeights: new Float32Array(prims[0].morphWeights) }),
  });
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

function lightDirection(currentWorld: Mat4): readonly [number, number, number] {
  const direction = mat4.getForward(vec3.create(), currentWorld);
  return [direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? -1];
}

function lightComponent(
  light: GltfPunctualLightIr,
  direction: readonly [number, number, number],
): Record<string, unknown> {
  const range = light.range ?? Number.POSITIVE_INFINITY;
  if (light.type === 'directional') {
    return { direction, color: light.color, intensity: light.intensity };
  }
  if (light.type === 'point') {
    return { color: light.color, intensity: light.intensity, range };
  }
  return {
    direction,
    color: light.color,
    intensity: light.intensity,
    range,
    innerConeDeg: ((light.spot?.innerConeAngle ?? 0) * 180) / Math.PI,
    outerConeDeg: ((light.spot?.outerConeAngle ?? Math.PI / 4) * 180) / Math.PI,
    castShadow: false,
  };
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
  const importedLights = doc.lights ?? doc.extensions?.KHR_lights_punctual?.lights ?? [];
  const animationTargetIds = new Map<number, string>();
  for (const clip of doc.animationClips) {
    for (const channel of clip.channels) {
      animationTargetIds.set(channel.targetNodeIndex, channel.targetId);
    }
  }

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
    pos: [
      transform.translation[0] ?? 0,
      transform.translation[1] ?? 0,
      transform.translation[2] ?? 0,
    ],
    // Quaternion component order [x, y, z, w] (glTF-aligned; E6).
    quat: [
      transform.rotation[0] ?? 0,
      transform.rotation[1] ?? 0,
      transform.rotation[2] ?? 0,
      transform.rotation[3] ?? 1,
    ],
    scale: [transform.scale[0] ?? 1, transform.scale[1] ?? 1, transform.scale[2] ?? 1],
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

    const importedLight = importedLights[ir.lightIndex ?? -1];
    if (importedLight !== undefined) {
      const componentName =
        importedLight.type === 'directional'
          ? 'DirectionalLight'
          : importedLight.type === 'point'
            ? 'PointLight'
            : 'SpotLight';
      components[componentName] = lightComponent(
        importedLight,
        lightDirection(currentWorld),
      ) as Record<string, unknown>;
    }

    if (ir.name !== undefined && ir.name !== '') {
      components.Name = { value: ir.name };
    }
    const animationTargetId = animationTargetIds.get(gltfNodeIdx);
    if (animationTargetId !== undefined) {
      components.AnimationTargetId = { value: animationTargetId };
    }

    if (hasMesh) {
      const meshHandle = ctx.meshHandles.get(ir.meshIndex as number);
      if (meshHandle !== undefined) {
        components.MeshFilter = { assetHandle: meshHandle };
      }
      const meshMorph = doc.meshes.find((mesh) => mesh.meshIndex === ir.meshIndex);
      const morphCount = meshMorph?.morphTargets?.length ?? 0;
      if (morphCount > 0) {
        const weights = ir.morphWeights ?? meshMorph?.morphWeights ?? new Float32Array(morphCount);
        if (weights.length !== morphCount) {
          throw new Error('gltfDocToSceneAsset: MorphWeights length does not match morph targets');
        }
        components.MorphWeights = { weights: new Float32Array(weights) };
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
      // Mesh-owned slots carry imported defaults. Scene nodes persist only
      // true instance differences, so the canonical imported node starts with
      // an empty per-slot override vector.
      components.MeshRenderer = { materials: [] };
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
  const lightFacts = importedLights.map((light) => ({
    kind: light.type,
    intensity: light.intensity,
    ...(light.range === undefined ? {} : { range: light.range }),
    ...(light.spot === undefined ? {} : { spot: light.spot }),
  }));
  return {
    kind: 'scene',
    entities: frozen,
    ...(lightFacts.length === 0 ? {} : { lights: lightFacts }),
  } as SceneAsset;
}

/** Internal helper: mark GltfNodeIr usable so future surface evolutions stay typed. */
export type _NodeIrAlias = GltfNodeIr;

export interface MaterialBridgeContext {
  /** glTF texture index -> registry TextureAsset handle. */
  readonly textureHandles?: ReadonlyMap<number, Handle<'TextureAsset', 'shared'>>;
  /** glTF sampler index -> registry SamplerAsset handle. */
  readonly samplerHandles?: ReadonlyMap<number, Handle<'SamplerAsset', 'shared'>>;
  /** Built-in standard MaterialAsset GUID supplied by the importing project. */
  readonly standardRootGuid?: AssetGuid;
  /**
   * feat-20260611 w17-a: when any primitive consuming this material carries
   * JOINTS_0 + WEIGHTS_0, the cooker passes `skinned: true` so the emitted
   * MaterialAsset's pass[0].program.module is `forgeax::pbr-skin` instead of
   * `forgeax::default-standard-pbr`. The cooker (gltf-importer) is the only
   * site with full mesh<->material wiring info; routing here keeps shader
   * choice content-driven (not user-driven, per Q4 — runtime fail-fast in
   * render-system-extract remains the reverse-direction safety net).
   */
  readonly skinned?: boolean;
}

function textureInfo(info: GltfTextureInfoIr | number | undefined): GltfTextureInfoIr | undefined {
  return info === undefined ? undefined : typeof info === 'number' ? { texture: info } : info;
}

type MaterialTextureSlot =
  | 'baseColorTexture'
  | 'metallicRoughnessTexture'
  | 'normalTexture'
  | 'occlusionTexture'
  | 'emissiveTexture';

function textureValue(
  info: GltfTextureInfoIr | number | undefined,
  slot: MaterialTextureSlot,
  ctx: MaterialBridgeContext | undefined,
): MaterialTextureValue | undefined {
  const binding = textureInfo(info);
  if (binding === undefined || ctx?.textureHandles === undefined) return undefined;
  const textureHandle = ctx.textureHandles.get(binding.texture);
  if (textureHandle === undefined) return undefined;
  const samplerHandle =
    binding.sampler === undefined ? undefined : ctx.samplerHandles?.get(binding.sampler);
  const coordinates =
    binding.texCoord === undefined && binding.transform === undefined
      ? undefined
      : {
          ...(binding.texCoord === undefined ? {} : { set: binding.texCoord }),
          ...(binding.transform === undefined ? {} : { transform: binding.transform }),
        };
  const value = {
    texture: textureHandle as unknown as MaterialTextureValue['texture'],
    ...(samplerHandle === undefined
      ? {}
      : { sampler: samplerHandle as unknown as NonNullable<MaterialTextureValue['sampler']> }),
    ...(coordinates === undefined ? {} : { coordinates }),
  };
  if (slot === 'normalTexture') {
    const normal = info as GltfMaterialIr['normalTexture'];
    if (typeof normal === 'object' && normal?.scale !== undefined) {
      return { ...value, normalScale: normal.scale };
    }
  }
  if (slot === 'occlusionTexture') {
    const occlusion = info as GltfMaterialIr['occlusionTexture'];
    if (typeof occlusion === 'object' && occlusion?.strength !== undefined) {
      return { ...value, occlusionStrength: occlusion.strength };
    }
  }
  return value;
}

export function validateMaterialUvSets(
  mat: GltfMaterialIr,
  primitive: string,
  availableSets: readonly number[],
): Result<void, MaterialError> {
  const available = new Set(availableSets);
  const slots: readonly [MaterialTextureSlot, GltfTextureInfoIr | number | undefined][] = [
    ['baseColorTexture', mat.baseColorTexture],
    ['metallicRoughnessTexture', mat.metallicRoughnessTexture],
    ['normalTexture', mat.normalTexture],
    ['occlusionTexture', mat.occlusionTexture],
    ['emissiveTexture', mat.emissiveTexture],
  ];
  for (const [slot, rawBinding] of slots) {
    const binding = textureInfo(rawBinding);
    if (binding === undefined) continue;
    const requestedSet = binding.texCoord ?? 0;
    if (!available.has(requestedSet)) {
      return err(
        createMaterialError('gltf-material-uv-set-missing', {
          material: mat.name ?? '<unnamed>',
          primitive,
          slot,
          requestedSet,
          availableSets,
        }),
      );
    }
  }
  return ok(undefined);
}

/** Convert a parsed GltfMaterialIr into a standard-root derived MaterialAsset. */
export function toMaterialAsset(mat: GltfMaterialIr, ctx?: MaterialBridgeContext): MaterialAsset {
  const values: Record<string, NonNullable<MaterialAsset['values']>[string]> = {
    baseColor: mat.baseColorFactor,
    metallic: mat.metallicFactor,
    roughness: mat.roughnessFactor,
  };
  if (mat.emissiveFactor !== undefined) {
    values.emissive = mat.emissiveFactor;
    values.emissiveIntensity = 1;
  }
  const textureSlots: readonly [MaterialTextureSlot, GltfTextureInfoIr | number | undefined][] = [
    ['baseColorTexture', mat.baseColorTexture],
    ['metallicRoughnessTexture', mat.metallicRoughnessTexture],
    ['normalTexture', mat.normalTexture],
    ['occlusionTexture', mat.occlusionTexture],
    ['emissiveTexture', mat.emissiveTexture],
  ];
  for (const [slot, info] of textureSlots) {
    const value = textureValue(info, slot, ctx);
    if (value !== undefined) values[slot] = value;
  }
  if (mat.occlusionTexture !== undefined && values.occlusionStrength === undefined) {
    values.occlusionStrength = 1;
  }

  const module = ctx?.skinned === true ? 'forgeax::pbr-skin' : 'forgeax::default-standard-pbr';

  const isMask = mat.alphaMode === 'MASK';
  const alphaCutoff = isMask ? (mat.alphaCutoff ?? 0.5) : undefined;
  if (alphaCutoff !== undefined) values.alphaCutoff = alphaCutoff;

  // glTF BLEND uses straight alpha and does not write depth.
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
  const pass = {
    name: 'Forward',
    program: { module },
    renderState: {
      tags: { LightMode: 'Forward' },
      queue: (isBlend ? 3000 : isMask ? 2450 : 2000) as RenderQueue,
      ...(isBlend || isMask || mat.doubleSided === true
        ? {
            ...(isBlend ? { blend: straightAlphaBlend, depthWriteEnabled: false } : {}),
            ...(mat.doubleSided === true ? { cullMode: 'none' as const } : {}),
          }
        : {}),
    },
  };

  return {
    kind: 'material',
    colorSpace: 'linear',
    ...(ctx?.standardRootGuid === undefined ? {} : { parent: ctx.standardRootGuid }),
    passes: [pass],
    values,
  };
}
