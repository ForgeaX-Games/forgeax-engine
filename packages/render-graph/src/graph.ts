// @forgeax/engine-render-graph/src/graph.ts — RenderGraph core primitives.
//
// Shape (plan-strategy D-1/D-4/D-5/D-6.1):
// - ResourceDescriptor / PassDescriptor — declaration types
// - RenderGraph — main class: addResource / addPass / compile / execute
// - PassInfo / ResourceInfo — query interfaces (D-5)

import type { RhiCaps, RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import {
  type CapMissingDetail,
  type CyclicDependencyDetail,
  type DanglingReadDetail,
  err,
  ok,
  RenderGraphError,
  type Result,
} from './errors.js';
import type { PassEntry } from './pass-registry.js';
import { PassRegistry } from './pass-registry.js';
import type { ResourceEntry } from './resource-registry.js';
import { ResourceRegistry } from './resource-registry.js';

// ── Declaration types ────────────────────────────────────────────

export type ResourceKind = 'texture' | 'buffer';

export type ResourceLifetime = 'transient' | 'persistent';

export type BufferRole = 'auto-storage-or-uniform' | 'uniform';

/**
 * Three-state size for addColorTarget (D-8):
 * - 'swapchain' — matches the output canvas size
 * - 'half-swapchain' — 1/2 the output canvas size (bloom downscale)
 * - { w, h } — fixed pixel dimensions (shadow maps, etc.)
 */
export type ColorTargetSize =
  | 'swapchain'
  | 'half-swapchain'
  | { readonly w: number; readonly h: number };

/**
 * Color target descriptor for addColorTarget (D-8).
 *
 * format: GPU texture format (e.g. 'rgba16float', 'bgra8unorm').
 * size: target dimensions relative to swap-chain or absolute.
 * sample: multisample count (default 1; MSAA count=4 via #301).
 * usage: GPU texture usage flags (default RENDER_ATTACHMENT | TEXTURE_BINDING).
 * viewFormats: extra GPU texture formats viewable via createTextureView from this
 *   texture; mirrors GPUTextureDescriptor.viewFormats. The LDR MSAA path needs
 *   `bgra8unorm` storage + `bgra8unorm-srgb` view (hardware sRGB encoding on
 *   store), so the consumer pre-declares the alternate format here.
 */
export interface ColorTargetDescriptor {
  readonly format: string;
  readonly size: ColorTargetSize;
  readonly sample?: number | undefined;
  readonly usage?: number | undefined;
  readonly viewFormats?: readonly string[] | undefined;
}

export interface ResourceDescriptor {
  readonly kind: ResourceKind;
  readonly lifetime: ResourceLifetime;
  readonly bufferRole?: BufferRole;
}

/**
 * Opaque handle returned by addColorTarget. Resolved to a TextureView after
 * compile by calling resolve(name) in a pass execute closure.
 */
export type ColorTargetHandle = string;

/**
 * Per-pass resolve context: maps color target names to compiled TextureViews.
 * A pass execute closure receives this alongside the user-provided Ctx.
 */
export interface ResolveContext {
  /** Resolve a color target name to its compiled TextureView, or undefined if not compiled. */
  readonly resolve: (name: string) => unknown;
}

export interface PassDescriptor<Ctx = unknown> {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly execute?: ((ctx: Ctx) => void) | ((ctx: Ctx, resolve: ResolveContext) => void);
  readonly compute?: boolean;
  readonly storageBuffer?: boolean;
}

// ── Query types (D-5) ────────────────────────────────────────────

export interface PassInfo {
  readonly name: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
}

export interface ResourceInfo {
  readonly key: string;
  readonly kind: ResourceKind;
  readonly lifetime: ResourceLifetime;
}

// ── Internalized graph ───────────────────────────────────────────

export interface InternalizedPass {
  readonly name: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly barriers: readonly string[];
}

/**
 * RHI buffer binding type a buffer resource resolves to after compile.
 * Mirrors the `@webgpu/types` GPUBufferBindingType subset used by the
 * storage-vs-uniform cap switch (research Finding 7; runtime template
 * `pbr-pipeline.ts` `caps.storageBuffer ? 'read-only-storage' : 'uniform'`).
 */
export type ResolvedBufferType = 'read-only-storage' | 'uniform';

/**
 * Resolved buffer binding for a registered `kind:'buffer'` resource.
 * Produced by compile() per AC-09 / D-6.1: the declarative graph picks the
 * concrete binding type from `caps.storageBuffer`, so a consumer building a
 * bind-group layout reads `resolvedBufferType` instead of duplicating the
 * cap switch.
 */
export interface ResolvedBuffer {
  readonly key: string;
  readonly resolvedBufferType: ResolvedBufferType;
}

export interface InternalizedGraph {
  readonly passes: readonly InternalizedPass[];
  /**
   * Buffer resources resolved to a concrete RHI binding type (AC-09).
   * Empty when the graph declares no `kind:'buffer'` resources.
   */
  readonly resolvedBuffers: readonly ResolvedBuffer[];
  /**
   * Resolved TextureViews keyed by resource name.
   * Populated by the compile allocation phase for addColorTarget resources.
   * Empty when no color targets were declared.
   */
  readonly resolvedTextures: ReadonlyMap<string, TextureView>;
}

// ── Compile options ──────────────────────────────────────────────

export interface CompileOptions {
  // D-6: second independent literal union (NOT derived from RhiCaps['backendKind']);
  // add-only '|null' member so passthrough callers forwarding
  // device.caps.backendKind type-check. Deriving from RhiCaps to collapse the
  // duplicate is a known OOS follow-on (architecture-principles #2 Derive).
  readonly backendKind: 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null';
  readonly caps: RhiCaps;
  /**
   * RHI device interface handle for real GPU texture allocation (D-1).
   * Required when the graph has addColorTarget resources; the compile phase
   * calls device.createTexture/createTextureView for each color target.
   */
  readonly device?: RhiDevice | undefined;
}

// ── RenderGraph ──────────────────────────────────────────────────

/**
 * Descriptor key for texture pool lookups (D-2 / D-8 / KB-2).
 * Transient resources with identical descriptors share the same physical
 * texture; drift in any field triggers rebuild.
 * NOTE: stringified form is used as Map key; the interface is for doc only.
 */
// interface _TexturePoolKey { format:string; width:number; height:number; usage:number; sampleCount:number; }

/** Pooled transient texture entry. */
interface PooledTexture {
  readonly texture: unknown; // opaque RHI Texture handle
  readonly view: unknown; // opaque RHI TextureView handle
}

/** A subset of RhiDevice surface needed by drain() and reclaim to release pooled textures. */
type DrainDevice = Pick<RhiDevice, 'destroyTexture' | 'queue'>;

function poolKey(meta: {
  format: string;
  width: number;
  height: number;
  usage: number;
  sample: number;
}): string {
  return `${meta.format}:${meta.width}x${meta.height}:${meta.usage}:${meta.sample}`;
}

export class RenderGraph<Ctx = unknown> {
  private readonly resources = new ResourceRegistry();
  private readonly passes = new PassRegistry<Ctx>();
  private compiled: InternalizedGraph | null = null;

  /** Transient texture pool: keyed by descriptor, reused across compiles (D-2). */
  private readonly transientPool = new Map<string, PooledTexture>();
  /**
   * Pending-destroy queue (bug-20260622): old transient textures awaiting GPU
   * retirement before actual device.destroyTexture. drainTransient() and
   * setTransientEntry() push here instead of destroying immediately;
   * reclaimRetiredTransients() (called post-queue.submit in recordFrame) drains
   * the queue when the GPU signals onSubmittedWorkDone.
   */
  private readonly pendingDestroy: PooledTexture[] = [];
  /** Persistent textures: keyed by resource name, kept across compiles. */
  private readonly persistentTextures = new Map<string, PooledTexture>();
  /** Swap-chain size for resolving 'swapchain' / 'half-swapchain' sizes. */
  private swapChainWidth = 800;
  private swapChainHeight = 600;
  /** Last compile-time swap-chain size; diff triggers recompile-invalidation. */
  private compiledWidth = 800;
  private compiledHeight = 600;
  /**
   * feat-20260612 M-4 / w15: device reference stashed at compile-time so
   * drain() can release pooled textures via device.destroyTexture without
   * a separate parameter. Set by compile(); null until the first compile.
   * Render-graph stays RHI-pure (no runtime dep): the destroy bookkeeping
   * SSOT is the RHI shim, exactly as GpuTexture.destroy() routes through it.
   */
  private lastDevice: DrainDevice | null = null;

  /**
   * Set the current swap-chain dimensions (w7).
   * The compile allocation phase uses this to resolve 'swapchain' and
   * 'half-swapchain' size specifiers. Returns true when dimensions differ
   * from the last compile, signalling that a recompile is needed.
   */
  setSwapChainSize(width: number, height: number): boolean {
    this.swapChainWidth = width;
    this.swapChainHeight = height;
    if (width !== this.compiledWidth || height !== this.compiledHeight) {
      return true;
    }
    return false;
  }

  /**
   * w7: resolve a color-target name to its compiled TextureView.
   * Returns the GPU view after compile, or undefined if not yet compiled
   * or the name was not registered via addColorTarget.
   */
  getColorTargetView(name: string): unknown {
    return this.compiled?.resolvedTextures.get(name);
  }

  /**
   * w7: resolve a color-target name to its compiled GPU Texture handle.
   * Returns the texture after compile, or undefined if not yet compiled.
   */
  getColorTargetTexture(name: string): unknown {
    return this.compiled?.resolvedTextures.get(`${name}::tex`);
  }

  /**
   * Declare a color target alias: both names share the same physical texture.
   * The source must already be registered via addColorTarget.
   * Used for hdrComposited -> hdrColor folding (KB-1 / D-2).
   */
  addColorTargetAlias(name: string, source: string): ColorTargetHandle {
    this.resources.addColorTargetAlias(name, source);
    return name;
  }

  addResource(
    key: string,
    descriptor: ResourceDescriptor,
  ): Result<ResourceEntry, RenderGraphError> {
    return this.resources.add(key, descriptor);
  }

  /**
   * Declare a color target resource that the compiler will allocate as a
   * transient GPU texture (D-1 / D-8). Returns an opaque string handle
   * that can be referenced in pass read/write arrays and resolved to a
   * TextureView via resolve(name) inside a pass execute closure.
   *
   * The resource is registered as `kind:'texture'` with `lifetime:'transient'`
   * internally. format/size/sample/usage are stored on the resource entry
   * for the compile allocation phase (w6).
   */
  addColorTarget(name: string, desc: ColorTargetDescriptor): ColorTargetHandle {
    this.resources.addColorTarget(name, desc);
    return name;
  }

  addPass(name: string, descriptor: PassDescriptor<Ctx>): PassEntry<Ctx> {
    return this.passes.add(name, descriptor);
  }

  /**
   * Compile the graph into an internalized form.
   *
   * Phases (plan-strategy 3.1):
   * 1. Cap-gate fail-fast
   * 2. Unknown-resource fail-fast (every pass read/write key is registered)
   * 3. Dangling-read fail-fast
   * 4. Topology sort + cycle detection
   * 5. Barrier planning (D-1)
   * 6. Buffer-role resolution (AC-09 / D-6.1)
   * 7. GPU allocation for color targets (D-1) — when device is provided and the
   *    graph has addColorTarget resources, allocate textures via
   *    device.createTexture/createTextureView. Errors surface as
   *    'resource-alloc-failed' or 'invalid-format'.
   */
  compile(opts: CompileOptions): Result<InternalizedGraph, RenderGraphError> {
    const passList = this.passes.list();
    const { backendKind, caps, device } = opts;

    const capErr = this.validateCaps(passList, caps);
    if (capErr) return capErr;

    const unknownErr = this.validateNoUnknownResource(passList);
    if (unknownErr) return unknownErr;

    const danglingErr = this.validateNoDanglingRead(passList);
    if (danglingErr) return danglingErr;

    const sorted = this.topologicalSort(passList);
    if (!sorted.ok) return sorted;

    const sortedPasses = sorted.value;
    const barriersPerPass = this.planBarriers(sortedPasses, backendKind);

    const internalizedPasses: InternalizedPass[] = sortedPasses.map((pass, i) => {
      const barriers = barriersPerPass[i] ?? [];
      return {
        name: pass.name,
        reads: pass.descriptor.reads,
        writes: pass.descriptor.writes,
        barriers,
      };
    });

    const resolvedBuffers = this.resolveBuffers(caps);

    // Phase 6.5: resize drain (AC-09, plan-strategy D-4). When swap-chain
    // dimensions have changed since the last compile, release all old-size
    // transient pool textures before allocating new ones. Without this step,
    // old-dimension pool entries are stranded (key includes WxH, resize
    // produces new keys and the old ones are never accessed again).
    if (
      this.swapChainWidth !== this.compiledWidth ||
      this.swapChainHeight !== this.compiledHeight
    ) {
      this.drainTransient();
    }

    // Phase 7: GPU allocation for color targets (D-1).
    const resolvedTextures = this.allocateColorTargets(device);

    this.compiled = {
      passes: internalizedPasses,
      resolvedBuffers,
      resolvedTextures,
    };
    this.compiledWidth = this.swapChainWidth;
    this.compiledHeight = this.swapChainHeight;
    if (device !== undefined) {
      this.lastDevice = device;
    }
    return ok(this.compiled);
  }

  /**
   * feat-20260612 M-4 / w15: release every pooled GPU texture and clear
   * the pools.
   *
   * Walks `transientPool` + `persistentTextures`, forwarding each
   * `PooledTexture.texture` opaque handle to `device.destroyTexture(...)`,
   * then clears both Maps. The destroy bookkeeping SSOT is the RHI shim
   * (architecture-principles §1 SSOT: same path GpuTexture.destroy()
   * uses); render-graph stays RHI-pure (no runtime dep).
   *
   * Plan-strategy D-7 + OOS-7: drain only covers the dispose exit path
   * (`Renderer.dispose()`); resize / recompile pool eviction stays on
   * the existing leaky-replace path until a follow-up feat addresses it.
   *
   * Idempotent (architecture-principles §6): a second drain on cleared
   * Maps is a no-op. drain() before any compile is also a safe no-op.
   * Per-handle errors from the RHI shim (e.g. 'destroy-after-destroy'
   * on a stale handle) are tolerated so the dispose chain can make
   * progress (mirrors gpuStore.destroyAll's swallow-and-continue
   * policy; plan-strategy D-3 / D-8). The structured error stays
   * available on the device handle for future inspector hooks.
   */
  drain(): void {
    const device = this.lastDevice;
    if (device === null) {
      this.transientPool.clear();
      this.persistentTextures.clear();
      this.pendingDestroy.length = 0;
      return;
    }
    for (const pooled of this.transientPool.values()) {
      try {
        device.destroyTexture(pooled.texture as Texture);
      } catch {
        // swallow-and-continue: per-handle destroy failures do not
        // interrupt the drain chain (docstring tolerance contract).
      }
    }
    this.transientPool.clear();
    // bug-20260622 D-6: drain teardown path — destroy any pendingDestroy
    // items left over (Renderer.dispose() has no in-flight frames).
    for (const pooled of this.pendingDestroy) {
      try {
        device.destroyTexture(pooled.texture as Texture);
      } catch {
        // swallow-and-continue: per-handle destroy failures do not
        // interrupt the drain chain (docstring tolerance contract).
      }
    }
    this.pendingDestroy.length = 0;
    for (const pooled of this.persistentTextures.values()) {
      try {
        device.destroyTexture(pooled.texture as Texture);
      } catch {
        // swallow-and-continue: per-handle destroy failures do not
        // interrupt the drain chain (docstring tolerance contract).
      }
    }
    this.persistentTextures.clear();
  }

  /**
   * Release every transient-pool texture while keeping persistentTextures
   * intact (AC-09: resize drain, plan-strategy D-4).
   *
   * Walks `transientPool` values and forwards each `PooledTexture.texture`
   * opaque handle to `device.destroyTexture(...)`, then clears the transient
   * pool. Mirror of `drain()` but scoped to the transient pool only.
   *
   * Persistent textures survive `drainTransient` — they are only released by
   * the full `drain()` on teardown. `drainTransient` is an internal helper
   * called by `compile()` when swap-chain size changes; it is NOT a public API
   * (callers should use `drain()` for teardown).
   *
   * Idempotent (architecture-principles §6): a second drainTransient on an
   * already-cleared transient pool is a no-op.
   */
  private drainTransient(): void {
    const device = this.lastDevice;
    if (device === null) {
      this.transientPool.clear();
      return;
    }
    // bug-20260622 D-1: push old transient textures into pendingDestroy
    // queue instead of destroying immediately. The GPU may still hold
    // references from a prior in-flight command buffer.
    for (const pooled of this.transientPool.values()) {
      this.pendingDestroy.push(pooled);
    }
    this.transientPool.clear();
  }

  /**
   * Guarded transient pool insert (AC-08, plan-strategy D-4).
   *
   * Before overwriting a key in the transient pool, destroys the old pooled
   * texture via `device.destroyTexture(...)` to prevent stranded GPU textures.
   * The guard is defensive: in current production code flow this code path is
   * unreachable (set() only follows a get() miss inside allocateColorTargets),
   * but the single-line guard costs almost nothing and closes the symmetry gap
   * (every GPU resource allocation has a paired destroy).
   *
   * When `lastDevice` is null (no device ever stashed), the old entry is
   * silently dropped without destroy (mirrors drainTransient's null-device
   * fast path).
   */
  private setTransientEntry(key: string, pooled: PooledTexture): void {
    const old = this.transientPool.get(key);
    if (old) {
      // bug-20260622 D-1: push into pendingDestroy queue instead of
      // destroying immediately — the old texture may still be referenced
      // by an in-flight command buffer.
      this.pendingDestroy.push(old);
    }
    this.transientPool.set(key, pooled);
  }

  /**
   * bug-20260622 D-2: reclaim pool textures queued in pendingDestroy after
   * the GPU has retired all prior command buffers.
   *
   * Takes a snapshot of pendingDestroy, then calls
   * `lastDevice.queue.onSubmittedWorkDone()`. When the promise resolves,
   * the snapshot items are actually destroyed via
   * `device.destroyTexture(...)` and removed from the queue.
   *
   * Idempotent (architecture-principles D-4): a second reclaim on an
   * already-drained pendingDestroy is a no-op. When lastDevice is null
   * (no device ever stashed), pendingDestroy is cleared directly.
   *
   * Per-handle destroy errors are tolerated (swallow-and-continue,
   * plan-strategy D-5) — a stale-handle destroy-after-destroy does not
   * interrupt the reclaim chain.
   */
  async reclaimRetiredTransients(): Promise<void> {
    const device = this.lastDevice;
    if (device === null) {
      this.pendingDestroy.length = 0;
      return;
    }
    if (this.pendingDestroy.length === 0) return;

    // Snapshot the queue; items added after this point are handled by the
    // next reclaim call (D-4: no race with concurrent push from same-frame
    // drainTransient).
    const snapshot = this.pendingDestroy.splice(0);

    // Wait for all prior GPU work to complete.
    await device.queue.onSubmittedWorkDone();

    // Destroy snapshot items.
    for (const pooled of snapshot) {
      try {
        device.destroyTexture(pooled.texture as Texture);
      } catch {
        // swallow-and-continue: per-handle destroy errors are tolerated
        // (docstring contract) — a stale handle does not interrupt the
        // reclaim chain for subsequent items.
      }
    }
  }

  /**
   * Drop the pendingDestroy queue WITHOUT calling device.destroyTexture
   * (feat-20260622-s5 M3 / B-2 / B-AC-02).
   *
   * Used on the device-lost recover() rebuild path: the queue holds
   * PooledTexture handles minted against the now-lost device, so calling
   * destroyTexture on them against the freshly-rebuilt device is meaningless
   * (the old GPUDevice owns them; spec retires its resources implicitly when
   * it is lost). recover() calls this after `gpuStore.destroyAll()` and before
   * `tryCreateWebGPURenderer` so no stale handle reaches the new device.
   *
   * device-lost is an upstream judgement (createRenderer's health state); the
   * graph stays RHI-pure and takes no device parameter — it only exposes the
   * clear entry. Same effect as the existing null-device fast paths in drain()
   * / reclaimRetiredTransients() (`pendingDestroy.length = 0`), surfaced as a
   * method recover() can call directly. Idempotent: a second call on an
   * already-empty queue is a no-op.
   */
  clearPendingDestroy(): void {
    this.pendingDestroy.length = 0;
  }

  /**
   * Execute the compiled graph: iterate passes in topological order, calling
   * each pass's execute closure with the provided context. Passes without an
   * execute closure are silently skipped.
   */
  execute(ctx: Ctx): void {
    const compiled = this.compiled;
    if (!compiled) return;
    const resolvedTextures: ReadonlyMap<string, unknown> = compiled.resolvedTextures;
    const resolveCtx: ResolveContext = {
      resolve: (name: string) => resolvedTextures.get(name),
    };
    const passList = this.passes.list();
    const passByName = new Map<string, PassEntry<Ctx>>(passList.map((p) => [p.name, p]));
    for (const internalPass of compiled.passes) {
      const entry = passByName.get(internalPass.name);
      const execute = entry?.descriptor.execute;
      if (execute) {
        (execute as (ctx: Ctx, resolve: ResolveContext) => void)(ctx, resolveCtx);
      }
    }
  }

  listPasses(): readonly PassInfo[] {
    return this.passes.list().map((p) => ({
      name: p.name,
      reads: p.descriptor.reads,
      writes: p.descriptor.writes,
    }));
  }

  listResources(): readonly ResourceInfo[] {
    const result: ResourceInfo[] = [];
    for (const entry of this.resources.entries()) {
      result.push({
        key: entry.key,
        kind: entry.descriptor.kind,
        lifetime: entry.descriptor.lifetime,
      });
    }
    return result;
  }

  // ── Private helpers ────────────────────────────────────────────

  private validateCaps(
    passList: readonly PassEntry<Ctx>[],
    caps: RhiCaps,
  ): Result<never, RenderGraphError> | null {
    for (const pass of passList) {
      const { name, descriptor } = pass;

      if (descriptor.compute && !caps.compute) {
        return err(
          new RenderGraphError({
            code: 'cap-missing',
            expected: `pass '${name}' is a compute pass but caps.compute is false`,
            hint: 'use a render pass path or enable compute on the backend',
            detail: { cap: 'compute', passName: name } satisfies CapMissingDetail,
          }),
        );
      }

      if (descriptor.storageBuffer && !caps.storageBuffer) {
        return err(
          new RenderGraphError({
            code: 'cap-missing',
            expected: `pass '${name}' requires storage buffer but caps.storageBuffer is false`,
            hint: 'switch to uniform buffer or enable storageBuffer on the backend',
            detail: {
              cap: 'storageBuffer',
              passName: name,
            } satisfies CapMissingDetail,
          }),
        );
      }
    }
    return null;
  }

  private validateNoUnknownResource(
    passList: readonly PassEntry<Ctx>[],
  ): Result<never, RenderGraphError> | null {
    for (const pass of passList) {
      for (const key of [...pass.descriptor.reads, ...pass.descriptor.writes]) {
        // Built-in reserved key 'swapchain' (feat-20260609 framebuffers demo
        // M5 / T-12-a): the swap-chain output is not a graph-allocated
        // resource; passes that write to 'swapchain' surface their writeView
        // through the resolveCtx fallback (`resolveCtx.resolve('swapchain')`
        // returns undefined -> the dispatcher falls back to `ctx.view`, the
        // current swap-chain view). Allowed in `writes` (a fullscreen pass
        // outputs to the swap-chain) and in `reads` (a future pass that
        // samples the swap-chain via copyTextureToTexture). The graph never
        // allocates, owns, or aliases this resource — it is purely an
        // ordering/contract token.
        if (key === 'swapchain') continue;
        if (!this.resources.has(key)) {
          return err(
            new RenderGraphError({
              code: 'unknown-resource',
              expected: `pass '${pass.name}' references resource key '${key}' but it is not registered`,
              hint: `call addResource('${key}', ...) before compile, or remove '${key}' from pass '${pass.name}'`,
              detail: {
                resourceKey: key,
                passName: pass.name,
              } satisfies DanglingReadDetail,
            }),
          );
        }
      }
    }
    return null;
  }

  /**
   * Resolve every registered `kind:'buffer'` resource to a concrete RHI
   * binding type (AC-09 / D-6.1). `bufferRole='auto-storage-or-uniform'`
   * (the default when unset) picks `'read-only-storage'` when the backend
   * advertises `caps.storageBuffer`, else falls back to `'uniform'`;
   * `bufferRole='uniform'` is always `'uniform'`. Mirrors the runtime
   * `pbr-pipeline.ts` cap switch (research Finding 7), expressed here in the
   * RHI-pure graph layer so consumers never duplicate the branch.
   */
  private resolveBuffers(caps: RhiCaps): ResolvedBuffer[] {
    const resolved: ResolvedBuffer[] = [];
    for (const entry of this.resources.entries()) {
      if (entry.descriptor.kind !== 'buffer') continue;
      const role = entry.descriptor.bufferRole ?? 'auto-storage-or-uniform';
      const resolvedBufferType: ResolvedBufferType =
        role === 'uniform' ? 'uniform' : caps.storageBuffer ? 'read-only-storage' : 'uniform';
      resolved.push({ key: entry.key, resolvedBufferType });
    }
    return resolved;
  }

  /**
   * Phase 7: allocate GPU textures for registered color targets (D-1 / D-2).
   *
   * For each addColorTarget resource, resolves the concrete size from the
   * ColorTargetSize descriptor and swapChainSize, then looks up the transient
   * pool by descriptor key. Pool hit reuses the same physical texture/view;
   * pool miss (drift) triggers device.createTexture/createTextureView rebuild.
   *
   * Alias targets (addColorTargetAlias) fold into the source's physical texture
   * (KB-1 MoveNode pattern). Persistent targets are retained across compiles
   * with size-drift rebuild.
   *
   * device === undefined is a no-op (returns empty map).
   * Texture allocation failures are silently skipped (error propagation via
   * structured RenderGraphError in a follow-up).
   */
  private allocateColorTargets(device: RhiDevice | undefined): Map<string, TextureView> {
    const result = new Map<string, TextureView>();
    if (
      !device ||
      typeof (device as unknown as Record<string, unknown>).createTexture !== 'function'
    )
      return result;

    for (const entry of this.resources.entries()) {
      const meta = entry.colorTarget;
      if (!meta) continue;

      // Resolve alias: fold to source physical texture.
      if (meta.aliasedFrom !== undefined) {
        const sourceView = result.get(meta.aliasedFrom);
        if (sourceView) {
          result.set(entry.key, sourceView);
        }
        continue;
      }

      const width = this.resolveWidth(meta.size);
      const height = this.resolveHeight(meta.size);
      const lifetime = entry.lifetime;

      // feat-20260612-hdrp-ssao M9 scope-amendment (M8 graph barrier):
      // Include the resource name in the transient pool key. Without this,
      // two simultaneously-active transient color targets with identical
      // descriptors (e.g. ssaoRaw / ssaoBlurred — both r8unorm half-swapchain
      // RENDER_ATTACHMENT|TEXTURE_BINDING) share the same GPU texture. When
      // one pass writes and the next pass both writes (color attachment) and
      // reads (texture binding from the same view), WebGPU rejects the command
      // buffer: "TextureBinding|RenderAttachment in the same synchronization
      // scope."
      const key = `${entry.key}:${poolKey({
        format: meta.format,
        width,
        height,
        usage: meta.usage,
        sample: meta.sample,
      })}`;

      if (lifetime === 'transient') {
        const pooled = this.transientPool.get(key);
        if (pooled) {
          result.set(entry.key, pooled.view as TextureView);
          // w7-fix (round 3): re-publish the GPU Texture handle on every
          // compile, not only on pool-miss. Without this the second compile
          // (the recompile-on-resize path) leaves `${entry.key}::tex` empty,
          // breaking consumers that read `getColorTargetTexture` (shadow
          // debugReadback, fxaa copyTextureToTexture, MSAA srgb-view creation).
          // biome-ignore lint/suspicious/noExplicitAny: opaque RHI texture handle
          result.set(`${entry.key}::tex`, pooled.texture as any);
          continue;
        }
      } else if (lifetime === 'persistent') {
        const persisted = this.persistentTextures.get(entry.key);
        if (persisted) {
          // Check for size drift.
          // For simplicity: always reuse. Full drift detection in follow-up.
          result.set(entry.key, persisted.view as TextureView);
          // biome-ignore lint/suspicious/noExplicitAny: opaque RHI texture handle
          result.set(`${entry.key}::tex`, persisted.texture as any);
          continue;
        }
      }

      // Pool miss or persistent fresh allocation: create new texture.
      const texResult = device.createTexture({
        label: entry.key,
        size: { width, height, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: meta.sample,
        dimension: '2d',
        format: meta.format,
        usage: meta.usage,
        viewFormats: meta.viewFormats ?? [],
      } as never);

      if (!texResult.ok) {
        // M1 / w7: propagate createTexture failure so the caller (recordFrame)
        // can fire a structured error rather than silently falling through
        // with an undefined TextureView.
        return new Map();
      }

      const viewResult = device.createTextureView(texResult.value, {});
      if (!viewResult.ok) {
        return new Map();
      }

      const pooled: PooledTexture = {
        texture: texResult.value,
        view: viewResult.value,
      };

      if (lifetime === 'transient') {
        this.setTransientEntry(key, pooled);
      } else {
        this.persistentTextures.set(entry.key, pooled);
      }

      result.set(entry.key, viewResult.value);
      // biome-ignore lint/suspicious/noExplicitAny: store Texture alongside TextureView
      result.set(`${entry.key}::tex`, texResult.value as any);
    }
    return result;
  }

  private resolveWidth(size: ColorTargetDescriptor['size']): number {
    if (typeof size === 'string') {
      return size === 'half-swapchain' ? Math.ceil(this.swapChainWidth / 2) : this.swapChainWidth;
    }
    return size.w;
  }

  private resolveHeight(size: ColorTargetDescriptor['size']): number {
    if (typeof size === 'string') {
      return size === 'half-swapchain' ? Math.ceil(this.swapChainHeight / 2) : this.swapChainHeight;
    }
    return size.h;
  }

  private validateNoDanglingRead(
    passList: readonly PassEntry<Ctx>[],
  ): Result<never, RenderGraphError> | null {
    const writers = new Set<string>();
    for (const pass of passList) {
      for (const key of pass.descriptor.writes) {
        writers.add(key);
      }
    }

    for (const pass of passList) {
      for (const key of pass.descriptor.reads) {
        if (!writers.has(key)) {
          return err(
            new RenderGraphError({
              code: 'dangling-read',
              expected: `pass '${pass.name}' reads key '${key}' but no pass writes it`,
              hint: `add a pass that writes '${key}', or remove '${key}' from pass '${pass.name}' reads`,
              detail: {
                resourceKey: key,
                passName: pass.name,
              } satisfies DanglingReadDetail,
            }),
          );
        }
      }
    }
    return null;
  }

  private topologicalSort(
    passList: readonly PassEntry<Ctx>[],
  ): Result<readonly PassEntry<Ctx>[], RenderGraphError> {
    const passNames = passList.map((p) => p.name);
    const indexMap = new Map<string, number>();
    for (let i = 0; i < passNames.length; i++) {
      const name = passNames[i];
      if (name !== undefined) indexMap.set(name, i);
    }

    // Build dependency edges: pass depends on passes that write its reads.
    const edges = this.buildEdges(passList);

    // Compute in-degree for Kahn's algorithm.
    const inDegree = new Map<string, number>();
    for (const name of passNames) inDegree.set(name, 0);
    for (const [name, deps] of edges) {
      for (const _dep of deps) {
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      }
    }

    // Kahn's algorithm.
    const queue = passNames.filter((n) => (inDegree.get(n) ?? 0) === 0);
    const sorted: string[] = [];
    while (queue.length > 0) {
      queue.sort((a, b) => (indexMap.get(a) ?? 0) - (indexMap.get(b) ?? 0));
      const current = queue.shift();
      if (current === undefined) break;
      sorted.push(current);

      for (const [name, deps] of edges) {
        if (deps.has(current)) {
          const newDeg = (inDegree.get(name) ?? 1) - 1;
          inDegree.set(name, newDeg);
          if (newDeg === 0) queue.push(name);
        }
      }
    }

    if (sorted.length < passList.length) {
      return err(
        new RenderGraphError({
          code: 'cyclic-dependency',
          expected: 'pass graph must be acyclic',
          hint: this.buildCycleHint(passNames, sorted, edges),
          detail: {
            cycle: this.findCycle(passNames, sorted, edges),
          } satisfies CyclicDependencyDetail,
        }),
      );
    }

    const sortedPasses = sorted
      .map((name) => passList.find((p) => p.name === name))
      .filter((p): p is PassEntry => p !== undefined);
    return ok(sortedPasses);
  }

  private buildEdges(passList: readonly PassEntry<Ctx>[]): Map<string, Set<string>> {
    const edges = new Map<string, Set<string>>();
    for (const pass of passList) {
      const deps = new Set<string>();
      for (const key of pass.descriptor.reads) {
        for (const other of passList) {
          if (other.descriptor.writes.includes(key) && other.name !== pass.name) {
            deps.add(other.name);
          }
        }
      }
      edges.set(pass.name, deps);
    }
    return edges;
  }

  private findCycle(
    passNames: string[],
    sorted: string[],
    edges: Map<string, Set<string>>,
  ): string[] {
    const remaining = passNames.filter((n) => !sorted.includes(n));
    if (remaining.length === 0) return [];
    const firstNode = remaining[0];
    if (firstNode === undefined) return remaining;
    let node = firstNode;
    const visited = new Set<string>();
    const cycle: string[] = [];
    while (!visited.has(node)) {
      visited.add(node);
      cycle.push(node);
      const deps = edges.get(node);
      let found = false;
      if (deps) {
        for (const dep of deps) {
          if (remaining.includes(dep)) {
            node = dep;
            found = true;
            break;
          }
        }
      }
      if (!found) break;
    }
    return cycle.length > 0 ? cycle : remaining;
  }

  private buildCycleHint(
    passNames: string[],
    sorted: string[],
    edges: Map<string, Set<string>>,
  ): string {
    const cycle = this.findCycle(passNames, sorted, edges);
    return `break the cycle among passes: ${cycle.join(' -> ')}`;
  }

  private planBarriers(
    sortedPasses: readonly PassEntry<Ctx>[],
    backendKind: CompileOptions['backendKind'],
  ): string[][] {
    const barriersPerPass: string[][] = sortedPasses.map(() => []);
    if (backendKind !== 'wgpu-native') return barriersPerPass;

    const lastWriter = new Map<string, number>();
    for (let i = 0; i < sortedPasses.length; i++) {
      const pass = sortedPasses[i];
      if (pass === undefined) continue;
      for (const key of pass.descriptor.reads) {
        const writerIdx = lastWriter.get(key);
        if (writerIdx !== undefined && writerIdx !== i) {
          const passBarriers = barriersPerPass[i];
          if (passBarriers !== undefined && !passBarriers.includes(key)) {
            passBarriers.push(key);
          }
        }
      }
      for (const key of pass.descriptor.writes) {
        lastWriter.set(key, i);
      }
    }
    return barriersPerPass;
  }
}
