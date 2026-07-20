// @forgeax/engine-assets-runtime -- inline pack-payload loader bodies
// (feat-20260705-runtime-tier2-decomposition M1 / w4, D-4 F1 straight-cut).
// Pure move from asset-registry.ts; zero identifier changes.

import type {
  AnimationChannel,
  Asset,
  LoadContext,
  Loader,
  MaterialAsset,
  MaterialPassDescriptor,
  ParseErrorDetail,
  MeshAsset as TypesMeshAsset,
} from '@forgeax/engine-types';
import { BUILTIN_FLOATS_PER_VERTEX } from '../builtin-asset-registry';
import { parseScenePayload } from '../scene-payload';

// === Inline pack-payload loader bodies (feat-20260603-asset-import-loader-injection
// M1 / w4) ===
//
// The seven `if (kind === ...)` arms that lived inside
// `AssetRegistry.parseAssetPayload` (research Finding 1) are extracted here as
// module-level `{ kind, load }` objects so they register into a
// `LoaderRegistry` (D-1) and can be imported by `wireDefaultLoaders` (w5). The
// body logic is copied verbatim — M1 is a pure refactor (AC-03), no behavioural
// change. Each parses an inline `.pack.json` payload synchronously and returns
// the `Asset` POD or `undefined` (parse rejected). The `scene` arm routes its
// structured out-of-bounds-ref error back through the LoaderOutput return
// value instead of the old shared instance slot (D-8 channel replaced by F21).

/** mesh loader — Float32Array / Uint16Array | Uint32Array normalisation -> MeshAsset.
 *
 * feat-20260611: skinIndex (Uint16Array) and skinWeight (Float32Array) accept
 * both their native typed-array shape (in-memory: dawn smoke / direct
 * `register` test) AND `number[]` (post-`JSON.stringify` shape produced by the
 * dev-server / build-mode pack-body round-trip — `JSON.stringify(pack) -> fetch
 * -> JSON.parse` flattens every typed array to a plain Array). Same dual
 * contract `skeletonLoader` / `animationClipLoader` already honour (PR #350);
 * without the array arm, every Fox.glb / Khronos skinned glTF surfaces as
 * `asset-parse-failed` on the browser path while dawn smoke stays green.
 */
export const meshLoader: Loader = {
  kind: 'mesh',
  load(payload) {
    const vertexData = payload.vertices;
    const indexData = payload.indices;
    const rawAttributes = (payload.attributes as Record<string, unknown> | undefined) ?? {};
    const attributes: Record<string, unknown> = { ...rawAttributes };

    const skinIndexRaw = rawAttributes.skinIndex;
    if (skinIndexRaw instanceof Uint16Array) {
      attributes.skinIndex = skinIndexRaw;
    } else if (Array.isArray(skinIndexRaw)) {
      attributes.skinIndex = new Uint16Array(skinIndexRaw as number[]);
    } else if (skinIndexRaw !== undefined) {
      return undefined;
    }

    const skinWeightRaw = rawAttributes.skinWeight;
    if (skinWeightRaw instanceof Float32Array) {
      attributes.skinWeight = skinWeightRaw;
    } else if (Array.isArray(skinWeightRaw)) {
      attributes.skinWeight = new Float32Array(skinWeightRaw as number[]);
    } else if (skinWeightRaw !== undefined) {
      return undefined;
    }

    let vertices: Float32Array;
    let indices: Uint16Array | Uint32Array | undefined;

    if (vertexData instanceof Float32Array) {
      vertices = vertexData;
    } else if (Array.isArray(vertexData)) {
      vertices = new Float32Array(vertexData as number[]);
    } else {
      return undefined;
    }

    // bug-20260610: index width must follow vertex count, not a hard-coded
    // Uint16Array. A glTF mesh (e.g. Sponza, ~192k merged verts) overflows
    // Uint16; round-tripping through Uint16Array silently wraps and
    // `mesh-vertex-stride-mismatch` then fires because `maxIndex + 1` no
    // longer equals `vertexCount`. Mirrors `meshIrToMeshAsset` in
    // packages/gltf/src/bridge.ts which picks Uint32 above 0xffff.
    //
    // feat-20260612 M2 fixup: when the input carries an empty index array
    // (Fox.glb-style non-indexed primitives flattened through the mesh-bin
    // sidecar with `ilen=0`), drop the indices field rather than emit a
    // 0-byte typed array. The downstream `gpu-resource-store` chooses the
    // indexed-vs-vertex-only path on `mesh.indices !== undefined`; a 0-byte
    // typed array still satisfies !== undefined and triggers a 0-size IBO
    // allocation, whose `setIndexBuffer(buffer.slice(0..0), ...)` panics
    // wgpu's `BufferSlice` "buffer slices can not be empty" assertion.
    if (indexData instanceof Uint16Array || indexData instanceof Uint32Array) {
      indices = indexData.length > 0 ? indexData : undefined;
    } else if (Array.isArray(indexData)) {
      const arr = indexData as number[];
      if (arr.length === 0) {
        indices = undefined;
      } else {
        const vertexCount = vertices.length / BUILTIN_FLOATS_PER_VERTEX;
        const useUint32 = vertexCount > 0xffff;
        indices = useUint32 ? new Uint32Array(arr) : new Uint16Array(arr);
      }
    } else if (indexData === undefined) {
      indices = undefined;
    } else {
      return undefined;
    }

    // feat-20260608 M5 / w27: pack-payload mesh assets default to a single
    // triangle-list submesh covering the full index/vertex range. Inline
    // .pack.json mesh payloads do not carry submesh tables (single-prim
    // legacy shape); render code unconditionally reads `submeshes[0]`.
    // vertexCount stored as full vertices.length (downstream computes per-
    // attribute strides; submesh keeps the buffer-element-count for now).
    //
    // bug-20260610: when the payload carries an explicit `submeshes` table
    // (gltf importer emits one per primitive), respect it. The
    // `triangle-list 0..indices.length` default fits only single-prim packs.
    const payloadSubmeshes = payload.submeshes;
    const submeshes =
      Array.isArray(payloadSubmeshes) && payloadSubmeshes.length > 0
        ? (payloadSubmeshes as unknown as TypesMeshAsset['submeshes'])
        : [
            {
              indexOffset: 0,
              indexCount: indices?.length ?? 0,
              vertexCount: vertices.length,
              topology: 'triangle-list' as const,
            },
          ];

    return {
      kind: 'mesh',
      vertices,
      ...(indices !== undefined ? { indices } : {}),
      attributes: attributes as TypesMeshAsset['attributes'],
      aabb: new Float32Array(6),
      submeshes,
    };
  },
};

/** scene loader — delegates to parseScenePayload; routes structured ref error via ctx. */
export const sceneLoader: Loader = {
  kind: 'scene',
  load(payload, refs, _ctx: LoadContext) {
    const result = parseScenePayload(payload, refs === undefined ? undefined : [...refs]);
    if (result === undefined) return undefined;
    // Structured ParseSceneError (has an `index` field absent on SceneAsset):
    // return it inline through LoaderOutput so the caller (parseAndReturnAsset)
    // can build a precise AssetError without a shared instance slot (F21).
    if ('index' in result) {
      return { ok: false, error: result as ParseErrorDetail };
    }
    return result as Asset;
  },
};

/**
 * feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
 * the legacy hardcoded texture-field allowlist Set has been removed
 * (AC-03). The materialLoader now consults `ctx.getMaterialShaderTextureFieldNames`
 * (paramSchema-derived via derive()) to know which paramValues fields carry
 * refs[] indices. When the shader is not yet registered (cross-worktree
 * shader-late-register path, plan R-4), the loader falls back to attempting
 * resolution on every int-typed paramValue in [0, refs.length) — M4 / w23's
 * extract-layer paramSchema validation catches misclassifications and routes
 * unresolved texture slots through `MISSING_TEXTURE_HANDLE`.
 */
function collectShaderTextureFieldNames(
  passesFromPayload: unknown,
  ctx: LoadContext,
): ReadonlySet<string> | undefined {
  if (!Array.isArray(passesFromPayload) || passesFromPayload.length === 0) return undefined;
  const lookup = ctx.getMaterialShaderTextureFieldNames;
  if (lookup === undefined) return undefined;
  const collected = new Set<string>();
  let anyResolved = false;
  for (const pass of passesFromPayload) {
    const shaderId = (pass as { shader?: unknown }).shader;
    if (typeof shaderId !== 'string' || shaderId.length === 0) continue;
    const fields = lookup(shaderId);
    if (fields === undefined) continue;
    anyResolved = true;
    for (const name of fields) collected.add(name);
  }
  return anyResolved ? collected : undefined;
}

/** material loader — passes + paramValues + parent ref-index -> parentGuid string. */
export const materialLoader: Loader = {
  kind: 'material',
  load(payload, refs, ctx: LoadContext) {
    const matPayload = payload;
    const passesFromPayload = matPayload.passes;
    const rawParamValues = (matPayload.paramValues as Record<string, unknown>) ?? {};

    let parentGuid: string | undefined;
    if (typeof matPayload.parent === 'number') {
      const idx = matPayload.parent;
      const refsArr = refs ?? [];
      if (idx >= 0 && idx < refsArr.length) {
        const refGuid = refsArr[idx];
        if (typeof refGuid === 'string') {
          parentGuid = refGuid;
        }
      }
      if (parentGuid === undefined) {
        return undefined;
      }
    }

    // bug-20260610: paramValues fields that are typed `handle<TextureAsset>`
    // arrive on disk as a refs[] index (small int 0..refs.length-1). The
    // build-time gltfImporter writes these as refs indices, mirroring the
    // scene's HANDLE_FIELD_NAMES treatment.
    //
    // feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
    // texture-field discovery now derives from the registered shader's
    // paramSchema via `ctx.getMaterialShaderTextureFieldNames`. When the
    // shader is registered (the common case), only declared texture fields
    // are resolved — identical to the old hardcoded-Set behaviour without the
    // SSOT duplication. When the shader is not yet registered (cross-worktree
    // shader-late-register, plan R-4), every int-typed paramValue in
    // [0, refs.length) is attempted; the M4 / w23 extract layer's paramSchema
    // validation catches misclassified scalars and falls back to
    // MISSING_TEXTURE_HANDLE.
    const paramValues: Record<string, unknown> = { ...rawParamValues };
    if (refs && refs.length > 0) {
      const shaderTextureFields = collectShaderTextureFieldNames(passesFromPayload, ctx);
      const candidateFields =
        shaderTextureFields !== undefined ? shaderTextureFields : Object.keys(paramValues);
      for (const fieldName of candidateFields) {
        const value = paramValues[fieldName];
        if (typeof value !== 'number' || !Number.isInteger(value)) continue;
        if (value < 0 || value >= refs.length) {
          // Only emit a parse-error breadcrumb when the field is declared as
          // a texture by the shader paramSchema (the OOB is unambiguous).
          // For the graceful "try every int" fallback, OOB simply means
          // "this scalar was not a refs index" — don't spam parse errors.
          if (shaderTextureFields !== undefined) {
            delete paramValues[fieldName];
          }
          continue;
        }
        const refGuid = refs[value];
        if (typeof refGuid !== 'string') {
          if (shaderTextureFields !== undefined) {
            delete paramValues[fieldName];
          }
          continue;
        }
        // feat-20260614 M8 (D-19): store the embedded sub-asset ref as its GUID
        // string (dash-form). The ECS/render side resolves GUID -> column handle
        // at use time via `world.allocSharedRef` -- the registry never mints.
        paramValues[fieldName] = refGuid;
      }
    }

    if (Array.isArray(passesFromPayload) && passesFromPayload.length > 0) {
      return {
        kind: 'material',
        passes: passesFromPayload as readonly MaterialPassDescriptor[],
        paramValues,
        parentGuid,
      } as MaterialAsset & { parentGuid?: string };
    }

    if (parentGuid !== undefined) {
      return {
        kind: 'material',
        paramValues,
        parentGuid,
      } as unknown as MaterialAsset & { parentGuid?: string };
    }

    return undefined;
  },
};

/** skeleton loader — inverseBindMatrices stride validation.
 *
 * bug-20260611: accept both `Float32Array` (in-memory: dawn smoke / direct
 * `register` test) AND `number[]` (post-`JSON.stringify` shape: `normaliseForPack`
 * in @forgeax/engine-import flattens every typed array to a plain Array so
 * `JSON.stringify(pack)` survives the dev-server / build-mode round-trip --
 * the same dual contract `meshLoader` already honours). Without the array arm
 * the .pack.json -> fetch -> JSON.parse path lands a plain object whose
 * `instanceof Float32Array` check fails, surfacing as `asset-parse-failed`
 * for any glTF carrying a Skin (e.g. Khronos Fox.glb).
 */
export const skeletonLoader: Loader = {
  kind: 'skeleton',
  load(payload) {
    const ibmRaw = payload.inverseBindMatrices;
    const jointCount = typeof payload.jointCount === 'number' ? payload.jointCount : 0;
    let ibm: Float32Array;
    if (ibmRaw instanceof Float32Array) {
      ibm = ibmRaw;
    } else if (Array.isArray(ibmRaw)) {
      ibm = new Float32Array(ibmRaw as number[]);
    } else {
      return undefined;
    }
    if (ibm.byteLength !== jointCount * 64) return undefined;
    return {
      kind: 'skeleton',
      inverseBindMatrices: ibm,
      jointCount,
    };
  },
};

/** skin loader — skeletonGuid + jointPaths validation. */
export const skinLoader: Loader = {
  kind: 'skin',
  load(payload) {
    const skeletonGuid = payload.skeletonGuid;
    const jointPathsRaw = payload.jointPaths;
    if (typeof skeletonGuid !== 'string') return undefined;
    if (!Array.isArray(jointPathsRaw)) return undefined;
    const jointPaths: string[] = [];
    for (const item of jointPathsRaw) {
      if (typeof item !== 'string') return undefined;
      jointPaths.push(item);
    }
    return { kind: 'skin', skeletonGuid, jointPaths };
  },
};

/** animation-clip loader — channels / sampler validation.
 *
 * bug-20260611: sampler.input / sampler.output accept both `Float32Array`
 * (in-memory) and `number[]` (post-`JSON.stringify` shape produced by
 * `normaliseForPack`). Same dual contract as `skeletonLoader` /
 * `meshLoader`; without it the dev `.pack.json` round-trip surfaces every
 * skinned-with-animation glTF as `asset-parse-failed`.
 */
export const animationClipLoader: Loader = {
  kind: 'animation-clip',
  load(payload) {
    const duration = typeof payload.duration === 'number' ? payload.duration : 0;
    const channelsRaw = payload.channels;
    if (!Array.isArray(channelsRaw)) return undefined;
    const channels: AnimationChannel[] = [];
    for (const ch of channelsRaw) {
      if (typeof ch !== 'object' || ch === null) return undefined;
      const chObj = ch as Record<string, unknown>;
      const targetPath = chObj.targetPath;
      const property = chObj.property;
      const samplerObj = chObj.sampler as Record<string, unknown> | undefined;
      if (!Array.isArray(targetPath)) return undefined;
      if (property !== 'translation' && property !== 'rotation' && property !== 'scale')
        return undefined;
      if (samplerObj === undefined) return undefined;
      const inputRaw = samplerObj.input;
      const outputRaw = samplerObj.output;
      const interpolation = samplerObj.interpolation;
      let input: Float32Array;
      if (inputRaw instanceof Float32Array) {
        input = inputRaw;
      } else if (Array.isArray(inputRaw)) {
        input = new Float32Array(inputRaw as number[]);
      } else {
        return undefined;
      }
      let output: Float32Array;
      if (outputRaw instanceof Float32Array) {
        output = outputRaw;
      } else if (Array.isArray(outputRaw)) {
        output = new Float32Array(outputRaw as number[]);
      } else {
        return undefined;
      }
      if (interpolation !== 'LINEAR' && interpolation !== 'STEP') return undefined;
      channels.push({
        targetPath: targetPath as readonly string[],
        property: property as 'translation' | 'rotation' | 'scale',
        sampler: { input, output, interpolation },
      });
    }
    return { kind: 'animation-clip', duration, channels };
  },
};

/**
 * The six inline pack-payload loaders, in the historical `if`-chain order.
 * `wireDefaultLoaders` (w5) registers these plus the texture / font / equirect
 * loaders (w6) and the audio placeholder (w8).
 */
export const INLINE_PACK_LOADERS: readonly Loader[] = [
  meshLoader,
  sceneLoader,
  materialLoader,
  skeletonLoader,
  skinLoader,
  animationClipLoader,
];
