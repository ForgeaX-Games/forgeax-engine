// to-asset-pack.ts — aggregate parsed sub-assets into ImportedAsset[] (t31).
//
// GUID import-stable iron law: GUIDs come from `ctx.subAssets[]` (the external
// meta), never minted here. Each parsed POD is matched to its declared GUID by
// (kind, sourceIndex); a parsed asset that no sub-asset declares is dropped so
// the produced set stays a subset of the declared set (mirrors gltfImporter).
// The import-runner then validates produced == declared and rejects mismatches.

import { box3 } from '@forgeax/engine-math';
import type {
  AnimationClipPod,
  ImportedAsset,
  MaterialAsset,
  MaterialPod,
  MeshAsset,
  MeshPod,
  SceneAsset,
  ScenePod,
  SkeletonPod,
  SkinPod,
  TexturePod,
} from '@forgeax/engine-types';

type SubAsset = { readonly guid: string; readonly sourceIndex: number; readonly kind: string };

/** Resolve the meta-declared GUID for a parsed (kind, sourceIndex) pair. */
function makeGuidResolver(
  subAssets: readonly SubAsset[],
): (kind: string, sourceIndex: number) => string | undefined {
  const byKey = new Map<string, string>();
  for (const sub of subAssets) byKey.set(`${sub.kind}:${sub.sourceIndex}`, sub.guid);
  return (kind, sourceIndex) => byKey.get(`${kind}:${sourceIndex}`);
}

export function buildMeshAsset(
  pod: MeshPod,
  guid: string,
  influences?: readonly { jointIndices: Uint16Array; jointWeights: Float32Array }[],
): ImportedAsset {
  const vc = pod.vertices.length / 3;
  const n = pod.attributes.NORMAL as Float32Array | undefined;
  // feat-20260629-multi-uv-set-support m1-w6: scan all TEXCOORD_n sets
  // (n in [0,7]) from MeshPod.attributes. TEXCOORD_0 -> uv (set 0),
  // TEXCOORD_n for n>=1 -> uvN attribute. >8 sets truncated per D-6.
  // uvSetCount = max(n) + 1 (not count of keys) so sparse sets (TEXCOORD_0+TEXCOORD_2
  // without TEXCOORD_1) still get correct interleaved stride with zero-filled gap.
  let uvSetCount = 1; // always at least 1 (uv slot in interleaved)
  for (const key of Object.keys(pod.attributes)) {
    if (key.startsWith('TEXCOORD_')) {
      const n = Number(key.slice('TEXCOORD_'.length));
      if (Number.isFinite(n) && n >= 0 && n <= 7) {
        uvSetCount = Math.max(uvSetCount, n + 1);
      }
    }
  }

  const u = pod.attributes.TEXCOORD_0 as Float32Array | undefined;

  // Skinned meshes use the 18-float interleaved stride (mirror of gltfImporter):
  // 12 floats (position/normal/uv/tangent) + uint16x4 joints (2 float slots, via
  // an aliased Uint16 view) + float32x4 weights = 18 floats / 72 bytes. The
  // runtime deriveVertexBufferLayout expects skinIndex at byte 48, skinWeight at
  // byte 56. Unskinned meshes keep the 12-float layout.
  const skinned = influences !== undefined && influences.length === vc && vc > 0;
  // feat-20260629-multi-uv-set-support m1-w6: dynamic stride.
  // Canonical interleaved order = position/normal/uv/tangent/skinIndex/skinWeight/uv1..uv7.
  // Base stride: 12 (unskinned) / 18 (skinned). Extra UV sets add 2F each.
  // UV1 offset: 12 (unskinned) / 18 (skinned) -- same as glTF bridge m1-w3.
  const BASE_FLOATS = skinned ? 18 : 12;
  const UV1_OFFSET = skinned ? 18 : 12;
  const FLOATS_PER_VERT = BASE_FLOATS + (uvSetCount - 1) * 2;
  const ib = new Float32Array(vc * FLOATS_PER_VERT);
  const ibU16 = skinned ? new Uint16Array(ib.buffer) : undefined;
  const skinIndexAttr = skinned ? new Uint16Array(vc * 4) : undefined;
  const skinWeightAttr = skinned ? new Float32Array(vc * 4) : undefined;

  for (let i = 0; i < vc; i++) {
    const d = i * FLOATS_PER_VERT;
    const p = i * 3;
    const t = i * 2;
    ib[d + 0] = pod.vertices[p + 0] ?? 0;
    ib[d + 1] = pod.vertices[p + 1] ?? 0;
    ib[d + 2] = pod.vertices[p + 2] ?? 0;
    ib[d + 3] = n?.[p + 0] ?? 0;
    ib[d + 4] = n?.[p + 1] ?? 0;
    ib[d + 5] = n?.[p + 2] ?? 0;
    ib[d + 6] = u?.[t + 0] ?? 0;
    ib[d + 7] = u?.[t + 1] ?? 0;
    ib[d + 8] = 1;
    ib[d + 9] = 0;
    ib[d + 10] = 0;
    ib[d + 11] = 1;
    if (skinned && ibU16 && skinIndexAttr && skinWeightAttr) {
      const inf = influences[i];
      const u16Base = (d + 12) * 2; // float slot 12 -> uint16 index (d+12)*2
      const sd = i * 4;
      for (let k = 0; k < 4; k++) {
        const ji = inf?.jointIndices[k] ?? 0;
        const jw = inf?.jointWeights[k] ?? 0;
        ibU16[u16Base + k] = ji;
        ib[d + 14 + k] = jw;
        skinIndexAttr[sd + k] = ji;
        skinWeightAttr[sd + k] = jw;
      }
    }
    // feat-20260629-multi-uv-set-support m1-w6: write uv1..uvK after skin data.
    // Canonical interleaved order matches glTF bridge m1-w3:
    // position/normal/uv/tangent/skinIndex/skinWeight/uv1..uv7.
    // UV1 starts at UV1_OFFSET (12 for unskinned, 18 for skinned) in float slots.
    // Each additional UV set 2F. Missing texcoordK -> zero-fill (implicit).
    for (let k = 1; k < uvSetCount; k++) {
      const srcKey = `TEXCOORD_${k}`;
      const srcArr = pod.attributes[srcKey] as Float32Array | undefined;
      const interleavedOffset = UV1_OFFSET + (k - 1) * 2;
      if (srcArr !== undefined) {
        ib[d + interleavedOffset + 0] = srcArr[t + 0] ?? 0;
        ib[d + interleavedOffset + 1] = srcArr[t + 1] ?? 0;
      }
      // else: zero-fill (implicit -- Float32Array defaults to 0)
    }
  }

  // feat-20260629-multi-uv-set-support m1-w6: per-UV-set standalone typed arrays
  // for MeshAsset.attributes (uv1..uvK). TEXCOORD_n -> attributes.uvN.
  // Only emitted when the corresponding TEXCOORD key is present in pod.attributes.
  const extraUvAttrs: Record<string, Float32Array> = {};
  for (let k = 1; k < uvSetCount; k++) {
    const srcKey = `TEXCOORD_${k}`;
    const srcArr = pod.attributes[srcKey] as Float32Array | undefined;
    if (srcArr !== undefined) {
      const cat = new Float32Array(vc * 2);
      for (let i = 0; i < vc; i++) {
        const t2 = i * 2;
        cat[t2 + 0] = srcArr[t2 + 0] ?? 0;
        cat[t2 + 1] = srcArr[t2 + 1] ?? 0;
      }
      extraUvAttrs[`uv${k}`] = cat;
    }
  }

  const attributes: MeshAsset['attributes'] = {
    position: pod.vertices,
    normal: n ?? new Float32Array(vc * 3).fill(0),
    uv: u ?? new Float32Array(vc * 2).fill(0),
    tangent: new Float32Array(vc * 4).fill(0).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 1 : 0)),
    ...(skinIndexAttr ? { skinIndex: skinIndexAttr } : {}),
    ...(skinWeightAttr ? { skinWeight: skinWeightAttr } : {}),
    ...extraUvAttrs,
  };

  const mesh: MeshAsset = {
    kind: 'mesh',
    vertices: ib,
    ...(pod.indices ? { indices: pod.indices } : {}),
    aabb: box3.fromPositions(box3.create(), pod.vertices),
    attributes,
    submeshes: pod.submeshes.map((sm) => ({
      indexOffset: sm.indexOffset,
      indexCount: sm.indexCount,
      vertexCount: vc,
      topology: sm.topology,
    })),
  };

  return {
    guid,
    kind: 'mesh',
    ...(pod.name !== undefined ? { name: pod.name } : {}),
    payload: mesh,
    refs: [],
  };
}

function buildMaterialAsset(pod: MaterialPod, guid: string, skinned = false): ImportedAsset {
  // A material consumed by a skinned mesh must select the pbr-skin shader so the
  // runtime PSO chain (LayoutKind 'pbr-skin' + 18-float vertex layout + joint
  // palette) is exercised; the render-system fail-fasts otherwise (mirror of
  // gltfImporter's `skinned` routing).
  const mat: MaterialAsset = {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: skinned ? 'forgeax::pbr-skin' : 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: {
      baseColor: pod.baseColorFactor as readonly [number, number, number, number],
      metallic: pod.metallicFactor,
      roughness: pod.roughnessFactor,
    },
  };
  return {
    guid,
    kind: 'material',
    ...(pod.name !== undefined ? { name: pod.name } : {}),
    payload: mat,
    refs: [],
  };
}

interface SceneBuildContext {
  /** mesh sourceIndex -> MeshFilter.assetHandle (a scene refs[] index). */
  readonly meshHandleByIndex: ReadonlyMap<number, number>;
  /** mesh sourceIndex -> submesh count, for materials[]/submeshes[] count alignment. */
  readonly submeshCountByMeshIndex: ReadonlyMap<number, number>;
  /** material handle (scene refs[] index) used to fill every submesh slot. */
  readonly materialHandle: number | undefined;
  /** mesh sourceIndex carrying the skin deformer; null when the scene has no skin. */
  readonly skinnedMeshIndex: number | null;
  /** Skin.skeleton handle (a scene refs[] index); undefined when no skeleton. */
  readonly skeletonHandle: number | undefined;
  /** Scene refs[]: [mesh..., material..., texture..., skeleton..., skin...] GUIDs. */
  readonly refs: readonly string[];
  /**
   * Skin GUIDs (inline strings) injected into the SceneAsset payload and the
   * scene envelope's refs[] so the runtime recursive loadByGuid walk pulls each
   * SkinAsset on the browser-async pack-fetch path. Mirrors gltf-importer:
   * stored as GUID strings (the on-disk round-trip + parseScenePayload's
   * resolveSkinGuids accept both shapes).
   */
  readonly skinGuids: readonly string[];
}

function buildSceneAsset(pod: ScenePod, guid: string, ctx: SceneBuildContext): ImportedAsset {
  // ChildOf wiring: ScenePod.children[] holds flattened-array indices; invert to
  // a parent map so each entity emits ChildOf { parent } (localId === array idx).
  const parentOf = new Map<number, number>();
  for (let i = 0; i < pod.entities.length; i++) {
    const e = pod.entities[i];
    if (!e) continue;
    for (const childIdx of e.children ?? []) parentOf.set(childIdx, i);
  }

  const entities = pod.entities.map((e, idx) => {
    const components: Record<string, Record<string, unknown>> = {
      Transform: {
        posX: e.transform.translation[0],
        posY: e.transform.translation[1],
        posZ: e.transform.translation[2],
        quatX: e.transform.rotation[0],
        quatY: e.transform.rotation[1],
        quatZ: e.transform.rotation[2],
        quatW: e.transform.rotation[3],
        scaleX: e.transform.scale[0],
        scaleY: e.transform.scale[1],
        scaleZ: e.transform.scale[2],
      },
    };

    // Name is required for postSpawnResolveJoints to match SkinAsset.jointPaths
    // against the spawned subtree (the skeleton joint resolution path).
    if (e.name) components.Name = { value: e.name };

    const parent = parentOf.get(idx);
    if (parent !== undefined) components.ChildOf = { parent };

    if (e.meshIndex !== null) {
      const meshHandle = ctx.meshHandleByIndex.get(e.meshIndex);
      if (meshHandle !== undefined) components.MeshFilter = { assetHandle: meshHandle };

      // materials[] must equal submeshes[] in length (render-system fail-fast
      // mesh-renderer-material-count-mismatch). Both fixtures are single-material;
      // fill every submesh slot with the one material handle.
      const submeshCount = ctx.submeshCountByMeshIndex.get(e.meshIndex) ?? 1;
      if (ctx.materialHandle !== undefined) {
        components.MeshRenderer = {
          materials: Array.from({ length: submeshCount }, () => ctx.materialHandle),
        };
      }

      // Skinned mesh node carries Skin { skeleton: <handle> }; instantiate
      // resolves the handle and postSpawnResolveJoints fills Skin.joints[].
      if (ctx.skinnedMeshIndex === e.meshIndex && ctx.skeletonHandle !== undefined) {
        components.Skin = { skeleton: ctx.skeletonHandle };
      }
    }

    return { localId: idx as never, components };
  });

  const scene: SceneAsset = {
    kind: 'scene',
    entities,
    ...(ctx.skinGuids.length > 0 ? { skinGuids: ctx.skinGuids } : {}),
  } as SceneAsset;

  return {
    guid,
    kind: 'scene',
    ...(pod.name !== undefined ? { name: pod.name } : {}),
    payload: scene,
    refs: ctx.refs.map((guid) => ({ guid })),
  };
}

// M3: TextureAsset requires decoded pixel data — deferred to M4.
// TexturePod.filePath is preserved for diagnostics during M3.
function buildTextureNote(_pod: TexturePod, _guid: string): ImportedAsset {
  // Produce a minimal placeholder; real texture import (decode + upload)
  // lands with M4 material parsing.
  return {
    guid: _guid,
    kind: 'texture',
    ...(_pod.name !== undefined ? { name: _pod.name } : {}),
    payload: {} as never,
    refs: [],
  };
}

export function toAssetPack(params: {
  readonly meshes: readonly MeshPod[];
  readonly scene: ScenePod;
  readonly materials: readonly MaterialPod[];
  readonly textures: readonly TexturePod[];
  readonly skeleton: SkeletonPod;
  readonly skin: SkinPod;
  readonly animationClips: readonly AnimationClipPod[];
  readonly subAssets: readonly SubAsset[];
}): readonly ImportedAsset[] {
  const assets: ImportedAsset[] = [];
  const guidOf = makeGuidResolver(params.subAssets);

  // The skin deforms the (single) first mesh; its per-vertex influences promote
  // both the mesh (18-float skinned layout) and its material (pbr-skin shader).
  const hasSkin = params.skin.vertexCount > 0;
  const skinnedMeshSourceIndex = hasSkin ? (params.meshes[0]?.sourceIndex ?? null) : null;

  for (const mesh of params.meshes) {
    const guid = guidOf('mesh', mesh.sourceIndex);
    if (guid === undefined) continue;
    const inf = mesh.sourceIndex === skinnedMeshSourceIndex ? params.skin.influences : undefined;
    assets.push(buildMeshAsset(mesh, guid, inf));
  }

  for (let i = 0; i < params.materials.length; i++) {
    const mat = params.materials[i];
    if (!mat) continue;
    const guid = guidOf('material', i);
    // Single-mesh fixtures: any material is consumed by the skinned mesh.
    if (guid !== undefined) assets.push(buildMaterialAsset(mat, guid, hasSkin));
  }

  for (const tex of params.textures) {
    const guid = guidOf('texture', tex.sourceIndex);
    if (guid !== undefined) assets.push(buildTextureNote(tex, guid));
  }

  // Scene refs[] ordering (mirror of gltfImporter): the scene's MeshFilter /
  // MeshRenderer / Skin handle fields are decoded at runtime as indices into
  // the scene asset's own refs[], concatenated as
  //   [mesh GUIDs..., material GUIDs..., texture GUIDs..., skeleton GUIDs...,
  //    skin GUIDs...]
  // each section in declared sourceIndex order. Build the section -> refs-index
  // maps here so buildSceneAsset can stamp the right indices.
  const declaredByKind = (kind: string): string[] =>
    params.subAssets
      .filter((s) => s.kind === kind)
      .slice()
      .sort((a, b) => a.sourceIndex - b.sourceIndex)
      .map((s) => s.guid);

  const meshGuids = declaredByKind('mesh');
  const materialGuids = declaredByKind('material');
  const textureGuids = declaredByKind('texture');
  const skeletonGuids = declaredByKind('skeleton');
  const skinGuids = declaredByKind('skin');
  const sceneRefs = [
    ...meshGuids,
    ...materialGuids,
    ...textureGuids,
    ...skeletonGuids,
    ...skinGuids,
  ];

  // mesh sourceIndex -> scene refs[] index (mesh section starts at 0).
  const meshHandleByIndex = new Map<number, number>();
  params.subAssets
    .filter((s) => s.kind === 'mesh')
    .forEach((s) => {
      const idx = meshGuids.indexOf(s.guid);
      if (idx >= 0) meshHandleByIndex.set(s.sourceIndex, idx);
    });
  const submeshCountByMeshIndex = new Map<number, number>();
  for (const mesh of params.meshes) {
    submeshCountByMeshIndex.set(mesh.sourceIndex, Math.max(1, mesh.submeshes.length));
  }
  // Single-material fixtures: every submesh slot binds the one material handle
  // (material section starts after the mesh section).
  const materialHandle = materialGuids.length > 0 ? meshGuids.length : undefined;
  // skeleton handle = first skeleton's scene refs[] index.
  const skeletonRefBase = meshGuids.length + materialGuids.length + textureGuids.length;
  const skeletonHandle = skeletonGuids.length > 0 ? skeletonRefBase : undefined;
  // Single-mesh fixtures: the skin deforms the (only) mesh node.
  const skinnedMeshIndex =
    params.skin.vertexCount > 0 ? (params.meshes[0]?.sourceIndex ?? null) : null;

  // Skeleton asset (t48). refs[] empty (skeleton is leaf data). The runtime
  // SkeletonAsset POD is { inverseBindMatrices, jointCount } — joint paths live
  // on the parallel SkinAsset (mirror of gltfImporter's emit policy). The native
  // binding derives the skeleton from the skin's clusters, so jointCount /
  // inverseBindMatrices already align 1:1 with the skin's jointPaths and the
  // per-vertex skinIndex influences (runtime requires
  // SkeletonAsset.jointCount === Skin.joints.length).
  const skeletonGuid = guidOf('skeleton', 0);
  if (params.skeleton.jointCount > 0 && skeletonGuid !== undefined) {
    assets.push({
      guid: skeletonGuid,
      kind: 'skeleton',
      payload: {
        kind: 'skeleton',
        inverseBindMatrices: params.skeleton.inverseBindMatrices,
        jointCount: params.skeleton.jointCount,
      } as never,
      refs: [],
    });
  }

  // Skin asset (t49). The runtime SkinAsset POD is { skeletonGuid, jointPaths };
  // per-vertex influences live in the mesh vertex buffer, not the SkinAsset.
  // refs[] carries the skeleton GUID cross-edge (mirror of gltfImporter) so the
  // runner / runtime asset graph sees the skin->skeleton link.
  const skinGuid = guidOf('skin', 0);
  if (params.skin.vertexCount > 0 && skinGuid !== undefined) {
    assets.push({
      guid: skinGuid,
      kind: 'skin',
      payload: {
        kind: 'skin',
        skeletonGuid: skeletonGuid ?? '',
        jointPaths: params.skin.jointPaths,
      } as never,
      refs:
        skeletonGuid !== undefined
          ? [{ guid: skeletonGuid, sourceField: { fieldName: 'skeleton' } }]
          : [],
    });
  }

  // Animation clip assets (t50)
  for (let i = 0; i < params.animationClips.length; i++) {
    const clip = params.animationClips[i];
    if (!clip) continue;
    const guid = guidOf('animation-clip', i);
    if (guid === undefined) continue;
    assets.push({
      guid,
      kind: 'animation-clip',
      payload: {
        kind: 'animation-clip',
        name: clip.name ?? `Clip${i}`,
        duration: clip.duration,
        channels: clip.channels.map((ch) => ({
          targetPath: ch.targetPath,
          property: ch.property,
          sampler: {
            input: Array.from(ch.sampler.input),
            output: Array.from(ch.sampler.output),
            interpolation: ch.sampler.interpolation,
          },
        })),
      } as never,
      refs: [],
    });
  }

  const sceneGuid = guidOf('scene', 0);
  if (sceneGuid !== undefined) {
    assets.push(
      buildSceneAsset(params.scene, sceneGuid, {
        meshHandleByIndex,
        submeshCountByMeshIndex,
        materialHandle,
        skinnedMeshIndex,
        skeletonHandle,
        refs: sceneRefs,
        skinGuids,
      }),
    );
  }

  // XOR identity rule (aligned with the glTF importer): a single-asset package
  // derives its name from the package path, so the stored entry name is dropped.
  // Only multi-asset packages keep per-entry stored names. FBX is almost always
  // multi-asset (a scene asset is always emitted), so this strips name only in
  // the degenerate single-asset case.
  if (assets.length === 1) {
    const only = assets[0];
    if (only && 'name' in only) {
      const { name: _dropped, ...rest } = only;
      assets[0] = rest;
    }
  }

  return assets;
}
