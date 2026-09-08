---
name: forgeax-engine-rhi-debug
description: >-
  ForgeaX deterministic RHI capture, replay, and per-work inspection. Use when diagnosing
  black frames, wrong bindings, draw divergence, or backend-specific GPU behavior.
---

# forgeax-engine-rhi-debug

Use this skill when a render issue needs a self-contained capture, deterministic
replay, or offline per-work inspection. The package contract is the SSOT:
[`packages/rhi-debug/README.md`](../../packages/rhi-debug/README.md).

## Mental model

| Concept | Use |
|:--|:--|
| `.rhitape` | One canonical v7 artifact containing the frame events and binary blobs. |
| `EventSemantics` | The method-to-event and handle-lifecycle mapping. |
| `TapeIndex` | Derived event, resource, and work lookup. |
| `FrameModel` | One `works[].workIndex` sequence shared by all inspectors. |
| `ReplaySession` | Fresh backend creation, typed resources, readback, and disposal. |

There is one artifact and one owner per concern. Do not invent a second tape,
selection key, resource registry, or host-side replay model.

## Shortest workflow

1. Attach the recorder to the real RHI backend at the Runtime to App seam.
2. Capture one frame and retain its `{ kind, digest, bytes }` result.
3. Decode the bytes with the strict v7 decoder.
4. Build `FrameModel` and select a `works[].workIndex`.
5. Open a replay session with a factory that creates a fresh backend.
6. Inspect that work item, then dispose the session even on failure.

```ts
const captured = await app.rhiCapture?.captureFrame();
if (!captured?.ok) return captured;
const tape = decodeTape(captured.value.bytes);
if (!tape.ok) return tape;
const model = buildFrameModel(tape.value.tape);
const replay = await openReplay(tape.value.tape, createFreshBackend);
if (!replay.ok) return replay;
const result = await replay.value.inspectWork(model.works[0].workIndex);
replay.value.dispose();
```

## Protocol and lifecycle rules

- Accept only `RHITAPE` with `formatVersion: 7`.
- Validate canonical JSON, digest, typed arrays, handles, blobs, cardinality,
  and create/dispose history before replay.
- Reject versions 2 through 6 explicitly.
- Use the same `workIndex` for EventBrowser, PipelineState, TextureViewer,
  ResourceInspector, and DevKit inspect.
- Let `ResourceTable` validate generations and own disposal.
- Use the declared readback format matrix; return structured unsupported or
  failed results instead of guessing a conversion.

## Structured recovery

Expected failures are `Result` values with `RhiDebugError`. Switch on
`error.code` and let TypeScript narrow `error.detail`; do not parse `.hint` or
message text to decide control flow.

| Failure | First action |
|:--|:--|
| `tape-invalid` | Preserve the original bytes and capture again if the source is stale. |
| `tape-version-unsupported` | Use a producer that emits v7; older formats are not compatibility inputs. |
| `replay-capability-mismatch` | Create a fresh backend with the recorded capabilities or record again. |
| `replay-position-invalid` | Select a `workIndex` from the current `FrameModel`. |
| `readback-unsupported` | Keep structural evidence and report the missing backend format capability. |
| `readback-failed` | Preserve the detail stage and dispose the replay session. |

## Viewer evidence

The Viewer is read-only. It loads one `.rhitape`, shows the four linked views
through the shared `workIndex`, and keeps the structural model available when
WebGPU is absent. Pixel inspection is a capability-gated enhancement, not a
reason to replace the tape or create a browser-only model.

For an AI handoff, include the artifact digest, selected `workIndex`, event
anchor, structured error detail when present, backend capability result, and
the exact command or browser path used.

## Platform boundaries

| Platform | Owns |
|:--|:--|
| Browser | DOM file selection, WebGPU backend construction, and raw tape transfer. |
| Node / DevKit | File access, operation discovery, and host-owned fresh backend creation. |
| Dawn | Native backend and pixel evidence. |
| Core package | Protocol, recorder, index, model, replay, and readback contracts. |

The core must not import DOM, Node filesystem APIs, PNG encoders, or Viewer
state. The Vite bridge serves one raw tape in development only.

## Verification

```bash
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm exec tsc -b packages/rhi-debug/tsconfig.json --pretty false
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm --filter @forgeax/engine-rhi-debug exec vitest run --config vitest.config.ts src/__tests__
pnpm test:browser
pnpm test:dawn
```

Use the package and host gates for the changed surface, then preserve the
artifact and its command output as evidence. Do not call an unrun browser or
Dawn gate green.
