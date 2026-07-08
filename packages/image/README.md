# @forgeax/engine-image

> **Disk-to-memory image importer for forgeax-engine.** Pure functions translate `*.jpg` / `*.png` / `*.hdr` source files into `TextureAsset` / `EquirectAsset` PODs (raw `.bin` or Basis `.ktx2`) + `external-asset-package` sidecar JSON. GPU upload lives in `@forgeax/engine-runtime` (charter P5: producer / consumer split).

## compressionMode sidecar field

The `.meta.json` sidecar accepts an optional `compressionMode` field controlling
the offline block-compression encoding (Basis KTX2). The default is `'auto'`.

### Four-mode semantics

| Mode | Behavior | Encoding | Runtime format |
|:--|:--|:--|:--|
| `'auto'` (default) | Derive encoding from color space + source format | Depends on source (see table below) | Depends on target caps |
| `'etc1s'` | Force ETC1S Basis encoding | ETC1S (fast preset, deterministic) | BC1/ETC1/ETC2 depending on caps |
| `'uastc'` | Force UASTC-LDR Basis encoding | UASTC-LDR 4x4 (fast preset, deterministic) | BC7/ASTC4x4/ETC2 depending on caps |
| `'none'` | Skip compression, produce raw RGBA `.bin` | None | `rgba8unorm` / `rgba16float` |

### 'auto' derivation rules (D-12)

| Source | colorSpace | Encoding | Rationale |
|:--|:--|:--|:--|
| PNG/JPEG | `'srgb'` | `etc1s` | Albedo/UI textures: ETC1S with sRGB transfer |
| PNG/JPEG | `'linear'` | `uastc` | Normal/ORM/data textures: UASTC-LDR with linear color |
| HDR (`.hdr`) | N/A (always linear) | `none` (rgba16float) | `.hdr` sources are always `kind: 'equirect'` (IBL/skybox). The runtime drives them through equirect-to-cube / irradiance / prefilter RENDER passes, and a block-compressed (BC6H) texture is sample-only, never color-renderable -- so equirect is forced to uncompressed rgba16float (feat-20260707 M5 fix). The `uastc-hdr` -> BC6H encoding remains in `compressionFor` for a purely-sampled HDR *texture*, but no current source path produces a non-equirect HDR texture. |

### Mip offline baking constraint

**Block-compressed textures cannot use runtime mipmap generation** (compressed
formats are not render-target-compatible). Mip chains must be baked offline
through the importer sidecar:

- Set `importSettings.mipmap: true` in `.meta.json` to bake a full mip chain
  during import. The encoder produces mip levels with a box filter.
- Runtime `mipmap: true` on a compressed TextureAsset fails fast with
  `mipgen-unsupported-compressed-format` (AC-09). The `.hint` directs you to
  set `compressionMode: 'none'` or bake mips offline.
- Uncompressed textures (`compressionMode: 'none'`) are exempt: they support
  runtime mip-gen normally.

### Determinism

Same input bytes + same `compressionMode` + same import settings produce
byte-identical `.ktx2` every time (AC-02). The encoder runs single-threaded
with no timestamp or random seed, guaranteeing DDC cache safety.

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
4. Produces an `EquirectAsset` POD: `format: 'rgba16float'`, `colorSpace: 'linear'`

The sidecar (`.hdr.meta.json`) declares `subAssets[0].kind: 'equirect'` (a dedicated asset kind; the prior `cube-texture` kind + its `importSettings.cubeFaceSize`/`specularMipLevels` are removed -- the equirect-to-cubemap projection params are decided internally by the render-system). At build-catalog time, the `.hdr` extension passes through as a `kind: 'equirect'` catalog row with `ImageMetadata(format: 'rgba16float')`. The `vite-plugin-pack` import step hashes the f16 payload into an imported `.bin`. At runtime, `loadByGuid<EquirectAsset>` loads the imported `.bin` via `equirectLoader` (an UPSTREAM_ENTRY loader) -- transparent to the consumer. The loaded `EquirectAsset` binds declaratively to `Skylight.equirect` / `SkyboxBackground.equirect`; the equirect-to-cubemap projection + IBL precompute run engine-internally. Raw `.hdr` sources hitting runtime without import fail fast with `image-decode-failed`.

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
