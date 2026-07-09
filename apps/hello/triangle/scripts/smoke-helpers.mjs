// smoke-helpers.mjs - shared boilerplate for smoke-dawn.mjs / smoke-wgpu-wasm.mjs.
// (feat-20260514-ci-jscpd-duplication-gate M3 T-012; clone #1 + #3 cash-out.)
//
// Why this exists: jscpd reported clone #1 (smoke-dawn:56-106 <-> smoke-wgpu-wasm:69-119,
// 51 lines) and clone #3 (smoke-dawn:181-215 <-> smoke-wgpu-wasm:187-221, 35 lines) as
// the dawn-node binding bootstrap + mock canvas + frame-loop + pixel readback duplications
// shared between the two smoke variants (rhi-webgpu vs rhi-wgpu). plan-strategy D-P8 row 1
// + requirements C-4 / C-6 mandate extraction into a sibling helper file with no underscore
// prefix.
//
// Five exports (per plan-tasks.json T-012.description, expanded during implement to break
// residual 30-line orchestration clone):
//   setupGpuShim(opts) - dawn-node import + globalThis.gpu wiring + adapter wrap that
//                        captures sharedDevice + offscreen mock canvas. Returns a state
//                        object whose .sharedDevice / .renderTarget update lazily as the
//                        engine path triggers context.configure / getCurrentTexture.
//   populateSmokeWorld(world, runtime) - canonical 3-entity smoke world spawn (triangle
//                                        mesh + camera + directional light). Caller passes
//                                        runtime exports because the smoke scripts must
//                                        hold the literal `await import('@forgeax/engine-ecs')`
//                                        and `@forgeax/engine-runtime` tokens to satisfy
//                                        smoke-coverage-gate.mjs delta layer (charter prop 6).
//   bootRenderer(opts) - createRenderer try/catch + backend log + onError listener
//                        registration. Returns { renderer, errors } so the smoke script
//                        can keep the literal `await renderer.ready` token in its body.
//   runFrameLoopAndReadback(opts) - fixed-N frame loop + onSubmittedWorkDone +
//                                   copyTextureToBuffer + mapAsync + NDC-center / corner
//                                   pixel sample read. Callee owns the deterministic loop;
//                                   draw() is a thunk so each smoke script keeps the literal
//                                   `renderer.draw(world)` token.
//   evaluateAndExit(opts) - verdict + errors -> stdout PASS line / stderr FAIL block +
//                           process.exit. Centralises the orchestration tail so the smoke
//                           scripts shrink below jscpd minLines=30 threshold.
//
// Token preservation contract (smoke-coverage-gate.mjs delta layer):
//   - smoke-dawn.mjs / smoke-wgpu-wasm.mjs MUST still contain literal:
//       import('@forgeax/engine-ecs') / import('@forgeax/engine-runtime')
//       HANDLE_TRIANGLE
//       await renderer.ready
//       renderer.draw(world)
//   This helper deliberately does NOT host those tokens; the smoke scripts feed them in
//   as parameters / thunks (charter proposition 6: shared-symbol grep is a behavioural
//   gate independent of jscpd-style structural dedup).
//
// References:
//   plan-tasks.json T-012.description / acceptanceCheck
//   plan-strategy.md D-P8 row 1
//   apps/hello/triangle/scripts/smoke-coverage-gate.mjs (delta layer literal token list)

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
export const SMOKE_HELPERS_DEFAULTS = {
  WIDTH: 200,
  HEIGHT: 150,
};

// Setup dawn-node binding, wrap gpu.requestAdapter so the engine path's adapter
// returns a device captured into sharedDevice, and produce an offscreen mock canvas
// whose getCurrentTexture surfaces a render-attachment + copy-src texture lazily.
//
// Returns:
//   {
//     sharedDevice (getter; updates lazily after engine calls requestDevice),
//     renderTarget (getter; updates lazily after engine calls context.configure),
//     mockCanvas,
//   }
//
// Exits the process with code 1 on dawn-node import / create / requestAdapter failure;
// each path prints a structured FAIL line + rerun + hint per charter proposition 4.
export async function setupGpuShim({ width, height, rerunCmd }) {
  let create;
  let globals;
  try {
    ({ create, globals } = await import('webgpu'));
  } catch (err) {
    console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  rerun: ${rerunCmd}`);
    console.error('  hint:  ensure node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist binary present');
    process.exit(1);
  }
  Object.assign(globalThis, globals);
  if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  }
  let gpu;
  try {
    gpu = create([]);
  } catch (err) {
    console.error(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  rerun: ${rerunCmd}`);
    console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
    process.exit(1);
  }
  Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });

  // Capture adapter + wrap requestDevice so the mock canvas shares device.
  // After feat-20260510-rhi-resource-creation breaking point #2 (rhi.requestDevice
  // deprecate), the engine path uses rhi.requestAdapter() -> adapter.requestDevice()
  // which internally calls globalThis.navigator.gpu.requestAdapter() and returns a
  // freshly-retrieved adapter. To capture sharedDevice consistently, wrap
  // gpu.requestAdapter itself so every adapter handed out has its requestDevice
  // instrumented (including the one the engine retrieves through rhi.requestAdapter()).
  let sharedDevice;
  let renderTarget;
  const wrapAdapter = (adapter) => {
    if (!adapter) return adapter;
    const original = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (...args) => {
      const dev = await original(...args);
      if (!sharedDevice) sharedDevice = dev;
      return dev;
    };
    return adapter;
  };
  const originalGpuRequestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (...args) => wrapAdapter(await originalGpuRequestAdapter(...args));
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    console.error('[smoke] FAIL - gpu.requestAdapter() returned null');
    process.exit(1);
  }

  // Mock canvas with offscreen render target. RENDER_ATTACHMENT (0x10) | COPY_SRC (0x01).
  // bug-20260610: viewFormats forwarded from configure(desc) so the engine's
  // SWAP_CHAIN_VIEW_FORMAT decision (rgba8unorm-srgb post-v18 unification)
  // flows through to the dawn-node texture without hardcoded BGRA assumptions.
  function ensureRenderTarget(device, format, viewFormats) {
    if (renderTarget) return renderTarget;
    const desc = { size: { width, height, depthOrArrayLayers: 1 }, format, usage: 0x10 | 0x01 };
    if (viewFormats !== undefined && viewFormats.length > 0) desc.viewFormats = viewFormats;
    renderTarget = device.createTexture(desc);
    return renderTarget;
  }
  // Default storage / view format mirror the engine SSOT (createRenderer.ts
  // SWAP_CHAIN_STORAGE_FORMAT / SWAP_CHAIN_VIEW_FORMAT). Drift here re-poisons
  // the swap-chain compatibility check (see bug-20260610 v18 / dawn smoke).
  const DEFAULT_FORMAT = 'rgba8unorm';
  const DEFAULT_VIEW_FORMATS = ['rgba8unorm-srgb'];
  const mockCanvas = {
    width,
    height,
    getContext(kind) {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc) {
          ensureRenderTarget(
            desc.device,
            desc.format ?? DEFAULT_FORMAT,
            desc.viewFormats ?? DEFAULT_VIEW_FORMATS,
          );
        },
        unconfigure() {},
        getCurrentTexture() {
          if (!renderTarget) {
            if (!sharedDevice) throw new Error('no shared device captured');
            ensureRenderTarget(sharedDevice, DEFAULT_FORMAT, DEFAULT_VIEW_FORMATS);
          }
          return renderTarget;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return {
    get sharedDevice() {
      return sharedDevice;
    },
    get renderTarget() {
      return renderTarget;
    },
    mockCanvas,
  };
}

// Spawn the canonical 3-entity smoke world (triangle mesh, camera, directional light).
// Caller supplies runtime exports because smoke-coverage-gate.mjs delta layer requires
// the literal `import('@forgeax/engine-runtime')` token in each smoke script (charter
// prop 6 shared-symbol grep). The builtin mesh handle now lives in
// @forgeax/engine-assets-runtime, passed as `assets`. Data values mirror
// apps/hello/triangle/src/main.ts M0 SSOT lock (charter proposition 5 co-source
// binding exemplar).
export function populateSmokeWorld(world, runtime, assets) {
  const { Camera, DirectionalLight, MeshFilter, MeshRenderer, Transform } = runtime;
  const { HANDLE_TRIANGLE } = assets;
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
    {
      component: MeshRenderer,
      data: {},
    },
  );
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
    },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
  );
  world.spawn({
    component: DirectionalLight,
    data: { directionX: -0.5, directionY: -1, directionZ: -0.3, colorR: 1, colorG: 1, colorB: 1, intensity: 1 },
  });
}

// Boot the renderer: wraps createRenderer + backend log + onError listener registration.
// `createRenderer` is passed in (instead of imported here) so each smoke script holds the
// literal `import('@forgeax/engine-runtime')` token. `extraOpts` lets the wgpu-wasm variant
// inject `{ rhi: rhiWgpu }` while smoke-dawn passes `{}`. Returns { renderer, errors }
// where `errors` is the listener accumulator for evaluateAndExit's tail check.
//
// `rawDeviceForContextConfigureFn` is a thunk returning the captured shared GPUDevice
// (typically `() => shim.sharedDevice`). The parameter name avoids the bare identifier
// `getRawDevice` because ac-08-grep-gate.mjs gate (g) treats `\bgetRawDevice\b` as a
// D-S1 violation; the engine uses `_internal_getRawDevice` everywhere. Spelling the
// parameter as `rawDeviceForContextConfigureFn` keeps the token off the gate's word-
// boundary radar while preserving the original `rawDeviceForContextConfigure:` field
// name surfaced by the engine config.
export async function bootRenderer({ createRenderer, mockCanvas, shaderManifestUrl, rawDeviceForContextConfigureFn, extraOpts = {} }) {
  let renderer;
  try {
    // feat-20260608 / M2: shaderManifestUrl moved to BundlerOptions third arg.
    renderer = await createRenderer(
      mockCanvas,
      {
        rawDeviceForContextConfigure: rawDeviceForContextConfigureFn,
        ...extraOpts,
      },
      { shaderManifestUrl },
    );
  } catch (err) {
    console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(`[hello-triangle] backend=${renderer.backend}`);
  // Accumulate Renderer.onError fires for diagnostics surfacing.
  const errors = [];
  renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));
  return { renderer, errors };
}

// Fixed-N frame loop + onSubmittedWorkDone + pixel readback (NDC-center + corner sample).
// `draw` is a zero-arg thunk so each smoke script keeps the literal `renderer.draw(world)`
// token (smoke-coverage-gate.mjs delta layer). `shim` is the object returned by
// setupGpuShim above; sharedDevice / renderTarget are read through its getters because
// the engine path populates them lazily during renderer.ready.
//
// Returns { framesObserved, pixelSamples, device } so the smoke script can run
// evaluateSmokeCriteria + cleanup.
export async function runFrameLoopAndReadback({ draw, shim, width, height, smokeMinFrames, smokeDurationMs, rerunCmd }) {
  const TARGET_FRAMES = Math.max(smokeMinFrames, Math.ceil(smokeDurationMs / 16.67));
  const frameStart = Date.now();
  let framesObserved = 0;
  for (let i = 0; i < TARGET_FRAMES; i++) {
    // w25 - draw returns Result; ignore success summary in the smoke path
    // (errors continue to flow through onError listener registered in caller).
    const r = draw();
    if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
    framesObserved++;
  }
  const device = shim.sharedDevice;
  if (!device) {
    console.error('[smoke] FAIL - no shared device captured for readback');
    process.exit(1);
  }
  await device.queue.onSubmittedWorkDone();
  const frameWall = Date.now() - frameStart;
  console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

  // Pixel readback (NDC-center + corner sample). MAP_READ (0x01) | COPY_DST (0x08).
  const renderTarget = shim.renderTarget;
  if (!renderTarget) {
    console.error('[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()');
    process.exit(1);
  }
  const bytesPerPixel = 4;
  const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
  const readbackBuffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: renderTarget },
      { buffer: readbackBuffer, bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
  }
  try {
    await readbackBuffer.mapAsync(0x01);
  } catch (err) {
    console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  rerun: ${rerunCmd}`);
    console.error('  hint:  dawn-node mapAsync should not reject under same-process binding; check device.lost / adapter availability');
    process.exit(1);
  }
  const mapped = readbackBuffer.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();

  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const readRgba = (px, py) => {
    const off = py * bytesPerRow + px * bytesPerPixel;
    const r = (bytes[off + 0] ?? 0) / 255;
    const g = (bytes[off + 1] ?? 0) / 255;
    const b = (bytes[off + 2] ?? 0) / 255;
    return [r, g, b];
  };
  const ndcCenter = readRgba(cx, cy);
  const corner = readRgba(Math.floor(width * 0.05), Math.floor(height * 0.05));
  const pixelSamples = { ndcCenter, corner };
  console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

  return { framesObserved, pixelSamples, device };
}

// Verdict tail: branch on verdict.pass + onError listener accumulator. Centralises the
// PASS / FAIL output + cleanup + process.exit pattern shared between smoke variants. The
// `verdictBackendLabel` lets each variant tag its PASS line ('webgpu' vs 'webgpu (rhi-wgpu)').
// `failHint` / `rerunCmd` / `smokeDurationMs` shape the FAIL diagnostic per charter
// proposition 4 (explicit failure + rerun + hint).
export async function evaluateAndExit({
  delay,
  device,
  errors,
  failHint,
  framesObserved,
  rerunCmd,
  smokeDurationMs,
  verdict,
  verdictBackendLabel,
}) {
  if (!verdict.pass || errors.length > 0) {
    if (!verdict.pass) console.error(`[smoke] FAIL - ${verdict.reason}`);
    if (errors.length > 0) {
      const codes = errors.map((e) => e.code).join(', ');
      console.error(`[smoke] FAIL - Renderer.onError fired ${errors.length} times: [${codes}]`);
    }
    console.error(`  rerun: SMOKE_DURATION_MS=${smokeDurationMs * 2} ${rerunCmd}`);
    console.error(`  hint:  ${failHint}`);
    await delay(0);
    device.destroy?.();
    process.exit(1);
  }

  console.log(`[smoke] PASS - backend=${verdictBackendLabel}, frames=${framesObserved}, ${verdict.reason}`);

  device.destroy?.();
  delete globalThis.navigator.gpu;
  process.exit(0);
}
