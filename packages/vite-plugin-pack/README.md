// @forgeax/engine-vite-plugin-pack
// Vite plugin for the forgeax engine asset package system.
// Dev mode: HMR + /__pack/lookup/:guid + /__pack/index routes.
// Build mode: generateBundle scans roots, imports each `kind: 'texture'` row
// (parseImage -> raw RGBA bytes -> emitFile hashed `<guid>-[hash].bin`),
// rewrites `packageUrl` to the hashed path, and emits `pack-index.json`.

## Native authored Pack cookers

An authored `.pack.json` may be runtime `direct` or `cooked`; the filename does
not decide this. Register native producers at the app composition root so the
same producer runs in dev and build mode:

```ts
pluginPack({
  roots: ['assets'],
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
> `buildCatalogResult()` is the canonical builder result. It contains
> `entries`, `authority`, and structured `diagnostics`. The legacy
> `buildCatalog()` array is a one-way projection of that result, so old callers
> remain source-compatible without creating a second catalog truth.

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
> `pluginPack` publishes the neutral `forgeax:catalog-delta` transport. A
> `CatalogDelta` says which rows were added, changed, or removed; it does not
> decide whether a host reloads. Hosts that need a reload opt in explicitly.

The browser adapter is `createCatalogClient(enumerate, import.meta.hot)`. It
provides the browser-side transport pair. Adapt it with `createCatalogSource`
and give that source to an `AssetRegistry`; subscribe and enumerate through the
registry, so application code has one catalog owner and the registry never
imports Vite. Subscribe before requesting the initial snapshot, then merge
`added`, `changed`, and `removed` by stable GUID. Consult the exported
`CatalogEntry` and `CatalogDelta` types in `@forgeax/engine-types` for the
schema rather than reproducing it here.

```ts
import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';
import { createCatalogClient } from '@forgeax/engine-vite-plugin-pack/catalog-client';
import { createCatalogSource } from '@forgeax/engine-assets-runtime';

const rowsByGuid = new Map<string, CatalogEntry>();

function mergeRows(rows: readonly CatalogEntry[]): void {
  for (const row of rows) rowsByGuid.set(row.guid.toLowerCase(), row);
}

function mergeDelta(delta: CatalogDelta): void {
  for (const guid of delta.removed) rowsByGuid.delete(guid.toLowerCase());
  mergeRows(delta.added);
  mergeRows(delta.changed);
}

async function readCatalogRows(): Promise<readonly CatalogEntry[]> {
  const response = await fetch('/__pack/index');
  if (!response.ok) throw new Error(`catalog request failed: ${response.status}`);
  return (await response.json()) as readonly CatalogEntry[];
}

const client = createCatalogClient(readCatalogRows, import.meta.hot);
assets.setCatalogSource(
  createCatalogSource({ url: '/__pack/index', subscribe: client.subscribe }),
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

`createCatalogSource` owns the registry-facing snapshot and its structured
failure result. The Vite client contributes the HMR subscription; its
`enumerate()` helper remains available to Vite-specific hosts. The application
keeps only its derived `rowsByGuid` view: apply every delta as removals followed
by complete row replacements, and merge each successful snapshot into that same
view. On a late subscription or interrupted transport, call `reconcileCatalog()`
again rather than relying on an event replay guarantee. Keep the subscription
alive until the host's teardown or unmount path calls `disposeCatalog()`.

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

Each row in `pack-index.json` (build) or `/__pack/index` (dev) carries:

| Field | Type | Notes |
|:--|:--|:--|
| `guid` | `string` (UUIDv5/v7 lowercase) | asset identity |
| `packageUrl` | `string` | dev: source-relative path (e.g. `/assets/wood-container.jpg`); build: hashed import artefact (e.g. `/assets/<guid>-[hash].bin`) |
| `kind` | `string` (closed disc.) | `'texture'` / `'mesh'` / `'scene'` / `'material'` / future arms |
| `sourcePath` | `string` | on-disk source path (debugging + grep; build retains source JPG path even though `packageUrl` points to import artefact) |
| `metadata` | `ImageMetadata \| undefined` | present iff `kind === 'texture'`; sub-structure: `width?` / `height?` / `format: GPUTextureFormat` / `colorSpace: 'srgb' \| 'linear'` / `mipmap: boolean`; `width` / `height` may be absent in dev-mode entries pre-decode (build-mode import fills them) |
| `packageId`, `provenance`, `revision` | producer PODs | stable facts copied from the declaration; absent means no evidence was published |
| `sourceKey`, `sourceIndex` | topology PODs | semantic key plus positional evidence; `sourceIndex` is never identity |
| `relations`, `diagnostics` | structured facts | copied into the row and consumed by property, not message parsing |

`metadata.mipmap` is the boolean form; sidecar `*.meta.json` `importSettings.mipmap` string tokens `'auto'` / `'none'` are mapped at the catalog builder (feat-20260517-vite-plugin-image-build-time-cook D-5; runtime is unaware of the string form). 5-field shape is feat-20260517-vite-plugin-image-build-time-cook D-2 (charter P4 consistent abstraction; metadata field names mirror `TextureAsset` POD byte-for-byte).

# Dev import pairing contract (AC-14)

> [!IMPORTANT]
> Dev-mode lazy import (import-on-demand) needs **two** wirings that come as a pair. Provide one without the other and dev `loadByGuid` of an un-imported texture fails. They live on opposite sides of the dev boundary, so each is easy to forget.

| Side | Wiring | Symptom if omitted |
|:--|:--|:--|
| **plugin** (`vite.config.ts`) | `pluginPack({ roots, importers: [imageImporter] })` | dev `POST /__import` has an empty `ImporterRegistry` -> `422 importer-not-registered`; nothing is ever imported |
| **client** (app host) | inject `createDevImportTransport()` into `createApp` / `createRenderer` | the studio form has no transport, so import-on-demand degrades to the shipped fail-fast: `loadByGuid` returns `asset-not-imported` and the frame stays black |

## Layer 1 -- wire the dev transport in one line each

```ts
// vite.config.ts (plugin side)
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';

export default defineConfig({
  plugins: [pluginPack({ roots: ['assets'], importers: [imageImporter] })],
});
```

```ts
// app host (client side)
import { createApp } from '@forgeax/engine-app';
import { createDevImportTransport } from '@forgeax/engine-runtime';

const app = await createApp(canvas, options, { importTransport: createDevImportTransport() });
```

## Layer 2 -- what the pair does on a DDC miss

A dev catalog keeps a **discoverable raw-source texture row** for any asset that has only a `*.meta.json` (no build-imported `.bin`). When `loadByGuid` resolves that row, the runtime loader sees a non-`.bin` `packageUrl` and returns the `AssetErrorCode` sentinel `texture-source-not-imported` (an `AssetError`). `loadByGuidProd` treats that sentinel as transport-eligible and calls the injected transport's `fetchPack(guid)`, which `POST`s `/__import/<guid>`. The dev server imports the source to an `rgba16float` / `rgba8` `.bin` via the shared `importTextureEntry` SSOT, rebuilds the catalog so the same-GUID row now ends `.bin`, and returns the fresh `PackIndexEntry[]`; the loader clears its cache and re-enters, reading the imported `.bin`. HDR equirect sources (`*.hdr` declared as a `cube-texture` sub-asset) ride the same path: the dev `POST /__import` tolerates the runner's `import-produced-no-assets` and still imports the `.hdr` to a 2D `rgba16float` `.bin` (the GPU cube-isation stays in `uploadCubemapFromEquirect`).

## Layer 3 -- shipped form fails fast; build is untouched

Without an injected transport (shipped form), the same sentinel surfaces as `asset-not-imported` -- a fail-fast, never a silent lazy import. A genuinely corrupt imported `.bin` is a different signal entirely: it is the `ImageError` `image-decode-failed` and is **never** transport-eligible (the eligibility guard is `instanceof AssetError`), so a real decode failure is never re-fetched. The build path is also unaffected: `generateBundle` pre-imports every texture row (incl. `.hdr`) to a hashed `.bin` ahead of its own pre-import pass, so the shipped bundle carries the `.bin` directly and never exercises the dev `POST /__import` arm.
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
load the row. `producerReadiness: 'on-demand'` still requires both the Vite
producer registration and the host's dev import transport. Missing either
side is a structured producer failure, not permission for runtime compilation.

The plugin owns Catalog projection and dev/build route wiring. It does not own
source authoring, DDC persistence policy, runtime payload semantics, or Editor
write operations. Those boundaries remain in the source package, producer,
assets-runtime, and asset-authoring gateway respectively.
