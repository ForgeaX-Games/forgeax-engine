# @forgeax/engine-ecs

Archetype ECS for forgeax-engine — `World` / `Entity` / `Component` / `Query` / `System` / `Schedule` / `Commands` / `Resource`. Position in the package family: see [AGENTS.md §Packages](../../AGENTS.md#packages).

This README is the **per-package演进契约 anchor** for `Result<T, E>`. AGENTS.md keeps doc-brevity (the bare reference to "演进契约 / Per-feat breaking changes" lives there); concrete shape supersedes are logged here so AI users can `grep -rn '2026-05-11' packages/*/README.md` and locate every breaking change row in one pass.

## Evolution log

> Append-only registry of breaking-change rows for this package's public surface. Each row carries an ISO-date anchor (`YYYY-MM-DD`), the superseded shape, the new shape, a call-site upgrade diff, and the harness loop folder where the original decision lives. Per [AGENTS.md §Error model](../../AGENTS.md#error-model) the **Evolution contract** is: minor = add members only; major = rename / delete / reorder / narrow / deprecate. Rows below are all major edits.

### 2026-06-22 — instantiateScene diagnostics envelope + unknown-field non-fatal (major)

**Supersedes**: the legacy `world.instantiateScene` -> `Result<EntityHandle, ...>` surface with fatal-abort on unknown fields. Loop anchor: `.forgeax-harness/forgeax-loop/feat-20260622-s5-device-surface-self-heal-recover/`.

**Shape diff**:

| Aspect | Before | After |
|:--|:--|:--|
| `instantiateScene` success value | `EntityHandle` (branded number, synthetic root) | `{ root: EntityHandle; readonly diagnostics: readonly SceneInstantiateDiagnostic[] }` (envelope) |
| Unknown-field behavior | `return err(SpawnDataUnknownFieldError)` — aborts entire scene | Skip the unknown field, record `SceneInstantiateDiagnostic` entry, continue (all entities spawn, known fields write correctly) |
| New type | — | `SceneInstantiateDiagnostic = { readonly component: string; readonly field: string; readonly localId: number }` (barrel export from `@forgeax/engine-ecs`) |
| Runtime `assets.instantiate()` | — | Keeps `Result<EntityHandle>` contract; internally unwraps `.root` |
| NODE_ENV-gating | — | Not gated; diagnostics are production-observable (property-access, not string parsing) |

**Call-site upgrade diff**:

```diff
 // before — EntityHandle directly, unknown field aborts entire scene
-const r = world.instantiateScene(handle);
-if (r.ok) {
-  const root = r.value; // EntityHandle
-}

 // after — envelope with diagnostics
+const r = world.instantiateScene(handle);
+if (r.ok) {
+  const { root, diagnostics } = r.value;
+  for (const d of diagnostics) {
+    // d.component, d.field, d.localId — property access
+  }
+}
```

**Why this row exists**: AI users porting code that assumes `instantiateScene` returns an `EntityHandle` directly will hit TS errors. The envelope adds `diagnostics` to the success path; old callers can `r.value.root` (mechanical). The runtime `assets.instantiate()` keeps the simpler `Result<EntityHandle>` contract for users who don't need diagnostics.

### 2026-05-15 — Buffer / array schema vocab collapse (major)

**Supersedes**: feat-20260514-ecs-children-instances-managed-buffer-array (the legacy `'buffer:<N>'` colon-literal keyword + `FixedArrayView<T>` / `VarArrayView<T>` value-shape exports + `defineComponent` `arrayStride` option). Loop anchor: `.forgeax-harness/forgeax-loop/feat-20260515-buffer-array-vocab-collapse/`.

**Shape diff**:

| Aspect | Before (feat-20260514) | After (this loop) |
|:--|:--|:--|
| Buffer keyword shape | `'buffer:<N>'` (colon-literal, fixed only) | `'buffer'` (variable capacity) + `'buffer<N>'` (fixed N-byte capacity); collapsed-vocab generic forms |
| Value-shape exports | `FixedArrayView<T>` / `VarArrayView<T>` (length / get / set / push / pop / grow methods) | **deleted** — `world.get(...).<arrayField>` returns `TypedArrayFor<T>` read-only snapshot; mutations route through 3 new World commands `world.push` / `world.pop` / `world.capacity` |
| `defineComponent` options | accepted `arrayStride: { transforms: 16 }` | `arrayStride` option removed; stride contract migrates to RenderSystem entry defensive fail-fast for `Instances.transforms` |
| `EcsErrorCode` count | 23 (18 base + 5 `managed-array-*`) | 25 (18 base + 1 surviving `managed-array-element-type-not-allowed` + 3 collapsed-vocab capacity codes `fixed-size-mismatch` / `fixed-array-overflow` / `array-pop-empty` + 1 `instance-transforms-stride-mismatch` from RenderSystem entry + 1 `spawn-light-invalid-bounds` from PointLight / SpotLight spawn payload validation + 1 `cardinality-exceeded` from PointLightShadow cardinality=4 enforcement); rename + delete + add reshape (net 23 -> 25 across two minor adds) |
| Single-import gate | `... / FixedArrayView / VarArrayView / ...` | view classes removed; gate set: `Handle / SchemaFieldType / ManagedRefStore / EcsErrorCode / EcsErrorDetail / EcsError / Name / TypedArrayFor` (+ all error classes) |
| File `packages/ecs/src/managed-array-view.ts` | present (defines `FixedArrayView` / `VarArrayView`) | physically deleted |

**Why this row exists** (charter proposition 4 text-over-image + proposition 5 consistent abstraction): the v2 simplification folds two value-shape view classes (`FixedArrayView` / `VarArrayView`) plus the colon-literal `'buffer:<N>'` keyword into one collapsed generic vocab (`array<T,N>` / `array<T>` / `buffer<N>` / `buffer`) plus a uniform 3-command surface (`world.push` / `world.pop` / `world.capacity`). AI users learn one keyword family and one command surface for every variable / fixed array + buffer; the legacy `as unknown as VarArrayView<...>` cast vanishes from the spawn-site, and `'array<entity>'` / `'array<f32>'` / `'buffer<16>'` / `'buffer'` become first-class, statically-extractable schema literals (covered by `Component.schema['<field>']` runtime self-discovery + offline ripgrep). Loop anchor above carries the full requirements / plan / verify trail.

### 2026-05-15 — `'string'` collapse onto managed-ref dispatch + `World.setManagedRefStore` removal (major)

**Supersedes**: the same-day additive 2026-05-15 row below (`'string'` -> `StringView`) + the M1 setter/getter form of `World.managedRefs`. Loop anchor: `.forgeax-harness/forgeax-loop/feat-20260515-string-managed-collapse/`.

**Shape diff** (`SchemaVocabKeyword` count holds at 7; storage path changes; setter/getter pair deleted):

| Aspect | Before (additive `'string'` -> `StringView` form, AM) | After (this loop, collapse) |
|:--|:--|:--|
| `FieldValueType<'string'>` | `StringView` (5-member view class: `byteLength` / `byteCapacity` / `get` / `set` / `clear`) | `string` (JS native, by reference) |
| Storage column | `Uint32Array` of `BufferPool` slot ids; utf-8 bytes packed in slot | `Uint32Array` of `ManagedRefStore<any>` u32 handles (shared column shape with `ref<T>`) |
| Release dispatch | `BufferPool.release(slot)` via `isStringField` predicate (separate arm from `ref<T>`) | `managedRefs.release(handle)` via `isManagedField` predicate (single arm shared with `ref<T>`) |
| Predicate surface | `isStringField` + `isManagedRefField` (two predicates, two arms) | `isManagedField` (one predicate, one arm — collapses 'string' + 'ref<T>' into the managed family) |
| `World.managedRefs` field | `ManagedRefStore<any> \| null`; wired via `world.setManagedRefStore(store)` setter; `getManagedRefStore()` getter | `ManagedRefStore<any>` (constructor-owned, private, always-on); setter + getter pair removed |
| `StringView` exports | `import { StringView } from '@forgeax/engine-ecs'` | deleted (file `packages/ecs/src/string-view.ts` removed; `StringView` re-export deleted) |
| `isStringField` export | `import { isStringField } from '@forgeax/engine-ecs'` | deleted (re-export removed; the predicate folded into `isManagedField`) |
| Identity stability | `Object.is` not preserved across reads or archetype migration (per-call view rebuild) | `Object.is(read1, read2) === true` for consecutive reads with no intervening set (AC-03); preserved across archetype migration (AC-04 strong contract) |
| Capacity overflow | `set(s)` past 256 KB routed `managed-buffer-out-of-bounds` via `BufferPool` | n/a — JS string capacity is bounded by host runtime, not by `BufferPool` buckets; `managed-buffer-out-of-bounds` JSDoc trigger drops the 'string' bullet |
| Single-import gate | `Handle / SchemaFieldType / ManagedRefStore / EcsErrorCode / EcsErrorDetail / EcsError / FixedArrayView / VarArrayView / StringView / Name / isStringField` | `Handle / SchemaFieldType / ManagedRefStore / EcsErrorCode / EcsErrorDetail / EcsError / Name / TypedArrayFor` (drops `StringView` + `isStringField` + view classes) |
| Grep-gate freeze | n/a | `pnpm grep:no-string-view-import` + `pnpm grep:no-set-managed-ref-store` — block accidental re-import / re-introduction of the deleted symbols |

**Call-site upgrade diff** (minimum 1 example, charter proposition 4 text-over-image):

```diff
 // before — additive form (StringView view-class)
-import { Name, World, type StringView } from '@forgeax/engine-ecs';
-const world = new World();
-world.setManagedRefStore(new ManagedRefStore());
-const e = world.spawn({ component: Name, data: { value: 'Player' } /* historic-bypass */ }).unwrap();
-const view: StringView = world.get(e, Name).unwrap().value;
-view.get();          // 'Player'
-view.byteLength;     // 6

 // after — collapse form (native string by reference)
+import { Name, World } from '@forgeax/engine-ecs';
+const world = new World();              // ManagedRefStore is constructor-owned
+const e = world.spawn({ component: Name, data: { value: 'Player' } }).unwrap();
+const value: string = world.get(e, Name).unwrap().value;
+value;               // 'Player'  (native JS string)
+value.length;        // 6
```

**Why this row exists**: AI users porting code from the additive form will hit TS errors on the deleted `StringView` import + the deleted `setManagedRefStore` setter. Grepping `2026-05-15` lands on the AGENTS.md three-row registry + this evolution log row. The collapse simplifies the AI-user mental model: `'string'` is no longer a third value-shape sibling — it materialises as a native JS string by reference, the same shape downstream code already manipulates.

### 2026-05-15 — `'string'` schema vocab keyword + `Name` component (minor, superseded same day)

**Supersedes**: nothing (additive). Loop anchor: `.forgeax-harness/forgeax-loop/feat-20260515-ecs-name-component-and-string-schema/`.

**Shape diff** (additive only — closed unions extended without rename / delete / reorder, evolution minor):

| Aspect | Before | After (this loop) |
|:--|:--|:--|
| `SchemaVocabKeyword` count | 6 (`buffer:N` / `ref<T>` / `handle<T>` / `entity` / `array<T,N>` / `array<T>`) | 7 (added `'string'` — bare-literal sibling, no `<>` wrapper). **Note**: the later feat-20260515-buffer-array-vocab-collapse row above replaces `buffer:N` with `'buffer'` / `'buffer<N>'` and physically deletes the array view classes; the gate / value-shape entries below describe the snapshot at the close of *this* loop and were superseded one cut later. |
| `EcsErrorCode` count | 23 | 23 (capacity overflow reuses `managed-buffer-out-of-bounds`; KD-7 / AC-07: no new code) |
| Value-shape exports | `FixedArrayView<T>` / `VarArrayView<T>` (later **deleted** by the buffer-array-vocab-collapse row above) | + `StringView` (5-member surface: `byteLength` / `byteCapacity` / `get` / `set` / `clear`; same `@internal` constructor + `errorRouter` envelope contract as the legacy array views — `StringView` survives the collapse) |
| Pre-built component tokens | none specific to `string` | + `Name { value: 'string' }` (single-field exemplar, `defineComponent('Name', { value: 'string' })`) |
| Single-import gate | `Handle / SchemaFieldType / ManagedRefStore / EcsErrorCode / EcsErrorDetail / EcsError / FixedArrayView / VarArrayView` (the two view-class entries are dropped one cut later by the buffer-array-vocab-collapse row above) | + `StringView` / `Name` / `isStringField` |
| README discoverability gate | `pnpm grep:readme-array-vocab-mentioned` | + `node scripts/grep/check-readme-string-vocab-mentioned.mjs` (`'string'` literal + `Name { value:` + `StringView` must surface in `packages/ecs/README.md`) |

**Why this row exists** (charter proposition 4 text-over-image): AI users discovering the new keyword via IDE autocomplete on `SchemaVocabKeyword` see `'string'` as the seventh union member; grepping `Name { value:` lands on every component declaration site; reading the BufferPool 3-path release loop in `world.ts` finds the `isStringField` branch alongside `isManagedBufferField` / `isManagedArrayField`. No call-site migration is required (additive only); existing `array<T,N>` / `array<T>` / handle / buffer / entity vocab keywords retain their byte-for-byte runtime form.

### 2026-05-11 — Result narrow form realignment

**Supersedes**: `feat-20260507-ecs-refactor` KD-1 (`packages/ecs/src/result.ts` plain-union `Result<T, E>` with method-getter surface).

**Loop anchor**: `.forgeax-harness/forgeax-loop/feat-20260511-tetris-retro-followups/` (requirements §6.3 AC-14 / plan-decisions D-P8 方向 B / research §F-12).

**Shape diff**:

| Aspect | Old shape (KD-1, plain union + method-getter) | New shape (this loop, discriminated union + plain fields) |
|:--|:--|:--|
| Discriminant | `_ok: true` / `_ok: false` (private-by-convention prefix) | `readonly ok: boolean` (public boolean discriminant) |
| Value accessor | `_value: T` on ok branch | `readonly value: T` on ok branch |
| Error accessor | `_error: E` on err branch | `readonly error: E` on err branch |
| Method surface | `.isOk()` / `.isErr()` / `.map(fn)` / `.mapErr(fn)` getters | `.unwrap()` / `.unwrapOr(default)` only (`.isOk` / `.isErr` / `.map` / `.mapErr` **removed**) |
| Narrow idiom | `if (r.isOk()) { r._value }` | `if (r.ok) { r.value }` |
| Alignment | ecs-private union (rhi unchanged) | byte-for-byte aligned with `packages/rhi/src/errors.ts` Result (charter proposition 5 一致抽象) |

**Call-site upgrade diff** (minimum 1 example, charter proposition 4 text-over-image):

```diff
 // before — KD-1 plain union + method-getter surface
-const r = world.get(entity, Position);
-if (r.isOk()) {
-  const data = r._value;
-  use(data);
-} else {
-  console.error(r._error.code);
-}
-const doubled = r.map((data) => data.posX * 2);

 // after — feat-20260511-tetris-retro-followups discriminated union + plain fields
+const r = world.get(entity, Position);
+if (r.ok) {
+  const data = r.value;
+  use(data);
+} else {
+  console.error(r.error.code);
+}
+// `.map` removed — inline the transform after `.ok` narrow
+const doubled = r.ok ? r.value.posX * 2 : 0;
```

**Why this row exists**: AI users porting code written against the KD-1 surface will see TypeScript errors (`Property 'isOk' does not exist on type 'Result<T, E>'`). Grepping `2026-05-11` in `packages/*/README.md` lands here and on the matching `packages/runtime/README.md` row; the diff above is the mechanical port. Decision rationale, OQ branches, and AI-user charter mapping live in the harness loop anchor above — not duplicated here.

### 2026-06-02 — Entity as id=0 component + alive absorption + removeComponent rejection (major)

**Supersedes**: `World.isAlive` / `_getEntityGenerationForIndexSlot` / `EntityRecord.alive` deleted; the `arch.entities` side-array is demoted (no longer the entity-identity surface — survives as internal swap-pop bookkeeping, see table). Loop anchor: `.forgeax-harness/forgeax-loop/feat-20260602-archetype-stores-full-packed-entity/`.

**Shape diff** — Entity identity reshaped as a real id=0 component, with archetype rows carrying the full packed handle in a uniform column:

| Aspect | Before | After |
|:--|:--|:--|
| Entity identity storage | `arch.entities[row]` (24-bit index slot only, side-array) | id=0 `Entity` component column `self: 'entity'` (full packed 32-bit handle) |
| Rebuilding a handle from a row | `arch.entities[i]` + `_getEntityGenerationForIndexSlot` + `encodeEntity` (three-step) | `bundle.Entity.self[i]` (query) or `arch.columns.get(Entity.id).get('self')` (hand-written loops) |
| Liveness probe | `world.isAlive(e)` (public method) | `world.get(e, Entity)` (returns `err(STALE_ENTITY)` for despawned handles; works on any entity ref field via `'entity'` vocab) |
| `EntityRecord.alive` field | present (boolean, dual-judgement with generation) | **deleted** — liveness is pure `record.generation === handle.gen` |
| `despawn` | sets `alive = false`, pushes index to `freeIndices` | `generation += 1` unconditionally; pushes index to `freeIndices` only when new gen <= 255 |
| gen>255 | unreachable (8-bit packing bounds gen to 0..255) | slot permanently retires (never reissued), serving as a tombstone |
| `entityCount` (inspect) | scans `records[].alive` | sum of `arch.size` across all archetypes |
| `removeComponent(e, Entity)` | N/A (no Entity component existed) | returns `err(code='remove-essential-component')` — the Entity column is structurally required |
| `EcsErrorCode` count | 29 (post-drop-dangling-sweep + post-drop-registration) | 30 (net +1: `remove-essential-component` added) |
| archetypeKey shape | `"2+5+7"` (components ids joined by +, no Entity column) | `"0+2+5+7"` (id=0 prefixed — the Entity column is always present) |
| `_getEntityGenerationForIndexSlot` | `World` method + consumer `WorldInternalView` interfaces | **deleted** — 0 remaining callers |
| `arch.entities` array | `Uint32Array` bare-index side-array — the entity-identity surface (read for handle rebuild) | **demoted** — full handle now lives in the id=0 `self` column; `arch.entities` survives only as internal row→index-slot swap-pop bookkeeping (`removeEntity` fixes up the displaced row's `records[].row`), never read for entity reconstruction |

**Call-site upgrade diff**:

```diff
 // before — three-step entity rebuild
-const idx = arch.entities[i];
-const gen = (world as WorldInternalView)._getEntityGenerationForIndexSlot(idx);
-const handle = encodeEntity(idx, gen);
-const inst = world.get(handle, Instances);

 // after — single column read (query path)
+const handle = bundle.Entity.self[i];
+const inst = world.get(handle, Instances);

 // before — liveness check
-if (world.isAlive(parent)) { ... }

 // after — universal liveness probe
+const r = world.get(parent, Entity);
+if (r.ok) { ... }
+// or: if (!r.ok && r.error.code === 'stale-entity') { ... }

 // before — remove Entity component (was not a real component)
-// N/A

 // after — essential-component rejection
+const r = world.removeComponent(e, Entity);
+// r.ok === false, r.error.code === 'remove-essential-component'
```

**gen>255 permanent retirement — forgeax-only, do not extrapolate**:

> [!WARNING]
> **Forgeax uses unbounded JS-number generation + packed handle taking the low 8 bits, with gen>255 slots permanently retiring as tombstones.** No native ECS (Bevy NonMaxU32 / EnTT tombstone / flecs tag bits / UECS swap-back) lets generation cross the packing bit-width to serve as a tombstone — this is a forgeax-unique idiom driven by JavaScript's lack of a native 8-bit integer type. **Do not extrapolate gen-wrap mentality from Bevy or EnTT experience:** forgeax generation never wraps, and a handle with generation=256 is a real, usable handle whose index slot will never be reissued. If you design a system that assumes "generation wraps modulo 256," it will be wrong on forgeax.

**Why this row exists** (charter P4 consistent abstraction + P3 explicit failure): AI users porting code written against the three-step entity rebuild pattern must replace `arch.entities[i]` with `bundle.Entity.self[i]` and `world.isAlive(e)` with `world.get(e, Entity)`. The Entity component column unifies the read path — entity handles are read like any other component column — and the error code `remove-essential-component` makes the structural invariant (Entity column is required) surface as a structured error rather than a silent corruption. Grepping `2026-06-02` in `packages/*/README.md` lands on this row. The loop anchor above carries the full requirements / plan / verify trail.

### 2026-06-11 — ECS storage naming SSOT (major)

**Supersedes**: all prior naming / storage / error-code conventions for the archetype store. Loop anchor: `.forgeax-harness/forgeax-loop/feat-20260611-ecs-storage-naming-ssot/`.

**Shape diff** — 9 sub-changes converge the archetype store onto a single-source-of-truth shape:

| Sub-item | Before | After |
|:--|:--|:--|
| EntityHandle rename | `type Entity = ...` (branded handle; collided with id=0 `Entity` component token) | `type EntityHandle = ...` (unambiguous branded handle; `Entity` token for id=0 component only) |
| Archetype single-field | `Archetype` carried `componentIds: ReadonlyArray<ComponentId>` + `entities: Uint32Array` as independent fields | `Archetype.components: ReadonlyArray<Component>` is the sole field; `componentIds` derived via `.components.map(c => c.id)` |
| `arch.entities` deleted | side-array `Uint32Array` of row-to-index-slot mappings | removed entirely; swap-pop reads the id=0 `self` column via `columns.get(0)?.get('self')?.view[lastRow] & 0xffffff` |
| `ESSENTIAL_COMPONENT_IDS` + `foldEssentials` | `archetypeKey` / `createArchetype` each hard-coded `Entity.id` prepend | single `ESSENTIAL_COMPONENT_IDS = [Entity.id]` constant + `foldEssentials(ids)` helper (2 call sites: `archetypeKey` + `createArchetype`) |
| `isManaged` column | 4 `isXxxField` predicates each hand-written with OR expressions and string-match logic | `TYPE_METADATA` gains `isManaged: boolean` column; 4 predicates converge to single-line `TYPE_METADATA[key]?.isXxx ?? false` lookups |
| `componentRegistry` deleted | `ArchetypeGraph.componentRegistry: Map<ComponentId, Component>` for reverse lookups | removed; `getRemoveEdge` derives component set from `src.components.filter(c => c.id !== removedId)` |
| `EcsErrorCode` kebab | 7 SCREAMING_SNAKE code literals (`ENTITY_INDEX_OVERFLOW`, `STALE_ENTITY`, etc.) | 7 kebab-case code literals (`entity-index-overflow`, `stale-entity`, etc.); 96 cross-package references mechanically replaced |
| `relationshipSyncDepth` eliminated | `private relationshipSyncDepth = 0` counter + `++`/`--` guards to prevent reentrant hook recursion | 4 `_xxxCore` private methods with `internal: boolean` parameter; public methods delegate `_xxxCore(args, false)`; hooks call `_xxxCore(args, true)` |
| `EntityRecord.pending` derived delete | `EntityRecord.pending: boolean` field (written at 4 sites: spawn / allocate / materialize / despawn) | field removed; liveness derived from `record.generation === gen && record.archetypeId !== -1` (pending=true iff archetypeId === -1) |

**Why this row exists**: every sub-item above changes a public API surface or a greppable code literal. AI users porting code post-M-6 will hit TS errors on removed fields (`arch.entities`, `arch.componentIds`, `graph.componentRegistry`, `record.pending`, `relationshipSyncDepth`), renamed types (`Entity` -> `EntityHandle`), and changed error-code strings (SCREAMING_SNAKE -> kebab-case). Grepping `2026-06-11` in `packages/*/README.md` lands on this row. The loop anchor above carries the full requirements / plan / verify trail.

## Related packages

- [`@forgeax/engine-runtime`](../engine-runtime) — consumes `Result` returned by `world.get` / `world.spawn` etc.
- [`@forgeax/engine-rhi`](../rhi) — the cross-package `Result` SSOT this package aligns with.
- [`@forgeax/engine-math`](../math) — POD math types consumed by component schemas.

## Inspector contribution

`registerEcsInspector(reg, world)` is a top-level pure function that wires four JSON-RPC inspection methods + one mutating-method contribution onto a `Registry` instance from `@forgeax/engine-console`. Method names: `entities` / `components` / `systems` / `resources` (registration order locked, byte freeze of the legacy `inspect-scripts.ts`). The third step (feat-20260517 D-2 / w13) calls `reg.registerMutatingMethods(ECS_MUTATING_METHODS)` — the 15-name frozen Set is the SSOT for ECS write methods that the console sandbox blacklist consults at wrap-time. Importing `@forgeax/engine-ecs` does **not** call `reg.register*` — registration only fires on explicit invocation (AC-10 zero import-time side effect; charter P3 + R-PLUGIN-IMPORT-SIDE-EFFECT mitigation).

```ts
// host main.ts assembly (plan-strategy section 3.3 success path)
import { Registry, startConsoleServer, wireDefaultInspectors } from '@forgeax/engine-console';
import { registerEcsInspector } from '@forgeax/engine-ecs';

const reg = new Registry();
const r = registerEcsInspector(reg, world);
if (!r.ok) { console.error(r.error); process.exit(1); }
await startConsoleServer({ port: 5732, registry: reg });
```

Same-name duplicate fails fast on the first conflict and returns `Result.err(InspectorError, code: 'console-startup-failed')` — short-circuits without partial-registration leak. Reuse across reloads requires a fresh `new Registry()`.

## CLI — `forgeax-engine-console-ecs`

`@forgeax/engine-ecs` ships the `forgeax-engine-console-ecs` plugin bin (kubectl 4th-path; discovered by the base bin `forgeax-engine-console` via PATH-prefix scan). 5 subcommands mirror the inspector method set; the WS client is shared with the base CLI through `@forgeax/engine-types/inspector-client`.

| Subcommand | Flags | Output |
|:--|:--|:--|
| `entities` | `--with <name>` / `--without <name>` (repeatable) | archetypes filtered by component-name set + entity counts |
| `components` | — | registered component name list with archetype + entity rollup |
| `systems` | — | system count + name list (registration order) |
| `resources` | — | resource key list |
| `world` | — | full `world.inspect()` snapshot |

Common flags: `--port <n>` (default 5732) / `--host <s>` (default localhost) / `--help`. Examples:

```sh
forgeax-engine-console-ecs entities --with Transform
forgeax-engine-console-ecs components --port 5731
forgeax-engine-console-ecs world | jq .archetypes
```

The legacy `forgeax-engine-console inspect <target>` form was removed in feat-20260517-console-ecs-plugin-extraction; the base bin now surfaces a "did you mean 'forgeax-engine-console-ecs <target>'?" hint when AI users type the deleted form.

## Schema vocabulary quick-ref

Component fields accept two tiers of keywords. Both are surfaced through one type — `SchemaFieldType = ScalarFieldType | SchemaVocabKeyword` (`packages/ecs/src/component.ts`) — so AI users see the full vocabulary at one IDE-autocomplete site (charter proposition 1: one obvious entry).

| Keyword | Tier | Resolves to (TS) | Storage column | Release path on remove / despawn / set | Source |
|:--|:--|:--|:--|:--|:--|
| `'f32'` / `'f64'` / `'i32'` / `'u32'` / `'i16'` / `'u16'` / `'i8'` / `'u8'` / `'bool'` / `'enum'` / `'ref'` | scalar (legacy) | `number` (`bool` widens to `boolean`) | matching typed-array (`'ref'` -> `Uint32Array`, plain u32) | none — POD; carry-over byte-equal | `ScalarFieldType` |
| `` `ref<${string}>` `` | vocab — managed handle | `Handle<TargetTag, 'managed'>` | `Uint32Array` (packed handle) | `ManagedRefStore.release(handle)` (3-path: despawn / removeComponent / set) | `SchemaVocabKeyword` |
| `` `handle<${string}>` `` | vocab — unmanaged handle | `Handle<TargetTag, 'unmanaged'>` | `Uint32Array` (packed handle) | none — external owner manages release | `SchemaVocabKeyword` |
| `` `buffer` `` | vocab — variable-capacity managed buffer slot | `Uint8Array` read-only snapshot (resolved on `world.get`) | `Uint32Array` of `BufferPool` slot ids | `BufferPool.release(slot)` (3-path) | `SchemaVocabKeyword` |
| `` `buffer<${number}>` `` | vocab — fixed-capacity managed buffer (capacity `N` bytes frozen at schema compile time) | `Uint8Array` read-only snapshot (resolved on `world.get`); `world.set` writes must satisfy `byteLength === N` (routes `fixed-size-mismatch` on violation) | stride-N `Uint8Array` inline column (feat-20260602); bytes laid out contiguously per row, no `BufferPool` slot | none — inline byte column; carry-over byte-equal | `SchemaVocabKeyword` |
| `'entity'` | vocab — single entity ref | `Entity` (branded `number`) | `Uint32Array` (packed handle) | none — raw u32 returned verbatim on read; ECS does not validate liveness, the consumer self-checks (`world.isAlive` / generation / its own design) | `SchemaVocabKeyword` |
| `` `array<${T}, ${N}>` `` | vocab — fixed-length managed array (`T` is `ManagedArrayElementType`; `N` is element count) | `TypedArrayFor<T>` read-only snapshot (length === N) | stride-N inline column (feat-20260602); elements laid out contiguously per row, no `BufferPool` slot; typed via `elemStorage(T)` (entity -> u32, scalars -> identity) | none — inline typed-array column; carry-over byte-equal | `SchemaVocabKeyword` |
| `` `array<${T}>` `` | vocab — variable-length managed array (`T` is `ManagedArrayElementType`; capacity grows via `world.push`) | `TypedArrayFor<T>` read-only snapshot (length === current count) | `Uint32Array` of BufferPool slot ids + sidecar count column; live `count` tracked through `world.push / world.pop` | `BufferPool.release(slot)` (3-path); carry-over byte-equal + `count / capacity` preserved | `SchemaVocabKeyword` |
| `'string'` | vocab — managed JS string (collapsed onto managed-ref dispatch by feat-20260515-string-managed-collapse) | `string` (JS native, by reference) | `Uint32Array` of `ManagedRefStore<any>` u32 handles (shared column shape with `ref<T>`) | `managedRefs.release(handle)` (3-path: despawn / removeComponent / set; routed through the single `isManagedField` predicate alongside `ref<T>`); carry-over byte-equal — the same JS string identity (`Object.is`) survives archetype migration | `SchemaVocabKeyword` (added 2026-05-15; `StringView` class deleted 2026-05-15 in same-day collapse) |

> **Retired one-cut**: the legacy `'entity[]'` predecessor (v1 OOS-04 sidecar `Map<row, Entity[]>`) was replaced in one edit by `array<entity>` (the `T = entity` instantiation of the variable-length array vocab above). Sweep is now backed by the same BufferPool path as every other array — no sidecar map, no `[]` syntax. Loop anchor: [`feat-20260514-ecs-children-instances-managed-buffer-array`](../../.forgeax-harness/forgeax-loop/feat-20260514-ecs-children-instances-managed-buffer-array/).

`ManagedArrayElementType` = `ScalarFieldType | 'entity'` (`packages/ecs/src/component.ts:78`); reference / handle / buffer / nested-array element types are forbidden (gate route `managed-array-element-type-not-allowed`).

Runtime gate: `isSchemaVocabKeyword(s)` (component.ts:178). Storage map: `storageFieldType(s)` (component.ts:106). Managed-field probes: `isManagedRefField` / `isManagedBufferField` / `isEntityField`.

> **Cross-mode safety** (charter proposition 5: consistent abstraction across the vocab families):
> The handle-shaped keywords (`ref<T>` / `handle<T>` / `buffer` / `buffer<N>` / `entity`) share template-literal syntax + the `Handle<TargetTag, Mode>` phantom-tag form (or `Entity` for the entity case). The two array vocab keywords (`array<T,N>` / `array<T>`) share the same template-literal shape — different element types `T` produce different `TypedArrayFor<T>` snapshot types; cross-element-type, cross-shape (`array<T,N>` vs `array<T>` vs `buffer` vs `buffer<N>`), and cross-tag assignment is a TS error (`packages/ecs/src/__tests__/handle.test-d.ts:37,46,55,64` + `packages/ecs/src/__tests__/managed-array-vocab.test.ts` inline `expectType` anchors).

## Transient view contract -- fixed `array<T,N>` and `buffer<N>`

> [!IMPORTANT]
> **The TypedArray view returned by `world.get(e, Transform).world` aliases the archetype column buffer directly.** It is valid only until the next structural change. Re-fetch the view on every access.

Fixed-capacity inline columns (`array<T,N>` / `buffer<N>` as of feat-20260602) store their payload contiguously in a stride-N `TypedArray` column. The snapshot returned by `world.get` and the fast-path view returned by `_getArrayView` both alias the live column buffer -- not a copy, and not a `BufferPool` slot. This means:

- **Every access must re-fetch the view** (`world.get(e, C).field` or the internal `_getArrayView` call). Do not hold the returned `TypedArray` across an operation that may grow, shrink, or remap columns.
- **Structural change** = `spawn` / `despawn` / `addComponent` / `removeComponent` -- anything that causes archetype migration or column growth (`growColumn` detaches the old `ArrayBuffer` via `transfer()`).
- **Holding a view across a structural change is undefined behaviour**: after growth the backing buffer is detached (the view becomes zero-length); after a swap-remove at the same row index the view points to the wrong entity.

### Why the existing hot paths are already safe

The inline layout merely makes an implicit contract explicit. Three per-frame consumers already conform:

| Consumer | Pattern | Why safe |
|:--|:--|:--|
| `propagateTransforms` | Pins the view inside a single-pass loop over archetype rows | No spawn/despawn/migration occurs mid-pass |
| `render-system-extract` | Fetches `_getArrayView`, copies 16 floats, discards the view | Fetch-use-copy within the same tick |
| `pick` | Fetches the world matrix, transforms the ray, returns immediately | Fetch-use-return, no retention |

AI users writing a new system that reads a fixed-capacity array field across spawns or component adds must re-fetch the view after each structural change. The contract is documented here and in the JSDoc of `_getArrayView` / `get` / `Transform.world`; no runtime epoch check is performed (accepted risk R-1, defer to future hardening).

## Array / buffer field access — `world.push` / `world.pop` / `world.capacity` + read-only snapshot

`array<T,N>` and `array<T>` resolve at `world.get(...).unwrap().<field>` to a `TypedArrayFor<T>` **read-only snapshot** (D-4: snapshots are throwaway; do not retain across calls; writing to the returned typed array has undefined effect on World state — go through the three commands below). One value shape, three commands:

| Command | `array<T,N>` (fixed-length) | `array<T>` (variable-length) |
|:--|:--|:--|
| `world.push(e, C, 'f', v)` | not available (capacity frozen; pushes past `N` route `fixed-array-overflow`) | grows the live element count by 1; `count > capacity` triggers transparent `BufferPool` grow |
| `world.pop(e, C, 'f')` | not available (length frozen) | returns the trailing element typed `T`; routes `array-pop-empty` when `count === 0` |
| `world.capacity(e, C, 'f')` | returns `N` (literal-typed at compile time) | returns the current allocation; never decreases except on slot release |

```ts
import { defineComponent, World } from '@forgeax/engine-ecs';

const C = defineComponent('C', { tag: 'array<u32>' });
const world = new World();
const e = world.spawn({ component: C, data: { tag: new Uint32Array(0) } }).unwrap();

world.push(e, C, 'tag', 7);                  // count: 0 -> 1
world.push(e, C, 'tag', 9);                  // count: 1 -> 2
world.capacity(e, C, 'tag');                 // current allocation
const snapshot = world.get(e, C).unwrap().tag; // TypedArrayFor<'u32'> (Uint32Array), read-only snapshot
world.pop(e, C, 'tag');                      // count: 2 -> 1; returns 9
```

`fieldName` is statically constrained to `keyof S` filtered to fields whose schema keyword is `array<...>` / `array<..., N>` (`world.push(e, C, 'parent', x)` where `parent: 'entity'` is a TS error; `world.capacity(e, C, 'meta')` where `meta: 'buffer<N>'` is a TS error — `*.test-d.ts` locks each cross-shape rejection). For `buffer<N>` the entry is `world.set(e, C, { f: bytes })` with `bytes.byteLength === N` (routes `fixed-size-mismatch` on violation); `buffer` (variable) has no `byteLength` constraint and writes through the same `world.set`.

Stride contract for `Instances.transforms` is **not** enforced at the ECS layer — `defineComponent` no longer accepts an `arrayStride` option. The defensive fail-fast (`length % 16 === 0`) lives at the RenderSystem entry that consumes `Instances.transforms` before GPU upload, where it routes `instance-transforms-stride-mismatch` (see [`packages/runtime/README.md`](../runtime/README.md)). AI users at the spawn site write `transforms: new Float32Array(N * 16)` directly — no stride option, no view wrapper.

> **Carry-over rules (D-3, weak constraint)** — archetype migration preserves: (a) inline column bytes for fixed `array<T,N>` / `buffer<N>` are byte-equal (the full stride-N block is copied verbatim); for variable `array<T>` the BufferPool slot bytes are byte-equal and the slot stays live (no release/realloc); (b) `count` (queried via `world.capacity` for variable arrays) and the fixed `N` are unchanged; (c) the typed-array snapshot returned by post-migration `world.get` is byte-equal but is **not** the same JS object — identity (`Object.is`) is **not** part of the contract. AI users rely on contents, not identity.

## Relationship — bidirectional entity relations (feat-20260531)

A **relationship** is a binary entity-to-entity relation (parent-child, attachment, ownership) declared once on `defineComponent`; the engine then auto-maintains both directions. The canonical instance is `ChildOf` (source, holds the SSOT) ↔ `Children` (mirror, an `array<entity>` reverse list) in `@forgeax/engine-runtime`. The abstraction is generic — any relation (`FollowedBy` / `OwnedBy` / your own) uses the same shape.

**Declare it** (third `defineComponent` arg, one nested entry — charter P1):

```ts
const ChildOf = defineComponent('ChildOf', { parent: 'entity' }, {
  relationship: { mirror: 'Children', field: 'entities', exclusive: true, linkedSpawn: false },
});
```

`RelationshipMeta` (`packages/ecs/src/component.ts`): `mirror` (mirror component **name**, string — resolved at define time via the global `resolveComponent` index, keeps `engine-ecs` free of any `engine-runtime` import), `field` (the mirror's `array<entity>` field), `exclusive` (single-target: re-attaching auto-reparents), `linkedSpawn?` (default `false` — despawning the target does **not** cascade-despawn its sources; set `true` for Bevy-style recursive despawn).

**Define-order constraint** — the mirror component must be `defineComponent`'d **before** the holder. Relationship validation runs at `defineComponent` time (fail-fast throw): if the mirror name is unknown, `defineComponent` throws `RelationshipMirrorComponentNotRegisteredError`; if the mirror's field is not `'array<entity>'`, it throws `RelationshipMirrorFieldTypeMismatchError`. In a TS module, ESM top-level evaluation order guarantees this as long as the mirror's `defineComponent` call appears (or is imported) before the holder's — no separate registration step needed:

| Failure | `err.code` |
|:--|:--|
| mirror name unknown at define time | `relationship-mirror-component-not-registered` |
| mirror field not `array<entity>` | `relationship-mirror-field-type-mismatch` |

**Commands** (synchronous `World` methods; the relationship hook maintains the mirror automatically — no manual `Children` push/pop):

| Method | Effect |
|:--|:--|
| `addChild(parent, child, C, data)` | attach via relationship component `C`; O(depth) cycle check fail-fast (`relationship-self-cycle`); `exclusive` auto-reparents off any old target |
| `removeChild(parent, child, C)` | detach (entity survives); parent-mismatch → `relationship-detach-mismatch` |
| `reparent(child, newParent, C, data)` | atomic detach-then-attach; same cycle check |

> The 4-arg `addChild(parent, child, component, data)` shape is the price of generality — the relation type is not hard-coded to `ChildOf`, so the holder `Component` token + its field `data` are explicit. Bare `addComponent(child, ChildOf, { parent })` works identically (the hook fires either way); the Commands add cycle-detection + atomic reparent on top.

**Traverse** — `world.iterDescendants(e)` / `world.iterAncestors(e)` return `Iterable<EntityHandle>` for `for...of`; both carry a visited-set so corrupt cyclic data terminates instead of looping.

**Lifecycle** — bidirectional sync runs at three `World` sites: `addComponent`/`spawn` (append to mirror, lazily creating the mirror component if absent), `removeComponent` (prune), `despawn` (prune the mirror entry; cascade only if `linkedSpawn`). Built on the internal `onInsert`/`onRemove` component hooks (`DefineComponentOptions`, not a public registration API in this release).

> Eliminates the prior manual `Children` ↔ `ChildOf` two-step maintenance (OOS-09 / OOS-10).

## Query — `optional` per-archetype column-level exposure (feat-20260531)

**`optional` = per-archetype column-level data exposure; does not participate in matching/filtering.** The `with` set determines **which archetypes match** (`with ∩ ¬without`); `optional` only decides **which extra columns the bundle carries** on each matched archetype. A component in `optional` that is absent from an archetype simply omits its key from `bundle` (overall absent — no `undefined` value, no empty object). This is the data/filter separation (wiki/bevy-ecs AP-3): optional lives in the data dimension, not the filter dimension.

**Constructor shape** — `optional` is a peer of `with` / `without` on `QueryDescriptor`, same `readonly Component[]` shape:

```ts
const state = createQueryState({
  with: [Camera],
  optional: [GlobalTransform, Transform],
}, world);
```

**Bundle type mapping** — `NestedColumnBundle<Cs, Os>` maps optional components to an overall-`?:` intersection via `Partial<...>` (charter P4). The `exactOptionalPropertyTypes` compiler flag means `?:` signals "key may be absent", matching the AC-02 per-archetype absent semantic exactly:

| Component source | Bundle key type | Example |
|:--|:--|:--|
| `with` (Cs) | Non-optional intersection | `bundle.Camera.fovY` is `number // not undefined` |
| `optional` (Os) | Overall `?:` intersection | `bundle.GlobalTransform` is `{ posX: Float32Array, ... } \| undefined` |

**Callback consumption** — AI users read optional columns with standard TS optional chaining, no cast needed:

```ts
queryRun(state, world, (bundle) => {
  const count = bundle.entityCount;
  const cam = bundle.Camera;                    // always present (with)
  const gtf = bundle.GlobalTransform;           // { posX, ... } | undefined
  for (let i = 0; i < count; i++) {
    const fovY = cam.fovY;                      // non-optional read
    const px = gtf?.posX[i];                    // optional chaining — safe when absent
  }
});
```

Real-world consumer: `packages/runtime/src/render-system-extract.ts` Camera / PointLight / SpotLight extract segments (feat-20260531 M2 migration).

**Boundaries**:

| Scenario | Behaviour |
|:--|:--|
| Optional component absent from **all** matched archetypes | `bundle.X === undefined` on every callback — no error, optional means "may be absent" |
| Optional component present on **some** archetypes | Present archetypes get the key; absent archetypes omit it. Per-archetype granularity, matches archetype ECS model. |
| Same token in both `with` and `optional` | **Fail-fast** at `createQueryState` construction time: `EcsError(code='query-descriptor-with-optional-conflict')` with `.hint` property-accessible (charter P3). `with` implies "always present + filter", `optional` means "may be absent, no filter" — they contradict for the same component. This is a descriptor self-consistency check, O(descriptor) one-time, zero per-frame / per-archetype overhead. |
| Optional component not registered in World | Treated as absent from all archetypes — `optionalIds` omits unresolved tokens; no crash, predictable behaviour (<https://github.com/bevyengine/bevy/issues/17578>) |
| Empty `optional: []` | Equivalent to pure `with` query — no optional keys in bundle. `DirectionalLight` query keeps this form (OOS-5). |

## Name component

> [!TIP]
> **30-second TLDR**: `Name { value: 'string' }` is the canonical single-field exemplar of the `'string'` schema vocab. Read returns a native JS `string` (no view class — collapsed onto the managed-ref dispatch by feat-20260515-string-managed-collapse). AI users round-trip via `world.get(e, Name).unwrap().value` and mutate via `world.set(e, Name, { value: 'NewName' })`. Despawn frees the underlying `ManagedRefStore` handle through the same 3-path release as every other managed field.

```ts
import { defineComponent, Name, World } from '@forgeax/engine-ecs';
// Name is pre-defined; equivalent to: defineComponent('Name', { value: 'string' })

const world = new World();
const e = world.spawn({ component: Name, data: { value: 'Player' } }).unwrap();

// Read: world.get returns Result<{ value: string }, EcsError>
const value: string = world.get(e, Name).unwrap().value;
value;               // 'Player'  (native JS string, by reference)

// Mutate: world.set replaces the managed-ref handle in one shot
world.set(e, Name, { value: 'Boss' }).unwrap();
world.get(e, Name).unwrap().value;  // 'Boss'

// Identity stability across reads with no intervening set (AC-03)
const a = world.get(e, Name).unwrap().value;
const b = world.get(e, Name).unwrap().value;
Object.is(a, b);     // true  (managed-ref handle returns the same JS string)

// Despawn releases the handle via the ManagedRefStore 3-path. Carry-over
// across archetype migrations preserves Object.is identity (AC-04 strong
// contract).
world.despawn(e);
```

`Name` is exported from `@forgeax/engine-ecs` as a pre-built component token. The schema literal `Name { value: 'string' }` is the canonical grep target for AI users discovering the `'string'` vocab via `rg "Name { value:" packages apps templates` — the same pattern used by `Children { entities` / `Instances { transforms` for the `array<...>` vocab. Mutation, archetype carry-over (`Object.is` identity preserved per AC-04), and `ManagedRefStore` 3-path release are all covered by the unit tests at `packages/ecs/src/__tests__/name-component.test.ts` + `name-mutation.test.ts` + `string-release.test.ts` + `string-carry-over.test.ts` + `string-managed-dispatch.test.ts` + `string-identity-contract.test.ts`.

## Error code reverse anchors (full set)

`EcsErrorCode` (`packages/ecs/src/errors.ts`) is the closed union of every `.code` literal carried by the EcsError family — **31 members** (the source file is the live SSOT; read it for the exact list). Recent evolution: feat-20260531-query-optional-components added `query-descriptor-with-optional-conflict`; then on 2026-06-02 two sibling feats each removed members — feat-20260602-drop-entity-dangling-sweep deleted `entity-dangling-cleared` + `entity-dangling-component-removed` (-2), and feat-20260602-drop-component-registration-registered-concept-lig deleted `COMPONENT_ALREADY_REGISTERED` + `COMPONENT_NOT_REGISTERED` and added `component-not-defined` (net -1) — combined net -3 landing at 29; then feat-20260602-archetype-stores-full-packed-entity added `remove-essential-component` (net +1, landing at 30); then feat-20260608-scene-nesting-ecs-fication M1 / w9 added `scene-override-type-mismatch` (net +1, landing at 31). Switch on `err.code` for exhaustive narrowing; `err.detail` is narrowed per-code via `EcsErrorDetail`.

| `.code` literal | Severity (default route via Layer-3 `matchSeverity`) | One-line hint | Class / source |
|:--|:--|:--|:--|
| <a id="entity-index-overflow"></a>`'entity-index-overflow'` | `Panic` | reduce simultaneous entity count or investigate leaks | `EntityIndexOverflowError` |
| <a id="schema-unsupported-field"></a>`'schema-unsupported-field'` | `Panic` | use a `SchemaFieldType` keyword (table above) | `SchemaUnsupportedFieldError` |
| <a id="stale-entity"></a>`'stale-entity'` | `Error` (Result err) | despawned entity used; check `r.ok` before `r.value` | `StaleEntityError` |
| `'component-not-defined'` | `Error` (Result err) | a SceneAsset node references a component name that was never `defineComponent`'d; define the component globally first | `ComponentNotDefinedError` |
| <a id="component-already-present"></a>`'component-already-present'` | `Error` | use `set` to replace, not `addComponent` | `ComponentAlreadyPresentError` |
| <a id="component-not-present"></a>`'component-not-present'` | `Error` | `addComponent` before `removeComponent` / `set` | `ComponentNotPresentError` |
| <a id="cyclic-dependency"></a>`'cyclic-dependency'` | `Panic` | break the system before/after cycle | `CyclicDependencyError` |
| <a id="resource-not-found"></a>`'resource-not-found'` | `Error` | `world.insertResource(...)` before reading | `ResourceNotFoundError` |
| `'system-before-unknown'` / `'system-name-conflict'` / `'cyclic-injection'` | `Panic` | resolve via `name` / break the schedule cycle | `ScheduleMutationError` (3 codes via `ScheduleMutationErrorCode`) |
| `'managed-ref-released'` | `Error` (Result err) | re-acquire via `ManagedRefStore.alloc(...)`; do not retain references past release | `ManagedRefReleasedError` |
| `'managed-ref-double-release'` | `Panic` | one release per `alloc`; trace the duplicate dispose path | `ManagedRefDoubleReleaseError` |
| `'managed-buffer-out-of-bounds'` | `Error` | grow via the buffer slot's `defineComponent({ buffer: 'buffer<N>' })` budget; do not write past `N`. Triggers limited to `buffer<N>` + managed-array element-buffer paths; the `'string'` schema vocab does not route through this code (collapsed onto managed-ref dispatch by feat-20260515-string-managed-collapse) | `ManagedBufferOutOfBoundsError` |
| `'managed-buffer-shrink-not-supported'` | `Panic` | drop the slot via `removeComponent` and re-allocate, or grow only | `ManagedBufferShrinkNotSupportedError` |
| <a id="fixed-size-mismatch"></a>`'fixed-size-mismatch'` | `Error` (Result err) | `world.set` for a `buffer<N>` field requires `data.byteLength === N`; check spawn-site allocation | `FixedSizeMismatchError` |
| <a id="fixed-array-overflow"></a>`'fixed-array-overflow'` | `Error` (Result err) | `world.push` on `array<T,N>` past the capacity `N`; remove or reset before pushing more | `FixedArrayOverflowError` |
| <a id="array-pop-empty"></a>`'array-pop-empty'` | `Error` (Result err) | guard `world.capacity(e, C, 'f') > 0` before `world.pop`; pop on empty leaves count unchanged | `ArrayPopEmptyError` |
| <a id="instance-transforms-stride-mismatch"></a>`'instance-transforms-stride-mismatch'` | `Error` (Result err) | `Instances.transforms.length % 16 === 0` violated at RenderSystem entry; spawn-site must allocate `new Float32Array(N * 16)` | `InstanceTransformsStrideMismatchError` (`packages/runtime/src/__tests__/render-system-stride.test.ts`) |
| <a id="managed-array-element-type-not-allowed"></a>`'managed-array-element-type-not-allowed'` | `Panic` | element type must be `ScalarFieldType \| 'entity'`; nested arrays / `ref<T>` / `handle<T>` / `buffer` / `buffer<N>` element types are forbidden | `ManagedArrayElementTypeNotAllowedError` |
| <a id="spawn-light-invalid-bounds"></a>`'spawn-light-invalid-bounds'` | `Error` (Result err) | PointLight / SpotLight spawn payload field out of documented bound (`.detail.field` narrows to `'range' \| 'innerOuter' \| 'outerNinety'`); fix the offending field at the spawn site | `SpawnLightInvalidBoundsError` |
| <a id="cardinality-exceeded"></a>`'cardinality-exceeded'` | `Error` (Result err) | component declared cardinality=N already present on N entities; despawn the extra carrier (canonical first consumer: `PointLightShadow` with cardinality=4) | `CardinalityExceededError` |
| <a id="resource-invalid-value"></a>`'resource-invalid-value'` | `Error` (Result err) | resource-setter bound violation; pass a value inside the documented range (canonical first consumer: `setTransparentSortConfig` mode in `{0, 1, 2}`) | `ResourceInvalidValueError` |
| <a id="sprite-animation-invalid"></a>`'sprite-animation-invalid'` | `Error` (Result err) | `spriteAnimationTickSystem` runtime invariant violated (e.g. frame index out of atlas range); fix the SpriteAnimation payload at the spawn site | `SpriteAnimationInvalidError` |
| <a id="relationship-self-cycle"></a>`'relationship-self-cycle'` | `Error` (Result err) | `addChild` / `reparent` would make an entity its own ancestor; pick a target outside the child's subtree | `RelationshipSelfCycleError` |
| <a id="relationship-mirror-component-not-registered"></a>`'relationship-mirror-component-not-registered'` | `Error` (Result err) | the mirror component name passed to `defineComponent` was not yet `defineComponent`'d; define the mirror component before the holder (see Define-order constraint above) | `RelationshipMirrorComponentNotRegisteredError` |
| <a id="relationship-mirror-field-type-mismatch"></a>`'relationship-mirror-field-type-mismatch'` | `Error` (Result err) | the mirror's reverse-list field is not exactly `'array<entity>'`; fix the mirror component schema | `RelationshipMirrorFieldTypeMismatchError` |
| <a id="relationship-detach-mismatch"></a>`'relationship-detach-mismatch'` | `Error` (Result err) | `removeChild` named a parent that is not the child's current parent; pass the actual parent or use `reparent` | `RelationshipDetachMismatchError` |
| <a id="query-descriptor-with-optional-conflict"></a>`'query-descriptor-with-optional-conflict'` | `Panic` | same component token in both `with` and `optional`; remove from one (`optional` means may-be-absent + no filter, `with` means always-present + filter — contradictory for the same token) | `QueryDescriptorOptionalConflictError` |
| <a id="remove-essential-component"></a>`'remove-essential-component'` | `Error` (Result err) | `world.removeComponent(e, Entity)` is structurally rejected — the Entity column is essential on every archetype; despawn the entity instead | `RemoveEssentialComponentError` |

> **Charter proposition 1 (single-entry surface) — discoverability**:
> Every name above is re-exported from `@forgeax/engine-ecs` (`packages/ecs/src/index.ts:322,328`). One `import { EcsErrorCode, ManagedRefReleasedError, ... } from '@forgeax/engine-ecs'` is enough — there is no second-best path. Enforced by the `pnpm grep:single-exit` gate (`packages/ecs/scripts/check-single-exit.mjs`).

## Component.toSchemaJSON() — offline manifest discoverability

`defineComponent(name, schema)` returns a frozen token whose `.schema` property **is** the manifest payload — the same string-keyed map the call site wrote, surviving every transform unchanged. The token also exposes a trivial `toSchemaJSON()` method (an alias for `JSON.stringify(this.schema)`) so AI users discover the manifest surface via IDE autocomplete on the token instead of having to remember the wrapping idiom:

```ts
const Mat = defineComponent('Mat', { albedo: 'ref<MaterialAsset>', count: 'u32' });
Mat.toSchemaJSON();
//   {"albedo":"ref<MaterialAsset>","count":"u32"}
JSON.stringify(Mat.schema); // identical output — both forms are interchangeable
```

Charter proposition 3: the schema is **statically extractable** without bundling the runtime — `grep -rn "defineComponent('" packages apps templates` lands every component plus its full schema map in one ripgrep pass. Build-time tooling (manifest dumpers, codegen) inspects `Component.schema` directly; no reflection API is needed. Tests `packages/ecs/src/__tests__/component.test.ts` + `packages/ecs/src/__tests__/component-schema-json.test.ts` (feat-20260515 / w29) lock the round-trip.

> **Offline manifest commitment (feat-20260515-buffer-array-vocab-collapse / plan-strategy §8.4)**: via `Component.toSchemaJSON()` (the `JSON.stringify(this.schema)` manifest payload), AI users perform **offline grep static analysis** in the repo root to discover which components use which `array<*>` / `buffer<*>` fields — no runtime startup, no reflection, no bundling required. A single ripgrep pass covers all four keyword shapes (`array<entity>` / `array<f32, 16>` / `buffer<16>` / `buffer`) at every declaration site. This is the concrete cash-out of charter proposition 1 (single-entry surface) + proposition 4 (text-over-image) for the feat-20260515 vocab collapse.

## Component.schema['<field>'] — runtime self-discovery

Charter proposition 4 (eager + lazy discoverability dual): the same `.schema` field that supports offline grep is also the runtime self-discovery surface. AI-user-authored debug code reads `Component.schema['<field>']` to ask "what keyword did this field declare?" without re-importing the source:

```ts
import { defineComponent } from '@forgeax/engine-ecs';
const C = defineComponent('C', { mat: 'ref<MaterialAsset>', dim: 'buffer<1024>' });
C.schema['mat'];  // 'ref<MaterialAsset>'  (literal-typed, not widened to string)
C.schema['dim'];  // 'buffer<1024>'
```

Inspection helpers (`isManagedRefField` / `isManagedBufferField` / `isEntityField` / `isSchemaVocabKeyword`, all re-exported from `@forgeax/engine-ecs`) accept plain `string` so the runtime release loop in `World` calls them on the erased runtime schema map without a cast — same probe surface for AI-user runtime code and engine-internal code (charter proposition 5: one consistent abstraction).

## Component reflection — three-layer read-only introspection (feat-20260602)

`defineComponent` now accepts a **field-descriptor object** form that aggregates `type` + `default` + field-level `meta` at each field declaration site. At registration time the engine pre-parses this input into **three read-only reflection layers** on the frozen component token. This eliminates the 12 scattered type-intrinsic structures (`FIELD_SIZE_BYTES` / `VIEW_CTORS` / `SUPPORTED_FIELD_TYPES` / `storageFieldType` / `isSchemaVocabKeyword` etc.) — all converged into one global `TYPE_METADATA` table.

### Input signature

```ts
import { defineComponent } from '@forgeax/engine-ecs';

const C = defineComponent('C', {
  x: { type: 'f32', default: 0, meta: { unit: 'm' } },
  tags: 'array<u32>',  // bare type keyword still accepted (flat form)
});
```

The second argument is a `FieldsInput` (map of field-name to `FieldSpec` — either a bare type keyword or a `FieldDescriptor { type, default?, meta? }` object). `meta` is an open namespace — the infra gives no key special meaning (OOS-1).

### Layer 1: `component.meta` — component-level open namespace

A `Record<string, unknown>` frozen map aggregating every field's `meta` sub-keys into a single component-level namespace. AI users read it to discover subsystem annotations without enumerating per-field sources:

```ts
const C = defineComponent('C', {
  x: { type: 'f32', meta: { unit: 'm' } },
  y: { type: 'f32', meta: { priority: 10 } },
});
C.meta.unit;      // 'm'
C.meta.priority;  // 10
C.meta.noSuchKey; // undefined (charter P3 — no silent default)
```

The infra **zero-interprets** any key — no special handling for `priority` / `blend` / etc. Downstream subsystems are expected to carve out their own key space via convention (e.g. prefix `volume.` / `blend.`), matching the `PackIndexEntry.metadata` "open namespace" precedent.

### Layer 2: `component.fields[fieldName]` — per-field pre-parsed reflection

A frozen `Record<fieldName, FieldReflection>` where each entry carries:

| Field | Type | Description |
|:--|:--|:--|
| `type` | `SchemaFieldType` | The field-type keyword (same as `component.schema[fieldName]`) |
| `default` | `unknown` (if present) | The layer-2 default value from the field descriptor |
| `arrayMeta` | `ArrayMeta` (if `array<...>` field) | Pre-parsed array metadata — parsed **once** at registration |

`ArrayMeta` shape (`{ elementType: ManagedArrayElementType, length?: number }`):

- `length` present => fixed-capacity (`array<T,N>`)
- `length === undefined` => variable-capacity (`array<T>`) — variable is **derived** from `length` absence, no `isVariable` / `kind` discriminant (D-A1 user ruling, architecture-principles.md #2 Derive)

```ts
const C = defineComponent('C', { v: 'array<f32, 3>' });
C.fields.v?.arrayMeta; // { elementType: 'f32', length: 3 }

// Pre-parsed reuse (AC-03c): same object reference across multiple reads
const a = C.fields.v?.arrayMeta;
const b = C.fields.v?.arrayMeta;
Object.is(a, b); // true — parse happens once at registration
```

`ElementBytes` / `variable` flag are intentionally **not stored** in `arrayMeta` — consumers derive them: `elementBytes` by looking up `TYPE_METADATA[arrayMeta.elementType].byteSize`; `variable` via `arrayMeta.length === undefined`.

### Layer 3: `TYPE_METADATA` — global per-type intrinsic table

A module-level frozen table (keyed by `SchemaFieldType`) converging the 12 former scattered structures into one multi-column map. Each row carries type-intrinsic properties:

| Column | Meaning | Example (`'f32'`) |
|:--|:--|:--|
| `byteSize` | Column storage width | 4 |
| `viewCtor` | TypedArray constructor | `Float32Array` (NB: actual ctor, not a string) |
| `storage` | Normalized storage-family keyword or `null` | `'f32'` |
| `isLegacyScalar` | From the 11-key `ScalarFieldType` set | `true` |
| `isManagedRef` | Routed through `ManagedRefStore` release | `false` |
| `isBuffer` | Routed through `BufferPool` release | `false` |
| `isEntityRef` | `entity` keyword | `false` |
| `isArray` | `array<...>` keyword family | `false` |
| `isVocabKeyword` | From `SchemaVocabKeyword` union | `false` |
| `fixedByteLength` | Fixed-`N` for `buffer<N>`, else `undefined` | `undefined` |

**Key granularity**: scalar family = one row per concrete type (11 rows: `f32` / `f64` / `i32` / `u32` / `i16` / `u16` / `i8` / `u8` / `bool` / `enum` / `ref`); vocab family = one row per family (6 rows: `entity` / `string` / `buffer` / `ref` / `handle` / `array`). Parametrized parameters (`<T>` / `<N>`) are not independent keys — they stay as `arrayMeta.elementType` / `TYPE_METADATA` column lookups.

```ts
import { TYPE_METADATA } from '@forgeax/engine-ecs';

TYPE_METADATA['f32'].byteSize;           // 4
TYPE_METADATA['f32'].viewCtor;           // Float32Array (constructor)
TYPE_METADATA['entity'].isEntityRef;     // true
TYPE_METADATA['array'].isArray;          // true
TYPE_METADATA['buffer'].fixedByteLength; // undefined (family-keyed table; the
                                         // `buffer<N>` byte count is per-field,
                                         // parsed into the field reflection, not a
                                         // per-type column — there is no
                                         // `'buffer<16>'` key)
```

### Naming disambiguation (AC-10)

Two distinct namespaces use the name `fields`:

| Context | Shape | Meaning |
|:--|:--|:--|
| `defineComponent(name, fields, ...)` — input parameter | `Record<string, FieldSpec>` | AI user writes field declarations here |
| `component.fields[fieldName]` — token property | `Record<string, FieldReflection>` | AI user reads pre-parsed reflection here |

Both are named `fields` but occupy **separate scopes** (parameter vs. property). IDE autocomplete and JSDoc distinguish them: "I write into `fields` at `defineComponent`; I read from `component.fields` on the token." No attribute-level name collision — `component.fields` is a property on the token, while the `defineComponent` parameter `fields` is a local argument at the call site.

## SceneInstance lifecycle — `detach*` vs `despawnScene`

> feat-20260608-scene-nesting-ecs-fication M3: the pre-feat
> world-scoped scene-instance container + `class SceneInstance` API was
> deleted; SceneInstance is now an ECS component (one row per instance,
> live on the synthetic root entity) and the World gains 8 verb-prefixed
> methods. Tearing an instance down has two distinct verbs — `detach*`
> (sever bookkeeping, keep entities) and `despawnScene` (truly destroy
> the entities). Picking the wrong one silently leaks entities or
> destroys data you meant to keep, so the split is explicit.

| Verb family | Calls `world.despawn`? | Entities after | Reversible? | Use when |
|:--|:--|:--|:--|:--|
| `detachSceneMember(root, member)` | no | stay alive in `world` | yes — `reattachSceneMember(root, member)` clears the tombstone | prefab-edit: promote spawned entities out of the instance and keep mutating them directly |
| `despawnDescendants(root)` | yes — on every entity reached by `ChildOf` | destroyed | no | drop the subtree but keep the synthetic root |
| `despawnScene(root)` | yes — `despawnDescendants(root) + world.despawn(root)` | all destroyed including synthetic root | no | tear the instance down for good and free its entities |

### Synthetic root invariant (D-V-0 / R2/F-7)

`world.instantiateScene(handle)` returns `{ root, diagnostics }` — `root` is a synthetic root `Entity` that
carries `SceneInstance{source, mapping, state}` and identity
`Transform`. The Transform attach is load-bearing — `propagateTransforms`
walks the `ChildOf` chain `meshRenderer -> ... -> syntheticRoot` through
the Transform liveMap and reports `RhiError(hierarchy-broken)` when a
parent in the chain lacks Transform. The same invariant applies to
*mount entities* (one per `SceneAsset.mounts[i]`); the runtime attaches
identity Transform to each mount entity (R2/B-1) so the chain `cube ->
innerSyntheticRoot -> mountEntity -> outerSyntheticRoot` resolves
cleanly without per-frame errors. AI users normally never observe these
intermediates — they read the synthetic root via `world.get(root,
SceneInstance)` and address members through `mapping[localId]`.

`diagnostics: readonly SceneInstantiateDiagnostic[]` is a structured array of unknown-field records. When a `.pack.json` carries a field name that no longer matches the registered component schema, that field is skipped (entity still spawns with known fields intact) and logged as a diagnostic entry `{ component, field, localId }`. This is production-observable (property-access, not NODE_ENV-gated) and covers the "stale field in old pack.json does not blank the entire 21-entity scene" studio scenario.

### 8 World methods

| Method | Signature | Effect |
|:--|:--|:--|
| `instantiateScene` | `(Handle<SceneAsset>, parent?: EntityHandle) => Result<{ root: EntityHandle; readonly diagnostics: readonly SceneInstantiateDiagnostic[] }, EcsError \| PackError>` | Materialise the SceneAsset; spawns 1 synthetic root + every entity / mount entity / nested member. Success returns `{ root, diagnostics }` — `root` is the synthetic root Entity, `diagnostics` is structured unknown-field records (property-access, production-observable). Unknown fields are skipped (do not abort the scene). |
| `despawnScene` | `(root: EntityHandle, opts?: { keepDetached?: boolean }) => Result<number, EcsError>` | `despawnDescendants(root) + world.despawn(root)`. Returns the count of destroyed entities. |
| `despawnDescendants` | `(root: EntityHandle, opts?: { keepDetached?: boolean }) => Result<number, EcsError>` | Walk `ChildOf` from `root` and despawn every descendant; root stays alive. Returns the count of destroyed entities. |
| `setSceneOverride` | `<S>(root: EntityHandle, member: EntityHandle, component: Component<S>, field: keyof ShapeOf<S>, value: unknown) => Result<void, EcsError>` | Layer-0 override — write through to the live entity column AND record the diff in `state.overrides`. `member` is the live Entity; `component` and `field` are typed via the component's schema. |
| `removeSceneOverride` | `<S>(root: EntityHandle, member: EntityHandle, component: Component<S>, field: keyof ShapeOf<S>) => Result<void, EcsError>` | Drop the diff and replay Layer 1 -> 2 -> 3 fallback. |
| `detachSceneMember` | `(root: EntityHandle, member: EntityHandle) => Result<void, EcsError>` | Soft tombstone — mark the member's LocalEntityId in `state.detachedLocalIds`. Does NOT call `world.despawn`. |
| `reattachSceneMember` | `(root: EntityHandle, member: EntityHandle) => Result<void, EcsError>` | Clear the tombstone. |
| `getSceneAssetForInstance` | `(root: EntityHandle) => Handle<SceneAsset> \| undefined` | Read the originating handle. Equivalent to `world.get(root, SceneInstance).value.source`. |

Read paths use the standard ECS query surface:
`world.queryRun([SceneInstance], rows => ...)` for active-instance scans;
`world.get(root, SceneInstance).value` for one-instance reads;
`world.getSceneInstanceState(root)` for the full state ref payload
(`overrides`, `detachedLocalIds`, `rootEntities`, `totalSlots`,
`mountTimeOverrides`).

### `despawnScene` destroy set

```
destroy set = every entity reachable from `root` via ChildOf
```

`despawnDescendants` walks the `ChildOf` graph rooted at `root` and
despawns every reached entity. `despawnScene` then calls
`world.despawn(root)` to drop the synthetic root itself. Detached
members (those marked in `state.detachedLocalIds` via
`detachSceneMember`) are still reachable through `ChildOf` *unless* the
caller explicitly broke the link — they are despawned by default, since
the soft-detach is bookkeeping-only and does not unwire the entity from
the hierarchy. To genuinely promote an entity out of the instance,
remove its `ChildOf` first (`world.removeComponent(member, ChildOf)`)
then call `detachSceneMember`.

### Known limitation — hand-attached orphans (OOS-1)

`despawnScene` walks `ChildOf` starting from the synthetic root, so
sub-entities a user hand-attached *underneath* a member entity ARE
descendants and ARE despawned by `despawnScene`. The pre-feat
limitation (where hand-attached entities sat outside the instance's
`mapping()` and leaked) is fixed by the ChildOf-walking destroy set.

### Runtime-facing reference

The runtime-facing pages — error-code attribution, mount-window
addressing rules, default-value 4-layer fallback, sample loop —
live in `packages/runtime/README.md` §SceneInstance.

## AI User affordance — charter proposition 1 / 4 / 5 alignment

Narrative evidence that the new vocabulary lands the [AI User Charter](../../.claude/skills/forgeax-closed-loop/agents/ai-user-charter.md) propositions in code, not in prose. Per `requirements.md §8.5`:

| Charter proposition | What it asks for | Where it lands in this loop | How to verify |
|:--|:--|:--|:--|
| **1. Single-entry surface** | One obvious import path; second-best paths are noise | `packages/ecs/src/index.ts` re-exports `Handle`, `SchemaFieldType`, `SchemaVocabKeyword`, `ManagedRefStore`, `EcsErrorCode`, `EcsErrorDetail`, `Name`, `TypedArrayFor`, plus all `EcsError` classes (the legacy `FixedArrayView<T>` / `VarArrayView<T>` value-shape exports were deleted by feat-20260515-buffer-array-vocab-collapse — array fields now resolve to `TypedArrayFor<T>` read-only snapshots, mutations route through `world.push` / `world.pop` / `world.capacity`; the same-day feat-20260515-string-managed-collapse deleted `StringView` + `isStringField` — `'string'` materialises as a native JS `string` by reference) — single ripgrep + 1-screen Schema vocabulary quick-ref + Array / buffer field access section cover the full vocab (progressive disclosure: scan the table, drill in only when needed) | `pnpm grep:single-exit` (`packages/ecs/scripts/check-single-exit.mjs`) gates re-exports of these symbols from any non-ecs package |
| **4. Explicit failure boundaries (eager + lazy)** | Errors are structured (data, not messages); cross-mode + cross-shape + cross-element-type misuse refused at compile time, not runtime | `packages/ecs/src/errors.ts` — every error class carries `.code` (string-literal type member of `EcsErrorCode`), `.hint` (programmatic), `.detail` (discriminated by `.code` via `EcsErrorDetail`); compile-time refusal in `packages/ecs/src/__tests__/handle.test-d.ts` (cross-mode + cross-target rejection) + `packages/ecs/src/__tests__/managed-array-view.test-d.ts` (cross-shape + cross-element-type rejection) + `packages/ecs/src/__tests__/component-schema.test-d.ts` + `packages/ecs/src/__tests__/managed-array-element-type.test.ts` (`array<string>` rejection — string vocab does not nest into the array vocab; compile-time + runtime lock via `managed-array-element-type-not-allowed`); runtime AC-05 coverage routes the 4 collapsed-vocab capacity codes (`fixed-size-mismatch` / `fixed-array-overflow` / `array-pop-empty` / `instance-transforms-stride-mismatch`) through Layer-3 ErrorRouter; `'string'` allocation / release error paths reuse the existing `managed-ref-released` / `managed-ref-double-release` envelopes (collapsed onto the managed-ref dispatch — no new error code) | `pnpm test --filter @forgeax/engine-ecs` runs the full RED→GREEN suite; `tsc -b` runs the compile-time tests |
| **5. Consistent abstraction across the family** | Same syntax for related concepts; learning one teaches all | The schema vocab keywords share template-literal string syntax — `ref<T>`, `handle<T>`, `buffer`, `buffer<N>`, `entity`, `array<T,N>`, `array<T>`, `string` (`packages/ecs/src/component.ts`); `array<T,N>` stores elements inline (stride-N column, feat-20260602) while `array<T>` keeps the BufferPool slot column — both resolve to the same `TypedArrayFor<T>` read shape; `'string'` shares the `ManagedRefStore` u32-handle column with `ref<T>` and materialises by reference as a native JS `string` (collapsed onto managed-ref dispatch, no view-class wrapper); two handle modes share the `Handle<TargetTag, Mode>` phantom-tag form (`packages/ecs/src/handle.ts`); `Result<T, E>` shape is identical to `@forgeax/engine-rhi` (see Evolution log row 2026-05-11 above) | Quick-ref table in §Schema vocabulary above; `Handle` cross-mode safety test cited in column 3 |

Counter-examples actively rejected by this loop (so the table above is load-bearing, not aspirational):

- ✗ Splitting the vocab keywords into `'managed-ref'` / `'managed-buffer'` constant exports + a separate `'unmanaged-ref'` keyword — would force AI users to import three names, breaking proposition 1
- ✗ Throwing a plain `Error` from `ManagedRefStore.release` on double-release — string `.message` is unparseable; structured `.code = 'managed-ref-double-release'` + narrowed `.detail` is the form
- ✗ Keeping `'entity[]'` and `array<entity>` as parallel keywords — would split AI users between two equivalent paths; proposition 5 (consistency) is enforced by deleting the legacy syntax in one cut (gate `pnpm grep:no-entity-array-literal`)
- ✗ Letting `Instances.transforms` keep the `buffer: 'ref'` legacy keyword + carry a `Handle<InstancedBufferAsset>` — the AssetRegistry triplet (`createInstancedBuffer` / `updateInstancedBuffer` / `getInstancedGpuBuffer`) splits the per-entity transform lifecycle from the ECS entity; the array vocab folds it back into the BufferPool 3-path release (gate `pnpm grep:asset-registry-instanced-removed`)
- ✗ Adding a new `string-capacity-exceeded` error code parallel to the managed-ref envelopes for `'string'` overflow — would split AI users' exhaustive switches across two codes meaning the same thing (handle release / re-acquire). The collapse onto managed-ref dispatch routes through `managed-ref-released` / `managed-ref-double-release`; `EcsErrorCode` count holds at 23

### AI User affordance — Name + string vocab alignment

The `'string'` schema vocab + `Name` component land charter propositions 1 / 4 / 5 with the same shape as the `array<T>` family — three propositions, three concrete cash-outs:

| Proposition | What `'string'` + `Name` deliver | Verify |
|:--|:--|:--|
| **1. Single-entry surface** | `import { Name } from '@forgeax/engine-ecs'` is the only path; `Name.schema.value === 'string'` is the canonical literal AI users grep with `rg "'string'" packages/ecs/src` to find the keyword + `rg "Name { value:" packages apps templates` to find every component declaration site. The read shape is a native JS `string` (no view-class import required) | `pnpm grep:single-exit` (`Name` in `GATED_SYMBOLS`); `node scripts/grep/check-readme-string-vocab-mentioned.mjs` (reverse-coupling discoverability gate); `pnpm grep:no-string-view-import` + `pnpm grep:no-set-managed-ref-store` (freeze gates against re-introducing the deleted symbols) |
| **4. Explicit failure boundaries (eager + lazy)** | Eager: `defineComponent('Bad', { items: 'array<string>' as const })` is a TS error (`array<string>` element type rejected at compile time — `string` vocab does not nest). Lazy: `world.set` on a stale entity routes `stale-entity` (Result err); `ManagedRefStore` double-release routes `managed-ref-double-release`; `world.push` past `array<T,N>` capacity routes `fixed-array-overflow`; AI users branch on `r.error.code` not `r.error.message` | `packages/ecs/src/__tests__/component-schema.test-d.ts` + `packages/ecs/src/__tests__/managed-array-element-type.test.ts` (compile-time + runtime refusal of `array<string>`); `packages/ecs/src/__tests__/string-release.test.ts` (release contract) |
| **5. Consistent abstraction across the family** | `'string'` is a vocab keyword in the same `SchemaVocabKeyword` closed union as `'entity'` / `array<T>` / `ref<T>` etc.; `'string'` shares the `ManagedRefStore` u32-handle column with `ref<T>` (one storage path, one dispatch arm via `isManagedField`); the read materialises by reference as a native JS `string` — no view class is needed because the runtime owns the payload by reference. Array fields share the `TypedArrayFor<T>` snapshot contract instead of a view-class (post-buffer-array-vocab-collapse) | `packages/ecs/src/world.ts` release loop branches uniformly on `isManagedField` / `isManagedBufferField` / `isManagedArrayField` (managed-family arm collapses 'string' + 'ref<T>' into one branch) |

### Code-site anchors (proposition -> file:line)

The table above resolves to plain ripgrep targets. AI users running `rg <symbol> packages/ecs/src` should land directly on the referenced lines without intermediate documentation hops.

| Proposition | Anchor | What lives there |
|:--|:--|:--|
| 1 — single-entry | `packages/ecs/src/index.ts` | Re-export blocks: `Result` + `EcsError`, `SchemaFieldType` + `SchemaVocabKeyword`, `Handle`, `ManagedRefStore`, entity utilities, component internals, schedule layer, `EcsErrorCode` + `EcsErrorDetail`, all error classes (managed-ref + managed-buffer + collapsed-vocab capacity families), `Name`, `TypedArrayFor`, entity constants. The legacy `FixedArrayView` + `VarArrayView` re-exports were deleted by feat-20260515-buffer-array-vocab-collapse — array fields read through `TypedArrayFor<T>` snapshots and write through `world.push` / `world.pop` / `world.capacity`. The `StringView` + `isStringField` re-exports were deleted same-day by feat-20260515-string-managed-collapse — `'string'` materialises as a native JS `string` |
| 1 — gate | `packages/ecs/scripts/check-single-exit.mjs` | `GATED_SYMBOLS = ['Handle', 'SchemaFieldType', 'ManagedRefStore', 'EcsErrorCode', 'EcsErrorDetail', 'EcsError', 'Name', 'TypedArrayFor']` (the legacy `FixedArrayView` / `VarArrayView` entries were dropped by feat-20260515-buffer-array-vocab-collapse when the view classes were physically deleted; `StringView` + `isStringField` were dropped by feat-20260515-string-managed-collapse) |
| 1 — README discoverability gate | `scripts/grep/check-readme-string-vocab-mentioned.mjs` | Reverse-coupling check: `'string'` literal + `Name { value:` schema literal must surface in `packages/ecs/README.md` (mirrors `check-readme-array-vocab-mentioned.mjs`; `StringView` literal dropped by feat-20260515-string-managed-collapse) |
| 4 — eager (compile-time refusal) | `packages/ecs/src/__tests__/handle.test-d.ts` + `packages/ecs/src/__tests__/managed-array-view.test-d.ts` + `packages/ecs/src/__tests__/component-schema.test-d.ts` + `packages/ecs/src/__tests__/managed-array-element-type.test.ts` | `@ts-expect-error` clauses: plain-number widening / managed -> unmanaged / unmanaged -> managed / cross-target / cross-shape `array<T,N>` vs `array<T>` / cross-element-type; runtime: `array<string>` rejection (string vocab does not nest into array vocab) |
| 4 — lazy (runtime structured failure) | `packages/ecs/src/errors.ts` | `EcsErrorCode` closed union (23 members: 18 base + 1 `managed-array-element-type-not-allowed` + 3 collapsed-vocab capacity codes `fixed-size-mismatch` / `fixed-array-overflow` / `array-pop-empty` + 1 `instance-transforms-stride-mismatch`) + `EcsErrorDetail` discriminated map; `'string'` allocation / release errors reuse `managed-ref-released` / `managed-ref-double-release` (collapsed onto managed-ref dispatch) — count holds at 23 |
| 4 — exhaustive consumption | `packages/ecs/src/errors.ts` (every class declares `readonly code` as a `'literal' as const`) | `switch (err.code)` is exhaustive against `EcsErrorCode`; `assertNever(code)` catches future additions at compile time |
| 5 — keyword family syntax | `packages/ecs/src/component.ts` | `SchemaVocabKeyword = '...buffer' \| 'buffer<${N}>' \| 'ref<${string}>' \| 'handle<${string}>' \| 'entity' \| 'array<${T},${N}>' \| 'array<${T}>' \| 'string'` (template-literal family; `'buffer'` + `'buffer<N>'` are the angle-bracket-aligned vocab after feat-20260515 collapse — legacy `'buffer:N'` literal removed) |
| 5 — handle two-axis brand | `packages/ecs/src/handle.ts` | `Handle<TargetTag, Mode>` phantom tag — same form for `'managed'` and `'unmanaged'`; cross-mode is a TS error, not a runtime check |
| 5 — array snapshot + 3 commands | `packages/ecs/src/world.ts` | `world.get(e, C).<arrayField>` returns `TypedArrayFor<T>` read-only snapshot; `world.push(e, C, 'f', v)` / `world.pop(e, C, 'f')` / `world.capacity(e, C, 'f')` are the three element-granular commands. The legacy `FixedArrayView<T>` / `VarArrayView<T>` value-shape view classes were physically deleted by feat-20260515-buffer-array-vocab-collapse (`packages/ecs/src/managed-array-view.ts` removed); fixed `array<T,N>` columns store elements inline (stride-N, feat-20260602), variable `array<T>` columns carry a BufferPool slot id via a u32 column |
| 5 — string by reference | `packages/ecs/src/world.ts` (managed-ref dispatch arms) | `'string'` materialises by reference as a native JS `string` via `managedRefs.resolve(handle).unwrap()` — same `ManagedRefStore` storage column as `ref<T>`, no view-class wrapper. The `StringView` class was deleted in same-day collapse (feat-20260515-string-managed-collapse) |
| 5 — Result shape parity | `packages/ecs/README.md` Evolution log row 2026-05-11 | `Result<T, E>` `.ok` / `.value` / `.error` byte-for-byte aligned with `@forgeax/engine-rhi` |

### TLDR for AI users (30 seconds)

> [!TIP]
> **One import**: `import { defineComponent, World, Handle, ManagedRefStore, Name, TypedArrayFor, EcsErrorCode, ... } from '@forgeax/engine-ecs'`. Re-exporting any of these from another package is a CI failure (`pnpm grep:single-exit`). Array fields no longer expose view classes — read via `world.get(e, C).<arrayField>` (`TypedArrayFor<T>` read-only snapshot), write via `world.push` / `world.pop` / `world.capacity`. `'string'` materialises as a native JS `string` (no view class).
>
> **One schema syntax** for managed resources: `'ref<T>'` (managed handle, ECS releases), `'handle<T>'` (unmanaged, you release), `'buffer'` (variable byte slot), `'buffer<N>'` (fixed N-byte slot, contract — was `'buffer:N'` hint pre-feat-20260515), `'entity'` (raw entity ref; liveness probe via `world.get(ref, Entity)` returns `err(STALE_ENTITY)` for despawned handles), `'array<T,N>'` (fixed-length view), `'array<T>'` (variable-length view), `'string'` (managed JS string by reference). All template-literal strings, all surfaced through `SchemaFieldType`. The legacy `'entity[]'` syntax is retired one-cut by `'array<entity>'`; the legacy `'buffer:N'` syntax is retired one-cut by `'buffer<N>'` (feat-20260515-buffer-array-vocab-collapse).
>
> **One error shape**: `Result<T, EcsError>` everywhere; `if (!r.ok) switch (r.error.code) { ... }`. `r.error.code` is a literal type member of `EcsErrorCode` (23 codes: 18 base + `managed-array-element-type-not-allowed` + 3 collapsed-vocab capacity codes + 1 `instance-transforms-stride-mismatch`); `r.error.detail` is narrowed per code via `EcsErrorDetail`. Programmatic recovery without parsing strings. The `'string'` allocation / release errors reuse `managed-ref-released` / `managed-ref-double-release` (collapsed onto managed-ref dispatch) — count holds at 23.
>
> **One thing this loop does change**: `Name { value: 'string' }` ships as a single-field component exemplar; `'string'` materialises by reference as a native JS `string` on top of the `ManagedRefStore` u32-handle column shared with `ref<T>` (one storage cash-out, one dispatch arm). The legacy `FixedArrayView<T>` / `VarArrayView<T>` value-shape classes were physically deleted by feat-20260515-buffer-array-vocab-collapse (array fields read via `TypedArrayFor<T>` snapshots, write via `world.push` / `world.pop` / `world.capacity`); the `StringView` class was deleted same-day by feat-20260515-string-managed-collapse. Cross-cuts gated by `pnpm grep:single-exit` (`Name` / `TypedArrayFor`) + `node scripts/grep/check-readme-string-vocab-mentioned.mjs` + freeze gates `pnpm grep:no-string-view-import` + `pnpm grep:no-set-managed-ref-store` + `pnpm grep:no-managed-array-view-import` + `pnpm grep:no-array-stride-option` + `pnpm grep:no-buffer-colon-keyword` + `pnpm grep:no-managed-array-error-code`.

## Dangling entity refs are the consumer's responsibility

> [!IMPORTANT]
> **The ECS does not back-stop dangling `'entity'` refs.** `world.get(e, C)` decodes an `'entity'` field by returning the raw u32 verbatim — it does **not** validate that the referenced entity is still alive, and it never mutates your component to "clean up" a stale ref. Liveness is the consumer's job: check with `world.get(ref, Entity)` (the universal liveness probe — returns `err(STALE_ENTITY)` for despawned handles), carry your own generation, or design so a stale ref cannot arise. ECS-level read-time validation was removed deliberately (feat-20260602-drop-entity-dangling-sweep) — it cost a per-read sweep on a path most consumers do not need.

Earlier versions exposed an `onDangling: 'clear' | 'remove'` option plus two error codes (`entity-dangling-cleared` / `entity-dangling-component-removed`) that `world.get` raised when it noticed a dead ref. Both the option and the codes are gone. Earlier versions also provided `world.isAlive(e)` as a standalone liveness method; that was deleted in feat-20260602-archetype-stores-full-packed-entity — the universal `world.get(e, Entity)` probe replaces it. Migrate the catch into an explicit liveness self-check:

```ts
// Before — relied on the ECS to sweep dead refs on read:
const r = world.get(child, ChildOf);
if (!r.ok) {
  switch (r.error.code) {
    case 'entity-dangling-cleared':
    case 'entity-dangling-component-removed':
      respawnParentAndReattach();
      break;
    // ...
  }
}

// After — the ECS returns the raw ref; you decide what a dead parent means:
const r = world.get(child, ChildOf);
if (r.ok) {
  const parent = r.value.parent;
  const probe = world.get(parent, Entity);
  if (!probe.ok) {
    // probe.error.code === 'stale-entity'
    // your policy: re-parent, despawn the child, skip it, etc.
    world.removeComponent(child, ChildOf);
  }
}
```

Self-help affordances for stale refs:

- **`world.get(ref, Entity)`** — the universal liveness probe (replaces the deleted `world.isAlive`); call it at the exact point you are about to dereference, not eagerly across the whole world. Returns `Result<{ self: EntityHandle }, EcsError>` — check `.ok`, or branch on `r.error.code === 'stale-entity'`.
- **Relationship `onRemove` hook** — for relationship components like `ChildOf`, despawning the *child* auto-removes it from the parent's `Children` mirror list (the reverse direction is maintained for you). Despawning the *parent* does **not** cascade (Bevy-aligned: removing a parent does not destroy its children) — if you want recursive teardown, set `linkedSpawn: true` on the relationship or despawn the subtree yourself.
- **`'stale-entity'`** — write APIs that take an entity argument still fail-fast with this `EcsErrorCode` when handed a dead entity, so an accidental stale write surfaces structurally rather than corrupting data silently.
- **`remove-essential-component`** — `world.removeComponent(e, Entity)` returns this structured error (the Entity column is structurally required on every archetype); despawn the entity instead if you want to retire it.

## Managed handles are operational, not persistent

> [!IMPORTANT]
> A `Handle<T, 'managed'>` returned by `world.allocManagedRef(...)` (or installed implicitly through a `ref<T>` schema field) is valid **only until the next release-edge of its holder**. Caching one across that edge is undefined behavior — the ECS does **not** detect a stale managed handle at runtime, and the typed runtime surface deliberately has no `'managed-ref-stale-slot'` arm.

**Release edges** (the moments a managed handle stops being valid):

| Edge | Trigger |
|:--|:--|
| `world.despawn(e)` | The holder entity is gone; every `ref<T>` field on it releases. |
| `world.removeComponent(e, C)` | Only `C`'s `ref<T>` fields release; other components on `e` are unaffected. |
| `world.set(e, C, { ... })` overwrite of a `ref<T>` field | Replacing a managed value releases the prior payload **before** installing the new one. |

**Consequences AI users must internalise:**

- **Do not stash a managed handle in a long-lived JS variable** that outlives the holder entity / component / field write. Read it through `world.get(e, C).<refField>` at the point of use.
- **Stale resolve is silent.** If the handle's underlying slot has been re-allocated (a fresh `allocManagedRef` reusing the freed slot), `world.get` returns the **new** payload — by design. `'managed-ref-released'` only fires when the slot is currently free; it is **not** a stale-cache detector. Treat managed handles like Rust borrows: their lifetime is enforced at the type / lifecycle layer (`Handle<T, 'managed'>` brand + ECS hooks), not by runtime tracking.
- **Double-release is detected by payload-presence**, not by a generation tag — `'managed-ref-double-release'` (`EcsErrorCode`) surfaces when `release` runs against a slot whose payload is already gone and the slot has not yet been re-allocated.
- **Throwing `onRelease` is throw-safe.** When a release-edge fires the `onRelease` callback registered at `allocManagedRef`, the slot's bookkeeping (callback table + payload map + freelist) is cleared **before** the callback runs. A throwing `onRelease` therefore re-propagates from the first `release` cleanly — the store is already consistent, and a second `release` of the same handle returns `'managed-ref-double-release'` as expected. Do not wrap the call in `try/finally` "to be safe"; the ECS already does it for you (plan-strategy D-1; AC-01/02).

**Why no generation tag?** Adding a per-slot generation counter to `ManagedRefStore` would let the runtime distinguish "stale-by-reuse" from "live re-alloc", but:

- Detection without prevention is a half-measure: the type system + lifecycle hooks already make the correct usage shape easy to spot in code review and AI inspection.
- A generation tag on a 24-bit slot index forces a roll-over policy, which adds a "permanently retired slot" failure mode under heavy churn — a regression the M3 deletion explicitly removes (see `docs/specs/2026-06-14-ecs-managed-lifecycle-ssot-design.md` §3.3).
- Concept compression (AGENTS.md §Design axiom): one less moving part for every reader of `world.get(e, C)`.

### BufferPool — slot id never escapes

`BufferPool` (the backing store for `buffer:<bytes>` schema-vocab fields) follows the same operational-not-persistent contract, with one tightening: **the slot `id` returned by `pool.alloc(byteLength)` never escapes the ECS internals.** There is no public `Handle<Buffer>` surface today; archetype columns store the `id` as u32 and `world.get(e, C).<bufferField>` rebinds the live `Uint8Array` view through `pool.view(id)` at the point of access (no caller-facing caching).

Because of that, `BufferPool` carries no generation tag and `BufferPool.prototype.release` is typed `Result<void, never>` — there is no error arm and the type contract is locked at compile time by `packages/ecs/src/__tests__/buffer-pool.test-d.ts`. If a future feature adds a public `Handle<Buffer>` surface, the no-gen-tag design **must be re-debated** — silent slot re-use is only safe while the holder is a single ECS field, not a free-floating cache (see requirements-decisions q4 / q5).

> [!NOTE]
> **Deeper design rationale:** [`docs/specs/2026-06-14-ecs-managed-lifecycle-ssot-design.md`](../../docs/specs/2026-06-14-ecs-managed-lifecycle-ssot-design.md) §3.3 — covers the choice of payload-presence detection over generation tags, the relationship to `Handle<T, 'managed'>` typing, and the carry-over invariant that lets archetype migrate move row indices without invalidating wrapper identity.
