# @forgeax/engine-pack

Disk schema, GUID tools (`AssetGuid` brand + UUIDv7/v5), scanner fail-fast chain (13-member `PackErrorCode`) for the forgeax engine asset package system. The three CLI surfaces -- `scan`, `lookup`, `verify` -- are shipped as the standalone plugin bin `forgeax-engine-remote-asset` (resolved via PATH-prefix discovery for `forgeax-engine-remote-`; filesystem-mode; offline; no WS connection required).

> Package name vs directory: this package is published as `@forgeax/engine-pack` but lives at `packages/pack` on disk. The `@forgeax/engine-` prefix is the IDE-autocomplete entrypoint AI users discover the package family by; the directory drops the prefix to keep tree depth flat (mirrors the `packages/runtime` / `@forgeax/engine-runtime` pair). All other packages in the engine family follow the same convention.

## Quick start

```typescript
import { AssetGuid } from "@forgeax/engine-pack/guid";
import { scan } from "@forgeax/engine-pack/scanner";

// Runtime: resolve a known GUID at build time
const result = AssetGuid.parse("cbe42beb-8975-5096-b3a1-3dda4cb4c077");
if (!result.ok) throw result.error; // PackError with .code 'pack-guid-malformed'
const guid = result.value;

// Build / CI: validate an asset directory
const scanResult = await scan(["apps/hello/cube/assets"]);
if (!scanResult.ok) throw scanResult.error; // PackError with .code/.hint/.detail
console.log(scanResult.value); // PackEntry[]
```

## Schema shapes

Two sidecar JSON files live next to each source file in an asset directory:

### `.meta.json` -- external-asset-package

```json
{
  "schemaVersion": "1.0.0",
  "kind": "external-asset-package",
  "assetType": "gltf",
  "source": "<source-filename>",
  "importSettings": {},
  "subAssets": [
    { "guid": "<UUIDv7-or-UUIDv5>", "sourceIndex": 0, "kind": "mesh", "compression": "zstd" }
  ]
}

> [!NOTE]
> `compression?: 'none' | 'zstd'` on `PackIndexEntry` (and `subAssets[].compression`)
> indicates whether the asset's `.bin` is zstd-compressed. See
> `@forgeax/engine-codec` README for the full codec API and error codes.
> Runtime `fetchBinary` transparently decompresses when this field is `'zstd'`.
>
> **Declaring compression intent (AC-01):** set `importSettings.compression`
> (`'none' | 'zstd'`) to override the build-time default strategy for this asset
> (default: mesh -> `zstd`, texture -> `none`; `.pack.json` never compressed).
> The importer honors the override and writes the resulting `compression` onto
> the output catalog row. Omit it to accept the kind-keyed default.
```

### `.pack.json` -- internal-text-package

```json
{
  "schemaVersion": "1.0.0",
  "kind": "internal-text-package",
  "assets": [
    {
      "guid": "<UUIDv7-or-UUIDv5>",
      "kind": "mesh",
      "payload": {},
      "refs": []
    }
  ]
}
```

### MaterialAsset shape -- pass-based material in `.pack.json`

When `kind: 'material'`, the `payload` object carries `passes[]` + `paramValues` (feat-20260527-material-registration-unification M3).

```json
{
  "guid": "<UUIDv7>",
  "kind": "material",
  "payload": {
    "kind": "material",
    "passes": [
      {
        "name": "Forward",
        "shader": "forgeax::default-standard-pbr",
        "tags": { "LightMode": "Forward" },
        "queue": 2000
      }
    ],
    "paramValues": {
      "baseColor": [1.0, 0.8, 0.2],
      "metallic": 0.3
    }
  },
  "refs": []
}
```

**MaterialAsset fields in pack.json**:

| Field | Type | Description |
|:--|:--|:--|
| `passes` | `MaterialPassDescriptor[]` | Array of pass descriptors; `pass.shader` routes to `ShaderRegistry.lookupMaterialShader` for register-time validation. |
| `paramValues` | `Record<string, unknown>` | Instantiated parameter values; validated at register-time via union paramSchema (extra-key ignore, missing-required error). |

**Validation** is performed by `AssetRegistry._validateMaterialPasses` at register-time (per-pass ShaderRegistry lookup + union paramSchema). The `parseAssetPayload` `'material'` arm only accepts `passes[]` format; legacy `materialShader` / `shadingModel` formats return structured error. SSOT: `AssetRegistry` in `@forgeax/engine-runtime`.

## `AssetGuid` API

| Function | Signature | Description |
|:--|:--|:--|
| `AssetGuid.parse` | `(input: string) => Result<AssetGuid, PackError>` | Parse dash-separated UUID string; returns `Ok(AssetGuid)` on success or `Err(PackError{code:'pack-guid-malformed'})` on failure. Never throws. |
| `AssetGuid.format` | `(guid: AssetGuid) => string` | Format as lowercase dash-separated UUID string |
| `AssetGuid.equals` | `(a: AssetGuid, b: AssetGuid) => boolean` | Constant-time equality |
| `AssetGuid.random` | `() => AssetGuid` | Generate a random UUIDv7 GUID |
| `deriveBuiltin` | `(name: string) => Promise<AssetGuid>` | Derive a deterministic UUIDv5 from a name within the ForgeaX namespace; async (SHA-1 via Web Crypto or node:crypto) |

## `PackErrorCode` -- 13-member closed union

Exhaustive `switch (err.code)` without `default` -- TS guards completeness.

| Code | `err.detail` shape |
|:--|:--|
| `pack-malformed-meta` | `{ path: string; ajvErrors: string[] }` |
| `pack-malformed-pack` | `{ path: string; ajvErrors: string[] }` |
| `pack-guid-malformed` | `{ raw: string; reason: string }` |
| `pack-orphan-meta` | `{ metaPath: string; expectedFile: string }` |
| `pack-meta-missing` | `{ sourcePath: string; expectedMetaPath: string }` |
| `pack-guid-collision` | `{ guid: string; paths: [string, string] }` |
| `pack-cyclic-reference` | `{ code; kind: 'childof' \| 'mount-asset'; cycle: string[] }` -- first and last element repeated; `kind` distinguishes runtime ChildOf cycle from build-time mount-asset cycle (R10) |
| `pack-subasset-index-out-of-range` | `{ metaPath: string; sourceIndex: number; maxIndex: number }` |
| `payload-schema-mismatch` | `{ guid: string; errors: { instancePath: string; message: string }[] }` -- material payload failed `buildMaterialAssetValidator` check (scanner step-7) |
| `pack-mount-localid-overlap` | `{ overlapping: number[]; sources: string[] }` -- mount memberFirst windows collide |
| `pack-mount-count-mismatch` | `{ mountLocalId; declared; actual }` -- mount.memberCount disagrees with referenced child SceneAsset.entities.length |
| `pack-mount-override-localid-out-of-range` | `{ overrideLocalId; mountLocalId; memberCount }` -- override.localId outside mount window |
| `pack-mount-override-unknown-field` | `{ comp; field; mountLocalId }` -- override.comp / override.field unknown to schema vocab |

Access `err.detail.<field>` directly after narrowing via `switch (err.code)` -- full IDE autocomplete.

## CLI plugin -- `forgeax-engine-remote-asset`

The CLI subcommands ship as a standalone plugin bin `forgeax-engine-remote-asset` (entry `dist/cli-asset.mjs`) declared in this package's `package.json#bin`, discovered via PATH-prefix scan for `forgeax-engine-remote-`.

| Subcommand | Description | Exit code |
|:--|:--|:--|
| `forgeax-engine-remote-asset scan [--roots <dir>...]` | Print JSON array of all discovered `PackEntry` objects to stdout | 0 always |
| `forgeax-engine-remote-asset lookup <guid>` | Print matching `PackEntry` as JSON to stdout (cwd as scan root) | 0 found / 1 not found |
| `forgeax-engine-remote-asset verify [--strict]` | Run fail-fast 7-step scanner; print `PackError` JSON to stderr on first failure; prints `material-validated: <N>` count at end | 0 clean / 1 error |

```bash
# Direct invocation (after pnpm -F @forgeax/engine-pack build)
forgeax-engine-remote-asset scan --roots apps/hello/room/assets
forgeax-engine-remote-asset lookup 01935f3b-aaaa-7000-8000-000000000001
forgeax-engine-remote-asset verify --strict
```

## Scanner 7-step validation chain

The `verify` subcommand runs a fail-fast 7-step chain:

| Step | Check | Error code on failure |
|:--|:--|:--|
| 1 | Schema validation (`.meta.json` / `.pack.json` ajv) | `pack-malformed-meta` / `pack-malformed-pack` |
| 2 | GUID format check (UUIDv5/v7 dash format) | `pack-guid-malformed` |
| 3 | GUID collision detection (cross-file duplicate) | `pack-guid-collision` |
| 4 | Orphan `.meta.json` check (`.meta.json` without source file) | `pack-orphan-meta` |
| 5 | Missing `.meta.json` check (source file without sidecar) | `pack-meta-missing` |
| 6 | Subasset index bounds check (`.meta.json` subAssets[].sourceIndex) | `pack-subasset-index-out-of-range` |
| 7 | Material payload schema check (`buildMaterialAssetValidator(MATERIAL_PARAM_TYPES_V1)` for `kind: 'material'`) | `payload-schema-mismatch` |

## Entry subpaths

| Subpath | Exports |
|:--|:--|
| `.` | Re-exports from all subpaths |
| `./schema` | Compiled ajv validators for `.meta.json` and `.pack.json` |
| `./guid` | `AssetGuid` brand type + `parse` (returns `Result`) / `format` / `equals` / `random` + async `deriveBuiltin(name)` |
| `./errors` | `PackError` class + `PackErrorCode` closed union + `PackErrorDetail` discriminated union |
| `./bridge` | `AssetRegistry` GUID bridge helpers |
| `./scanner` | File tree scanner with fail-fast 7-step validation chain |