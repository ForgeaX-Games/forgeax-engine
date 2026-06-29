// vitest.setup-webgpu.ts — dawn.node native binding setup for vitest `dawn` project.
//
// race-window mitigation: bug-20260511-dawn-worker-glibc-pthread-mutex-crash
// race-window narrowing rationale: see .forgeax-harness/forgeax-loop/bug-20260511-dawn-worker-glibc-pthread-mutex-crash/research.md §F-5
//
// 4-step teardown design (see afterAll below; plan-strategy §2 K-1):
//   1. device.destroy()              — drop GPU resources owned by every tracked device
//   2. queue.onSubmittedWorkDone()   — flush pending submitted work as an in-process barrier
//   3. delete globalThis.navigator.gpu — drop the only handle dawn-node exposes for instance teardown
//   4. await setTimeout 100 ms       — yield to dawn-node native pthread cleanup, collapsing the
//                                      Linux+lavapipe race window observed in CI before this fix
// Each step wraps errors in explicit console.error rather than swallow, per AI User Charter
// proposition 4 (explicit failure beats silent error); see plan-strategy §3 R-6.
//
// New .dawn.test.ts files do not need to repeat any afterAll logic in their own file:
// setup-webgpu.ts hooks globalThis.navigator.gpu.requestAdapter -> adapter.requestDevice
// to track every GPUDevice created by any dawn-project test, so the 4-step teardown
// covers them automatically (plan-strategy §7.4 discoverability — adding new
// .dawn.test.ts files inherits the mitigation for free).
//
// Referenced by root vitest.config.ts dawn project `setupFiles` (K-4 naming convention).
// dawn project test files (`**/*.dawn.test.ts`) execute under node env; we need to
// mount the dawn.node-created GPU instance on global `globalThis.navigator.gpu` and
// inject spec constants such as `GPUBufferUsage` into globalThis.
//
// research §1 Finding 1.3 integration pattern:
//   import { create, globals } from 'webgpu'  (K-2 correction: package name is `webgpu`,
//                                              not `@webgpu/dawn-node`)
//   Object.assign(globalThis, globals)         (inject GPUBufferUsage and other constants)
//   globalThis.navigator.gpu = create([])     (empty flags array)
//
// research §1 Finding 1.4 critical pitfalls:
//   - macOS Gatekeeper `com.apple.quarantine`: when first require fails, manually run
//     `xattr -d com.apple.quarantine node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist/*.dawn.node`
//     (cannot install with --ignore-scripts).
//   - chromium issue 387965810 — `globalThis.navigator.gpu` global pollution prevents
//     the node process from exiting; R10 mitigation: explicitly delete the reference in `afterAll`.
//   - dawn.node lacks `HTMLCanvasElement` / `VideoFrame` / `HTMLImageElement`;
//     `*.dawn.test.ts` cases focus on command recording + queue.submit + GPUBuffer readback,
//     not relying on canvas DOM.
//
// F-1 / D-P2 revision — structured wrapping of dawn.node binding errors:
//   When `create([])` throws (missing prebuild / Gatekeeper / unsupported platform), catch +
//   rethrow a structured Error containing `code` / `hint` fields; raw exceptions must not
//   propagate through (charter proposition 4 explicit failure: same structured channel as
//   the silent-skip fix). AI users can identify the root cause by reading the reason in the
//   vitest report; no need to assert against error message strings.

import { afterAll } from 'vitest';

let gpuRefCleanup: (() => void) | undefined;

// trackedDevices: M2 t-010 module-scoped collector for every GPUDevice created via the
// installed globalThis.navigator.gpu. afterAll's 4-step teardown (M2 t-011) iterates this
// Set to call device.destroy() + queue.onSubmittedWorkDone() before instance-level cleanup.
// Naming follows plan-strategy §7.2 — no abbreviation (no `td` / `devs`).
const trackedDevices = new Set<GPUDevice>();

try {
  // dawn.node binding entry; create / globals are provided by require dist/<platform>.dawn.node.
  const { create, globals } = await import('webgpu');
  // Inject spec global constants (GPUBufferUsage / GPUTextureUsage / GPUMapMode, etc.).
  Object.assign(globalThis as Record<string, unknown>, globals);
  // Fallback globalThis.navigator placeholder (node has none by default).
  if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {} as Navigator,
      configurable: true,
      writable: true,
    });
  }
  // create([]) — empty flags array (spec: reserved for future flag extension).
  const gpu = create([]);
  // M2 t-010: shim requestAdapter -> requestDevice to collect every created GPUDevice.
  // Wrapping at gpu.requestAdapter is the single chokepoint covering all *.dawn.test.ts
  // entry paths (research §F-1/§F-2 — every test calls navigator.gpu.requestAdapter()).
  // Tracking by device reference (not adapter) is required because requestAdapter returns
  // a fresh proxy each call (M1 probe §5); adapter identity cannot be used for dedup.
  const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
  (gpu as { requestAdapter: typeof gpu.requestAdapter }).requestAdapter = async (
    ...adapterArgs: Parameters<typeof gpu.requestAdapter>
  ) => {
    const adapter = await originalRequestAdapter(...adapterArgs);
    if (adapter) {
      const originalRequestDevice = adapter.requestDevice.bind(adapter);
      (adapter as { requestDevice: typeof adapter.requestDevice }).requestDevice = async (
        ...deviceArgs: Parameters<typeof adapter.requestDevice>
      ) => {
        const device = await originalRequestDevice(...deviceArgs);
        trackedDevices.add(device);
        if (process.env.FORGEAX_SETUP_DEBUG === '1') {
          console.error('[setup-webgpu] tracked device count=', trackedDevices.size);
        }
        return device;
      };
    }
    return adapter;
  };
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  // bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so the
  // pre-existing dawn-node test fleet (MSAA target / FXAA dispatcher / urp-pipeline.ts:185-192
  // / render-graph-primitives.ts:506 — all hardcoded rgba8unorm viewFormats) keeps using the
  // rgba8unorm-based swap-chain + MSAA + FXAA fixture chain. Browser project (test:browser)
  // does NOT load this setup file and validates the real Channel 2 BGRA path through the
  // canvas helper unmodified. Plan §4 R-5 anticipated 'pipeline format mismatch ... one of
  // the 8 callsites missed a rewrite'; rather than thread the M2 helper output into every dawn fixture
  // (large blast radius), we narrow the dawn surface to RGBA. Dawn-node's actual return value
  // varies per platform — patch is idempotent if it already returns 'rgba8unorm'.
  (gpu as { getPreferredCanvasFormat: () => GPUTextureFormat }).getPreferredCanvasFormat = () =>
    'rgba8unorm';
  gpuRefCleanup = () => {
    // R10 / chromium issue 387965810 mitigation: drop the reference at test teardown to
    // mitigate node process not exiting.
    delete (globalThis.navigator as { gpu?: unknown }).gpu;
  };
} catch (err: unknown) {
  // F-1 revision (D-P2): on dawn.node binding failure, rethrow in structured form — same
  // approach as the silent-skip fix. AI users read reason / code in the vitest report to
  // identify the root cause; raw err must not propagate through (charter proposition 4
  // explicit failure).
  const rawMessage = err instanceof Error ? err.message : String(err);
  const platform = `${process.platform}-${process.arch}`;
  const hint =
    platform === 'darwin-arm64' || platform === 'darwin-x64'
      ? 'macOS Gatekeeper blocked — run `xattr -d com.apple.quarantine node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist/*.dawn.node`'
      : `check whether the webgpu npm package has a ${platform} prebuild; for fallback path see plan-strategy K-6 / R10`;
  // structured throw — single-line `throw new Error(...code: ...)` shape matches the
  // plan-tasks w10 acceptanceCheck grep gate `throw\s+(new\s+)?Error\(.*code\s*:`.
  // Embedding code: and hint: inside the error message literal (vitest reporter prints it
  // directly) lets AI users identify the root cause by reading the message (charter
  // proposition 4 explicit failure: same structured channel as the silent-skip fix).
  // `{ cause: err }` propagates the original dawn.node exception for stack-trace debugging.
  throw new Error(`[setup-webgpu] code: 'dawn-binding-failed'; hint: ${hint}; raw: ${rawMessage}`, {
    cause: err,
  });
}

afterAll(async () => {
  // M2 t-011 — 4-step lifecycle teardown for bug-20260511 race-window mitigation
  // (plan-strategy §2 K-1). Each step is wrapped in try/catch with explicit console.error
  // (AI User Charter proposition 4 — explicit failure beats silent swallow; plan-strategy §3 R-6).
  //
  // Step 1: device.destroy() — synchronous void per M1 probe (m1-dawn-node-api-probe.md);
  //   do NOT await the return value. Iterate trackedDevices populated by the requestDevice
  //   shim above.
  for (const device of trackedDevices) {
    try {
      device.destroy?.();
    } catch (err) {
      console.error('[setup-webgpu teardown] step 1 device.destroy failed:', err);
    }
  }
  // Step 2: queue.onSubmittedWorkDone() — M1 probe verified 0ms resolve post-destroy
  //   (no throw, no hang). Acts as an in-process barrier ensuring submitted work signals
  //   completion before instance teardown.
  for (const device of trackedDevices) {
    try {
      await device.queue?.onSubmittedWorkDone?.();
    } catch (err) {
      console.error('[setup-webgpu teardown] step 2 onSubmittedWorkDone failed:', err);
    }
  }
  trackedDevices.clear();
  // Step 3: delete globalThis.navigator.gpu reference — R10 / chromium issue 387965810
  //   mitigation; dawn-node has no instance-level destroy (M1 probe §3), reference
  //   deletion is the only handle. gpuRefCleanup wraps `delete (globalThis.navigator as
  //   { gpu?: unknown }).gpu` (declared above); fall back to inline delete if the binding
  //   import failed and gpuRefCleanup never got assigned.
  try {
    if (gpuRefCleanup) {
      gpuRefCleanup();
    } else {
      delete (globalThis.navigator as { gpu?: unknown }).gpu;
    }
  } catch (err) {
    console.error('[setup-webgpu teardown] step 3 delete navigator.gpu failed:', err);
  }
  // Step 4: 100 ms microwait — collapse the race window by yielding to dawn-node's
  //   internal native pthread cleanup (plan-strategy §2 K-3, hardcoded magnitude).
  await new Promise((resolve) => setTimeout(resolve, 100));
});
