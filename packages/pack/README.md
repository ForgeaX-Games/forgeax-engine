# @forgeax/engine-pack

## MaterialAsset 唯一成功路径

Pack 承载 `paramSchema -> derive -> compile/reflect -> cook/load -> extract/record`
中的 cook/load 边界：producer 先发布含 `coordinateSet`、transform、
`physicalUvScale`、artifact 与 `layoutIdentity` 的 receipt，再由 catalog 按 GUID
提供给 runtime。identity 或 receipt 过期时 inspect producer evidence，修复后
recook 并重新验证，不手改 cooked payload。

> [!IMPORTANT]
> Pack 是发布与证据边界，不是第二份 schema；恢复动作依赖结构化状态与 receipt，
> 并沿 producer owner 回到源输入。

## Authoring and recovery index

## Material contract index

Pack is the single material-cook and publication boundary. It publishes one
GUID-addressed receipt and artifact for the resolved contract; it does not
redefine `paramSchema` or mint runtime feature macros. Keep
`materialContractDigest`, `sourceClosureDigest`, `layoutIdentity`,
`programIdentity`, `cookIdentity`, and `materialPublicationIdentity` together
as layered identity. Inspect `current` versus `generation`, repair the owning
producer at the first divergence, cold-cook the same GUID, and verify receipt,
artifact, and provenance.

## Mesh binary v4 boundary

Mesh artifacts use one canonical `geometry` projection and one strict wire
contract. The pack package owns the header facts and digest implementation in
[`src/mesh-bin-contract.ts`](src/mesh-bin-contract.ts); consumers must not
recreate that table.

| Fact | Owner | Recovery |
|:--|:--|:--|
| projection mask, schema version, stride, digest | `@forgeax/engine-geometry` + pack contract | Re-cook from source and Meta |
| vertex/index cardinality and payload bounds | build-time import producer | Repair source payload, then cold-cook |
| malformed or legacy mesh binary | strict runtime loader | Keep LKG; publish only a fully validated replacement |

> [!WARNING]
> Mesh binary v4 is the only accepted/emitted mesh wire version. v2/v3 are
> rejected closed; runtime never decodes or re-cooks a legacy payload.

## ScriptablePack in 30 seconds

The public happy path is: declare GUIDs in a `*.pack.ts`, run the Vite Pack
producer, publish Pack v2 plus the Catalog, then call
`AssetRegistry.loadByGuid(guid)`. The durable consumer matrix is the exported
`SCRIPTABLE_PACK_ASSET_KINDS` list: mesh, material, scene, texture, equirect,
sampler, font, render-pipeline, tileset, video, skeleton, skin,
animation-clip, animation-graph, audio, and particle-effect.

Every successful row keeps its `sourceKey` identity, dependency `refs`, and
producer-owned `artifacts`. Audio keeps `mediaType` and bytes; particle effects
keep `programFingerprint` and the cooked program. Animation and tile consumers
turn a loaded payload into a World-owned shared reference at their own boundary.

For failure, switch on `code`, inspect `expected`, `hint`, and narrowed `detail`:
repair the definition or producer, rebuild/cold-cook, refresh the Catalog LKG,
or attach the missing Host capability. A missing audio/video/VFX capability is
an install/play/execute error, not a durable-load error. The machine contract
lives in [`pack.schema.json`](schema/pack.schema.json) and
[`meta.schema.json`](schema/meta.schema.json); this section is guidance, not a
second manifest.

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

## Engine builtin mesh descriptors

The Engine-owned primitive mesh identities are published from one UUIDv5 table
(`@forgeax/engine-pack/builtin`). A standalone DevKit build materializes only
the missing rows as an ordinary Pack v2 tuple; Geometry then derives the mesh
payload from the `procedural-*` token at load time.

| Descriptor | GUID source | Geometry token |
|:--|:--|:--|
| Cube | `HANDLE_CUBE` | `procedural-cube` |
| Triangle | `HANDLE_TRIANGLE` | `procedural-triangle` |
| Quad | `HANDLE_QUAD` | `procedural-quad` |
| Sphere | `HANDLE_SPHERE` | `procedural-sphere` |
| Nine-slice quad | `HANDLE_NINESLICE_QUAD` | `procedural-nine-slice-quad` |
| Cylinder | `HANDLE_CYLINDER` | `procedural-cylinder` |

This keeps the runtime registry generic while ensuring a packaged game can
resolve legacy scene references without a second process-static asset owner.

> [!IMPORTANT]
> The pack contract has one material authoring shape: a `MaterialAsset` payload. The cook stage resolves inheritance, values, texture coordinates, module references, artifact bytes, and a receipt into one record. Runtime consumers use the GUID and catalog locator; they do not author a second shader resource.

## MaterialAsset cook contract

Put the material payload in the package `assets[]` row and keep its `refs[]` graph complete. The `passes`, `values`, `parent`, and texture `coordinates` remain one authored route. A valid cooked material record contains `resolved`, `refs`, `artifact`, and `receipt`. If any part is absent, recover by fixing the producer payload or re-running the cook; this is the recovery route. Then repeat `lookup/verify --guid --project --catalog --json`.

当 `parameters` 将字段声明为 `texture` 时，`values` 可保留纹理 GUID 字符串简写；省略
`parameters` 的默认材质也只对 `MATERIAL_TEXTURE_SLOTS` 中的纹理槽启用该简写。只有
sampler、强度或非默认坐标等附加元数据才使用结构化纹理对象。坐标字段的省略由运行时
统一解析为 identity，但 cook/load 不得把 identity 坐标自动展开并写回创作 payload。

> [!IMPORTANT]
> The producer publishes facts; the consumer does not guess. `packageId`,
> `provenance`, `revision`, `sourceKey`, relations, and diagnostics survive
> package moves and DDC relocation. Paths and array positions are locators,
> not identities.

Disk schema, GUID tools (`AssetGuid` brand + UUIDv7/v5), mesh-binary wire facts, and scanner fail-fast chain (13-member `PackErrorCode`) for the forgeax engine asset package system. The three CLI surfaces -- `scan`, `lookup`, `verify` -- are shipped as the standalone plugin bin `forgeax-engine-remote-asset` (resolved via PATH-prefix discovery for `forgeax-engine-remote-`; filesystem-mode; offline; no WS connection required).

> Package name vs directory: this package is published as `@forgeax/engine-pack` but lives at `packages/pack` on disk. The `@forgeax/engine-` prefix is the IDE-autocomplete entrypoint AI users discover the package family by; the directory drops the prefix to keep tree depth flat (mirrors the `packages/runtime` / `@forgeax/engine-runtime` pair). All other packages in the engine family follow the same convention.

## AssetEvidence: the offline proof chain

Pack owns the offline half of the GUID evidence chain: `source inventory -> catalog packageUrl/cookReceiptUrl -> producer CookReceipt -> Pack v2 package and artifact verification -> AssetEvidence`.

The catalog is a locator, not proof. `lookup/verify --guid --project --catalog --json` joins the source meta or authored pack, the catalog row, the receipt, and the package descriptors. Both commands emit one JSON record on stdout or one structured `{code, expected, hint, detail}` record on stderr; there is no runtime or WebSocket dependency.

## VFX Pack v2 migration

VFX source v2 is cooked in one atomic producer step. The executable contract is
`scripts/asset-cook-contract.mjs`; a package-local scripts path is not valid.
The cook publishes the Pack payload and
`particle-effect/program.json` with the same source fingerprint. Runtime loads
the GUID-indexed artifact and never compiles author WGSL.

When adding a Batch B renderer, update the source declaration, explicit material
or mesh refs, native-cook catalog, and receipt together. Re-run `lookup` and
`verify`; stale output is repaired by the owning importer or native cooker, not
by a demo-side mesh substitute.

`notCooked` means a source declaration has no successful receipt. `ready/current` means the receipt fingerprint matches the source; `ready/stale` means it does not. `unknown` is reserved for missing evidence. Artifact and package status remain `notChecked`, `passed`, or `failed`; a historical receipt never upgrades an unchecked package.

Build-time importers write source meta and producer receipts; the Vite plugin publishes the locator. Runtime packages consume the resulting Pack v2 bytes and must not import this Node-only evidence adapter. See [`packages/types/src/asset-evidence.ts`](../types/src/asset-evidence.ts) for the exact schema and closed errors.

Browser runtime code uses the focused Pack subpaths instead of the Node-oriented
root barrel. The root entry remains the build-time scanner/evidence surface.

| Runtime need | Browser-safe entry |
|:--|:--|
| Pack v2 validation and parsing | `@forgeax/engine-pack/runtime` |
| Artifact locator validation | `@forgeax/engine-pack/artifact-path` |
| Cooked material records | `@forgeax/engine-pack/material-cook` |
| Mesh wire facts | `@forgeax/engine-pack/mesh-bin-contract` |

## Quick start

### ScriptablePack source

Use `@forgeax/engine-pack/source` when one trusted TypeScript source declares and builds a multi-asset package. The definition owns `packageId`, every output `guid`, `sourceKey`, `kind`, optional display `name`, and the scene component schema needed to externalize scene refs. `build(reader)` returns ordinary typed Assets keyed by the same `sourceKey` set; it cannot publish, mutate Catalog, or mint identity.

```ts
import type { ScriptablePackDefinition } from '@forgeax/engine-pack/source';
import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export default {
  schemaVersion: '1.0.0',
  packageId,
  assets: {
    mesh: { guid: meshGuid, kind: 'mesh', name: 'Generated Mesh' },
    scene: { guid: sceneGuid, kind: 'scene', name: 'Generated Scene' },
  },
  sceneComponents: [Transform, Camera],
  externalAssets: { material: materialGuid },
  build: async (assets) => ({ ok: true, value: { mesh, scene } }),
} satisfies ScriptablePackDefinition;
```

`sceneComponents` is optional for packs that never produce a `scene`. When a
scene is produced, declare every component used by its entities in the same
definition; the isolated Pack worker projects the tokens to a neutral,
serializable schema. A scene component missing from that declaration is a
fail-closed producer error, not a lookup into a global World schema.

`forgeax-engine-remote-asset meta <source.pack.ts> --json` executes module initialization, validates the default export, and projects canonical Meta without calling `build`. `@forgeax/engine-pack/source-node` accepts a host executor with `load` and optional `dispose`; `timeoutMs` bounds module initialization and `buildTimeoutMs` bounds one `build(reader)` call. A build timeout returns one structured `pack-source-load-failed` Result with `detail.phase: 'build'`, the configured `timeoutMs`, and deterministic cleanup of the isolated worker and compile root.

The default worker executes the complete relative TypeScript module closure on the supported Node floor, including Node 22 hosts that do not load `.ts` files directly. It transpiles that closure into a disposable ESM directory, resolves bare imports through the source project's nearest `node_modules`, then falls back to the worker's packaged dependency graph for desktop games that intentionally have no local `node_modules`. The disposable directory is removed when the worker is disposed. Bulk producers use the internal `createScriptablePackModuleExecutorPool()` with two recyclable workers; a pooled lease is released after metadata projection or one build, so a generation never retains one live Worker-backed definition per source.

> [!IMPORTANT]
> Source authoring is an explicit Node contract. Every gateway call carries a caller-minted `requestId`; mutations may carry `expectedRevision` for SHA-256 CAS. The filesystem port confines paths to one game root and atomically replaces only `canonical-v1` scaffolds. Arbitrary valid TypeScript remains inspectable and rebuildable, but unsupported structural edits fail closed with stable `pack-source-*` errors.

`SOURCE_AUTHORING_OPERATION_DESCRIPTORS` is the producer-owned structured capability manifest for tools. The existing `asset.preflight` operation returns the current revision, canonical Meta, incoming references, and shape-derived mutation capabilities before any write.

```typescript
import { AssetGuid } from "@forgeax/engine-pack/guid";
import { scan, scanInventory } from "@forgeax/engine-pack/scanner";

// Runtime: resolve a known GUID at build time
const result = AssetGuid.parse("cbe42beb-8975-5096-b3a1-3dda4cb4c077");
if (!result.ok) throw result.error; // PackError with .code 'pack-guid-malformed'
const guid = result.value;

// Build / CI: validate an asset directory
const scanResult = await scan(["apps/hello/cube/assets"]);
if (!scanResult.ok) throw scanResult.error; // PackError with .code/.hint/.detail
console.log(scanResult.value); // PackEntry[]

// Build hosts can retain one validated inventory and project paths from it.
const inventory = await scanInventory(["apps/hello/cube/assets"]);
if (!inventory.ok) throw inventory.error;
console.log(inventory.value.paths, inventory.value.scriptablePackMeta);
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
function `diffTopology(previous, next)` preserves GUIDs by `sourceKey`, reports additions,
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

**Validation** is performed by the material schema and build-time cook. The cook resolves the parent chain, validates values and pass programs, and emits a `material-cook/3` record, artifact, references, and receipt. The receipt keeps material, source, layout, program, pipeline, publication, and cook identities together with compiler/WASM provenance and generation counters. Runtime reports a structured missing-cook error instead of compiling a material; stale generations are recooked by the producer.

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

## Mesh-binary artifact contract

`MESH_BIN_VERSION` and `MESH_BIN_HEADER_V4_BYTES` are the Pack-owned facts for
the v4 `<guid>.bin` mesh artifact. The header carries the geometry projection
version, attribute mask, stride, digest, cardinality, and payload byte lengths;
the import encoder and assets-runtime decoder consume those facts from the
package root. Independent test fixtures may keep literal header values only as
wire-format oracles, never as a second layout table.

> [!WARNING]
> v4 is the only accepted and emitted mesh-binary version. A v2/v3 artifact is
> a closed load error, not a compatibility input. Preserve the last-known-good
> catalog row, repair the source plus its `.meta.json` sidecar, then re-run the
> owning build-time importer/native cooker and `lookup/verify --guid --project
> --catalog --json` before publishing the replacement.

## Owner product and inventory contract

`scanInventory(...)` is the Pack-owned source inventory boundary. It preserves
GUID identity, source revision, source key, and source index before importer
work begins.

`finalizePackageProduct(...)` accepts the terminal producer product, validates
one receipt per GUID, validates asset-local artifact paths and bytes, and emits
the deterministic package URL and digest. Producers provide policy through the
finalizer sink; Pack owns package serialization and publication facts.

## Entry subpaths

| Subpath | Exports |
|:--|:--|
| `.` | Re-exports from all subpaths |
| `./schema` | Compiled ajv validators for `.meta.json` and `.pack.json` |
| `./guid` | `AssetGuid` brand type + `parse` (returns `Result`) / `format` / `equals` / `random` + async `deriveBuiltin(name)` |
| `./errors` | `PackError` class + `PackErrorCode` closed union + `PackErrorDetail` discriminated union |
| `./bridge` | `AssetRegistry` GUID bridge helpers |
| `./scanner` | File tree scanner with fail-fast 7-step validation chain |
