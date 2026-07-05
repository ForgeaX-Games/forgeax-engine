// fbx-importer.ts — TS wrapper around the ufbx WASM parser.

import type { ImportContext, ImportedAsset, Importer } from '@forgeax/engine-types';
import { fbxErr } from './errors.js';
import { initFbxWasm, parseFbx } from './index.js';
import { type FbxRawAnimDoc, parseAnimationClips } from './parse-animation-clip.js';
import { type FbxRawMaterial, parseMaterial } from './parse-material.js';
import { type FbxRawDocument, type FbxRawMesh, parseMesh } from './parse-mesh.js';
import { type FbxRawNodes, parseScene } from './parse-scene.js';
import { type FbxRawSkeletonDoc, parseSkeleton } from './parse-skeleton.js';
import { type FbxRawSkinDoc, parseSkin } from './parse-skin.js';
import { parseTextures } from './parse-texture.js';
import { toAssetPack } from './to-asset-pack.js';

export const fbxImporter: Importer = {
  key: 'fbx',

  async import(ctx: ImportContext): Promise<readonly ImportedAsset[]> {
    // ufbx WASM path: read raw FBX bytes via the import context (browser +
    // Node both resolve through readSource), then parse in-memory. No native
    // addon / SDK build step (the WASM module self-loads its .wasm).
    const read = await ctx.readSource();
    if (!read.ok) {
      const wrapper = new Error(`fbx-source-unreadable: ${ctx.source}`);
      (wrapper as { cause?: unknown }).cause = read.error;
      throw wrapper;
    }

    await initFbxWasm();
    const jsonStr = parseFbx(read.value);
    const doc = JSON.parse(jsonStr) as FbxRawDocument &
      FbxRawSkeletonDoc &
      FbxRawSkinDoc &
      FbxRawAnimDoc;

    // NURBS / patch fail-fast: the bridge emits an error envelope for
    // unsupported surface types (charter P3 explicit failure).
    const maybeError = doc as unknown as {
      error?: { code: string; meshType: string; meshName: string };
    };
    if (maybeError.error?.code === 'fbx-mesh-type-unsupported') {
      const e = fbxErr('fbx-mesh-type-unsupported', {
        meshType: maybeError.error.meshType as 'nurbs' | 'patch',
        meshName: maybeError.error.meshName,
      });
      // The Importer interface returns Promise<ImportedAsset[]> (not Result),
      // so structural FbxError cannot flow through the import-runner's typed
      // error return. Throw a plain Error with the code in the message so
      // AI users can grep import-internal-error.detail.reason for the
      // 'fbx-mesh-type-unsupported' substring; the structural error rides on
      // `.cause`.
      const wrapper = new Error(`${e.code}: ${e.expected}`);
      (wrapper as { cause?: unknown }).cause = e;
      throw wrapper;
    }

    const rawMeshes: readonly FbxRawMesh[] = doc.meshes ?? [];
    const meshes = rawMeshes.map((raw, i) => parseMesh(raw, i));

    const scene = parseScene(doc as unknown as FbxRawNodes);

    const texturesModule = doc as unknown as { textures?: readonly unknown[] };
    const textures = parseTextures({ textures: texturesModule.textures as never });

    const materialDocs =
      (doc as unknown as { materials?: readonly FbxRawMaterial[] }).materials ?? [];
    const materials =
      materialDocs.length > 0
        ? materialDocs.map((raw, i) => parseMaterial(raw, i))
        : [parseMaterial({ kind: 'fallback' }, 0)];

    const skeleton = parseSkeleton(doc);
    const skin = parseSkin(doc);
    const animationClips = parseAnimationClips(doc);

    return toAssetPack({
      meshes,
      scene,
      materials,
      textures,
      skeleton,
      skin,
      animationClips,
      subAssets: ctx.subAssets,
    });
  },
};
