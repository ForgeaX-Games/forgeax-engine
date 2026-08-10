# @forgeax/engine-ddc

## Authoring and recovery index

DDC is a build-time, read-only, disposable runtime projection. The author authority remains an internal Pack or external source plus Meta. A cache hit is not author evidence, and a Catalog row is a projection of validated producer facts.

| Need | Owner | Safe action |
|:--|:--|:--|
| Inspect | DDC entry, receipt, integrity, and Catalog evidence | Read the structured fields together |
| Rebuild | Shared producer runner and finalizer | Delete invalid entries and cold cook deterministically |
| Preview LKG | Lifecycle head marked `lastKnownGood` | Preview only; never relabel it as current |
| Failed cook | Lifecycle evidence | Preserve the previous LKG and stop publish until current validates |

The machine-readable category and producer index is [`asset-authority.schema.json`](../../asset-authority.schema.json). DDC does not provide Save, Undo, Move, Rename, Promote, or Editor write operations.

## Indexed DDC recovery lifecycle

DDC is disposable evidence between the producer and Catalog, not a second
authoring database:

1. **Inspect** the lifecycle head, receipt, input fingerprint, output digest,
   artifacts, and Catalog locator. `missing`, `cooking`, `current`, `stale`,
   `failed`, and `lastKnownGood` are different facts.
2. **Rebuild** a replaceable derived entry through the shared producer and
   finalizer. **Cold-cook** when the entry is incomplete, corrupt, stale beyond
   policy, or has no trustworthy receipt.
3. **Verify** the receipt and integrity digests, then verify the Pack body and
   artifact descriptors. A cache hit alone is not verification.
4. **Retry** the same GUID only after the verified Catalog projection points to
   the new product. Preview `lastKnownGood` only as explicit read-only evidence.

The source package plus Meta is the author. Importers and native cookers are
producers. DDC only stores disposable derived products, and Catalog only
projects validated producer facts. DDC does not mint GUIDs, infer identity from
paths, compile runtime shaders, or provide a runtime fallback for a failed
cook.
