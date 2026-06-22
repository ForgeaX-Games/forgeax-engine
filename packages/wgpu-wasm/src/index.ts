// packages/wgpu-wasm/src/index.ts — ensureReady singleton wrapper (plan-strategy D-P3 /
// research F-4).
//
// SSOT for wasm init across all consumers (@forgeax/engine-rhi-wgpu + @forgeax/engine-naga thin shells).
// The single-Promise cache + null-reset-on-rejection semantics is required so that:
//
// 1. Multiple thin shells calling ensureReady() concurrently share one wasm instance
//    (charter proposition 6 Idempotency: reference equality across calls).
// 2. The wasm boundary is crossed exactly once per page lifecycle — a second call
//    after success returns the same wasm namespace without re-running init().
// 3. A transient init failure (e.g. fetch jitter) null-resets the cached Promise;
//    subsequent calls re-attempt _loadWasm() (charter proposition 4 explicit failure:
//    the original error is surfaced on each attempt, but the caller may retry).
//
// Three-scenario wasm asset resolution (research F-4):
// - Browser / Vite: the Vite ?url import resolves to a fetch-able asset URL.
// - Node runtime (no Vite): detected via process.versions.node + absent document;
//   the wasm bytes are read via fs.readFile relative to import.meta.url.
// - vitest node environment: the ?url import resolves through Vite's bundler to a
//   file:// URL, but the Node branch above takes precedence so the wasm bytes are
//   loaded synchronously before init().

import init, * as wasm from '../pkg/wgpu_wasm.js';

/**
 * The typed wasm namespace surface (camelCase per wasm-bindgen `js_name` rewrites).
 *
 * Consumers (@forgeax/engine-rhi-wgpu / @forgeax/engine-naga thin shells) destructure or call
 * methods directly: `const adapter = await wasm.RhiWgpuInstance.create()`,
 * `const parsed = wasm.parse(source)`, etc.
 */
export type WgpuWasm = typeof wasm;

/** @internal */
let _instance: Promise<WgpuWasm> | null = null;

/**
 * Initialise the merged wgpu + naga wasm module (or return the cached instance).
 *
 * Idempotent: N calls return the same Promise reference. The Promise resolves to
 * the same wasm namespace reference across N awaits (charter proposition 6).
 *
 * Null-reset on transient failure: if the underlying `init(wasmUrl)` rejects,
 * the cached Promise is cleared (set to null) so the next call retries
 * `_loadWasm()` (charter proposition 4 explicit failure; transient errors such
 * as fetch jitter are recoverable by the caller without manual reset).
 */
// Avoid @types/node devDep (mirror @forgeax/engine-math + @forgeax/engine-shader-compiler strategy).
// The process value on globalThis is fetched via an unknown bridge; runtime detection
// plus the dynamic import('node:*') module id are transparent to ts-strict.
interface NodeProcessLike {
  readonly versions?: { readonly node?: string };
}
interface NodeFsLike {
  readFile(path: string): Promise<Uint8Array>;
}
interface NodeUrlLike {
  fileURLToPath(url: URL): string;
}

async function _loadWasm(): Promise<WgpuWasm> {
  // Branch: Node when process.versions.node exists. Browser path is the default
  // wasm-bindgen fetch via the Vite-resolved ?url asset string.
  const proc = (globalThis as unknown as { process?: NodeProcessLike }).process;
  const isNode = typeof proc?.versions?.node === 'string';

  // Reach packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm relative to this module
  // (src/index.ts during vitest; dist/index.mjs after tsup build — both sit
  // one directory up from pkg/). This URL form works in both Node and browser
  // import.meta contexts and avoids the Vite-only `?url` suffix at module
  // top level (which Node interprets as a wasm module import).
  const wasmPath = new URL('../pkg/wgpu_wasm_bg.wasm', import.meta.url);

  if (isNode) {
    // Dynamic imports via string literals avoid triggering missing @types/node
    // errors during ts static resolution.
    const fsModuleId = 'node:fs/promises';
    const urlModuleId = 'node:url';
    const fs = (await import(/* @vite-ignore */ fsModuleId)) as NodeFsLike;
    const url = (await import(/* @vite-ignore */ urlModuleId)) as NodeUrlLike;
    const wasmBytes = await fs.readFile(url.fileURLToPath(wasmPath));
    await init({ module_or_path: wasmBytes });
  } else {
    await init(wasmPath);
  }
  return wasm as WgpuWasm;
}

export const ensureReady = (): Promise<WgpuWasm> => {
  if (!_instance) {
    _instance = _loadWasm().catch((e: unknown) => {
      _instance = null;
      throw e;
    });
  }
  return _instance;
};

/**
 * Test-only: reset the cached instance so a subsequent ensureReady() re-runs init().
 *
 * NOT exported from the package root — consumers should NEVER reset; this helper
 * exists only so the per-package vitest suite can exercise the failure-mode case
 * without process restart. Imported via the relative path inside test files.
 */
export const __resetForTests = (): void => {
  _instance = null;
};
