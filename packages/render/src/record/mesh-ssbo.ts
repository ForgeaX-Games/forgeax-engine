import { mat3 } from '@forgeax/engine-math';
import { type BindGroup, type Buffer, RhiError, type RhiQueue } from '@forgeax/engine-rhi';
import type { DispatchEntry } from '../render-system-extract';
import {
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_Z,
  type TransparentSortConfig,
} from '../systems/transparent-sort-config';
import type { ValidatedRenderable } from './frame-snapshot';

/**
 * Stride between per-renderable `entity_world` mat4 slots inside the
 * shared `pipelineState.meshStorageBuffer`. The 256-byte alignment is
 * required because the storage buffer is bound with
 * `hasDynamicOffset: true` and WebGPU spec
 * `minStorageBufferOffsetAlignment` defaults to 256.
 */
export const MESH_PER_ENTITY_STRIDE = 256;

// The storage-buffer Mesh struct also carries the temporal previous transform
// and reactive metadata when STORAGE_BUFFER_AVAILABLE is true:
// mat4 (64 B) + mat3 (48 B) + previous mat4 (64 B) + vec4 (16 B) = 192 B.
// The BindGroup entry's `size` must cover the complete reflected struct, not
// only the first world transform and normal matrix.
export const MESH_SSBO_BYTES = 192;

// bug-20260610: WebGL2 fallback shader declares `array<Mesh, 128>` as a
// uniform buffer; binding must cover the full array size. The storage
// variant binds a single 112-B slot via dynamic offset, but the uniform
// variant requires the whole 14336-B range visible to the shader.
export const MESH_UBO_FULL_ARRAY_BYTES = 112 * 128;

// bug-20260723-webgl2-instancing-uniform-range: the WebGL2 fallback shader
// declares `array<InstanceData, 128>` in the instances bind group. Even when
// a draw carries fewer transforms, the buffer binding must expose the full
// array range or wgpu rejects the draw at submit time with a late
// min-binding-size mismatch.
export const INSTANCE_UBO_FULL_ARRAY_BYTES = 80 * 128;

export const MAX_UNIFORM_INSTANCES = 128;

/** The storage-backed InstanceData layout is current + previous mat4. */
export const INSTANCE_STORAGE_STRIDE_FLOATS = 32;

/**
 * Project the ECS transform snapshot into the storage-backed InstanceData
 * layout. The extract contract carries one current mat4 per instance; until
 * the ECS snapshot owns a previous-instance column, current is the honest
 * previous value as well. Uniform-backed variants keep the compact 16-float
 * payload and do not use this projection.
 */
export function packInstanceStorageBuffer(transforms: Float32Array): Float32Array {
  const count = Math.floor(transforms.length / 16);
  const out = new Float32Array(count * INSTANCE_STORAGE_STRIDE_FLOATS);
  for (let i = 0; i < count; i++) {
    const sourceBase = i * 16;
    const targetBase = i * INSTANCE_STORAGE_STRIDE_FLOATS;
    for (let k = 0; k < 16; k++) {
      const value = transforms[sourceBase + k] ?? 0;
      out[targetBase + k] = value;
      out[targetBase + 16 + k] = value;
    }
  }
  return out;
}

/**
 * M3 / w12: extracts the underlying GPU resource object from a bind
 * group entry descriptor. Returns the raw object reference (Buffer,
 * TextureView, or Sampler) usable as a WeakMap chain key.
 */
export function extractEntryResourceHandle(entry: {
  resource: { kind: string; value: unknown };
}): object {
  const v = entry.resource.value;
  if (typeof v === 'object' && v !== null && 'buffer' in (v as Record<string, unknown>)) {
    return (v as { buffer: object }).buffer;
  }
  return v as object;
}

/**
 * feat-20260622-handle-to-id-allocator-elimination M2 / w7: walks a nested
 * WeakMap chain to find or create a BindGroup leaf. Each handle in the
 * `handles` array is a chain node; the final leaf is a Map<string, BindGroup>
 * keyed by `variant` (D-2). Chain keys are always object references, never
 * numeric ids — GC reclaims entries for dead handles automatically.
 *
 * On cache hit returns the cached BindGroup. On miss calls `factory`,
 * bumps `bindGroupCounts.createBindGroup`, stores the result at the leaf,
 * and returns it. Hit/miss accounting is observable via `bindGroupCounts`
 * (D-8: the skin probe reads `counts.createBindGroup` delta).
 */
export function getOrCreateFromChain(
  root: WeakMap<object, unknown>,
  handles: readonly object[],
  variant: string,
  factory: () => BindGroup,
  counts: { createBindGroup: number; keys: string[] },
): BindGroup {
  let node = root;
  for (let i = 0; i < handles.length - 1; i++) {
    // biome-ignore lint/style/noNonNullAssertion: handles length guards the index
    const h = handles[i]!;
    let next = node.get(h) as WeakMap<object, unknown> | undefined;
    if (next === undefined) {
      next = new WeakMap();
      node.set(h, next);
    }
    node = next;
  }
  // biome-ignore lint/style/noNonNullAssertion: known non-empty at call sites
  const last = handles[handles.length - 1]!;
  let leaf = node.get(last) as Map<string, BindGroup> | undefined;
  if (leaf === undefined) {
    leaf = new Map();
    node.set(last, leaf);
  }
  const hit = leaf.get(variant);
  if (hit !== undefined) return hit;
  const bg = factory();
  counts.createBindGroup += 1;
  counts.keys.push(variant);
  leaf.set(variant, bg);
  return bg;
}

/**
 * feat-20260622-handle-to-id-allocator-elimination M2 / w8: per-entity bind
 * group lookup-or-create helper (D-2). Two-step lookup: outer Map.get(outerKey)
 * finds or lazily creates an inner WeakMap chain, then delegates to
 * `getOrCreateFromChain` for the chain walk. outerKey is `string | number`
 * to cover both per-entity (number entityKey) and material-shared
 * (string shaderId) caches (D-1 / OQ-1).
 */
export function getOrCreatePerEntity(
  outerMap: Map<string | number, WeakMap<object, unknown>>,
  outerKey: string | number,
  handles: readonly object[],
  variant: string,
  factory: () => BindGroup,
  counts: { createBindGroup: number; keys: string[] },
): BindGroup {
  let inner = outerMap.get(outerKey) as WeakMap<object, unknown> | undefined;
  if (inner === undefined) {
    inner = new WeakMap();
    outerMap.set(outerKey, inner);
  }
  return getOrCreateFromChain(inner, handles, variant, factory, counts);
}

/**
 * feat-20260622-handle-to-id-allocator-elimination M2 / w8: evicts per-entity
 * cache entries whose entityKey is not in the validated set. Works on
 * Map<entityKey, WeakMap<handle, BindGroup>> by iterating the outer Map keys
 * and deleting entries for which validatedEntityKeys.has(ek) is false.
 * No string parsing, no Number / Number.isNaN — the entityKey is already a
 * number (D-1 / RD4).
 *
 * @internal — exported for unit test access (AC-08)
 */
export function cleanPerEntityCache(
  cache: Map<number, WeakMap<object, unknown>>,
  validatedEntityKeys: Set<number>,
): void {
  for (const ek of cache.keys()) {
    if (!validatedEntityKeys.has(ek)) {
      cache.delete(ek);
    }
  }
}

/**
 * feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
 * record-stage entry-point hook to the closure-scoped mesh-SSBO grow
 * controller (createRenderer.ts). Called once per frame, after
 * `validatedOrdered` has been finalised and BEFORE the first per-entity
 * `queue.writeBuffer`. Returns Result-like (never throws — D-5):
 *
 *  - `{ ok: true }`       — slotCount already covers `neededSlots` (idempotent
 *                           short-circuit), or the controller successfully grew
 *                           in this call. Caller proceeds with the frame.
 *  - `{ ok: false, code, degradedToSlotCount }` — controller hit ceiling /
 *                           capacity and ALREADY fired the structured error
 *                           via errorRegistry.  Caller truncates the draw
 *                           list to the largest complete entity prefix that
 *                           fits within `degradedToSlotCount` slots (graceful
 *                           degradation per plan-strategy D-2): renders the
 *                           subset that fits, discards overflow, no black
 *                           frame.
 *
 * This helper does NOT re-fire on `ok:false` — the controller is the single
 * fire site (createRenderer.ts grow factory), so callers see exactly one
 * structured error per ceiling event (charter P3 explicit failure: no
 * double-fire).
 *
 * Dev-mode visibility: when grow actually grew (slotCount transition) AND
 * `import.meta.env?.DEV` is truthy, a single `console.info('[mesh-ssbo] ...')`
 * line reports the before / after / requested counts. The optional-chain
 * keeps non-vite envs (dawn-node smoke, plain tsup tests) silent —
 * `import.meta.env` is undefined there, the chain short-circuits to
 * undefined, the if-guard is falsy (AC-11 + plan-strategy §2.D-3).
 *
 * Bind-group cache invalidation is automatic: on grow, the controller
 * mutates `meshSsboState.mesh.buffer` / `.material.buffer` in place
 * (wrapper-object identity preserved, inner buffer replaced — research §F8).
 * Downstream the fresh inner buffer object is a new WeakMap chain key, so
 * `getOrCreateFromChain` misses and rebuilds the BindGroup on the next frame
 * (AC-07; T-M3-03 (a) test).
 *
 * @internal — exported for unit-test access (`mesh-ssbo-grow.test.ts`
 * T-M3-01 / T-M3-02 / T-M3-03 cover idempotency, ceiling, dev info).
 */
export function ensureMeshSsboCapacity(
  internals: {
    readonly growMeshSsbo?:
      | ((neededSlots: number) =>
          | { readonly ok: true }
          | {
              readonly ok: false;
              readonly code: 'mesh-ssbo-ceiling-reached' | 'mesh-ssbo-capacity-exceeded';
              readonly degradedToSlotCount: number;
            })
      | undefined;
    readonly meshSsboState?: { readonly slotCount: number } | undefined;
  },
  neededSlots: number,
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'mesh-ssbo-ceiling-reached' | 'mesh-ssbo-capacity-exceeded';
      readonly degradedToSlotCount: number;
    } {
  // Empty scene / no controller wired (legacy / test fixture path).
  if (neededSlots <= 0) return { ok: true };
  const grow = internals.growMeshSsbo;
  if (grow === undefined) return { ok: true };
  // Idempotent guard — current slotCount already covers neededSlots.
  // The controller's own internal guard catches this too, but bailing here
  // skips the spy / tracing overhead and matches the AC-09 contract that
  // grow runs at most once per frame transition.
  const before = internals.meshSsboState?.slotCount ?? 0;
  if (before > 0 && before >= neededSlots) return { ok: true };
  const result = grow(neededSlots);
  // Note: ok:false has already fired the structured error inside the
  // controller (createRenderer.ts grow factory). Do NOT double-fire here.
  if (!result.ok) return result;
  // Dev-mode visibility — only on a real slotCount transition (skip
  // no-op idempotent paths above; ceiling path returned early on ok:false).
  const after = internals.meshSsboState?.slotCount ?? before;
  if (after !== before) {
    // Module-local binding read (NOT `recordModule.devModeProbe`) so vitest
    // ESM-readonly export forced us to expose the probe as a settable holder
    // (`setMeshSsboDevModeProbeForTests`) instead of a `vi.spyOn` target.
    if (meshSsboDevModeProbe()) {
      // biome-ignore lint/suspicious/noConsole: AC-11 mandates a `[mesh-ssbo]` info line in dev mode (vite build dead-strips this branch via the `import.meta.env.DEV` constant fold; tsup / esbuild prod sets NODE_ENV=production).
      console.info(
        '[mesh-ssbo] grew slotCount: %d -> %d (requested=%d)',
        before,
        after,
        neededSlots,
      );
    }
  }
  return result;
}

/**
 * Test seam: a closure-local function pointer ensureMeshSsboCapacity reads
 * for the dev-mode gate. Defaults to `isMeshSsboDevMode`; tests swap it out
 * via `setMeshSsboDevModeProbeForTests` because vitest 4.x export bindings
 * are non-writable (ESM spec) and `import.meta.env.DEV` is build-time-frozen
 * by the vite transform — neither `vi.spyOn(recordModule, 'isMeshSsboDevMode')`
 * nor `vi.stubEnv('DEV', false)` toggles it at runtime.
 */
let meshSsboDevModeProbe: () => boolean = isMeshSsboDevMode;

/**
 * @internal — test-only injection seam for `ensureMeshSsboCapacity`'s
 * dev-mode gate. Pass `undefined` to restore the production probe
 * (`isMeshSsboDevMode`). Production code paths NEVER call this.
 */
export function setMeshSsboDevModeProbeForTests(probe: (() => boolean) | undefined): void {
  meshSsboDevModeProbe = probe ?? isMeshSsboDevMode;
}

/**
 * Dev-mode probe for `ensureMeshSsboCapacity`'s console.info gate
 * (plan-strategy §2.D-3 + AC-11). True when the build is in dev mode:
 *   - `import.meta.env?.DEV` is truthy (vite dev / vitest), OR
 *   - `process.env.NODE_ENV !== 'production'` (esbuild / tsup / dawn-node).
 * Optional-chain keeps it safe in non-vite ESM envs that never inject
 * `import.meta.env` (the chain short-circuits to undefined → falsy).
 *
 * Vite's `import.meta.env.DEV` is constant-folded at build time, so the
 * production bundle dead-code-strips the entire branch even though the
 * test fall-through reads `process.env.NODE_ENV`.
 *
 * @internal — exported as a function (not a const) so unit tests can
 * `vi.spyOn(...).mockReturnValue(false)` to exercise the dev=false path
 * (vitest 4.x cannot toggle `import.meta.env.DEV` at runtime — it is
 * compile-time-frozen by the vite transform).
 */
export function isMeshSsboDevMode(): boolean {
  const importMetaDev = (import.meta as { env?: { DEV?: unknown } }).env?.DEV;
  if (importMetaDev) return true;
  // Fallback for tsup / esbuild / dawn-node where import.meta.env is absent:
  // NODE_ENV !== 'production' counts as dev. NODE_ENV unset (undefined)
  // also counts as dev so test envs without explicit NODE_ENV log too —
  // production builds always set NODE_ENV='production'. We read process via
  // globalThis to keep this file @types/node-free (rest of the package is
  // browser-typed; engine-runtime ships ESM into both browser + dawn-node).
  const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  if (proc !== undefined && proc.env?.NODE_ENV === 'production') return false;
  if (proc === undefined) return false;
  return true;
}

/**
 * Module-scoped reusable scratch for batched mesh-SSBO uploads (O2).
 * Grows monotonically; never shrinks. One allocation per render session
 * instead of one per entity per frame.
 *
 * @internal
 */
let _meshSsboScratch = new Uint8Array(0);

/**
 * feat-20260704 M3/w21: per-renderable `entity_world` upload (batched). All N
 * mat4+normalMatrix slots are assembled into a single contiguous scratch
 * buffer, then flushed as one `writeBuffer` call instead of N individual
 * calls. Extracted verbatim from `recordFrame` (frame.ts) — the module-scoped
 * `_meshSsboScratch` let and its only reassignment site now co-locate in this
 * file so the two mesh-SSBO module lets live together (AC-06).
 *
 * feat-20260518 M3 / w14 (AC-08): each 256-byte slot carries a 16-float mat4
 * at [0..64B) and a 48-byte mat3 normalMatrix at [64..112B) (3 vec4 columns;
 * padding at indices 19/23/27 stays 0). The mat3 =
 * transpose(invert(mat3(worldFromLocal))) for correct normal transform under
 * non-uniform scale.
 *
 * feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4-record-swap (D-1):
 * fold-bucket heads write identity into their slot; the fold path assembles
 * per-instance world matrices into the @group(3) instances buffer instead
 * (sprite/unlit shaders ignore normals; AC-01/AC-02).
 *
 * @internal
 */
export function uploadMeshSsboBatch(
  queue: RhiQueue,
  meshStorageBuffer: { readonly buffer: Buffer },
  validatedOrdered: readonly ValidatedRenderable[],
  foldDispatchPlan: FoldDispatchPlan | null,
): void {
  const slotCount = validatedOrdered.length;
  const neededBytes = slotCount * MESH_PER_ENTITY_STRIDE;
  // Grow the module-scoped scratch monotonically; zero the used range.
  if (_meshSsboScratch.length < neededBytes) {
    _meshSsboScratch = new Uint8Array(neededBytes);
  } else {
    _meshSsboScratch.fill(0, 0, neededBytes);
  }
  const normalMatrixScratch = mat3.create();
  for (let i = 0; i < slotCount; i++) {
    const entry = validatedOrdered[i];
    if (entry === undefined) continue;
    // Float32Array view into this entity's 256-byte slot (28 floats used,
    // rest remains 0 from the fill above). Byte offset i*256 is always
    // 4-byte aligned since MESH_PER_ENTITY_STRIDE=256 is divisible by 4.
    const slot = new Float32Array(_meshSsboScratch.buffer, i * MESH_PER_ENTITY_STRIDE, 28);
    const isFoldHead = foldDispatchPlan?.headBuckets.has(i) === true;
    if (isFoldHead) {
      // identity mat4
      slot[0] = 1;
      slot[5] = 1;
      slot[10] = 1;
      slot[15] = 1;
      // identity mat3 normal (cols at slot offsets 16/20/24)
      slot[16] = 1;
      slot[20] = 1;
      slot[24] = 1;
    } else {
      const worldFromLocal = entry.source.transform.world;
      for (let k = 0; k < 16; k++) slot[k] = worldFromLocal[k] ?? 0;
      const normal = mat3.normalMatrix(normalMatrixScratch, worldFromLocal);
      slot[16] = normal[0] ?? 0;
      slot[17] = normal[1] ?? 0;
      slot[18] = normal[2] ?? 0;
      slot[20] = normal[3] ?? 0;
      slot[21] = normal[4] ?? 0;
      slot[22] = normal[5] ?? 0;
      slot[24] = normal[6] ?? 0;
      slot[25] = normal[7] ?? 0;
      slot[26] = normal[8] ?? 0;
    }
  }
  if (neededBytes > 0) {
    const meshUpload = queue.writeBuffer(
      meshStorageBuffer.buffer,
      0,
      _meshSsboScratch,
      0,
      neededBytes,
    );
    if (!meshUpload.ok) throw meshUpload.error;
  }
}

/**
 * Per-bucket descriptor produced by {@link foldDispatchBuckets}.
 *
 * One bucket = one fold-eligible run of consecutive DispatchEntry whose
 * `(layer, sortKey, materialHandle)` triple is equal. Singleton buckets
 * (bucketSize=1) appear when the mode bypasses fold (D-5 mode 2/3) or
 * when consecutive entries differ in one of the three keys.
 *
 * Fields:
 *   - `entries` — original DispatchEntry slice for this bucket (preserves
 *     the input ordering); the consumer uses these to look up per-entity
 *     material BG handles, mesh handles (which are bucket-uniform by
 *     construction since materialHandle key is included), etc.
 *   - `bucketSize` — `entries.length`. Surfaced as a top-level field so
 *     the consumer can pass it directly as `instanceCount` to
 *     `drawIndexed`.
 *   - `transforms` — assembled Float32Array of bucketSize world mat4s,
 *     stride=16 floats per instance, column-major. Suitable for direct
 *     `device.queue.writeBuffer` into an instance buffer used at @group(3).
 *   - `materialHandle` / `layer` / `sortKey` — the three-tuple key for this
 *     bucket. `sortKey` is mode-dependent: posZ (world[14]) for mode 0
 *     (LAYER_Z), posY (world[13]) for mode 1 (LAYER_Y). Consumed by the
 *     dispatch loop for bind-group selection / sort-stability invariants.
 */
export interface FoldBucket {
  readonly entries: readonly DispatchEntry[];
  readonly bucketSize: number;
  readonly transforms: Float32Array;
  readonly materialHandle: number;
  readonly layer: number;
  readonly sortKey: number;
}

/**
 * Minimal renderable shape consumed by the helper. The real
 * `RenderableSnapshot` carries many more fields; the helper only reads
 * `transform.world` (a Float32Array of 16 column-major floats) and
 * `material.transparent` (the LDR-split-sub-pass fold gate, see PR #502
 * fix + feat-20260625 R2 fix-up: geometry-pass entities — non-transparent
 * materials — MUST stay singleton because the sprite-pass dispatch path
 * that consumes `headBuckets` does not run for them; folding them would
 * overwrite their mesh-SSBO slot with identity and collapse 3D geometry
 * to origin).
 *
 * Production callers pass `RenderableSnapshot[]` straight through —
 * `RenderableSnapshot.material.transparent` is `boolean | undefined`
 * (derived by the extract stage from `passes[0].renderState.blend !==
 * undefined`, the post-feat-20260626-collapse SSOT; see
 * `MaterialSnapshot.transparent`), structurally compatible with this
 * minimal shape. The gate read inside the helper uses `=== true` /
 * `!== true` so both `false` and `undefined` enter the singleton branch.
 *
 * feat-20260625-refactor-sprite-as-transparent-mesh R2 fix-up: gate
 * migrated from `shadingModel === 'sprite'` (the union member was
 * removed in M3 / w15) to `transparent === true` (the new SSOT for
 * "routes through the LDR split sub-pass" — same predicate the
 * `splitLdrSprite` filter at render-system-record.ts:4826/5612 uses).
 */
export interface FoldRenderableLike {
  readonly transform: { readonly world: Float32Array };
  readonly material: { readonly transparent?: boolean | undefined };
}

/**
 * Linear-scan fold operator (plan-strategy D-1).
 *
 * Walks `orderedEntries` (must be transparent-sort-ordered when mode=0;
 * the helper trusts the input ordering and only checks adjacent equality
 * — non-consecutive entries with equal keys are NOT merged, preserving
 * stable-sort semantics).
 *
 * @param orderedEntries — DispatchEntry[] in transparent-sort order. Empty
 *   array yields zero buckets (defensive empty-bucket suppression).
 * @param mode — current `TransparentSortConfig.mode`. Modes 0 (LAYER_Z)
 *   and 1 (LAYER_Y) enable fold using the appropriate sort-axis coordinate
 *   (posZ / posY respectively). Modes 2 and 3 produce singleton buckets
 *   per entry (D-5 bypass).
 * @param renderables — parallel snapshot array indexed by
 *   `DispatchEntry.renderableIndex`. The helper reads `transform.world`
 *   to (a) extract the sort-axis coordinate for the bucket key (posZ
 *   world[14] for mode 0, posY world[13] for mode 1), and (b) copy 16
 *   floats per entry into the assembled transforms buffer. Out-of-range /
 *   missing renderables defensively contribute a zero mat4 slot.
 * @returns Array of FoldBucket descriptors in input order.
 */
export function foldDispatchBuckets(
  orderedEntries: readonly DispatchEntry[],
  mode: TransparentSortConfig['mode'],
  renderables: readonly FoldRenderableLike[],
): readonly FoldBucket[] {
  if (orderedEntries.length === 0) return [];

  // Bypass branch (D-5): modes 2 (LAYER_YZ) and 3 (DISTANCE) cannot fold
  // — their sort keys are composite foot-Y formulas or per-entity camera
  // distances, not reducible to a single world-mat4 coordinate read.
  // Each entry produces its own singleton bucket; the dispatch consumer
  // treats bucketSize=1 identically to per-entity drawIndexed (charter P3
  // silent fallback — no error fired).
  //
  // Mode 1 (LAYER_Y) falls through to the fold branch below and uses posY
  // (world[13]) as the sort-axis bucket key.
  if (mode !== TRANSPARENT_SORT_MODE_LAYER_Z && mode !== TRANSPARENT_SORT_MODE_LAYER_Y) {
    const out: FoldBucket[] = [];
    for (let i = 0; i < orderedEntries.length; i++) {
      const e = orderedEntries[i];
      if (e === undefined) continue;
      out.push(makeSingletonBucket(e, renderables, mode));
    }
    return out;
  }

  // Fold branch (mode 0 = LAYER_Z, mode 1 = LAYER_Y): linear scan, collect
  // runs with equal (layer, sortKey, materialHandle). sortKey is posZ for
  // mode 0, posY for mode 1 — see readSortKey().
  //
  // Transparent-pass-only gate (PR #502 fix + feat-20260625 R2 fix-up):
  // the only dispatch site that consumes `headBuckets` to emit one
  // instanced drawIndexed per bucket is the transparent-pass loop in
  // `render-system-record.ts` (~line 5500; routed via `splitLdrSprite`
  // filter on `material.transparent === true`). The geometry-pass loop
  // (~line 4660) iterates `validatedOrdered` and emits per-entity
  // drawIndexed unchanged; it does NOT branch on `headBuckets`. So when
  // a non-transparent entry (geometry-pass: unlit / standard-PBR / skin)
  // is folded into a multi-entry bucket, the mesh-SSBO upload loop
  // (~line 2710) still overwrites its mesh slot with identity (because
  // `headBuckets.has(i)` is true), but the geometry-pass then reads
  // identity and renders the 3D geometry at the origin — collapsing the
  // frame to black (hello-room CI regression).
  //
  // Concept-count fix: encode "fold is transparent-sub-pass-only" at the
  // head selection point — the gate is the single bucket-key invariant
  // that makes both dispatch sites correct without coupling identity-
  // overwrite logic to a separate check (avoiding the D-9 shared-exit
  // violation that selecting fix-location B would produce).
  //
  // Non-transparent entries (`transparent !== true`) always produce
  // singleton buckets (bucketSize=1), which `buildFoldDispatchPlan`
  // filters out (`if (bucket.bucketSize <= 1) continue`), so they never
  // enter `headBuckets` / `skipIndices` — the mesh-SSBO upload,
  // transparent-pass, and geometry-pass loops all see them as byte-
  // identical to the pre-fold per-entity path.
  //
  // feat-20260625 R2 fix-up: pre-feat the gate was `shadingModel ===
  // 'sprite'`; M3 / w15 narrowed the shadingModel union to
  // `'unlit' | undefined` (the `'sprite'` discriminator was the design
  // ablation target), so the gate now reads `material.transparent` —
  // the new SSOT for "routes through the LDR split sub-pass" mirrored
  // on `computeSplitLdrSprite` + the `splitLdrSprite` skip filter.
  const buckets: FoldBucket[] = [];
  let runStart = 0;
  while (runStart < orderedEntries.length) {
    const head = orderedEntries[runStart];
    if (head === undefined) {
      runStart += 1;
      continue;
    }
    // Transparent-pass-only gate (feat-20260625 R2 fix-up): non-transparent
    // heads emit a singleton bucket and advance the cursor by 1 — no run
    // extension. `RenderableSnapshot.material.transparent` is the SSOT
    // carrier (extract stage derives it from the first pass's
    // `renderState.blend !== undefined`, post-feat-20260626-collapse;
    // see `MaterialSnapshot.transparent`).
    const headTransparent = renderables[head.renderableIndex]?.material.transparent;
    if (headTransparent !== true) {
      buckets.push(makeSingletonBucket(head, renderables, mode));
      runStart += 1;
      continue;
    }
    const headSortKey = readSortKey(mode, head.renderableIndex, renderables);
    let runEnd = runStart + 1;
    while (runEnd < orderedEntries.length) {
      const cand = orderedEntries[runEnd];
      if (cand === undefined) break;
      if (cand.layer !== head.layer) break;
      if (cand.materialHandle !== head.materialHandle) break;
      // Defensive: cand transparent must also be true to join the run.
      // Same materialHandle implies same transparent flag in production
      // (material asset identity), but the check costs O(1) per cand and
      // makes the bucket invariant locally readable.
      const candTransparent = renderables[cand.renderableIndex]?.material.transparent;
      if (candTransparent !== true) break;
      const candSortKey = readSortKey(mode, cand.renderableIndex, renderables);
      if (candSortKey !== headSortKey) break;
      runEnd += 1;
    }

    const run = orderedEntries.slice(runStart, runEnd);
    const transforms = assembleTransforms(run, renderables);
    buckets.push({
      entries: run,
      bucketSize: run.length,
      transforms,
      materialHandle: head.materialHandle,
      layer: head.layer,
      sortKey: headSortKey,
    });
    runStart = runEnd;
  }
  return buckets;
}

function makeSingletonBucket(
  entry: DispatchEntry,
  renderables: readonly FoldRenderableLike[],
  mode: TransparentSortConfig['mode'],
): FoldBucket {
  const transforms = new Float32Array(16);
  const w = renderables[entry.renderableIndex]?.transform.world;
  if (w !== undefined) transforms.set(w);
  const sortKey = readSortKey(mode, entry.renderableIndex, renderables);
  return {
    entries: [entry],
    bucketSize: 1,
    transforms,
    materialHandle: entry.materialHandle,
    layer: entry.layer,
    sortKey,
  };
}

function assembleTransforms(
  run: readonly DispatchEntry[],
  renderables: readonly FoldRenderableLike[],
): Float32Array {
  const out = new Float32Array(run.length * 16);
  for (let i = 0; i < run.length; i++) {
    const e = run[i];
    if (e === undefined) continue;
    const w = renderables[e.renderableIndex]?.transform.world;
    if (w !== undefined) out.set(w, i * 16);
  }
  return out;
}

function readSortKey(
  mode: TransparentSortConfig['mode'],
  renderableIndex: number,
  renderables: readonly FoldRenderableLike[],
): number {
  const w = renderables[renderableIndex]?.transform.world;
  if (w === undefined) return 0;
  // mode 0 (LAYER_Z): sort-axis is Z, column 3 row 2 = world[14].
  // mode 1 (LAYER_Y): sort-axis is Y, column 3 row 1 = world[13].
  return ((mode === TRANSPARENT_SORT_MODE_LAYER_Z ? w[14] : w[13]) ?? 0) as number;
}

/**
 * Per-validatedOrdered-index fold metadata consumed by the record-stage
 * dispatch loops. Built from {@link foldDispatchBuckets} output by
 * {@link buildFoldDispatchPlan}; see plan-strategy §3.2 sequence diagram.
 *
 * Field semantics (consumer contract, w4-record-swap):
 *   - `headBuckets[i]` is non-null when validatedOrdered index `i` is the
 *     **bucket head** of a non-singleton (bucketSize > 1) fold bucket. The
 *     dispatch loop overrides @group(3) instances BG to a transient buffer
 *     holding `bucket.transforms` and emits `drawIndexed(idxCount,
 *     bucket.bucketSize)` instead of per-entity drawIndexed.
 *   - `skipIndices.has(i)` is true when index `i` is a non-head member of
 *     a non-singleton fold bucket; the dispatch loop emits `continue`.
 *   - Singleton buckets (bucketSize === 1) leave both arrays empty for
 *     that index — dispatch falls through to the existing per-entity path
 *     byte-identically (mode-bypass / non-foldable head / fold-disabled).
 *
 * Note: the maps are keyed on `validatedOrderedIndex`, NOT
 * `renderableIndex`. The dispatch loops iterate `validatedOrdered` by
 * positional index `i`, and that index drives mesh SSBO slot offset
 * (`i * MESH_PER_ENTITY_STRIDE`), material UBO slot, and per-entity bind
 * group cache keys, all of which the swap must coordinate with.
 */
export interface FoldDispatchPlan {
  readonly headBuckets: ReadonlyMap<number, FoldBucket>;
  readonly skipIndices: ReadonlySet<number>;
  readonly foldedBucketCount: number;
}

/**
 * Build the per-validatedOrdered-index fold metadata from a
 * {@link foldDispatchBuckets} output.
 *
 * @param buckets — output of {@link foldDispatchBuckets}; ordered by
 *   transparent-sort scan order.
 * @param renderableIndexToValidatedIndex — map from `DispatchEntry.renderableIndex`
 *   to the validated-ordered index `i` (the loop counter the dispatch
 *   loops use). Caller builds this once per frame from `validatedOrdered`.
 * @returns FoldDispatchPlan keyed by validated-ordered index.
 *
 * Empty / all-singleton input yields empty maps + `foldedBucketCount=0`,
 * which the dispatch loops treat as "no fold this frame" — byte-identical
 * to pre-feat behavior.
 */
export function buildFoldDispatchPlan(
  buckets: readonly FoldBucket[],
  renderableIndexToValidatedIndex: ReadonlyMap<number, number>,
): FoldDispatchPlan {
  const headBuckets = new Map<number, FoldBucket>();
  const skipIndices = new Set<number>();
  let foldedBucketCount = 0;
  for (const bucket of buckets) {
    if (bucket.bucketSize <= 1) continue;
    const headEntry = bucket.entries[0];
    if (headEntry === undefined) continue;
    const headValidatedIdx = renderableIndexToValidatedIndex.get(headEntry.renderableIndex);
    if (headValidatedIdx === undefined) continue;
    headBuckets.set(headValidatedIdx, bucket);
    foldedBucketCount += 1;
    for (let i = 1; i < bucket.entries.length; i++) {
      const memberEntry = bucket.entries[i];
      if (memberEntry === undefined) continue;
      const memberValidatedIdx = renderableIndexToValidatedIndex.get(memberEntry.renderableIndex);
      if (memberValidatedIdx === undefined) continue;
      skipIndices.add(memberValidatedIdx);
    }
  }
  return { headBuckets, skipIndices, foldedBucketCount };
}

/**
 * WebGL2 uniform-fallback per-bucket instance-count ceiling
 * (feat-20260622-chunk-gpu-instancing-sprite-tilemap M2 / D-2 +
 * research N-1).
 *
 * 128 instances * 64 B/mat4 stride = 8192 B, comfortably below the WebGL2
 * minimum 16384 B UBO size, leaving headroom for the per-frame material
 * UBO slice. Locked at the type level via `RhiInstancingExceedsUniformCapDetail.limit`
 * (literal 128) — a future cap change would be a major evolution, not a
 * runtime knob.
 */
export const FOLD_UNIFORM_INSTANCE_CAP = 128;

/**
 * Minimal `RhiCapabilities` shape consumed by the cap-fallback helper.
 *
 * The real `RhiDevice.caps` carries many feature flags; the helper only
 * reads `storageBuffer` (the WebGL2 / WebGPU split signal — true on
 * WebGPU + dawn / wgpu native paths, false on the WebGL2 uniform-only
 * fallback path). Mirrors the field name on the production `RhiCaps`
 * type so the dispatch site can pass `runtime.device.caps` straight in.
 */
export interface FoldCapsLike {
  readonly storageBuffer: boolean;
}

/**
 * Decision POD returned by {@link evaluateFoldBucketUniformCap}.
 *
 * Fields:
 *   - `fallback` — `true` when the bucket must NOT fold and the dispatch
 *     site must route it through the per-entity drawIndexed exit (the
 *     same exit the mode-gate bypass uses, plan-strategy D-9 "shared
 *     fallback exit"). `false` when the bucket can fold normally.
 *   - `error` — the structured RhiError to fire alongside the fallback.
 *     Always populated when `fallback === true`; always `undefined` when
 *     `fallback === false` (charter proposition 4: explicit failure on
 *     the failure path; silent success on the success path).
 *
 * Caller contract: when `fallback === true`, fire the error via the
 * runtime error registry AND draw the bucket's entries individually
 * (each as a 1-instance drawIndexed). Skipping the fallback while still
 * firing the error would leave the frame visually wrong (uniform buffer
 * write would clip at 128 entries).
 */
export interface FoldBucketCapDecision {
  readonly fallback: boolean;
  readonly error: RhiError | undefined;
}

/**
 * Decide whether a fold bucket fits the WebGL2 uniform-fallback per-bucket
 * instance-count ceiling, returning the structured RhiError + fallback
 * intent the dispatch site needs to act on
 * (feat-20260622-chunk-gpu-instancing-sprite-tilemap M2 / w11 +
 * plan-strategy D-2 + D-9 + AC-05).
 *
 * Decision matrix:
 *
 * | caps.storageBuffer | bucketSize  | fallback | error |
 * |:--|:--|:--|:--|
 * | `true`             | every       | `false`  | `undefined` (WebGPU has no per-binding instance cap inside the storage buffer's `maxStorageBufferBindingSize`; the byte-cap path emits `'limit-exceeded'` separately) |
 * | `false`            | `<= 128`    | `false`  | `undefined` (fits inside the WebGL2 minimum 16384 B UBO with headroom) |
 * | `false`            | `> 128`     | `true`   | `RhiError({ code: 'instancing-exceeds-uniform-cap', detail: { requested, limit: 128, scope } })` |
 *
 * Singleton buckets (`bucketSize === 1`) always pass — they are the
 * mode-gate bypass output and never need the cap check (the cap is
 * about *folded* bucket arity, not about per-entity per-frame work).
 *
 * @param bucket — the FoldBucket whose `bucketSize` is the sole input
 *   (instance count = bucketSize); other fields are not consulted.
 * @param caps — the runtime's RHI capability flags
 *   (`runtime.device.caps`); only `storageBuffer` is read.
 * @param scope — closed `'sprite' | 'tilemap-chunk'` discriminator the
 *   dispatch site picks based on the call site (sprite-pass primary
 *   sprite entry vs tilemap-chunk-derived entry). Surfaced verbatim on
 *   the error's `.detail.scope` so AI users can branch their recovery
 *   on which dispatch site overflowed.
 * @returns a {@link FoldBucketCapDecision} POD; never throws.
 */
export function evaluateFoldBucketUniformCap(
  bucket: FoldBucket,
  caps: FoldCapsLike,
  scope: 'sprite' | 'tilemap-chunk',
): FoldBucketCapDecision {
  if (caps.storageBuffer) return { fallback: false, error: undefined };
  if (bucket.bucketSize <= FOLD_UNIFORM_INSTANCE_CAP) {
    return { fallback: false, error: undefined };
  }
  const error = new RhiError({
    code: 'instancing-exceeds-uniform-cap',
    expected: `bucket instance count <= ${FOLD_UNIFORM_INSTANCE_CAP} (uniform fallback cap)`,
    hint: `reduce the bucket size (smaller layer/material groupings), switch to a WebGPU-capable backend (storage buffers lift the cap), or accept the per-cell drawIndexed fallback for ${scope}`,
    detail: {
      requested: bucket.bucketSize,
      limit: FOLD_UNIFORM_INSTANCE_CAP,
      scope,
    },
  });
  return { fallback: true, error };
}

/**
 * Closed metric key for the AC-06 fold counter
 * (feat-20260622-chunk-gpu-instancing-sprite-tilemap M3 / D-3).
 *
 * Semantics — count of instanced `drawIndexed` calls the fold operator
 * emits this frame; one increment per non-singleton head bucket retained
 * after the M2 / w11 cap-fallback filter. NOT entity count, NOT pre-
 * filter bucket count — cap-overrun buckets that the dispatch site
 * routed through the per-entity fallback exit do not count.
 *
 * Naming follows the EngineMetrics dot-namespace convention
 * (`<feature>.<event>`); `render.instancing.*` covers both sprite and
 * tilemap-chunk dispatch sites without scope ambiguity (research F-5,
 * plan-strategy §8.2). The owning host evidence reads
 * `ownerMetrics.snapshot()['render.instancing.foldedDraws']`.
 */
export const FOLDED_DRAWS_METRIC_KEY = 'render.instancing.foldedDraws';

/**
 * Minimal `EngineMetrics` shape consumed by {@link incrementFoldedDrawsMetric}.
 *
 * The real `EngineMetrics` carries `snapshot()` + `reset()` too; the
 * helper only writes, so the consumed surface narrows to a single
 * method. Lets the unit test inject a `vi.fn()` mock without faking the
 * read APIs.
 */
export interface FoldMetricsLike {
  increment(name: string): void;
}

/**
 * Bump the AC-06 `render.instancing.foldedDraws` counter once per fold-
 * eligible head bucket in `plan` (M3 / w13, plan-strategy D-3).
 *
 * Single counter-write site for the metric — the record-stage consumer
 * calls this once per `recordFrame` after the cap-fallback filter
 * (M2 / w11) so cap-overrun buckets do not contribute (their members
 * fall through to per-entity drawIndexed, which is not an instanced
 * draw). `plan.foldedBucketCount` is the SSOT for "how many instanced
 * drawIndexed will this frame emit"; passing the same plan to this
 * helper keeps the metric and the actual dispatch in lockstep.
 *
 * Mode-bypass plans (D-5: mode != 0 yields singleton-only buckets which
 * `buildFoldDispatchPlan` filters out) carry `foldedBucketCount === 0`
 * and produce no increments — per-entity drawIndexed is not folded so
 * the metric correctly stays at 0.
 *
 * @param plan — output of {@link buildFoldDispatchPlan} after possible
 *   cap-fallback filtering by the record-stage consumer.
 * @param metrics — the owner-provided EngineMetrics counter; only
 *   `increment(name)` is called. Empty `plan.foldedBucketCount === 0`
 *   produces zero calls (no metric churn for fold-disabled frames).
 */
export function incrementFoldedDrawsMetric(plan: FoldDispatchPlan, metrics: FoldMetricsLike): void {
  for (let i = 0; i < plan.foldedBucketCount; i++) {
    metrics.increment(FOLDED_DRAWS_METRIC_KEY);
  }
}
