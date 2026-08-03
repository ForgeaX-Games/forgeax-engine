# @forgeax/engine-pack

## Authoring and recovery index

The machine contract is [`asset-authority.schema.json`](../../asset-authority.schema.json). The audit gate is [`check-asset-authority-audit.mjs`](../../scripts/forgeax/check-asset-authority-audit.mjs); it reports subject, execution, author authority, runtime source, lifecycle, owner, producer, and sourceKey evidence for every named category.

The staged route is explicit: `author-validation` -> `external-declaration` ->
`import` -> `native-cook` -> `ddc-validation` -> `runtime-parse` ->
`editor-capability`. Each stage keeps its own evidence; a cache hit does not
replace author authority, and an Editor capability does not become a runtime
source.

| Need | Entry | Safe action |
|:--|:--|:--|
| Inspect one asset | `forgeax-engine-remote-asset lookup --guid ... --project ... --catalog ... --json` | Read structured evidence and diagnostics |
| Verify a result | `forgeax-engine-remote-asset verify --guid ... --project ... --catalog ... --json` | Repair the producer or package, then retry |
| Rebuild a cooked result | Pack/import runner and the declared producer | Cold cook after discarding invalid DDC |
| Preview old output | Catalog evidence with explicit last-known-good state | Preview only; never publish it as current |

Pack or external source plus Meta owns author facts. DDC and Catalog are derived projections; they are not author databases or write authorities.

> [!IMPORTANT]
> The pack contract has one material authoring shape: a `MaterialAsset` payload. The cook stage resolves inheritance, values, texture coordinates, module references, artifact bytes, and a receipt into one record. Runtime consumers use the GUID and catalog locator; they do not author a second shader resource.

## MaterialAsset cook contract

Put the material payload in the package `assets[]` row and keep its `refs[]` graph complete. The `passes`, `values`, `parent`, and texture `coordinates` remain one authored route. A valid cooked material record contains `resolved`, `refs`, `artifact`, and `receipt`. If any part is absent, recover by fixing the producer payload or re-running the cook; this is the recovery route. Then repeat `lookup/verify --guid --project --catalog --json`.

> [!IMPORTANT]
> The producer publishes facts; the consumer does not guess. `packageId`,
> `provenance`, `revision`, `sourceKey`, relations, and diagnostics survive
> package moves and DDC relocation. Paths and array positions are locators,
> not identities.

Disk schema, GUID tools (`AssetGuid` brand + UUIDv7/v5), scanner fail-fast chain (13-member `PackErrorCode`) for the forgeax engine asset package system. The three CLI surfaces -- `scan`, `lookup`, `verify` -- are shipped as the standalone plugin bin `forgeax-engine-remote-asset` (resolved via PATH-prefix discovery for `forgeax-engine-remote-`; filesystem-mode; offline; no WS connection required).

> Package name vs directory: this package is published as `@forgeax/engine-pack` but lives at `packages/pack` on disk. The `@forgeax/engine-` prefix is the IDE-autocomplete entrypoint AI users discover the package family by; the directory drops the prefix to keep tree depth flat (mirrors the `packages/runtime` / `@forgeax/engine-runtime` pair). All other packages in the engine family follow the same convention.

## AssetEvidence: the offline proof chain

Pack owns the offline half of the GUID evidence chain: `source inventory -> catalog packageUrl/cookReceiptUrl -> producer CookReceipt -> Pack v2 package and artifact verification -> AssetEvidence`.

The catalog is a locator, not proof. `lookup/verify --guid --project --catalog --json` joins the source meta or authored pack, the catalog row, the receipt, and the package descriptors. Both commands emit one JSON record on stdout or one structured `{code, expected, hint, detail}` record on stderr; there is no runtime or WebSocket dependency.

`notCooked` means a source declaration has no successful receipt. `ready/current` means the receipt fingerprint matches the source; `ready/stale` means it does not. `unknown` is reserved for missing evidence. Artifact and package status remain `notChecked`, `passed`, or `failed`; a historical receipt never upgrades an unchecked package.

Build-time importers write source meta and producer receipts; the Vite plugin publishes the locator. Runtime packages consume the resulting Pack v2 bytes and must not import this Node-only evidence adapter. See [`packages/types/src/asset-evidence.ts`](../types/src/asset-evidence.ts) for the exact schema and closed errors.

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
    "importer": "gltf",
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

### Producer provenance and topology

Both package schemas accept producer-owned `packageId`, `provenance`,
`revision`, and structured `diagnostics`. Asset/output rows may declare a
stable `sourceKey`; `sourceIndex` is positional evidence only. The runtime
function `diffTopology(previous, next)` (also exported as
`calculateTopologyDiff`) preserves GUIDs by `sourceKey`, reports additions,
removals, and kind changes, and marks multi-output source-index-only matching
as ambiguous.

| Fact | Published by | Consumer rule |
|:--|:--|:--|
| `packageId` | Producer declaration | Keep stable across path or URL relocation |
| `provenance` | Producer declaration | Copy without replacing it with importer guesses |
| `revision` | Producer/DDC | Use to detect stale updates; do not silently overwrite a verified snapshot |
| `sourceKey` | Imported-output producer | Match topology only when the producer supplies a stable semantic key |
| `sourceIndex` | Imported-output producer | Display or inspect position; never use it as identity |
| `relations` / `diagnostics` | Producer facts | Preserve the complete structured values |

> [!WARNING]
> A missing `sourceKey` in a multi-output declaration is evidence insufficiency,
> not permission to hash a path or promote `sourceIndex`. Keep the result
> ambiguous and expose the repair hint.

The DDC path is also lossless: the import runner copies package-level facts to
the `.pack.json` envelope and copies each declared output's `sourceKey`,
`sourceIndex`, and relations onto the matching GUID row. The catalog builder
then projects those rows into `PackIndexEntry`; it does not create a second
authoritative fact store.

### MaterialAsset shape -- pass-based material in `.pack.json`

When `kind: 'material'`, the `payload` object carries `passes[]` + `values` (feat-20260527-material-registration-unification M3).

```json
{
  "guid": "<UUIDv7>",
  "kind": "material",
  "payload": {
    "kind": "material",
    "passes": [
      {
        "name": "Forward",
        "program": { "module": "forgeax::default-standard-pbr" }
      }
    ],
    "values": {
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
| `passes` | `MaterialPass[]` | Root pass descriptors; each pass names a `program.module`. |
| `parameters` | `MaterialParameter[]` | Root parameter contract used by cook and reflection. |
| `values` | `Record<string, unknown>` | Child-owned values, including per-slot texture coordinates. |
| `parent` | `AssetGuid` | Optional serialized parent edge. |

**Validation** is performed by the material schema and build-time cook. The cook resolves the parent chain, validates values and pass programs, and emits the effective record, artifact, references, and receipt. Runtime reports a structured missing-cook error instead of compiling a material.

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
