import { mat3 } from '@forgeax/engine-math';
import type { BindGroup, Buffer, RhiQueue } from '@forgeax/engine-rhi';
import type { FoldDispatchPlan } from '../render-system-fold';
import type { ValidatedRenderable } from './frame-snapshot';

/**
 * Stride between per-renderable `entity_world` mat4 slots inside the
 * shared `pipelineState.meshStorageBuffer`. The 256-byte alignment is
 * required because the storage buffer is bound with
 * `hasDynamicOffset: true` and WebGPU spec
 * `minStorageBufferOffsetAlignment` defaults to 256.
 */
export const MESH_PER_ENTITY_STRIDE = 256;

// feat-20260518-pbr-direct-lighting-mvp M5 / M5-engine-fix Bug 2:
// per-entity Mesh SSBO slot size = mat4 worldFromLocal (64 B) + mat3
// normalMatrix std140 (3 vec4 columns = 48 B) = 112 B. The BindGroup
// entry's `size` MUST cover the full struct so the shader's `meshes[i].
// normalMatrix` access stays in bounds; previously this was 64 B which
// matched only the mat4 prefix and triggered a WebGPU validation error
// on the standard pipeline (which references `normalMatrix`). The 112 B
// shape matches common.wgsl `struct Mesh { worldFromLocal, normalMatrix }`
// byte-for-byte (see common.wgsl line 32-35).
export const MESH_SSBO_BYTES = 112;

// bug-20260610: WebGL2 fallback shader declares `array<Mesh, 128>` as a
// uniform buffer; binding must cover the full array size. The storage
// variant binds a single 112-B slot via dynamic offset, but the uniform
// variant requires the whole 14336-B range visible to the shader.
export const MESH_UBO_FULL_ARRAY_BYTES = 112 * 128;

// W3C WebGPU §3.6 GPUBufferUsage flags used by the per-entity instance
// transform buffer (STORAGE | COPY_DST = 128 | 8).
export const STORAGE_USAGE = 128;

export const UNIFORM_USAGE = 64;

export const COPY_DST_USAGE = 8;

export const MAX_UNIFORM_INSTANCES = 128;

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
 *                           list to `degradedToSlotCount` (graceful degradation
 *                           per plan-strategy D-2): renders the subset that
 *                           fits, discards overflow, no black frame.
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
      const normal = mat3.normalMatrix(
        mat3.create(),
        worldFromLocal as unknown as Parameters<typeof mat3.normalMatrix>[1],
      );
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
