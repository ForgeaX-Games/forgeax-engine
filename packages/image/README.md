# @forgeax/engine-image

> **Disk-to-memory image importer for forgeax-engine.** Pure functions translate `*.jpg` / `*.png` source files into `DecodedImage` POD + `external-asset-package` sidecar JSON. GPU upload lives in `@forgeax/engine-runtime` (charter P5: producer / consumer split).

## Entry points

| Entry | Surface | Browser-safe? |
|:--|:--|:--|
| `@forgeax/engine-image` (main) | `decodeImageInBrowser` (createImageBitmap path), `toAssetPack`, `subAssetKey` / `subAssetKeyEqual`, `reimportReuseMeta`, `imageError` / error types, `loadJpeg` / `loadUpng` (legacy lazy loaders) | yes — no `jpeg-js` / `upng-js` / `node:fs` |
| `@forgeax/engine-image/parse-image` | `parseImage(bytes, mime, opts?)` — synchronous Node decoder using `jpeg-js` / `upng-js` | **Node-only** (`exports['./parse-image']` carries `node` condition + `default: null`) |
| `@forgeax/engine-image/decode-image-from-file` | `decodeImageFromFile(path)` — async `node:fs` reader + sidecar resolver | **Node-only** (same `node` + `default: null` shape) |
| `@forgeax/engine-image/hdr-decoder` | `decodeHdr` — Radiance .hdr decoder | browser-safe (no Node-only deps) |

## HDR equirect import path

HDR equirectangular sources (`.hdr`) are decoded at build-time by `imageImporter`'s HDR arm. The importer:
1. Detects `.hdr` sources by file extension
2. Decodes RGBE data via `decodeHdr` -> `Float32Array`
3. Converts f32 -> f16 bytes via `halfFloat.f32ToF16Bytes` (`@forgeax/engine-math`)
4. Produces a `TextureAsset` POD: `format: 'rgba16float'`, `colorSpace: 'linear'`

The sidecar (`.hdr.meta.json`) declares `subAssets[0].kind: 'cube-texture'` with `importSettings.cubeFaceSize` (equirect -> cube face size, default 256) and `specularMipLevels` (default 0). At build-catalog time, the `.hdr` extension maps to a `kind: 'texture'` catalog row with `ImageMetadata(format: 'rgba16float')`. The `vite-plugin-pack` import step hashes the f16 payload into a imported `.bin`. At runtime, `loadByGuid<TextureAsset>` loads the imported `.bin` like any other texture -- transparent to the consumer. Raw `.hdr` sources hitting runtime without import fail fast with `image-decode-failed`.

## 4 步 recipe

```ts
// Node-only sub-export — fs read + decode in one call
import { decodeImageFromFile } from '@forgeax/engine-image/decode-image-from-file';
// browser-safe main entry — POD envelope helper
import { toAssetPack } from '@forgeax/engine-image';

// 1. read disk -- decodeImageFromFile stats the sidecar (image-meta-missing
//    if absent; charter P3 explicit failure) and returns DecodedImage POD
const r = await decodeImageFromFile('apps/learn-render/.../wood-container.jpg');
if (!r.ok) {
  switch (r.error.code) {
    case 'image-meta-missing':
      // r.error.detail.expectedSidecarPath = '...wood-container.meta.json'
      console.error(r.error.hint);
      return;
    case 'image-decode-failed':
    case 'image-format-unsupported':
    case 'image-dimension-out-of-bounds':
      return;
  }
}

// 2. translate decoded bytes + meta to AssetPack (sidecar JSON shape)
const pack = toAssetPack(r.value.decoded, r.value.meta);

// 3. write byte-stable JSON to disk; second `forgeax-engine-console asset
//    import` produces a byte-identical file (AC-16 idempotent reimport)
await fs.writeFile('wood-container.jpg.meta.json', JSON.stringify(pack, null, 2));

// 4. runtime consumes the sidecar via loadByGuid<TextureAsset>(guid) +
//    AssetRegistry.uploadTexture(handle, decoded) (M3, runtime side; image
//    package never imports `device.queue.writeTexture`)
```

## 4 错误码全集（charter P3 显式失败）

| code | trigger | detail shape |
|:--|:--|:--|
| `'image-decode-failed'` | UPNG / jpeg-js decoder threw on the byte stream | `{ path, reason }` |
| `'image-format-unsupported'` | mime not in `['image/png', 'image/jpeg']`, or format <-> colorSpace mismatch on uploadTexture entry | `{ actualMime, path, formatColorSpaceConflict? }` |
| `'image-dimension-out-of-bounds'` | width / height exceed device caps (or hard 16k cap when caps absent) | `{ requested, limit }` |
| `'image-meta-missing'` | source file exists but no `<source>.meta.json` sidecar in the same directory | `{ sourcePath, expectedSidecarPath }` |

`switch (err.code)` over the 4 members compiles without a `default:` arm; TS guards completeness (charter P4 explicit failure).

## 形态铁律

- **二态分离** -- 本包仅做磁盘 -> 内存翻译；GPU 上传 (`copyExternalImageToTexture` / `writeTexture`) 全部在 `@forgeax/engine-runtime` 内，本包 grep `device.queue.writeTexture` 零命中（CI 闸门）
- **同型镜像 in-flight gltf loader** -- `subAssetKey { kind, name?, indexFallback }` 与 `feat-20260515-gltf-loader-via-asset-system` 完全等价（image 单子资产场景退化为 `kind='image'` / `indexFallback='images/0'`）
- **disk schema 复用 meta.schema.json** -- `*.meta.json` 走 `external-asset-package` kind，不新增 schema kind（plan-strategy D-4）
- **byte-identical reimport** -- 第二次 `forgeax-engine-console asset import` 产出与第一次 `git diff` 输出空（AC-16）
- **OOS 远期** -- KTX2 / Basis / EXR / cubemap face / array layer / video texture 不在本 MVP（OOS-12 import 包独立 feat）

## 相关包

- [`@forgeax/engine-types`](../types) -- `ImageErrorCode` / `ImageErrorDetail` / `IMAGE_ERROR_HINTS` / `ImageMeta` / `DecodedImage` POD SSOT (math-free)
- [`@forgeax/engine-pack`](../pack) -- `AssetGuid.random()` UUIDv7 生成 + `external-asset-package` schema + scanner 6-step fail-fast (本包不修改 scanner 行为)
- [`@forgeax/engine-runtime`](../runtime) -- `AssetRegistry.uploadTexture(handle, decoded)` GPU 上传入口 (M3 落地，本包 M2 仅 producer)
