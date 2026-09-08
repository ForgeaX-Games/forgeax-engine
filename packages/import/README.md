# @forgeax/engine-import

## Authoring and recovery index

ScriptablePack sources use the public `@forgeax/engine-import` producer bridge.
The output is the same Pack v2 durable payload used by ordinary importers. The
16 `SCRIPTABLE_PACK_ASSET_KINDS` are `mesh`, `material`, `scene`, `texture`,
`equirect`, `sampler`, `font`, `render-pipeline`, `tileset`, `video`,
`skeleton`, `skin`, `animation-clip`, `animation-graph`, `audio`, and
`particle-effect`; all are loadable by GUID, while `refs`,
`artifacts`, `mediaType`, and `programFingerprint` remain producer facts.
Producer or dependency failures return `code`, `expected`, `hint`, and
`detail`; inspect the owning evidence, rebuild or cold-cook, and retry.

The import contract is [`asset-authority.schema.json`](../../asset-authority.schema.json). `ImporterRegistry` and `runImport` are the build-time owner for external source plus Meta; every writable multi-output declaration uses a stable `sourceKey`, while `sourceIndex` remains diagnostic evidence only.

| Need | Entry | Boundary |
|:--|:--|:--|
| Inspect producer evidence | Pack CLI `lookup` and `verify` JSON output | Read Catalog and receipt facts; do not parse messages |
| Rebuild | Registered importer through `runImport` | Write Pack/DDC output through the shared finalizer |
| Recover failed output | Fix source or Meta, then cold cook | Never return raw source as a runtime projection |
| Preview old output | Explicit Catalog last-known-good locator | Read-only preview; not current and not publishable |

The Importer owns neither DDC lifecycle nor Editor authoring writes. Editor writes go through its asset-authoring gateway, and runtime consumes the validated projection.

Build-time asset **import** runner + `ImporterRegistry` — the build-time half of
the engine's import/load split.

> [!IMPORTANT]
> **Build-time only.** This package never enters the player runtime bundle
> (AC-06). `@forgeax/engine-runtime` and `@forgeax/engine-app` do not depend on
> it. Its consumers are build tooling (the Vite pack plugin, the asset CLI).

## The DIP (dependency-inversion principle) shape

This is the engine's **third DIP instance** after RHI and Console. The engine
owns the contract (`Importer` / `ImportContext` / `ImportTransport` in
`@forgeax/engine-types`); concrete importers are injected by the host.

```ts
// Host assembly (vite.config.ts or build script)
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';

export default {
  plugins: [
    pluginPack({
      importers: [gltfImporter, imageImporter],
    }),
  ],
};
```

### Three iron laws (architecture invariants)

1. **GUID import-stable**. The `*.meta.json` sidecar pins every target GUID at
   declare time. Import only reproduces those GUIDs, never mints new ones.
2. **Lazy**. The runtime reads meta only to build a *catalog* (which GUIDs
   exist, with which `kind`). Only a real `AssetRegistry.load(guid, kind)` triggers import
   (when the DDC is absent) + load. No eager full-import on startup.
3. **One-way dependency**. The engine owns the `Importer` interface; concrete
   importers are injected. The engine never reverse-imports `gltfImporter` /
   `imageImporter` / etc.

## The import/load split

```mermaid
flowchart LR
  src["source\n(.gltf / .png / .ttf)"] -->|"importer.import(ctx)"| ia["ImportedAsset[]\n(Asset PODs + GUIDs)"]
  meta["*.meta.json\nimporter + subAssets[].guid"] --> ia
  ia -->|"import runner\n(GUID iron law)"| ddc["DDC\n.pack.json / .bin"]
  ddc -->|"AssetRegistry.load(guid, kind)"| runtime["runtime Loader\n(@forgeax/engine-assets-runtime)"]
```

- An **`Importer`** (`{ key, import }`) turns one external source + its
  `*.meta.json` GUID declarations into in-memory `ImportedAsset[]` PODs. It is
  pure of disk write + GUID minting — it reads the GUIDs declared in the meta
  (the **GUID import-stable iron law**) and stamps them onto the PODs.
- The **import runner** (`runImport(meta, registry, fs)`) dispatches a sidecar
  by its top-level `importer` string key to the registered `Importer`,
  validates the produced GUID set against the declared set, and folds the
  result into a DDC `.pack.json` document. The reserved key **`importer:
  'shader'`** is skipped — shader sidecars are consumed by
  `@forgeax/engine-vite-plugin-shader`'s orthogonal transform pipeline.
- **`ImportTransport`** (interface in `@forgeax/engine-types`) bridges the
  build-time importer to the runtime: the shipped form wires `null` transport
  (pre-import at build time, DDC miss -> fail-fast `asset-not-imported`); the
  studio form wires an HTTP adapter (`POST /__import/:guid`) for lazy on-demand
  import.

## Injection shape

### ScriptablePack build bridge

`buildScriptablePack` decorates a host-provided Asset snapshot source with the ordinary `AssetReader`. Each GUID is fixed to one generation/digest and cloned for the current Build. The adapter validates the exact output-key/kind closure, stamps descriptor identity, dispatches each Asset to the reusable `AssetOutputProducerRegistry`, and derives external usage from actual reads plus serialized refs. Scene output uses the source definition's neutral `sceneComponents` schema; it never consults a global ECS component registry.

| Derived usage | Input fingerprint | Runtime ref |
|:--|:--|:--|
| `content` | Asset generation and digest | No |
| `reference` | GUID only | Yes |
| `both` | Asset generation and digest | Yes |

Domain producers return structured `ImportError`; the generic bridge contains no per-kind switch. `createStandardAssetOutputProducerRegistry(sceneComponents)` composes the production Scene, Material, and Mesh owners with the definition-bound scene schema. Scene refs use the ECS externalization kernel shared with runtime save, Material refs cover parent/texture/sampler GUIDs, and Mesh emits the versioned binary artifact. The fingerprint covers canonical Meta, the definition-bound scene schema, the recursive source closure, observed external evidence, authoring contract version, and registered producer versions.

`createScriptablePackStagedAssetSnapshotSource()` owns clean-build content reads. It resolves a GUID to its local source owner, lazily builds that owner inside one fixed generation, memoizes private clones and digests, and reports `pack-source-build-cycle` without consulting an older fallback generation. A fallback is only an explicit prebuilt authority for GUIDs with no local owner.

`createStandardAssetOutputProducerRegistry(sceneComponents)` registers the production
Material, Mesh, and Scene producers. Material output derives
parent/texture/sampler refs; Mesh output derives default-material refs and emits
the `mesh-binary/4` body; Scene output uses the definition-bound neutral schema
through the shared ECS externalization contract. A specialized host may instead
register only the admitted kinds:

```ts
const outputs = new AssetOutputProducerRegistry();
outputs.register(materialAssetOutputProducer);
outputs.register(meshAssetOutputProducer);
```

### Mesh binary v4 producer contract

The Mesh producer calls [`packMeshBinV4`](src/mesh-bin.ts), which delegates
projection facts to geometry and records one stable digest, mask, stride,
cardinality, and payload length in the artifact header. Material defaults are
references into the producer refs table; GUID strings are not duplicated in the
binary metadata.

> [!IMPORTANT]
> A producer Result error contains `subject`, `sourceKey`, `expected`,
> `actual`, and a re-cook recovery hint. Failed validation returns no artifact,
> so the importer cannot publish a partial mesh product. v2/v3 mesh binaries
> are not compatibility inputs.

At the low-level `buildScriptablePack` boundary, `assetSource` is optional only
when `build` never calls `reader.readByGuid`. The first attempted content read
without a source returns structured `asset-not-found`; no empty snapshot or
stale content is invented. Production Vite hosts provide the staged generation
source described above.

`ImporterRegistry` mirrors the runtime `LoaderRegistry` and the Console
`Registry`: `register(importer)` (fail-fast on a malformed importer, idempotent
on a repeated key) + `get(key)` (returns `undefined`, which the runner maps to a
structured `ImportError(code='importer-not-registered')`).

```ts
import { ImporterRegistry, runImport } from '@forgeax/engine-import';
import { readFile } from 'node:fs/promises';

const registry = new ImporterRegistry();
registry.register(gltfImporter);

const fs = {
  async readSource(path: string) {
    try {
      const buf = await readFile(path);
      return { ok: true, value: new Uint8Array(buf) };
    } catch (e) {
      return { ok: false, error: e };
    }
  },
};

const result = await runImport(
  { importer: 'gltf', source: 'assets/box.gltf', subAssets: [...] },
  registry,
  fs,
);
if (result.ok) {
  console.log('DDC .pack.json:', result.value.pack);
}
```

## Error model

`ImportErrorCode` is a closed 5-member union (exhaustive `switch (err.code)`,
no `default:`). `ImportError` carries the four-field structured surface
(`.code` / `.expected` / `.hint` / `.detail`); SSOT lives in
`@forgeax/engine-types`.

| code | trigger |
|:--|:--|
| `importer-not-registered` | `meta.importer` has no registered importer |
| `source-read-failed` | `meta.source` could not be read |
| `import-produced-no-assets` | importer produced nothing, or omitted a declared GUID |
| `guid-mismatch` | importer produced a GUID not declared in `meta.subAssets[]` |
| `import-internal-error` | importer conversion or finalization failed; the runner wraps it in the existing structured Result. Finalization/digest failures carry a `detail.reason` prefixed with `finalization/digest`, and no CookProduct or Pack is returned for the failed attempt |

## Dual-form transport (M4)

| Form | `ImportTransport` | DDC source | DDC miss behavior |
|:--|:--|:--|:--|
| **studio** (dev server) | HTTP adapter `POST /__import/:guid` | lazily imported on demand | `transport.fetchPack(guid)` -> import -> load |
| **shipped** (player bundle) | `undefined` (null transport) | build-time pre-import via `generateBundle` | `asset-not-imported` fail-fast (never downgrades to runtime import) |

The runtime load path is **identical** in both forms — `ddcLoad` has zero
branches on transport. The only difference is whether `transportOrFail` is
reached on DDC miss (studio: it calls the transport; shipped: it returns the
error immediately).

## Indexed source-package lifecycle

Use this sequence when an import or Pack consumer reports a missing product:

1. **Inspect** the source Meta, declared GUID closure, Catalog row, DDC head,
   and producer receipt. Read the closed error union's `code` and `detail`.
2. **Repair** the source, Meta, or registered importer named by the detail.
   `ImporterRegistry` owns dispatch, while the source plus Meta remains the
   author authority.
3. **Rebuild** when the existing DDC entry can be replaced safely; **cold-cook**
   when integrity, receipt, or lifecycle state says the derived entry is
   invalid. Both paths use `runImport` and the shared finalizer.
4. **Verify** GUID closure, receipt freshness, DDC integrity, Pack artifacts,
   and the projected Catalog row.
5. **Retry** the same GUID after verification. Never parse an error message or
   turn an unverified source file into a runtime payload.

`runImport` keeps conversion and finalization failures inside its structured
Result boundary. A digest-capability refusal during CookProduct finalization
does not publish a partial product; repair that capability and retry the same
Meta/GUID through the same `ImporterRegistry`.

The import package stops at build-time source conversion and product
publication. It does not write authoring state, own Editor operations, or add
runtime transport branches. A dev `ImportTransport` is an explicit host
adapter; a shipped bundle must carry its build-time product and keeps
`asset-not-imported` fail-fast semantics.
