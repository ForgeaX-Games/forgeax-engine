// fbx-importer.ts — TS wrapper around the native FBX SDK addon.

import type { ImportContext, ImportedAsset, Importer } from '@forgeax/engine-types';
import { fbxErr } from './errors.js';
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
    // Use createRequire from node:module for ESM context.
    // In browser, node:module is not available and the catch block
    // produces a fbx-binding-not-built error (charter P3 explicit failure).
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    let binding: { parseFbx: (filename: string, options?: Record<string, unknown>) => string };
    try {
      binding = req('../build/Release/fbx_binding.node') as {
        parseFbx: (filename: string, options?: Record<string, unknown>) => string;
      };
    } catch {
      const e = fbxErr('fbx-binding-not-built', {
        sdkRoot: process.env.FBX_SDK_ROOT,
        binding: 'build/Release/fbx_binding.node',
      });
      // The Importer interface returns Promise<ImportedAsset[]> (not Result),
      // so structural FbxError cannot flow through the import-runner's typed
      // error return. Throw a plain Error with the code in the message so
      // AI users can at least grep import-internal-error.detail.reason for
      // the 'fbx-binding-not-built' substring.
      // Plan-layer follow-up (OOS-*): introduce ResultImporter for
      // structural error surfacing.
      const wrapper = new Error(`${e.code}: ${e.expected}`);
      (wrapper as { cause?: unknown }).cause = e;
      throw wrapper;
    }

    const jsonStr = binding.parseFbx(ctx.source);
    const doc = JSON.parse(jsonStr) as FbxRawDocument &
      FbxRawSkeletonDoc &
      FbxRawSkinDoc &
      FbxRawAnimDoc;

    // t46: NURBS error envelope
    const maybeError = doc as unknown as {
      error?: { code: string; meshType: string; meshName: string };
    };
    if (maybeError.error?.code === 'fbx-mesh-type-unsupported') {
      const e = fbxErr('fbx-mesh-type-unsupported', {
        meshType: maybeError.error.meshType as 'nurbs' | 'patch',
        meshName: maybeError.error.meshName,
      });
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

    // t48/t49/t50: skeleton, skin, animation clips
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
