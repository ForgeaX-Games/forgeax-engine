# @forgeax/engine-rhi-debug

> RenderDoc-inspired RHI frame record + deterministic replay + offline inspect for forgeax-engine.
> First user is AI subagent; exposed via WS:5732 JSON-RPC, CLI, and direct import.

## Proposition

This package records the **full RHI command surface** -- every encoder and pass-encoder method (except the 5 explicit `DEFERRED_COMMANDS` exemptions) -- into a **tape**. v3 coverage is enforced by a type-level invariant test (exhaustive `keyof` on all three encoder interfaces) -- an ordered sequence of `RhiCallEvent` items plus a hash-deduplicated binary blob pool. The tape can be **replayed** on a fresh `RhiDevice` (caps permitting) and **inspected** at any draw index, yielding bind group bindings, draw call metadata, and RT readback PNGs.

Starting in v2, the tape is **self-contained**: `snapshotResource(handleId)` reads back the actual GPU bytes of live resources at capture-start and stores them as `initialData` events in the tape's bootstrap prefix. Replay follows a strict create-then-seed-then-dispatch order, making the tape independent of any pre-recording command history (e.g., load-time VBO/IBO uploads that happened before the recording window opened).

Three key properties:
- **Proxy-based**: `wrap(rhiInstance)` returns a `DebugRhiInstance` that intercepts all RHI calls without modifying `@forgeax/engine-rhi` or `@forgeax/engine-rhi-webgpu`.
- **Deterministic replay**: on dawn-node, replay RT pixels match original within epsilon <= 0.01 (same device, same caps).
- **AI-friendly**: `fields` cropping avoids context explosion; RT is always a PNG path string, never inline base64.

Enable via `FORGEAX_ENGINE_RHI_DEBUG=1`. When unset, the entire package is tree-shaken from production bundles.

### Layered progressive disclosure (L0 / L1 / L2a / L2c / L3a / L3b / L3c)

The browser-to-CLI loop is: **one line in the browser console to capture a frame -> one line in the CLI to inspect it offline**. Seven layers (three added in PR3 for browser-side inspect without CLI), each usable on its own; the `tapePath` returned at L2a / L2c is the first argument the L3a CLI consumes. L3b and L3c run entirely in the browser -- no Node, no CLI, no dev-server round-trip for inspection.

| layer | surface | entry | output |
|:--|:--|:--|:--|
| **L0** | low-level subpath (raw bytes) | `@forgeax/engine-rhi-debug/capture-browser` -> `captureFramesToMemory(debugInst, frames, label?)` | `CaptureBrowserTape { runId, json, blob, passOffsets, valid }` (in-memory, zero fs/network) |
| **L1** | on-disk tape | POST `/__forgeax-debug/tape` (dev-server) or the Node `finalize()` tail | `.forgeax-debug/<runId>/frame-0.tape.bin` + `frame-0.report.json` (byte-identical from both writers, D-3) |
| **L2a** | external CLI trigger | `forgeax-rhi-debug trigger-browser [--frames=N] [--label=STR] [--dev-url=URL]` | `{ runId, tapePath, reportPath }` -- synchronous round-trip; no browser DevTools console switch |
| **L2c** | one-line browser trigger | `window.__forgeax.captureFrame(n)` (console autocomplete) | `{ runId, tapePath, reportPath }` -- `tapePath` feeds L3a |
| **L3a** | offline CLI inspect | `forgeax-rhi-debug inspect-offline <tapePath> <drawIdx> [--fields=...]` | structured InspectReport JSON (bindings / drawCall / **pipelineState**) + RT PNG path |
| **L3b** | browser per-draw JSON | `@forgeax/engine-rhi-debug/inspect-core` -> `inspectDrawJson(replay, idx, events, device, fields?)` | structured `InspectReport` (bindings + drawCall + pipelineState, no PNG path) |
| **L3c** | browser RT to canvas | `@forgeax/engine-rhi-debug/rt-to-canvas` -> `renderRtToCanvas(replay, idx, device, canvas)` | RT pixels rendered onto external canvas (no fs/pngjs) |
| **L3e** | whole-frame model | `forgeax-rhi-debug summary <tapePath>` (CLI) or `@forgeax/engine-rhi-debug/frame-model` -> `buildFrameModel(tape)` (pure, no GPU) | `FrameModel { meta, tree, draws[] (each with pipelineState), commands, resources }` -- the same model the RHI debug viewer (L3d) renders; the AI inspects the whole frame with the same operation the UI exposes |

L1 is the byte-on-disk handoff: the dev-server POST endpoint and the Node `finalize()` tail both route through the single `assembleReport` writer, so a browser-captured tape and a Node-captured tape are indistinguishable on disk (D-3 / AC-05). L2a and L2c chain straight into L3a -- the `tapePath` they return is the first positional argument of `inspect-offline`. L2a is the Node-side equivalent of L2c: an AI user runs one CLI command instead of switching to the browser DevTools console to type `window.__forgeax.captureFrame(n)`.

**L3a/L3b/L3c now support real demo tapes** (not just self-contained test tapes). The recorder's bootstrap create closure (computed in `getTape()`) prefixes the per-frame events with the transitive closure of all `create*` events needed by the frame's referenced resources, making non-self-contained steady-frame tapes replayable on a fresh device. Swapchain render targets are faithfully recorded as real-size createTexture events (not synthetic 1x1 stand-ins), and bindGroups with real resources (buffer/sampler/textureView) are replayed through `RhiBindingResource {kind,value}` packaging — so real-demo draws with color attachments and full resource bindings are now inspectable at all three L3 layers. A browser captures the canvas swapchain as a `bgra8unorm` texture but views it (and targets it) as `bgra8unorm-srgb`; on offline replay that srgb view over a plain bgra texture is an incompatible-view-format error (surfacing at `beginRenderPass`). `createReplay` adapts the canvas BGRA formats -> `rgba8unorm` (byte-compatible) consistently across createTexture / createTextureView / pipeline target, so a browser-captured tape feeds straight into `createReplay` with no per-script format mutation. `wrap()` must be called before resource creation; otherwise `finalize()` returns `tape-handle-graph-broken` with a finalize-side (bootstrap-table) hint directing the caller to re-capture.

## API

### Core functions

| export | signature | description |
|:--|:--|:--|
| `wrap` | `(instance: RhiInstance): DebugRhiInstance` | Proxy-wrap an RhiInstance. `DebugRhiInstance extends RhiInstance` with added `arm(frames)`, `onFrameEnd()`, `finalize()`, `getTape()`, `getState()`, `getEvents()`, `getBlobPool()`, `transitionToError()`, `disposeError()`, `snapshotResource(handleId)`, `snapshotAllLiveResources()`. |
| `snapshotResource` | `(handleId: HandleId): Promise<Result<{handleId, dataHash}, DebugError>>` | Snapshot a resource's GPU bytes into the tape as an `initialData` event. Reads the resource descriptor from the internal registry, copies bytes via copyToBuffer/mapAsync, stores them in the blobPool with djb2 hash-dedup, and pushes an `RhiCallEventInitialData` into the event stream. Returns `snapshot-readback-failed` on any readback/storeBlob failure. Async because the GPU readback chain (copyToBuffer -> submit -> onSubmittedWorkDone -> mapAsync) is inherently asynchronous. |
| `snapshotAllLiveResources` | `(): Promise<Result<void, DebugError>>` | Frame-header snapshot entry point: awaits all submitted GPU work (`onSubmittedWorkDone`), then iterates the live descriptor registry full-table, calling `snapshotResource` on every entry. Advances the recorder Armed -> Snapshotting -> Recording on success. Returns the first snapshot failure as a Result — fail-fast, not partial seed (architecture section 5). This is the function AC-01 tests call; `snapshotResource` is the per-resource building block it loops over. |
| `wrapCreateShaderModule` | `(originalFn: CreateShaderModuleFn, debugInst: DebugRhiInstance): CreateShaderModuleFn` | Standalone wrapper for `createShaderModule` (which is not on `RhiDevice` in rhi-webgpu). Records `createShaderModule` events in the tape. |
| `createReplay` | `(tape: Tape, device: RhiDevice, createShaderModuleFn?: CreateShaderModuleFn): Result<Replay, DebugError>` | Create a Replay object from a tape. Performs caps fail-fast check (returns `caps-mismatch` if `tape.rhiCapsRecorded` is not a subset of `device.caps`). `createShaderModuleFn` is **type-optional but required for any tape carrying `createShaderModule` events** (every real-demo tape does — only shader-free self-contained test tapes omit them): pass `createShaderModule` from `@forgeax/engine-rhi-webgpu`. Omitting it silently skips those events, so downstream pipeline creation fails at the RHI layer (no `DebugError`) — not at `createReplay`. |
| `replay.commitThroughDraw` | `(drawIdx: number): Promise<Result<{committed: boolean}, DebugError>>` | **Per-draw cumulative RT.** Replays up to & including global draw #`drawIdx`, then synthesizes `endRenderPass` + `finish` + `submit` on the enclosing pass so its color attachment holds the **draws-0..N cumulative** pixels (selecting draw N shows the frame as it stood right after N, not the final composite). After `{committed:true}`, `readbackDrawRt(drawIdx)` / `inspectDrawJson(..., ['rt'])` read those pixels. `{committed:false}` = the draw is in a depth-only render pass or a compute pass (no color RT — render a "no-rt" state). Monotonic-forward like `stepTo`: `reset()` before re-targeting an earlier draw. Out-of-range/non-monotonic → `replay-step-out-of-range`. Use this (not `stepTo(end)`) whenever inspecting a *specific* draw; use `stepTo(events.length-1)` only for the whole composited frame. |
| `inspectAt` | `(replay: Replay, drawIdx: number, events: readonly RhiCallEvent[], fields: readonly InspectFields[] \| undefined, device: RhiDevice, outputDir: string): Promise<Result<InspectReport, DebugError>>` | Inspect replay state at a specific draw index. `events` supplies frame/pass info; `fields` controls which data is computed (`['bindings']` skips RT readback; `['rt']` triggers `copyTextureToBuffer` + PNG; `undefined` = all); `device` performs RT readback; `outputDir` is where the RT PNG is written. Step the replay with `commitThroughDraw(drawIdx)` first for per-draw pixels (the CLI `inspect-at` path does this). |
| `debugAdapter` | eval scope live root | `debugAdapter` is directly available inside `@forgeax/engine-remote` eval scope (no Registry wiring needed — `createApp` auto-injects it alongside `world`, `renderer`, `assets`). Call `await debugAdapter.captureFrame({label: 'my-snapshot'})` and `await debugAdapter.inspectAt({tape, drawIdx: 3})` inside eval scripts. The offline CLI subcommands (`inspect-offline`, `summary`, `trigger-browser`) do not route through eval and remain direct CLI entry points. |

### Browser capture subpath (`@forgeax/engine-rhi-debug/capture-browser`)

Node-free L0 entry, reached only via the explicit `/capture-browser` subpath -- **deliberately not re-exported from the barrel** so the `FORGEAX_ENGINE_RHI_DEBUG=0` tree-shake gate stays intact (AC-10 / D-7). Imports only `./recorder-core` + `./tape-format`; no `node:` builtin, no `pngjs`, no `ws`.

| export | signature | description |
|:--|:--|:--|
| `captureFramesToMemory` | `(debugInst: CaptureBrowserRecorder, frames: number, label?: string): Promise<CaptureBrowserTape>` | Drive a live recorder through `arm -> waitForRecorderIdle -> finalizeToMemory`, entirely in memory (zero fs, zero network). Returns `{ runId, json, blob, passOffsets, valid }`. OOS-8: v1 finalizes a single-frame tape; `frames` is accepted for forward compatibility. |
| `uploadTape` | `(tape: CaptureBrowserTape, label?: string): Promise<UploadTapeResult>` | Base64-encode the blob (browser-safe `btoa`, no Node Buffer) and POST it to the dev-server `/__forgeax-debug/tape` endpoint. Returns `{ runId, tapePath, reportPath }`. Non-2xx throws an Error carrying the server `{error, hint}` envelope. |
| `captureAndUpload` | `(debugInst: CaptureBrowserRecorder, frames: number, label?: string): Promise<UploadTapeResult>` | `captureFramesToMemory` then `uploadTape` in one call. This is what `window.__forgeax.captureFrame(n)` invokes. |

The barrel (`@forgeax/engine-rhi-debug`) re-exports the node-free L0 primitives `finalizeToMemory` / `assembleReport` / `generateRunId` (shared by the Node finalize tail); the `capture-browser` symbols above are reachable **only** through the subpath.

### Browser inspect subpath (`@forgeax/engine-rhi-debug/inspect-core`)

Node-free L3b entry, reached only via the explicit `/inspect-core` subpath -- **deliberately not re-exported from the barrel** so the `FORGEAX_ENGINE_RHI_DEBUG=0` tree-shake gate stays intact. Imports only `./readback` + `./tape-format` + `./errors`; no `node:` builtin, no `pngjs`, no `ws`.

| export | signature | description |
|:--|:--|:--|
| `inspectDrawJson` | `(replay: Replay, drawIdx: number, events: readonly RhiCallEvent[], device: RhiDevice, fields?: readonly InspectFields[]): Promise<Result<InspectReport, DebugError>>` | Inspect a specific drawIdx within a replay and return a structured JSON report. Receives an **already-built** `Replay` (not a tape). Validates `drawIdx` bounds against `events` and returns `replay-step-out-of-range` if out of range (charter P3 explicit failure). `fields` controls cropping: `undefined` = full report (bindings + drawCall + RT pixels); `[]` = minimum report (frameIdx/drawIdx/passIdx only); `['bindings']` skips RT readback; `['rt']` triggers `readbackDrawRt` readback returning `{width, height, pixels}` (no PNG encode, no file write -- PNG path is Node-only in `inspectAt`). `.rt` field is `{width, height, pixels: Uint8Array}` (not a file path) when requested via L3b. Exports atom functions `extractDrawInfo`, `findPassIdx`, `mapResourceKindToInspectKind`, type `DrawInfo` for direct use. |
| `extractDrawInfo` | `(events: readonly RhiCallEvent[], targetDrawIdx: number): DrawInfo` | Extract draw info from tape events up to a given draw index. Returns `{ frameIdx, passIdx, bindings, drawCall, colorAttachmentHandleId }`. |
| `findPassIdx` | `(events: readonly RhiCallEvent[], drawIdx: number): number` | Find the pass index for a given draw index using `computePassOffsets`. |
| `mapResourceKindToInspectKind` | `(k: 'sampler' \| 'buffer' \| 'textureView' \| 'externalTexture'): 'buffer' \| 'texture' \| 'sampler' \| 'textureView'` | Project recorder-side `RhiBindResourceKind` onto inspector-facing `InspectBindingEntry.kind`. |

### Browser RT-to-canvas subpath (`@forgeax/engine-rhi-debug/rt-to-canvas`)

Node-free L3c entry, reached only via the explicit `/rt-to-canvas` subpath -- **deliberately not re-exported from the barrel** for tree-shake. Imports only `./readback`; no `node:` builtin, no `pngjs`, no `ws`, no `./inspector`.

| export | signature | description |
|:--|:--|:--|
| `renderRtToCanvas` | `(replay: Replay, drawIdx: number, device: RhiDevice, canvas: HTMLCanvasElement \| OffscreenCanvas): Promise<Result<void, DebugError>>` | Read back the color attachment RT at a specific drawIdx via `readbackDrawRt` (SSOT per-draw GPU readback, D-2) and render the RGBA8 pixels onto an external canvas via `ImageData` + `putImageData`. Supports `HTMLCanvasElement` (main-thread DOM) and `OffscreenCanvas` (Worker). Returns `err` on no color attachment, readback failure, or missing 2d context. |

### Browser inspect usage example

The code block below shows a complete browser-console flow: capture a frame to memory, replay it, and inspect a specific draw index with both JSON report and RT-to-canvas rendering. All symbols come from subpaths -- nothing ships in the barrel.

```ts
import { captureFramesToMemory } from '@forgeax/engine-rhi-debug/capture-browser';
import { createReplay, deserializeTape } from '@forgeax/engine-rhi-debug';
import { inspectDrawJson } from '@forgeax/engine-rhi-debug/inspect-core';
import { renderRtToCanvas } from '@forgeax/engine-rhi-debug/rt-to-canvas';
// createShaderModule is a free function on the backend, not on RhiDevice.
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';

// 1) Capture one frame to memory (no fs, no network).
const tape = await captureFramesToMemory(debugInst, 1);

// 2) Deserialize and create a replay on the live device.
const tapeRes = deserializeTape(tape.json, tape.blob);
if (!tapeRes.ok) {
  throw tapeRes.error;
}
const tapeObj = tapeRes.value;
// Pass createShaderModule as the third arg so pipeline shaders are replayed.
// Real-demo tapes carry createShaderModule events; omitting this silently
// skips them and downstream pipeline creation fails. (createShaderModule is
// not on RhiDevice in rhi-webgpu -- import it from the backend.)
const replayRes = createReplay(tapeObj, device, createShaderModule);
if (!replayRes.ok) {
  throw replayRes.error; // caps-mismatch, etc.
}
const replay = replayRes.value;

// 3) Step through all events to set up GPU state.
const stepRes = await replay.stepTo(tapeObj.events.length - 1);
if (!stepRes.ok) {
  throw stepRes.error;
}

// 4) Inspect a draw at index 0 -- JSON report (L3b).
const inspectRes = await inspectDrawJson(
  replay, 0, tapeObj.events, device, ['bindings', 'drawCall'],
);
if (inspectRes.ok) {
  console.log('bindings:', inspectRes.value.bindings);
  console.log('drawCall:', inspectRes.value.drawCall);
} else {
  // DebugErrorCode is a 14-member closed union -- exhaustive switch.
  const err = inspectRes.error;
  switch (err.code) {
    case 'replay-step-out-of-range':
      console.error(err.hint);
      break;
    case 'rt-readback-failed':
      console.error(err.hint);
      break;
    case 'caps-mismatch':
      console.error('missing caps:', err.detail?.missingCaps);
      break;
    // ... remaining 11 cases handled by TypeScript exhaustiveness check.
    default:
      console.error(err.code, err.hint);
  }
}

// 5) Render RT pixels onto a canvas (L3c).
const canvas = document.getElementById('inspect-canvas') as HTMLCanvasElement;
const rtRes = await renderRtToCanvas(replay, 0, device, canvas);
if (!rtRes.ok) {
  console.error('RT render failed:', rtRes.error.hint);
}

// 6) Clean up.
replay.dispose();
```

`device` is the engine's abstract `RhiDevice` -- callers pass the live device that wrapped the RHI instance (e.g. from `navigator.gpu` or the `debugInst` proxy chain). `tapeObj.events` holds the ordered `RhiCallEvent[]` produced by the capture. `replay.stepTo(N)` replays events `[0..N]` onto the GPU and leaves the pass open at N — for the **whole composited frame** step to `events.length-1`. To inspect a **specific draw**, call `replay.commitThroughDraw(drawIdx)` instead: it replays through that draw and synthesizes the pass commit so `inspectDrawJson` / `renderRtToCanvas` read the draws-0..N cumulative pixels (a color attachment cannot be read mid-pass, so a bare `stepTo` to a mid-pass draw would read uncommitted/black).

### Browser one-line trigger (L2c)

When `FORGEAX_ENGINE_RHI_DEBUG=1`, `createAppFromCanvas` (`@forgeax/engine-app`) installs:

```js
window.__forgeax.captureFrame(n)  // Promise<{ runId, tapePath, reportPath }>
```

It dynamic-imports `@forgeax/engine-rhi-debug/capture-browser` -> `captureAndUpload(debugInst, n)`. Discoverable via DevTools console autocomplete. When the flag is unset the assignment never runs, so `window.__forgeax` does not exist and a caller hits a `TypeError` -- explicit failure (charter P3 / F-3 zero-injection), not a silent no-op.

The flag is resolved from two sources (D-4), `import.meta.env` winning over `globalThis.process.env`:

```ts
(typeof import.meta !== 'undefined' && import.meta.env?.FORGEAX_ENGINE_RHI_DEBUG)
  ?? globalThis.process?.env?.FORGEAX_ENGINE_RHI_DEBUG
```

### Dev-server endpoint: POST `/__forgeax-debug/tape`

Mounted by `@forgeax/engine-vite-plugin-rhi-debug` (`vitePluginRhiDebug()`, default export, added to `vite.config` `plugins[]`). The plugin's `config()` hook also self-injects `define['import.meta.env.FORGEAX_ENGINE_RHI_DEBUG'] = '1'`, so a demo that registers the plugin needs zero extra boilerplate; without the plugin the flag leaves no residue (prod-clean, AC-07).

| field | type | required |
|:--|:--|:--|
| `runId` | `string` (non-empty) | yes |
| `label` | `string` | no |
| `json` | `string` (serialized tape header + events) | yes |
| `blobBase64` | `string` (standard base64 of the tape blob) | yes |
| `passOffsets` | `PassOffset[]` | yes |
| `valid` | `boolean` | yes |

On success: writes `.forgeax-debug/<runId>/frame-0.tape.bin` + `frame-0.report.json` (via the D-3 single-writer `assembleReport`, byte-identical to the Node finalize tail) and returns `200 { tapePath, reportPath, runId }`.

On a malformed body / wrong method: returns a `{ error, hint }` JSON envelope (`400` for bad body, `405` for non-POST) and **writes nothing** (Fail Fast / AC-06). HTTP-layer errors never enter `DebugError` (OOS-6 / D-9) -- the 14-member union is unchanged.

### Dev-server endpoint: POST `/__forgeax-debug/trigger` (L2a)

Also mounted by `vitePluginRhiDebug()`. This is the Node-side external trigger that backs the `trigger-browser` CLI: a `POST` broadcasts an HMR custom event (`forgeax-debug:capture`) to every connected browser tab, then holds the connection open until the first tab uploads its tape via the `/tape` endpoint above, at which point it returns that tape's paths synchronously.

| field | type | required |
|:--|:--|:--|
| `frames` | `number` | no (default 1) |
| `label` | `string` | no |

Request body is optional (empty body = `{ frames: 1 }`). On success: returns `200 { tapePath, reportPath, runId }` -- the same shape the `/tape` upload resolved with, so `tapePath` chains straight into `inspect-offline` (L3a).

Error envelopes (all `{ error, hint }`, never `DebugError` -- OOS-6, union stays 12):

| status | `error` | when |
|:--|:--|:--|
| `503` | `no-browser-tab` | no tab captured + uploaded within `triggerTimeoutMs` (default 30s). hint: confirm the dev-server URL is open in a browser and HMR is connected. |
| `409` | `recorder-busy` | a prior trigger is still in-flight (single pending slot, fail-fast, no queue). hint: wait for the current capture to finish, then retry. |
| `400` / `405` | bad body / non-POST | malformed JSON or wrong method. |

`triggerTimeoutMs` is configurable via `vitePluginRhiDebug({ triggerTimeoutMs })` (default `30_000`). Multi-tab: the HMR event broadcasts to all tabs, so each tab captures and uploads its own tape (multiple tapes land on disk under distinct `runId`s); the trigger response returns the **first** tape received.

### CLI subcommands

> [!NOTE]
> **Current invocation: `node packages/rhi-debug/dist/cli.mjs <subcommand>`** (after `pnpm -F @forgeax/engine-rhi-debug build`). The offline subcommands (`inspect-offline`, `summary`, `trigger-browser`) are direct CLI entry points -- no engine server or WS connection required. Live-inspect (`capture-frame` / `inspect-at` on a running engine) routes through `@forgeax/engine-remote` eval scope: `await debugAdapter.captureFrame({label})` and `await debugAdapter.inspectAt({tape, drawIdx: 3})` are the canonical live paths.

| command (end-state shape) | description |
|:--|:--|
| `forgeax-rhi-debug trigger-browser [--frames=N] [--label=STR] [--dev-url=URL]` (L2a) | POST `/__forgeax-debug/trigger` to the dev-server (default `http://localhost:5173`), wait for a tab to capture + upload, print `{ runId, tapePath, reportPath }`. Ships today under the real `forgeax-rhi-debug` bin. |
| `forgeax-rhi-debug summary <tapePath>` (L3d) | Read an on-disk tape and print the whole-frame `FrameModel` JSON (tree / per-draw pipelineState / bindings / drawCall / resources / commands / meta). Pure: no device, no replay. Ships today under the real `forgeax-rhi-debug` bin. |

#### Offline inspect (L3a) -- the canonical entry today

`inspect-offline` reads an on-disk tape and replays it on a freshly-booted dawn-node device **without a running engine or WS connection** -- this is the distinction from `inspect-at` (which dispatches over WS:5732 to a live device). It is the CLI half of the browser-to-CLI loop: pass the `tapePath` that `window.__forgeax.captureFrame(n)` returned.

```bash
node packages/rhi-debug/dist/cli.mjs inspect-offline <tapePath> <drawIdx> [--fields=bindings,drawCall,rt]
# example:
node packages/rhi-debug/dist/cli.mjs inspect-offline .forgeax-debug/<runId>/frame-0.tape.bin 0
```

| arg / flag | meaning |
|:--|:--|
| `<tapePath>` | path to `frame-0.tape.bin` (its `frame-0.report.json` sits alongside) |
| `<drawIdx>` | global draw event index to inspect (integer >= 0) |
| `--fields=LIST` | comma-separated subset of `bindings,drawCall,rt` (default: all). `bindings` skips RT readback; `rt` writes the RT PNG into the tape's own directory |

Outputs a structured `InspectReport` JSON (`frameIdx`, `drawIdx`, `passIdx`, `bindings`, `drawCall`, `rt` PNG path, `pipelineState`). `pipelineState` (the seven WebGPU pipeline stages) is always present for render draws -- it is **not** gated by `--fields`, so an AI sees the same pipeline state the viewer's Pipeline State panel renders. Failure reuses the existing `DebugError` union (OOS-6: no new error code) -- e.g. `recorder-not-attached` when no dawn-node backend is importable. Requires `@forgeax/engine-rhi-webgpu` (dawn-node) or `@forgeax/engine-rhi-wgpu` (wasm) to be installed.

#### Whole-frame summary (L3e) -- pure, no GPU

`summary` reads an on-disk tape and prints `buildFrameModel(tape)` JSON: the whole-frame structural model the RHI debug viewer renders (pass/draw `tree`, per-draw `pipelineState`, `bindings`, `drawCall`, `resources`, full `commands` stream, `meta`). It needs **no device and no replay** -- pure event analysis -- so it runs anywhere, instantly. This is the CLI mirror of the viewer's whole-frame view: the AI inspects the frame with the same operation the UI exposes (charter F1).

```bash
node packages/rhi-debug/dist/cli.mjs summary <tapePath>
# example:
node packages/rhi-debug/dist/cli.mjs summary .forgeax-debug/<runId>/frame-0.tape.bin
```

`buildFrameModel` is also importable directly from the node-free `@forgeax/engine-rhi-debug/frame-model` subpath (zero `node:` / `pngjs` / GPU, tree-shake gated like `inspect-core`); the RHI debug viewer re-exports it as its `ViewModel` so the UI and the CLI share one analysis SSOT. The `resources` map and per-draw `vertexBuffers` map serialize to arrays in the CLI JSON (`Map` has no JSON form).

The package exposes the CLI two ways: `package.json#bin` declares `forgeax-rhi-debug -> ./dist/cli.mjs`, and `package.json#exports['./cli']` re-exports the subcommand functions for programmatic use. The barrel does **not** re-export CLI symbols (Node `ws` / `pngjs` are reached only via `/cli`, `/inspector`, `/adapter` subpaths, keeping the tree-shake gate intact).

### Live inspect via eval scope

In a running engine with `app.remote` wired (default in dev mode), the `debugAdapter` live root inside eval scope exposes two methods:

| method | params | returns |
|:--|:--|:--|
| `debugAdapter.captureFrame` | `{ frames: number, label?: string }` | `Promise<{ frameModel, ... }>` — structured FrameModel shared SSOT with RHI debug viewer and CLI `summary` |
| `debugAdapter.inspectAt` | `{ tape, drawIdx: number }` | `Promise<InspectReport>` — JSON; includes `pipelineState` for render draws |

```js
// Inside eval scope:
await debugAdapter.captureFrame({ label: 'my-snapshot' });
await debugAdapter.inspectAt({ tape: someTape, drawIdx: 3 });
```

Offline subcommands (`inspect-offline`, `summary`, `trigger-browser`) do NOT route through eval and remain direct CLI entry points.

### State machine

```
idle -> armed -> snapshotting -> recording -> finalizing -> idle  (normal path, v2)
idle -> armed -> recording -> finalizing -> idle                  (v1 path, no snapshotting)
idle -> armed -> recording -> error                               (capture failure)
error -> idle           (via disposeError())
```

9 legal transitions: `idle->armed` (arm), `armed->snapshotting` (v2: frame-header snapshot window, calls snapshotResource for all live resources), `armed->recording` (v1 path when snapshotting is skipped), `snapshotting->recording` (snapshot complete, frame commands begin), `recording->idle` (N frames done, auto-finalize), `recording->error` (device.lost), `error->idle` (disposeError).

3 illegal: duplicate arm returns `recorder-already-armed`; arm from error returns `recorder-already-armed`; finalize from error writes `valid: false`.

**Seed insertion point (v2 replay order):** During replay, events are processed in tape order. The bootstrap prefix carries `create*` events first, then `initialData` events, then frame commands. Replay follows: create resources -> seed initialData (writeBuffer/writeTexture from blobPool) -> dispatch frame commands. The `replayInitialData` handler returns `Result` — failures bubble up through `stepToImpl` as `seed-initial-data-failed` (not void-silent-return).

## Error codes

`DebugErrorCode` is a 14-member closed union, completely independent from `RhiErrorCode`.

| code | hint template |
|:--|:--|
| `recorder-not-attached` | env `FORGEAX_ENGINE_RHI_DEBUG=1` not set at bootstrap |
| `recorder-already-armed` | previous arm() still active; call `disposeError()` or wait for capture to finish |
| `frame-end-hook-missing` | `createRenderer` internal `onFrameEnd` injection point absent (theoretically unreachable) |
| `tape-format-version-mismatch` | tape formatVersion vs runtime version (`{tapeVersion}` vs `{expectedVersion}`) |
| `tape-handle-graph-broken` | one code, two distinct `.hint` sides (cross-hint distinct): **finalize side** (`getTape()` found an in-frame handle with no `create*` in the bootstrap table) names the bootstrap table + "before wrap()" and tells you to re-capture; **deserialize side** (`deserializeTape()` found a dangling handle in a stored tape) names "never declared by a create event" / corrupt-or-stale tape. Both carry `.detail { danglingHandleId, referencingEventIndex }` -- branch on the hint text (not the code) to pick the right recovery: re-capture vs discard the stale tape. |
| `caps-mismatch` | missing caps: `{missingCaps}` |
| `replay-step-out-of-range` | stepTo(`{requestedStep}`) out of [0, `{totalEvents}`); current=`{currentStep}` |
| `replay-deterministic-violation` | RT pixel diff between original and replay exceeds threshold (test-only error) |
| `rt-readback-failed` | `copyTextureToBuffer` / `mapAsync` chain failed |
| `png-encode-failed` | PNG encoding of RT readback data failed |
| `rpc-target-not-wired` | `debugAdapter` not available in eval scope — ensure `createApp` is used (auto-wires `debugAdapter` alongside `world`, `renderer`, `assets`) |
| `replay-dispose-busy` | in-flight inspect at draw indices `{inFlightDrawIndices}`; `await` them first |
| `snapshot-readback-failed` | snapshotResource GPU byte readback failed (copy/mapAsync/storeBlob). `.detail = {handleId, stage: 'copy' | 'map' | 'store'}` |
| `seed-initial-data-failed` | replayInitialData seed failed (handleId missing / dataHash missing / writeBuffer failed). `.detail = {handleId, stage: 'lookup' | 'write'}` |

Each error object carries structured `.code` / `.expected` / `.hint` / `.detail` (discriminated union narrowed on `.code`). AI users consume via `switch (err.code)` exhaustive -- TypeScript catches missing branches at compile time.

## Tape format constants

| constant | value | locked in |
|:--|:--|:--|
| `TAPE_FORMAT_VERSION` | `3` | bumped in v3 for 6 new event types + full-command capture |
| `SUPPORTED_TAPE_VERSIONS` | `new Set([2, 3])` | deserialize accepts {2,3}; v2 tapes readable, missing new events naturally empty |
| `PER_EVENT_OVERHEAD` | `192` bytes | plan-strategy 5.3; m2-4 blob pool |

Serialization: `serializeTape(tape) -> { json: string, bin: ArrayBuffer }`. JSON header contains `formatVersion` + `rhiCapsRecorded` + events array. Binary blob pool contains hash-keyed `ArrayBuffer` data for `writeBuffer` / `writeTexture` / shader source. Newly recorded tapes always write `formatVersion = 3`. v2 tapes deserialize without version-mismatch error; missing new events produce natural empty state (commands array lacks those kinds, pipelineState fields are undefined) -- no separate error branch.

### v3 event additions

Six new event kinds were added to the `RhiCallEvent` closed union, plus 10 previously-existing event kinds that were missing `pushEvent` calls in the recorder:

**New event kinds (6):**

| event kind | source method | payload highlights |
|:--|:--|:--|
| `setBlendConstant` | `RhiRenderPassEncoder.setBlendConstant` | `color: GPUColor` |
| `drawIndirect` | `RhiRenderPassEncoder.drawIndirect` | `indirectBufferHandleId, indirectOffset` |
| `drawIndexedIndirect` | `RhiRenderPassEncoder.drawIndexedIndirect` | `indirectBufferHandleId, indirectOffset` |
| `passPushDebugGroup` | `RhiRenderPassEncoder.pushDebugGroup` | `passHandleId, groupLabel` |
| `passPopDebugGroup` | `RhiRenderPassEncoder.popDebugGroup` | `passHandleId` |
| `passInsertDebugMarker` | `RhiRenderPassEncoder.insertDebugMarker` | `passHandleId, markerLabel` |

**Previously-existing event kinds, now recorded (10):**

| category | event kinds |
|:--|:--|
| Copy/clear (5) | `copyBufferToBuffer`, `copyBufferToTexture`, `copyTextureToBuffer`, `copyTextureToTexture`, `clearBuffer` |
| Viewport/scissor (2) | `setViewport`, `setScissorRect` |
| Encoder-level debug group (3) | `pushDebugGroup`, `popDebugGroup`, `insertDebugMarker` |

The recorder `_collectFrameReferencedHandleIds` explicitly collects `passHandleId` + `indirectBufferHandleId` for `drawIndirect`/`drawIndexedIndirect`, and the switch uses an exhaustive `default: void (e as never)` guard -- any future unhandled event kind becomes a compile error.

### Coverage invariant

The file `packages/rhi-debug/src/__tests__/coverage-invariant.test-d.ts` contains a type-level invariant: it enumerates every method on the three RHI encoder interfaces (`RhiCommandEncoder`, `RhiRenderPassEncoder`, `RhiComputePassEncoder`) and asserts that every method either maps to a captured `RhiCallEvent.kind` or appears in the `DEFERRED_COMMANDS` exemption set.

```text
type Uncovered = Exclude<keyof<Interface>, CapturedMethods | DeferredMethods>
// Assertion: Uncovered = never for all three interfaces
```

A falsification variant injects a fake uncovered method and asserts the type becomes non-never, proving the guard is sensitive. Two non-1:1 method-name-to-kind-name mappings are handled via an explicit mapping table:

1. Method `end()` on both pass encoders maps to `endRenderPass` / `endComputePass` kinds
2. Render-pass `pushDebugGroup`/`popDebugGroup`/`insertDebugMarker` map to `passPushDebugGroup`/`passPopDebugGroup`/`passInsertDebugMarker` (the `pass` prefix distinguishes from encoder-level events)

### DEFERRED_COMMANDS

Explicitly exempt from recording -- these 5 RHI commands never produce a `RhiCallEvent`:

| command | interface | reason |
|:--|:--|:--|
| `beginOcclusionQuery` | `RhiRenderPassEncoder` | OOS-2: occlusion query not yet supported |
| `endOcclusionQuery` | `RhiRenderPassEncoder` | OOS-2 |
| `executeBundles` | `RhiRenderPassEncoder` | OOS-2: bundle execution not yet supported |
| `writeTimestamp` | `RhiCommandEncoder` | OOS-3: timestamp trace deferred |
| `resolveQuerySet` | `RhiCommandEncoder` | OOS-3: query set resolve deferred |

The `DEFERRED_COMMANDS` constant in `types.ts` is a `Set<string>` with exactly these 5 members, used by the coverage invariant as the known-exempt arm. A unit test (`coverage-invariant.unit.test.ts`) asserts the set has exactly 5 members, no more and no less.

### Initial-state capture (v2)

> **Contract SSOT** — new readers can reuse the interface seam by reading only this section, without consulting implementation source (AC-04). Feat-B consumers reference this section to avoid drift.

Starting in v2, the recorder snapshots live resource GPU bytes at capture-start and stores them as `initialData` events in the tape's bootstrap prefix. Replay follows a strict **create -> seed -> dispatch** order. This makes the tape self-contained: resources whose bytes were uploaded before the recording window (e.g., load-time VBO/IBO) are faithfully restored during replay.

**Three-piece interface seam:**

| piece | location | contract |
|:--|:--|:--|
| `initialData` event schema | `types.ts` `RhiCallEventInitialData` | `{ kind:'initialData', handleId: HandleId, dataHash: string }` — joined into `RhiCallEvent` closed union as the 40th member. `handleId` points to a resource declared by a prior `create*` event in the bootstrap prefix. `dataHash` is a djb2 hash key into the tape's `blobPool`, which stores the actual GPU bytes. Bytes are read back via copyToBuffer/mapAsync and stored with hash-dedup (reuses existing blobPool, no separate pool). |
| `snapshotResource` signature | `recorder.ts` `DebugRhiInstance` | `snapshotResource(handleId: HandleId): Promise<Result<{handleId, dataHash}, DebugError>>` — per-resource building block. Reads the resource descriptor from the internal registry, copies GPU bytes via copyToBuffer/mapAsync, stores them in blobPool via storeBlob, and pushes an `RhiCallEventInitialData` into the event stream. Returns `snapshot-readback-failed` with `.detail = {handleId, stage:'copy'\|'map'\|'store'}` on any failure. Async because the GPU readback chain is inherently asynchronous. |
| `snapshotAllLiveResources` signature | `recorder.ts` `DebugRhiInstance` | `snapshotAllLiveResources(): Promise<Result<void, DebugError>>` — frame-header full-table snapshot entry point. Awaits all submitted GPU work via `onSubmittedWorkDone`, then iterates every live resource in the descriptor registry, calling `snapshotResource` on each (**buffers + single-layer 4-byte-per-texel color textures only** — see *Snapshot scope* below). Advances the recorder Armed -> Snapshotting -> Recording on success. Returns the first snapshot failure as a Result — fail-fast, not partial seed. **Wired into the real capture path**: `adapter.ts captureFrames` and `capture-browser.ts captureFramesToMemory` call it right after `arm()`, so every real-demo tape carries initialData (not just hand-written test tapes). |
| seed insertion point | `replayer.ts` `replayInitialData` | `replayInitialData(event, tape, handleMap, queue): Result<void, DebugError>` — called during replay when the dispatch switch hits `case 'initialData'`. Looks up the recreated resource from `handleMap`, fetches its bytes from `tape.blobPool.get(event.dataHash)`, writes them via `queue.writeBuffer` (for buffers) or `queue.writeTexture` (for textures). Returns `seed-initial-data-failed` with `.detail = {handleId, stage:'lookup'\|'write'}` on failure. Failures bubble up through `stepToImpl` — not void-silent-return. |

**Capture flow (recording side):**

```text
arm() -> armed -> snapshotting state
  for each live resource in descriptor registry:
    await queue.onSubmittedWorkDone()  // conservative timing (C-3)
    snapshotResource(handleId)         // reads GPU bytes -> blobPool -> pushEvent(initialData)
  -> recording state
  frame commands proceed normally
```

Snapshot-internal copy/submit calls are wrapped with `_skipRecord=true` — they are never recorded in the tape event stream (only the `initialData` events appear).

**Snapshot scope (what gets seeded).** `snapshotAllLiveResources` snapshots only resources the readback/seed path can round-trip faithfully today: **all buffers**, and **color textures that are single-layer and 4-byte-per-texel** (`rgba8unorm`/`bgra8unorm`/`-srgb`, `r32float`, `rg16float`, …). It **skips**:
- **depth/stencil textures** — their content is render-pass output (shadow maps, z-buffers), never an uploaded payload, and `queue.writeTexture` rejects them (no CopyDst);
- **non-4-byte-per-texel formats** (e.g. `rgba16float`, 8 B) and **multi-layer/cubemap textures** (e.g. IBL prefiltered envmaps) — the seed path (`replayInitialData` + `readbackTexturePixels`) hardcodes `bytesPerRow = width*4` and `depthOrArrayLayers: 1`, so wider texels and array layers are not yet round-trippable.

Skipping is **Fail-Fast, correct-but-incomplete**: emitting an `initialData` for an un-seedable resource would throw on every replay, so the snapshot omits it rather than recording a corrupt seed. Consequence: a tape whose visible output depends on a pre-frame-uploaded HDR/IBL cubemap will replay with that resource unseeded. Lifting this (format→bytes-per-texel table + multi-layer copy loop + `viewFormats` declaration) is the documented follow-up for full IBL/HDR replay fidelity. On replay, `replayCreateTexture` always adds `COPY_DST` to recreated textures so a seedable texture can receive its `writeTexture`.

> [!IMPORTANT]
> **Snapshotting is an onFrameEnd-non-preemptible critical section.** The snapshot loop `await`s per-resource GPU readback, yielding the event loop. The host rAF loop's `onFrameEnd` MUST NOT advance the state machine while state is `snapshotting` — if it did, the loop would race to `recording -> finalizing -> idle` and the still-running loop's later `pushEvent(initialData)` calls would hit the `idle` gate and be **silently dropped** (the bug that lost every texture initialData -> all-zero material textures -> black cube). `onFrameEnd` therefore ignores the tick in `snapshotting`; the loop itself sets `recording` when done, and the next `onFrameEnd` records the real frame. Any future async work at the snapshot/record boundary (e.g. Phase 2 first-read hooks) must preserve this invariant.

**Replay flow (consumption side):**

```text
bootstrap prefix events in tape order:
  createBuffer / createTexture / ...  (resources created, stored in handleMap)
  initialData { handleId, dataHash }  (seed: handleMap.get -> blobPool.get -> writeBuffer/writeTexture)
frame commands:
  writeBuffer / draw / submit / ...   (commands execute normally with seeded resources)
```

**v1-v2 boundary:** v1 tapes (`formatVersion=1`) are explicitly rejected by `deserializeTape` with a structured `tape-format-version-mismatch` error (`.detail.expectedVersion=2`, `.detail.tapeVersion=1`). No silent degradation or best-effort migration. v1 was never a published format — all tapes are ephemeral and expect runtime-version-lock.

**Design constraints this section enforces:** `initialData` reuses the unified serialization path (no separate blob pool, D-1 / C-5). `snapshotResource` and `replayInitialData` return `Result` (not void-silent, D-3 / AC-07). The descriptor registry (internal to `recorder.ts`) records resource kind/size/format/usage at `create*` time and removes entries at `destroy*` — `snapshotResource` reads it to determine whether a resource is a buffer or texture and what shape to copy.

### PassOffset and computePassOffsets

`computePassOffsets(events)` scans the events array for `beginRenderPass`/`endRenderPass` and `beginComputePass`/`endComputePass` pairs, counts draw/dispatch calls within each pass, and returns an ordered array of `PassOffset`:

```ts
export interface PassOffset {
  readonly passIdx: number;       // 0-based sequential pass index
  readonly startDrawIdx: number;  // first global draw/dispatch index in this pass
  readonly endDrawIdx: number;    // last global draw/dispatch index in this pass
  readonly kind: 'render' | 'compute'; // pass kind discriminant (PR4 M1 extension)
}
```

The `kind` field was added in PR4 (M1) to distinguish render and compute passes. `computePassOffsets` now recognises `beginComputePass`/`endComputePass` events and produces a mixed render+compute offset array. `dispatchWorkgroups` calls within a compute pass increment the global draw index, so `startDrawIdx`/`endDrawIdx` cover both draw calls and dispatches.

**C5 preservation**: `findPassIdx` (in `inspect-core.ts`) reads only `passIdx`/`startDrawIdx`/`endDrawIdx` from `PassOffset` -- the additive `kind` field does not alter its behaviour for render-only tapes. The render-only pass index sequence is byte-identical before and after the extension.

Example mixed output (render+compute+render):

```ts
import { computePassOffsets } from '@forgeax/engine-rhi-debug';

const offsets = computePassOffsets(events);
// offsets = [
//   { passIdx: 0, startDrawIdx: 0, endDrawIdx: 2, kind: 'render' },
//   { passIdx: 1, startDrawIdx: 3, endDrawIdx: 3, kind: 'compute' },
//   { passIdx: 2, startDrawIdx: 4, endDrawIdx: 5, kind: 'render' },
// ]
```

## Dependency contract

> [!NOTE]
> requirements §2.2 + AC-01 originally read "`dependencies` contains exactly
> `@forgeax/engine-rhi`". Round 1 implement-review (I-1) flagged the live
> `package.json#dependencies` as having three entries — this section is the
> SSOT for the deviation and the rationale.

| dep | section | rationale |
|:--|:--|:--|
| `@forgeax/engine-rhi` | `dependencies` | proxy target; recorder/replayer/inspector all consume the spec interfaces |
| `@forgeax/engine-types` | `dependencies` | `Result` / `ok` / `err` SSOT (AGENTS.md §Error model — closed-union `.code` shipped from `@forgeax/engine-types`); inlining a second `Result` factory inside this package would violate the "1 SSOT per fact" axiom in `forgeax-harness/rules/architecture-principles.md` §1 |
| `pngjs` | `dependencies` | RT readback PNG encoder for `inspectAt(...).rt` (AC-15). Pure-TS PNG encode in v1; no dawn-node hard requirement |
| `@forgeax/engine-rhi-webgpu` | `peerDependencies` | dawn-node binding. Optional at runtime — `wrap(rhi)` works against any RHI backend; the dependency is `peer` so `FORGEAX_ENGINE_RHI_DEBUG=0` consumers do not pay an install cost |
| `@forgeax/engine-rhi-wgpu` | `peerDependencies` | wgpu-wasm binding. Same rationale (OOS-7: capture/replay against wgpu-wasm is v2) |

The original AC-01 wording is preserved as a **descriptive intent** ("debug instrumentation should not pull in the RHI backends"), but the *literal* one-dep constraint was relaxed to honor the SSOT axiom (`@forgeax/engine-types`) and to avoid a base64-encoded inline PNG implementation (`pngjs`). Backends remain `peer`, satisfying the original tree-shake intent: AC-03 (tree-shake grep gate) verifies no `engine-rhi-debug` import survives in `FORGEAX_ENGINE_RHI_DEBUG=0` bundles.

## Out of scope

| id | item | status |
|:--|:--|:--|
| OOS-1 | Override (edit UBO / swap shader / skip draw) during replay | v2 |
| OOS-2 | Per-pixel history | v2 |
| OOS-3 | Timestamp trace (`writeTimestamp` / `resolveQuerySet`) | v2; in `DEFERRED_COMMANDS` |
| OOS-4 | UI panel | shipped in v3 (four-panel dockview viewer at `apps/rhi-debug-viewer/`) |
| OOS-5 | Destroy-event recording (`destroyBuffer` / `destroyTexture`) | add-only minor when destroy feat lands |
| OOS-6 | Tape cross-version compatibility | shipped in v3 (`SUPPORTED_TAPE_VERSIONS = {2,3}`) |
| OOS-7 | rhi-wgpu (wasm) backend capture/replay testing | v2 |
| OOS-8 | Browser pixel-deterministic replay | dawn-node only epsilon <= 0.01; browser: non-zero + structural only |
| OOS-9 | URL param `?forgeax-debug=1` trigger | v2 (`FORGEAX_ENGINE_RHI_DEBUG=1` env only) |
| OOS-10 | `executeBundles` / occlusion queries event recording | in `DEFERRED_COMMANDS`; replay support deferred |
| OOS-11 | Auto-recovery from capture failure (recording -> idle) | v1: manual `disposeError()` required |