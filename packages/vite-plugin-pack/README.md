// @forgeax/engine-vite-plugin-pack
// Vite plugin for the forgeax engine asset package system.
// Dev mode: one scoped Catalog/asset transport plus an explicit host refresh policy.
// Build mode: one inventory/producer/publication pass emits Pack v2, artifacts,
// and the final `pack-index.json` through Rollup.

## Explicit DDC lifecycle contract

The host owns project identity and injects both DDC roots. The plugin does not
derive a root from the working directory, an asset root, a game basename, or a
URL:

```ts
pluginPack({
  roots: ['assets/scene.pack.json', 'assets/player.pack.ts', 'assets/fire.vfx.wgsl'],
  ddc: {
    buildCacheRoot: '/workspace/.forgeax/ddc/build-cache',
    projectDdcRoot: '/game/.forgeax/ddc/v2',
  },
});
```

`buildCacheRoot` is the optional build producer cache. Build-only consumers may
omit it; publication remains fail-open and still emits the authoritative Pack
and Meta outputs. `projectDdcRoot` is required for dev publication, runtime
scope binding, fixed-root rebinding, and recovery. A missing project root is a
closed structured error, never a fallback to `cwd` or `roots[0]`.

The project root is the only home for v2 project lifecycle state. The Engine
DDC lifecycle owns leases, candidate generations, `current`, `lastKnownGood`,
discard, close, and crash recovery. The plugin remains the single Pack owner:
Catalog rows, Pack v2 bodies, Meta, receipts, and artifact closure are
published as one validated producer result. `current` is the active verified
publication; `lastKnownGood` is read-only recovery evidence and is never
silently promoted or shipped. `runtimeBinding` carries the active scope and
generation to the browser consumer. Closing or rebinding a host releases the
old lease and cannot publish a discarded candidate.

Consumers should pass the same explicit `ddc` object to every plugin entry
point. Do not add legacy, v1, compatibility, basename, or URL fallback paths.

## Native authored Pack cookers

### Public ScriptablePack consumer contract

`SCRIPTABLE_PACK_CAPABILITY_MANIFEST` publishes the 16 durable kinds and the
three Host capability boundaries. Dev and production use the same Pack v2,
Catalog, payload, `refs`, `artifacts`, receipts, and structured recovery
fields; only the transport locator changes. Do not add a sidecar fallback for
a valid ScriptablePack GUID.

The ordered durable matrix is `mesh`, `material`, `scene`, `texture`,
`equirect`, `sampler`, `font`, `render-pipeline`, `tileset`, `video`,
`skeleton`, `skin`, `animation-clip`, `animation-graph`, `audio`, and
`particle-effect`; its SSOT is `SCRIPTABLE_PACK_ASSET_KINDS` in
`@forgeax/engine-pack`.

### ScriptablePack publication

`pluginPack({ roots })` automatically inventories trusted `*.pack.ts` sources. The production defaults compose the standard output registry and a fixed staged generation; hosts inject only roots, importers, native cookers, runtime binding, refresh, and DDC policy. A bounded authored build timeout is returned as the structured build-phase failure and the generation keeps its previous Catalog/Pack publication until a corrected source succeeds. Scanner/Catalog projection reads only the validated definition; explicit cook calls `build`, finalizes all outputs into one Pack v2 transaction, publishes one receipt per output GUID, and stores canonical Meta as `scriptable-pack.meta.json` in that package.

Dev and build share one scanner inventory and one bounded producer session. The
inventory contains canonical declaration identity, producer kind, projected
outputs/external GUIDs, closure digests, and diagnostics; Catalog projection
and the GUID-to-Meta watcher index consume it without reopening the source. Dev
registers owners and materializes on demand or before consume; production
materializes every owner through that same session. Content cycles fail
structurally. Successful rebuilds replace the complete generation, while a
failed watch rebuild leaves the previously installed Catalog and Pack bodies
current. Relative TypeScript, JavaScript, and JSON helpers enter the source
fingerprint through the Pack inventory. A scene-producing definition must
declare its `sceneComponents`; the producer binds that schema to the
definition's output only, so missing fields fail closed without a global ECS
roster. Runtime consumes only Catalog, Pack v2, and artifacts.

An authored `.pack.json` may be runtime `direct` or `cooked`; the filename does
not decide this. Register native producers at the app composition root so the
same producer runs in dev and build mode:

```ts
pluginPack({
  roots: ['assets/effects.pack.json', 'assets/effects.vfx.wgsl'],
  cookers: [particleEffectCooker],
});
```

For a `cooked` asset row, the cooker owns the runtime payload, dependency refs,
and artifact bytes. The plugin validates and finalizes that product before it
publishes the catalog row as `internal-asset + cooked + current`. A cooked row
without a registered producer is a build/dev error; raw authored payload must
never silently reach the runtime loader.

| Authored row | Producer output | Catalog after successful cook |
|:--|:--|:--|
| `execution: 'direct'` | authored payload | `internal-asset + direct + current` |
| `execution: 'cooked'` | runtime payload + refs + artifacts | `internal-asset + cooked + current` |

## Authoring and recovery index

The audit input and category conclusions live in [`asset-authority.schema.json`](../../asset-authority.schema.json); the executable gate is [`check-asset-authority-audit.mjs`](../../scripts/forgeax/check-asset-authority-audit.mjs). This plugin projects producer facts into Catalog rows. It does not become the author authority, DDC owner, or Editor write gateway.

| Need | Entry | Safe action |
|:--|:--|:--|
| Inspect | `buildCatalogResult()` and Catalog JSON | Branch on `authority`, `diagnostics`, and lifecycle fields |
| Rebuild | Declared importer or native cooker | Re-run the producer and publish only validated output |
| Preview LKG | Explicit evidence locator | Keep `lastKnownGood` read-only and out of shipped output |
| Stop publish | Degraded authority or failed lifecycle | Block the release and follow the diagnostic recovery |

## Producer fields are catalog facts

The build producer copies `packageId`, `provenance`, `revision`,
`sourceKey`/`sourceIndex`, typed `relations`, and structured `diagnostics`
from pack/meta declarations into every emitted `CatalogEntry`. It supplies a
fallback provenance version from the producer schema when a sidecar omits one;
consumers never need to guess importer identity from a URL or file suffix.

> [!IMPORTANT]
The producer result contains `entries`, `authority`, and structured
`diagnostics`. It is the only Catalog truth; a failed or degraded inventory is
a structured failure and cannot emit a partial build index.

| Result field | Meaning | Safe consumer action |
|:--|:--|:--|
| `entries` | Complete neutral catalog rows | Read producer facts and merge by lowercase GUID |
| `authority: 'authoritative'` | Scan and fold completed with verified inputs | Apply the snapshot or delta |
| `authority: 'degraded'` | Some roots or declarations could not be verified | Keep affected subjects isolated and follow diagnostics |
| `diagnostics` | Structured scan/fold evidence | Branch on `code`, `expected`, `actual`, and `hint` |

`packageId` is the topology group identity. `sourcePath`, `relativeUrl`, and
DDC locations are replaceable locators; they are never used as a fallback
identity. Revision and producer facts remain attached to every row in a
catalog delta, including a row whose locator changed.
## AssetEvidence producer boundary

The plugin publishes catalog navigation, not proof. A row's `packageUrl` and optional `cookReceiptUrl` are joined with the producer source meta, `CookReceipt`, and Pack v2 artifact verification by the pack CLI or runtime SDK as `AssetEvidence`. Dev and build paths should preserve the same locator semantics so diagnostics do not depend on HMR.

When source bytes change, keep the evidence state explicit: `notCooked`, `ready/current`, `ready/stale`, or `unknown`; package/artifact checks are `notChecked`, `passed`, or `failed`. Recover by fixing the source/cook producer and rerunning `lookup/verify --guid --project --catalog --json`, not by inventing a replacement catalog row.

# Catalog transport and host refresh

> [!IMPORTANT]
`pluginPack` publishes a typed Catalog delta through the scoped Vite channel. A
`CatalogDelta` says which rows were added, changed, or removed; it does not
decide whether a host reloads. Hosts that need a reload opt in explicitly.

The browser adapter is `createCatalogClient(enumerate, import.meta.hot)`. It
provides the browser-side subscription and enumeration pair; the application
keeps one Catalog owner and does not import Vite into the runtime. Subscribe
before requesting the initial snapshot, then merge `added`, `changed`, and
`removed` by stable GUID. Consult the exported `CatalogEntry` and
`CatalogDelta` types in `@forgeax/engine-types` for the schema rather than
reproducing it here.

```ts
import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';
import { createCatalogClient } from '@forgeax/engine-vite-plugin-pack/catalog-client';

const rowsByGuid = new Map<string, CatalogEntry>();

function mergeRows(rows: readonly CatalogEntry[]): void {
  for (const row of rows) rowsByGuid.set(row.guid.toLowerCase(), row);
}

function mergeDelta(delta: CatalogDelta): void {
  for (const guid of delta.removed) rowsByGuid.delete(guid.toLowerCase());
  mergeRows(delta.added);
  mergeRows(delta.changed);
}

const client = createCatalogClient(
  () => assets.enumerateCatalog(),
  import.meta.hot,
);

const stop = assets.subscribeCatalog(mergeDelta);

async function reconcileCatalog(): Promise<void> {
  const snapshot = await assets.enumerateCatalog();
  if (!snapshot.ok) {
    console.error(snapshot.error.code, snapshot.error.hint);
    return;
  }
  mergeRows(snapshot.value);
}

await reconcileCatalog();
// Call reconcileCatalog() again after a late subscription or transport interruption.

// Call from the host's teardown / unmount path, not after setup.
function disposeCatalog(): void {
  stop();
}
```

The Vite client contributes the HMR subscription and a structured failure
result. The application keeps only its derived `rowsByGuid` view: apply every
delta as removals followed by complete row replacements, and merge each
successful snapshot into that same view. On a late subscription or interrupted
transport, call `reconcileCatalog()` again. Keep the subscription alive until
the host's teardown or unmount path calls `disposeCatalog()`.

Engine app composition roots that require a full refresh for watched asset
content declare that choice directly:

```ts
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';

pluginPack({ roots: ['assets'], refresh: reloadAssetHost() });
```

This policy also covers source-only byte changes, which deliberately do not
become fake catalog-row changes. A static build has no HMR stream: enumeration
still works from its catalog, while subscription is a safe no-op. If a client
subscribed late or reconnects, re-enumerate and reconcile by GUID rather than
inventing a Vite replay guarantee.

# Pack-index entry shape (SSOT: `PackIndexEntry` in `@forgeax/engine-types`)

Each row in `pack-index.json` (build) or the scoped dev Catalog carries:

| Field | Type | Notes |
|:--|:--|:--|
| `guid` | `string` (UUIDv5/v7 lowercase) | asset identity |
| `packageUrl` | `string` | dev: scoped runtime locator from `runtimeBinding`; build: hashed Rollup artifact |
| `kind` | `string` (closed disc.) | `'texture'` / `'mesh'` / `'scene'` / `'material'` / future arms |
| `sourcePath` | `string` | on-disk source path (debugging + grep; build retains source JPG path even though `packageUrl` points to import artefact) |
| `metadata` | `ImageMetadata \| undefined` | present iff `kind === 'texture'`; sub-structure: `width?` / `height?` / `format: GPUTextureFormat` / `colorSpace: 'srgb' \| 'linear'` / `mipmap: boolean`; `width` / `height` may be absent in dev-mode entries pre-decode (build-mode import fills them) |
| `packageId`, `provenance`, `revision` | producer PODs | stable facts copied from the declaration; absent means no evidence was published |
| `sourceKey`, `sourceIndex` | topology PODs | semantic key plus positional evidence; `sourceIndex` is never identity |
| `relations`, `diagnostics` | structured facts | copied into the row and consumed by property, not message parsing |

`metadata.mipmap` is the boolean form; sidecar `*.meta.json` `importSettings.mipmap` string tokens `'auto'` / `'none'` are mapped at the catalog builder (feat-20260517-vite-plugin-image-build-time-cook D-5; runtime is unaware of the string form). 5-field shape is feat-20260517-vite-plugin-image-build-time-cook D-2 (charter P4 consistent abstraction; metadata field names mirror `TextureAsset` POD byte-for-byte).

## Dev and build semantics

`producerReadiness: 'before-consume'` materializes every required declaration
before a consumer can load it. `'on-demand'` keeps the inventory discoverable
and materializes the owning declaration at the first GUID request. Both modes
use the same producer and finalizer; an absent importer, cooker, or source
dependency returns a structured failure and never invents a raw runtime row.

The `runtimeBinding` identifies the active scope and generation for dev
transport. A late request from an old generation is rejected, and a failed
rebuild serves only the previous accepted publication. `lastKnownGood` remains
read-only evidence; `preview-LKG` is an explicit inspection action, never a
build input. Build mode always materializes all required declarations and emits
only the accepted Pack v2 publication. A host that needs live updates uses
`createCatalogClient` with the plugin's scoped Catalog stream; runtime asset
loading stays on the one Catalog/Pack reader path.
# Static asset evidence

> [!IMPORTANT]
> Static assets publish as Pack v2 and are navigated by `packageUrl`; runtime-only bytes remain a separate exception.

The derived `AssetEvidence` view joins catalog navigation, cook receipt freshness, and artifact verification. Discover it with `lookup/verify --guid --project --catalog --json`; `notCooked`, `stale`, and `unknown` require different recovery actions.

## Indexed producer recovery

This is the shortest path from a catalog symptom to a producer repair:

1. **Inspect** the catalog row, source Meta, DDC head, receipt, and Pack
   verification together. Branch on structured `code`, `detail`, `expected`,
   and `hint`; do not classify a row from a URL suffix or log string.
2. **Repair the producer boundary** named by `detail.stage`: register the
   declared importer, repair source or Meta, or remove an invalid derived DDC
   entry. The source package plus Meta remains the author authority.
3. **Rebuild or cold-cook** the source package through the registered importer
   or native cooker. The producer finalizer is the only writer of the DDC
   product and Pack body.
4. **Verify** the new receipt, package digest, artifacts, and Catalog
   lifecycle. A `lastKnownGood` product is read-only evidence, not current
   output.
5. **Retry** the same GUID only after verification passes. A failed producer
   attempt must not be hidden by a raw-source or custom-mesh fallback.

`producerReadiness: 'before-consume'` requires every source-package importer
or native cooker needed by the scanned Meta declarations before a consumer can
load the row. `producerReadiness: 'on-demand'` still requires the `pluginPack`
producer registration and the host's Catalog client/refresh wiring. Missing
either side is a structured producer failure, not permission for runtime
compilation.

The plugin owns Catalog projection and dev/build transport projection. It does not own
source authoring, DDC persistence policy, runtime payload semantics, or Editor
write operations. Those boundaries remain in the source package, producer,
assets-runtime, and asset-authoring gateway respectively.
