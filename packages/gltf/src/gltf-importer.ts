// gltf-importer.ts - the build-time gltfImporter (feat-20260603-asset-import-loader-injection M2 / w19,
// extended in feat-20260608 M3 w14 with the texture pipeline: three image
// source paths funnelled through the ImportContext decodeImage seam).
//
// The `{ key: 'gltf', import }` Importer the @forgeax/engine-import runner
// dispatches a `*.meta.json` with `importer: 'gltf'` to. It reads the source
// bytes via `ctx.readSource()`, parses them to a `GltfDoc` (parseGltf / parseGlb),
// and converts each declared sub-asset (mesh / material / scene / texture /
// skin / animation-clip) into an `ImportedAsset` POD stamped with the
// meta-declared GUID (GUID import-stable iron law: GUIDs come from
// `ctx.subAssets[]`, never minted here).
//
// Texture pipeline (M3 D-1 / D-3 / D-6, requirements AC-08 / 09 / 10 / 11 /
// 12 / 13): for every glTF `images[]` row the importer extracts the raw
// PNG / JPEG bytes from one of three sources (bufferView slice in
// .glb / data: URI in .gltf / external URI sibling read), funnels them
// through `ctx.decodeImage` (the only seam to @forgeax/engine-image — a
// grep gate enforces zero static `from '@forgeax/engine-image'` lines in
// this package), and emits a `kind: 'texture'` ImportedAsset stamped with
// the meta-declared GUID. The colorSpace is pre-derived per-image by
// `deriveTextureColorSpace` (D-3 walk of material slot bindings).
//
// Material refs[]: each material's emitted ImportedAsset carries the GUIDs
// of every texture sub-asset its slots reference, so the runner builds the
// scene/material -> texture cross-edge needed by AC-11 / AC-19.
//
// Sub-asset -> GUID mapping: `ctx.subAssets[]` carries one entry per declared
// sub-asset with `{ guid, sourceIndex, kind }`. The importer indexes into the
// parsed doc by (kind, sourceIndex) and emits the corresponding POD under the
// declared GUID. A sub-asset kind with no doc counterpart (or a sourceIndex out
// of range) is skipped; the runner's GUID iron-law check then surfaces the
// gap as `import-produced-no-assets`. A texture sub-asset that fails byte
// extraction surfaces as `gltf-image-extract-failed` (D-6).

import type {
  AssetRef,
  Handle,
  ImportContext,
  ImportedAsset,
  Importer,
  ImportResult,
} from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { gltfDocToSceneAsset, meshIrToMeshAsset, toMaterialAsset } from './bridge.js';
import { gltfErr } from './errors.js';
import { extractImageBytes } from './extract-image-bytes.js';
import { deriveTextureColorSpace } from './image-color-space.js';
import type { GltfDoc, GltfMaterialIr } from './parse-gltf.js';
import { parseGlb, parseGltf } from './parse-gltf.js';

function isGlbBytes(source: string): boolean {
  return source.toLowerCase().endsWith('.glb');
}

async function parseDoc(source: string, bytes: Uint8Array, ctx: ImportContext): Promise<GltfDoc> {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  if (isGlbBytes(source)) {
    const res = await parseGlb(ab, source);
    if (!res.ok) {
      throw new Error(`parseGlb failed: ${res.error.code} ${res.error.expected}`);
    }
    return res.value;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error(`gltf JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // External buffers: read sibling files relative to meta.source. data: URIs
  // are decoded inline by parseGltf; only external URIs reach the loader.
  const externalLoader = async (uri: string): Promise<ArrayBuffer> => {
    const sib = await ctx.readSibling(uri);
    if (!sib.ok) {
      throw new Error(`gltfImporter: external buffer "${uri}" read failed: ${sib.error.code}`);
    }
    return sib.value.buffer.slice(
      sib.value.byteOffset,
      sib.value.byteOffset + sib.value.byteLength,
    ) as ArrayBuffer;
  };
  const res = await parseGltf(json, externalLoader, source);
  if (!res.ok) {
    throw new Error(`parseGltf failed: ${res.error.code} ${res.error.expected}`);
  }
  return res.value;
}

interface HandleMaps {
  readonly meshHandles: Map<number, Handle<'MeshAsset', 'shared'>>;
  readonly materialHandles: Map<number, Handle<'MaterialAsset', 'shared'>>;
  readonly textureHandles: Map<number, Handle<'TextureAsset', 'shared'>>;
  readonly samplerHandles: Map<number, Handle<'SamplerAsset', 'shared'>>;
  readonly meshGuidByIndex: Map<number, string>;
  readonly materialGuidByIndex: Map<number, string>;
  readonly textureGuidByIndex: Map<number, string>;
}

/**
 * Build the gltf-index -> declared-GUID maps so scene refs resolve to the
 * sub-asset GUIDs (not runtime handles, which do not exist at import time).
 * The scene POD therefore carries deterministic synthetic handle slots; the
 * GUID cross-references are recorded on the ImportedAsset `refs[]`.
 *
 * Texture handles are seeded from `subAssets[]` of kind 'texture'; their
 * sourceIndex is the glTF `images[]` row (toAssetPack emits one texture
 * sub-asset per image row, so the mapping is image-index keyed even though
 * the field is named textureHandles for material binding readability).
 * GltfMaterialIr's `*Texture` fields hold glTF `textures[]` indices; the
 * importer dereferences `textures[i].source` to convert that into an image
 * index when stamping material handles.
 */
function buildHandleMaps(
  subAssets: readonly { guid: string; sourceIndex: number; kind: string }[],
  doc: GltfDoc,
): HandleMaps {
  const meshHandles = new Map<number, Handle<'MeshAsset', 'shared'>>();
  const materialHandles = new Map<number, Handle<'MaterialAsset', 'shared'>>();
  const textureHandles = new Map<number, Handle<'TextureAsset', 'shared'>>();
  const samplerHandles = new Map<number, Handle<'SamplerAsset', 'shared'>>();
  const meshGuidByIndex = new Map<number, string>();
  const materialGuidByIndex = new Map<number, string>();
  const textureGuidByIndex = new Map<number, string>();
  // bug-20260610 layer 7c-2: scene's `refs[]` is concatenated in the order
  // [mesh sub-assets..., material sub-assets..., texture sub-assets...] (see
  // gltf-importer scene branch). The synthetic handle values stamped here
  // travel through `MeshFilter.assetHandle` / `MeshRenderer.materials[*]` and
  // are decoded at runtime as **refs[] indices** by parseScenePayload. So the
  // handle value MUST equal the slot offset in the eventual concat, NOT the
  // gltf source-index. The previous keying-by-sourceIndex worked accidentally
  // when there was exactly one mesh + N <= meshCount materials; it broke as
  // soon as materialIndex landed past the mesh-section boundary (Sponza:
  // materials[0]=0 -> refs[0] = mesh GUID, every submesh sampled the mesh
  // asset as its material -> single fallback unlit dispatch entry, no per-
  // primitive draws).
  let meshCursor = 0;
  let materialCursor = 0;
  for (const sub of subAssets) {
    if (sub.kind === 'mesh') {
      meshHandles.set(sub.sourceIndex, toShared<'MeshAsset'>(meshCursor));
      meshGuidByIndex.set(sub.sourceIndex, sub.guid);
      meshCursor += 1;
    } else if (sub.kind === 'material') {
      // material handles come AFTER all mesh refs in the concat.
      // The actual offset (= meshCount + materialCursor) is back-patched
      // below once we know meshCount.
      materialHandles.set(sub.sourceIndex, toShared<'MaterialAsset'>(materialCursor));
      materialGuidByIndex.set(sub.sourceIndex, sub.guid);
      materialCursor += 1;
    } else if (sub.kind === 'texture') {
      textureGuidByIndex.set(sub.sourceIndex, sub.guid);
    }
  }
  const meshCount = meshCursor;
  if (meshCount > 0) {
    for (const [k, v] of materialHandles) {
      const local = v as unknown as number;
      materialHandles.set(k, toShared<'MaterialAsset'>(local + meshCount));
    }
  }
  // For material binding (toMaterialAsset / paramValues.<X>Texture) the handle
  // value is the texture's slot offset within the SAME asset's `refs[]` (which
  // is `materialTextureRefs` order, not the scene-level refs concat).
  // toMaterialAsset only consumes textureHandles to copy a number into the
  // paramValues; the gltf-importer's later 7a fix-up rewrites those values
  // into refs[] indices for the runtime materialLoader. Keying by texIndex
  // and storing `tex.source` here matches the existing 7a path.
  const textures = doc.textures ?? [];
  for (let texIndex = 0; texIndex < textures.length; texIndex++) {
    const tex = textures[texIndex];
    if (tex === undefined) continue;
    if (textureGuidByIndex.has(tex.source)) {
      textureHandles.set(texIndex, toShared<'TextureAsset'>(tex.source));
    }
  }
  return {
    meshHandles,
    materialHandles,
    textureHandles,
    samplerHandles,
    meshGuidByIndex,
    materialGuidByIndex,
    textureGuidByIndex,
  };
}

/** Collect texture-GUID refs for one material (AC-11 cross-edge). */
function materialTextureRefs(
  mat: GltfMaterialIr,
  doc: GltfDoc,
  textureGuidByIndex: ReadonlyMap<number, string>,
): readonly AssetRef[] {
  const refs: AssetRef[] = [];
  const textures = doc.textures ?? [];
  function pushRefForTextureIndex(texIdx: number | undefined, fieldName: string): void {
    if (texIdx === undefined) return;
    const tex = textures[texIdx];
    if (tex === undefined) return;
    const guid = textureGuidByIndex.get(tex.source);
    if (guid !== undefined)
      refs.push({
        guid,
        sourceField: { componentName: '<material>', fieldName },
      });
  }
  pushRefForTextureIndex(mat.baseColorTexture, 'baseColorTexture');
  pushRefForTextureIndex(mat.metallicRoughnessTexture, 'metallicRoughnessTexture');
  pushRefForTextureIndex(mat.normalTexture, 'normalTexture');
  return refs;
}

async function importGltf(ctx: ImportContext): Promise<ImportResult> {
  const read = await ctx.readSource();
  if (!read.ok) {
    throw new Error(
      `gltfImporter: readSource failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`,
    );
  }
  const doc = await parseDoc(ctx.source, read.value, ctx);
  const maps = buildHandleMaps(ctx.subAssets, doc);

  // Pre-derive each images[] row's colorSpace from material slot bindings
  // (D-3 / AC-08). orphan images default to 'linear' (AC-13).
  const imageColorSpaces = deriveTextureColorSpace({
    imageCount: (doc.images ?? []).length,
    textures: doc.textures,
    materials: doc.materials,
  });

  // Extract image bytes (3 source paths) once. Failures here are surfaced
  // per-image so a single bad row does not abort the whole importer.
  const declaredImageIndices = new Set<number>();
  for (const sub of ctx.subAssets) {
    if (sub.kind === 'texture') declaredImageIndices.add(sub.sourceIndex);
  }
  const extraction =
    declaredImageIndices.size > 0
      ? await extractImageBytes(read.value, ctx.source, ctx)
      : {
          extracted: new Map(),
          failures: [] as readonly {
            imageIndex: number;
            source: 'bufferView' | 'data-uri' | 'external-uri';
            reason: string;
          }[],
        };

  // M4 (tweak-20260611-skin-fox-3clip-and-kb-sample-assets): SkinAsset.refs[]
  // carries the skeleton GUID (each skin binds 1:1 to a SkeletonAsset; the
  // skeletonGuid field is the on-asset cross-reference; refs[] is the runner-
  // visible cross-edge used for pack-index ordering and integrity checks).
  // Build the index now so the skin emit branch below can stamp it.
  const skeletonGuidBySourceIndex = new Map<number, string>();
  for (const sub of ctx.subAssets) {
    if (sub.kind === 'skeleton') skeletonGuidBySourceIndex.set(sub.sourceIndex, sub.guid);
  }
  // feat-20260612 M2 fixup: parallel skin GUID index. Skins and skeletons
  // share `sourceIndex` (toAssetPack emits 1:1 per GltfSkeletonRecord) but live
  // as distinct `kind` sub-assets, so the SkinAsset GUIDs differ from the
  // SkeletonAsset GUIDs. The scene branch below appends these GUIDs to both
  // its refs[] (the runtime recursion source: loadByGuid<SceneAsset> walks
  // envelope.refs to recursively pull every SkinAsset before instantiate) and
  // its payload.skinGuids (the reverse-decode hint) -- without the refs[] edge,
  // browser-async-pack-fetch never loads SkinAssets and Skin.joints stays
  // length=0).
  const skinGuidBySourceIndex = new Map<number, string>();
  for (const sub of ctx.subAssets) {
    if (sub.kind === 'skin') skinGuidBySourceIndex.set(sub.sourceIndex, sub.guid);
  }

  const out: ImportedAsset[] = [];
  const isMultiAsset = ctx.subAssets.length > 1;
  for (const sub of ctx.subAssets) {
    if (sub.kind === 'mesh') {
      // sub.sourceIndex now indexes glTF mesh-index (not flat GltfMeshIr index).
      // parseGltf flattens N glTF meshes with M_i primitives into sum(M_i)
      // GltfMeshIr rows, all sharing meshIndex; gather all rows whose
      // meshIndex === sub.sourceIndex (preserving doc.meshes order so the
      // bridge's positional materials[i] <-> submeshes[i] pairing aligns)
      // and let meshIrToMeshAsset interleave them into one MeshAsset with
      // N Submesh entries.
      const prims = doc.meshes.filter((m) => m.meshIndex === sub.sourceIndex);
      if (prims.length === 0) continue;
      const meshName = isMultiAsset ? prims[0]?.name : undefined;
      out.push({
        guid: sub.guid,
        kind: 'mesh',
        ...(meshName !== undefined ? { name: meshName } : {}),
        payload: meshIrToMeshAsset(prims),
        refs: [],
      });
    } else if (sub.kind === 'material') {
      const mat = doc.materials[sub.sourceIndex];
      if (mat === undefined) continue;
      // feat-20260611 w17-a: scan doc.meshes[] for any primitive that (a)
      // references this material and (b) carries JOINTS_0 + WEIGHTS_0. If
      // found, route the emitted MaterialAsset to `forgeax::pbr-skin`.
      // Mirrors the per-MeshAsset 18F-stride decision in meshIrToMeshAsset
      // (D-2): a material consumed by any skinned primitive must use the
      // skin shader so the runtime PSO chain (LayoutKind='pbr-skin' +
      // 6-attribute deriveVertexBufferLayout) is exercised.
      let skinned = false;
      for (const meshIr of doc.meshes) {
        if (meshIr.materialIndex !== sub.sourceIndex) continue;
        if (meshIr.joints0 !== undefined && meshIr.weights0 !== undefined) {
          skinned = true;
          break;
        }
      }
      const matAsset = toMaterialAsset(mat, {
        textureHandles: maps.textureHandles,
        samplerHandles: maps.samplerHandles,
        skinned,
      });
      const refs = materialTextureRefs(mat, doc, maps.textureGuidByIndex);
      // D-8: if material has a parent, add parent edge to refs
      const materialRefs: AssetRef[] = [...refs];
      if (matAsset.parent !== undefined) {
        materialRefs.push({
          guid: matAsset.parent as unknown as string,
          sourceField: { fieldName: 'parent' },
        });
      }
      // bug-20260610: pack-side material handle fields (`<X>Texture`) must
      // carry refs[] indices on disk, NOT image indices. The runtime
      // materialLoader resolves these at registerWithGuid time using the
      // refs[] -> handle map; storing image-index here makes the runtime
      // sample handle-1 (BUILTIN_TRIANGLE) for every material instead of
      // the real texture. Mirror the ordering of materialTextureRefs.
      const textures = doc.textures ?? [];
      const slotKeys = ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture'] as const;
      const slotImageIndices: ReadonlyArray<number | undefined> = [
        mat.baseColorTexture !== undefined ? textures[mat.baseColorTexture]?.source : undefined,
        mat.metallicRoughnessTexture !== undefined
          ? textures[mat.metallicRoughnessTexture]?.source
          : undefined,
        mat.normalTexture !== undefined ? textures[mat.normalTexture]?.source : undefined,
      ];
      const newParamValues: Record<string, unknown> = { ...matAsset.paramValues };
      let refsCursor = 0;
      for (let slot = 0; slot < slotKeys.length; slot++) {
        const key = slotKeys[slot] as string;
        const imgIdx = slotImageIndices[slot];
        if (imgIdx === undefined) continue;
        const guid = maps.textureGuidByIndex.get(imgIdx);
        if (guid === undefined) {
          delete newParamValues[key];
          continue;
        }
        newParamValues[key] = refsCursor;
        refsCursor++;
      }
      const rewrittenAsset = { ...matAsset, paramValues: newParamValues };
      const matName = isMultiAsset ? mat.name : undefined;
      out.push({
        guid: sub.guid,
        kind: 'material',
        ...(matName !== undefined ? { name: matName } : {}),
        payload: rewrittenAsset,
        refs: materialRefs,
      });
    } else if (sub.kind === 'texture') {
      const imageIndex = sub.sourceIndex;
      const extracted = extraction.extracted.get(imageIndex);
      if (extracted === undefined) {
        const failure = extraction.failures.find((f) => f.imageIndex === imageIndex);
        const detail = failure ?? {
          imageIndex,
          source: 'bufferView' as const,
          reason: 'image row missing from extraction map (no images[] entry?)',
        };
        const error = gltfErr('gltf-image-extract-failed', detail);
        throw new Error(
          `gltfImporter: ${error.code} on image ${imageIndex} (${detail.source}): ${detail.reason}`,
        );
      }
      const colorSpace = imageColorSpaces.get(imageIndex) ?? 'linear';
      // Carry colorSpace + mipmap settings into decodeImage via a per-image
      // settings record (mirror of importImageSettings — but here the importer
      // owns the decision because the seam is in-bounds for AC-12 (c)).
      const decodeSettings = {
        ...ctx.importSettings,
        colorSpace,
        mipmap: ctx.importSettings.mipmap ?? true,
      };
      const decoded = await ctx.decodeImage(extracted.bytes, extracted.mimeType, decodeSettings);
      if (!decoded.ok) {
        const reason = `decodeImage failed: ${decoded.error.code}`;
        const error = gltfErr('gltf-image-extract-failed', {
          imageIndex,
          source: extracted.source,
          reason,
        });
        throw new Error(
          `gltfImporter: ${error.code} on image ${imageIndex} (${extracted.source}): ${reason}`,
        );
      }
      const imageItem = (doc.images ?? [])[imageIndex];
      const texName = isMultiAsset ? imageItem?.name : undefined;
      out.push({
        guid: sub.guid,
        kind: 'texture',
        ...(texName !== undefined ? { name: texName } : {}),
        payload: decoded.value.texture,
        refs: [],
      });
    } else if (sub.kind === 'scene') {
      // #317 multi-material design: bridge accepts glTF mesh-index keyed
      // meshHandles + materialHandles only; primitive merge happens via
      // doc.meshes[] filtering on meshIndex inside the bridge.
      // tweak-20260611 M6: also pass skeletonGuidBySkinIndex so the bridge
      // can stamp Skin component (skeleton GUID string) onto skinned mesh
      // entities. Skins are 1:1 with skeletons in toAssetPack so the same
      // sourceIndex map serves both purposes (the field name says
      // "BySkinIndex" because the bridge keys by GltfNodeIr.skinIndex).
      const scene = gltfDocToSceneAsset(doc, {
        meshHandles: maps.meshHandles,
        materialHandles: maps.materialHandles,
        skeletonGuidBySkinIndex: skeletonGuidBySourceIndex,
      });
      // Scene refs are the declared mesh / material / texture / skeleton /
      // skin sub-asset GUIDs the scene nodes (transitively) reference.
      // Skeleton GUIDs are appended so the runtime asset graph sees the
      // cross-edge when a skinned mesh node carries Skin { skeleton:
      // <guid-string> }; skin GUIDs (feat-20260612 M2 fixup) carry the
      // SkinAsset cross-edge that has no entity-component representation but
      // is required for postSpawnResolveJoints to resolve Skin.joints[] via
      // SkinAsset.jointPaths.
      //
      // D-2 / D-3: refs carries structured edge metadata (AssetRef[]).
      // Walk scene entities to build a handle-value -> (entityLocalId,
      // componentName, fieldName, arrayIndex?) provenance map, then
      // produce AssetRef[] from the flat GUID superset with sourceField
      // / sceneEntityId filled for mesh/material handle-field edges.
      // Texture edges: sourceField=undefined (transitive, no per-entity
      // origin). Skeleton edges: sourceField from Skin.skeleton if entity
      // carries that GUID. Skin edges: sourceField=undefined (cross-edge
      // with no entity-component representation).
      const handleValueProvenance = new Map<
        number,
        { sceneEntityId: number; componentName: string; fieldName: string; arrayIndex?: number }
      >();
      const skeletonGuidProvenance = new Map<string, { sceneEntityId: number }>();
      for (const entity of scene.entities) {
        const comps = entity.components as Record<string, Record<string, unknown>>;
        const mf = comps.MeshFilter;
        if (mf !== undefined && typeof mf.assetHandle === 'number') {
          handleValueProvenance.set(mf.assetHandle, {
            sceneEntityId: entity.localId,
            componentName: 'MeshFilter',
            fieldName: 'assetHandle',
          });
        }
        const mr = comps.MeshRenderer;
        if (mr !== undefined && Array.isArray(mr.materials)) {
          for (let arrIdx = 0; arrIdx < mr.materials.length; arrIdx++) {
            const h = mr.materials[arrIdx];
            if (typeof h === 'number') {
              handleValueProvenance.set(h, {
                sceneEntityId: entity.localId,
                componentName: 'MeshRenderer',
                fieldName: 'materials',
                arrayIndex: arrIdx,
              });
            }
          }
        }
        const skin = comps.Skin;
        if (skin !== undefined && typeof skin.skeleton === 'string') {
          skeletonGuidProvenance.set(skin.skeleton, { sceneEntityId: entity.localId });
        }
      }

      const meshGuidList = [...maps.meshGuidByIndex.values()];
      const materialGuidList = [...maps.materialGuidByIndex.values()];
      const textureGuidList = [...maps.textureGuidByIndex.values()];

      function makeRef(guid: string, idx: number): AssetRef {
        const prov = handleValueProvenance.get(idx);
        if (prov !== undefined) {
          return {
            guid,
            sourceField: {
              componentName: prov.componentName,
              fieldName: prov.fieldName,
              ...(prov.arrayIndex !== undefined ? { arrayIndex: prov.arrayIndex } : {}),
            },
            sceneEntityId: prov.sceneEntityId,
          };
        }
        return { guid };
      }

      const refs: AssetRef[] = [];
      let cursor = 0;
      for (const guid of meshGuidList) {
        refs.push(makeRef(guid, cursor));
        cursor++;
      }
      for (const guid of materialGuidList) {
        refs.push(makeRef(guid, cursor));
        cursor++;
      }
      for (const guid of textureGuidList) {
        refs.push({ guid });
        cursor++;
      }
      {
        const skeletonGuidList = [...skeletonGuidBySourceIndex.values()];
        for (const guid of skeletonGuidList) {
          const skProv = skeletonGuidProvenance.get(guid);
          refs.push(
            skProv !== undefined
              ? {
                  guid,
                  sourceField: { componentName: 'Skin', fieldName: 'skeleton' },
                  sceneEntityId: skProv.sceneEntityId,
                }
              : { guid },
          );
          cursor++;
        }
      }
      {
        const skinGuidList = [...skinGuidBySourceIndex.values()];
        for (const guid of skinGuidList) {
          refs.push({ guid });
          cursor++;
        }
      }
      // Inject skinGuids into the scene payload as the reverse-decode hint; the
      // SkinAsset GUIDs are already in the scene envelope's refs[] above, which
      // is the runtime recursion source for the browser-async-pack-fetch path.
      // Stored as inline GUID strings (in-memory dawn smoke path); the on-disk
      // .pack.json round-trip preserves them as strings -- parseScenePayload's
      // resolveSkinGuids accepts both string and refs[]-index shapes.
      const skinGuidList = [...skinGuidBySourceIndex.values()];
      const sceneWithSkinGuids =
        skinGuidList.length > 0 ? { ...scene, skinGuids: skinGuidList } : scene;
      const sceneName = isMultiAsset ? doc.scenes[sub.sourceIndex]?.name : undefined;
      out.push({
        guid: sub.guid,
        kind: 'scene',
        ...(sceneName !== undefined ? { name: sceneName } : {}),
        payload: sceneWithSkinGuids,
        refs,
      });
    } else if (sub.kind === 'skeleton') {
      // tweak-20260611 M4: skeleton sub-asset POD emit. GltfSkeletonRecord (the
      // gltf IR shape from parse-skin) carries inverseBindMatrices + jointCount
      // + jointPaths; SkeletonAsset (the runtime POD) carries IBM + jointCount
      // only — jointPaths live on the parallel SkinAsset (1:1 mapping per
      // toAssetPack's emit policy). refs[] is empty (skeleton is leaf data).
      const rec = doc.skeletons[sub.sourceIndex];
      if (rec === undefined) continue;
      const payload = {
        kind: 'skeleton' as const,
        inverseBindMatrices: rec.inverseBindMatrices,
        jointCount: rec.jointCount,
      };
      out.push({ guid: sub.guid, kind: 'skeleton', payload, refs: [] });
    } else if (sub.kind === 'skin') {
      // tweak-20260611 M4: skin sub-asset POD emit. The 1:1 mapping with
      // skeleton (toAssetPack emits one skin per GltfSkeletonRecord at the same
      // sourceIndex) lets us pull the skeleton GUID out of the pre-built
      // skeletonGuidBySourceIndex map. SkinAsset is the runtime POD, distinct
      // from GltfSkeletonRecord: skeletonGuid + jointPaths only (zero entity refs
      // at the asset layer per AC-06). refs[] carries the skeletonGuid so the
      // runner sees the cross-edge.
      const rec = doc.skeletons[sub.sourceIndex];
      if (rec === undefined) continue;
      const skeletonGuid = skeletonGuidBySourceIndex.get(sub.sourceIndex);
      if (skeletonGuid === undefined) continue;
      const payload = {
        kind: 'skin' as const,
        skeletonGuid,
        jointPaths: rec.jointPaths,
      };
      out.push({
        guid: sub.guid,
        kind: 'skin',
        payload,
        refs: [{ guid: skeletonGuid, sourceField: { fieldName: 'skeleton' } }],
      });
    } else if (sub.kind === 'animation-clip') {
      // tweak-20260611 M4: animation-clip sub-asset POD emit. GltfAnimationClipRecord
      // (gltf IR) and AnimationClip (runtime POD) are structurally compatible
      // — both carry duration + channels[]; channels' inner shape matches
      // (targetPath / property / sampler). property is narrowed to the runtime
      // closed union ('translation' | 'rotation' | 'scale') by an unsafe cast
      // — parse-animation already fail-fasts on unsupported paths (morph
      // 'weights' / CUBICSPLINE) so any clip reaching here is the supported
      // subset. refs[] is empty (animation clips reference joints by name path
      // resolved at post-spawn time, not by sub-asset cross-edge).
      const rec = doc.animationClips[sub.sourceIndex];
      if (rec === undefined) continue;
      const payload = {
        kind: 'animation-clip' as const,
        duration: rec.duration,
        channels: rec.channels.map((ch) => ({
          targetPath: ch.targetPath,
          property: ch.property as 'translation' | 'rotation' | 'scale',
          sampler: {
            input: ch.sampler.input,
            output: ch.sampler.output,
            interpolation: ch.sampler.interpolation,
          },
        })),
      };
      out.push({ guid: sub.guid, kind: 'animation-clip', payload, refs: [] });
    }
  }
  return { ok: true, value: { assets: out, artifacts: [], sourceDependencies: [] } };
}

/**
 * The gltf {@link Importer}. Register it into an `ImporterRegistry` so the
 * import runner dispatches `meta.importer === 'gltf'` sidecars here.
 *
 * @example
 * ```ts
 * import { ImporterRegistry } from '@forgeax/engine-import';
 * import { gltfImporter } from '@forgeax/engine-gltf';
 * const importers = new ImporterRegistry();
 * importers.register(gltfImporter);
 * ```
 */
export const gltfImporter: Importer = {
  key: 'gltf',
  import: importGltf,
};
