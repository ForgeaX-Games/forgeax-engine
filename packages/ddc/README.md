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
