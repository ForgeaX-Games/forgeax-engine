# @forgeax/engine-codec

> `@forgeax/engine-codec` provides runtime-safe zstd decode, KTX2 container parse,
> and build-time zstd encode for the forgeax asset pipeline.

> [!IMPORTANT]
> This package uses **subpath-level encode/decode separation** (D-1). The main entry
(`@forgeax/engine-codec`) exports runtime-safe decode functions. The `/encode`
subpath (`@forgeax/engine-codec/encode`) exports build-time encoding. Runtime code
must never import from `/encode` -- this is enforced by
`check-image-pipeline-isolation.mjs` path d (AC-09).

## API

### Runtime-safe decode (main entry)

| Export | Signature | Description |
|:--|:--|:--|
| `decompressZstd` | `(bytes: Uint8Array) => Promise<CodecResult<Uint8Array>>` | Decompress a zstd-compressed byte buffer. Lazy-init singleton (fzstd pure JS, zero WASM); concurrent first calls share the same init promise (AC-12). Returns `CodecOk<Uint8Array>` on success, `CodecError` on failure. |
| `parseKtx2` | `(bytes: Uint8Array) => Promise<CodecResult<Ktx2Parsed>>` | Parse a KTX2 2.0 container (12B magic validation). Returns header, index, level index, DFD, KV metadata, and SGD descriptor -- all five parts per AC-03. Does **not** interpret block-compressed payload content (OOS-6, Loop 2). Async -- `await` the result. |
| `ktx2LevelsToRGBA` | `(parsed: Ktx2Parsed, level?: number) => Promise<CodecResult<Uint8Array>>` | Extract RGBA bytes from a parsed KTX2 container. Handles scheme=0 (uncompressed, pass-through) and scheme=2 (zstd supercompression, reuses `decompressZstd` per AC-04). The optional `level` parameter selects a mip level (default: 0). Returns the level's RGBA bytes as a flat `Uint8Array`. |

Usage example:

```ts
import { decompressZstd, parseKtx2, ktx2LevelsToRGBA, codecError }
  from '@forgeax/engine-codec';

// Decompress zstd bytes
const res = await decompressZstd(compressedBytes);
if (res.ok) {
  const original = res.value; // Uint8Array
} else {
  switch (res.error.code) {
    case 'decompression-failed':  // res.error.detail: { reason }
    case 'codec-init-failed':     // res.error.detail: { stage }
    case 'ktx2-parse-failed':     // res.error.detail: { reason }
    case 'ktx2-unsupported-scheme': // res.error.detail: { scheme }
  }
}

// Parse KTX2 container and extract RGBA
const k = await parseKtx2(ktx2Bytes);
if (k.ok) {
  const rgba = await ktx2LevelsToRGBA(k.value, 0);
}
```

### Build-time encode (`/encode` subpath)

| Export | Signature | Description |
|:--|:--|:--|
| `compressZstd` | `(bytes: Uint8Array) => Promise<CodecResult<Uint8Array>>` | Compress bytes with zstd (pinned WASM, fixed level, no dictionary, no timestamp -- deterministic per AC-07). Build-time only; gated from runtime import by `check-image-pipeline-isolation.mjs` path d. |

Import path:

```ts
import { compressZstd } from '@forgeax/engine-codec/encode';
//                                       ^^^^^^^^^^^^^^^
//                                       build-time only, blocked from runtime
```

### Type exports

| Export | Description |
|:--|:--|
| `CodecErrorCode` | Closed union: `'decompression-failed' \| 'codec-init-failed' \| 'ktx2-parse-failed' \| 'ktx2-unsupported-scheme'` (order-locked, add-only-minor for Loop 2) |
| `CodecError` | Structured error: `{ ok: false, error: { code, expected, hint, detail } }` with per-code narrowed `detail` |
| `CodecOk<T>` | Success branch: `{ ok: true, value: T }` |
| `CodecResult<T>` | Discriminated union: `CodecOk<T> \| CodecError` |
| `Ktx2Header` | Parsed KTX2 header (9 u32 fields + supercompressionScheme) |
| `Ktx2Index` | Parsed KTX2 index (dfd/kvd/sgd byte offsets and lengths) |
| `Ktx2LevelEntry` | Per-level byte offset, byte length, uncompressed byte length |
| `Ktx2Dfd` / `Ktx2DfdSample` | Parsed DFD (data format descriptor) block |
| `Ktx2KvEntry` | Key-value metadata entry (key string + raw value bytes) |
| `Ktx2Parsed` | Fully parsed KTX2 container: `{ header, index, levelIndex, dfd, kvEntries, sgd }` |

## Error codes

All codec errors use the `CodecErrorCode` closed union. Consume with exhaustive
`switch (err.code)` -- no `default` branch, TypeScript guards completeness.

| Code | Trigger condition | `.hint` (executable recovery) | `.detail` payload |
|:--|:--|:--|:--|
| `decompression-failed` | Corrupted/malformed zstd input, or encode failure surfaced as decompression error | "Check catalog row compression field and asset binary consistency; re-run asset import." | `{ reason: string }` -- failure cause |
| `codec-init-failed` | Dynamic import of fzstd decode module failed (network / bundling) | "Uncompressed assets are still loadable. Verify the codec module is installed correctly." | `{ stage: string }` -- failed initialization stage |
| `ktx2-parse-failed` | KTX2 magic mismatch, header truncation, level index out of bounds (E5) | "Check that the KTX2 file is valid and not truncated. Re-import the texture asset." | `{ reason: string }` -- parse failure location |
| `ktx2-unsupported-scheme` | KTX2 supercompression scheme is BasisLZ (=1), ZLIB (=3), or other non-zstd (E6) | "This supercompression scheme requires a future codec upgrade. Check the codec README Loop 2 extension points." | `{ scheme: number }` -- the unsupported scheme value |

### Error propagation

Codec errors are consumed in two contexts:

1. **Direct consumption** -- AI users calling `decompressZstd` / `parseKtx2` directly
   get the full `CodecError` with per-code narrowed `detail`.

2. **Runtime transparent pass-through** -- in the runtime's `fetchBinary` gate,
   codec errors are nested in the existing `asset-fetch-failed` error's `.detail`
   field. The types-shared `ErrorCode` union is NOT extended (D-8). AI users
   doing `loadByGuid` never see `CodecErrorCode` directly; they see the standard
   asset error surface.

## Loop 2 extension points

> [!NOTE]
> This section documents the 3 frozen contract seams that Loop 2
> ("texture block-compression") consumes without re-designing (AC-13).
> Do not delete or rearrange these sections -- they are the hand-off interface.

### Contract seam 1: `compression` sidecar field

The `AssetCompression` union (`packages/types/src/index.ts`) currently has:

```ts
type AssetCompression = 'none' | 'zstd';
```

**Loop 2 extension**: May add combination literal members such as `'zstd+bc7'`,
`'zstd+astc'`, or `'basis-uastc'` to represent block-compressed payloads wrapped
in zstd supercompression. The field is consumed in `PackIndexEntry.compression?`,
`ImageMetadata.compression?`, `LoaderEntry.compression?`, `listCatalog()` return
rows, and `importSettings`. Loop 2 adds members here; runtime `fetchBinary`
gate branches on the string value.

### Contract seam 2: runtime single decompression gate

The runtime decompression happens in exactly one place:
`fetchBinary(url, { compression })` in `asset-registry.ts`. The gate currently
branches on `compression === 'zstd'` to call `decompressZstd`. Raw bytes are
returned to loaders unchanged in all other cases.

**Loop 2 extension**: After zstd decompression returns raw bytes, Loop 2 adds a
second gate for block-compressed payloads: `basis_transcoder.wasm` transcode from
the universal intermediate format to the platform's native block format.
The transcoder hangs **after** the zstd gate -- same `fetchBinary` entry point,
no second decompression point (contract seam 2 constraint).

### Contract seam 3: KTX2 container parser

`parseKtx2(bytes)` returns `Ktx2Parsed` with `header.supercompressionScheme`,
`levelIndex` (per-level `byteOffset` / `byteLength` / `uncompressedByteLength`),
`dfd.colorModel`, and `sgd`. `ktx2LevelsToRGBA` handles scheme=0 (uncompressed)
and scheme=2 (zstd) only.

**Loop 2 extension**: For scheme=1 (BasisLZ), `parseKtx2` already provides:
- `levelIndex[].byteOffset` and `levelIndex[].byteLength` -- the block payload
  bytes to feed into `basis_transcoder.wasm`
- `dfd.colorModel` and `dfd.colorPrimaries` -- color space metadata for upload
- `sgd` (supercompression global data) -- the BasisLZ codebook

Loop 2 adds a third arm to `ktx2LevelsToRGBA` for scheme=1 that calls the
transcoder instead of `decompressZstd`. The container parser itself does NOT
change -- Loop 2 reuses the same `parseKtx2` export (contract seam 3 constraint).

### Compression ratio baseline (AC-05)

zstd compression on representative mesh `.bin` data achieves approximately 30-60%
size reduction (f32 vertex data). The AC-05 assertion floor is `>= 30%` on the
compression ratio (compressed / original <= 0.70). Loop 2 may establish separate
ratios for block-compressed textures.

## Package metrics (AC-11)

The codec package declares all 5 `MetricKind` entries in
`package.json#forgeax.metrics`:

| Metric | Status | Reason |
|:--|:--|:--|
| `bundle-size` | enabled | Measures decode entry dist bundle (`dist/index.mjs` gzip). fzstd is pure JS (no WASM), so this captures the full decode cost. |
| `fps` | disabled | Pure-function library, no render-loop impact |
| `bench` | disabled | No performance-sensitive hot paths to benchmark in isolation |
| `gate` | disabled | No codec-specific gates beyond metric declaration itself |
| `spike-report` | disabled | No spiking concerns for a deterministic pure-function library |

## Build-time encode subpath

The `/encode` subpath (`@forgeax/engine-codec/encode`) exports `compressZstd`
for build-time use only. It is consumed by `vite-plugin-pack`'s
`compress-artifact.ts` SSOT function. Runtime code must never import from this
subpath -- enforced by `check-image-pipeline-isolation.mjs` path d (AC-09).

## Related documentation

- `packages/runtime/README.md` -- `fetchBinary` automatic decompression gate
- `packages/pack/README.md` -- `compression` field in pack-index row schema
- `skills/forgeax-engine-assets/SKILL.md` -- AI user-facing asset pipeline
- `docs/superpowers/specs/2026-07-06-asset-compression-pipeline-roadmap-design.md` -- two-loop roadmap