# @forgeax/engine-rhi-debug

The RHI debug package records one self-contained v7 frame tape, decodes it
strictly, and replays it on a fresh backend for deterministic inspection. The
artifact is one `.rhitape` file. The same artifact is the input to summary,
replay, readback, and the read-only Viewer.

> [!IMPORTANT]
> The shortest AI workflow is `captureFrame -> decodeTape -> buildFrameModel ->
> openReplay.inspectWork`. Keep the returned digest with the bytes. Do not
> infer a second artifact, a paired input, or a live inspection owner.

## AI cold-start manifest

| Step | Input | Stable result | Next coordinate |
|:--|:--|:--|:--|
| Capture | one bounded frame | `EncodedTape { bytes, digest }` | retain the same digest and bytes |
| Decode | `.rhitape` bytes | `V7Tape` or `tape-*` error | `buildFrameModel(tape)` |
| Project | `V7Tape` | JSON-safe `FrameModel` arrays | choose `works[n].workIndex` |
| Inspect | same tape + fresh `ReplaySession` | pipeline, bindings, resources, or error | pass `workIndex` to panels |
| Readback | `resourceId` + optional subresource | typed pixels or `readback-*` error | display with provenance |
| Preview | selected raster shader facts | viewer-private `preview` or `preview-*` | never write canonical facts |

The artifact identity is the digest of the one `.rhitape` byte sequence.
`FrameModel` is a plain-data projection safe for `JSON.stringify`. `ReplaySession`
is the sole fresh-device, replay, generation, readback, and disposal owner.
`workIndex` is the only cross-panel selection coordinate.

The Viewer Browser smoke emits a public cold-start transcript with explicit
inputs, outputs, codes, and recovery actions for the same ArtifactRef. The
transcript covers capture, summary, inspect, readback, preview, shader-error,
and layout-recovery. A recovery result is still useful structural evidence: it
must retain the artifact digest and coordinate while reporting the missing
capability or incomplete shader facts.

## Contract map

| Concept | Owner | Contract |
|:--|:--|:--|
| `.rhitape` | [`protocol/codec.ts`](src/protocol/codec.ts) | One canonical v7 envelope containing events, blobs, capabilities, and digest. |
| `EventSemantics` | [`protocol/event-semantics.ts`](src/protocol/event-semantics.ts) | Maps each RHI method to its event kind, handle effects, and lifecycle rules. |
| `TapeIndex` | [`protocol/tape-index.ts`](src/protocol/tape-index.ts) | Derives event, resource, and work lookup from the decoded tape. |
| `FrameModel` | [`frame-model.ts`](src/frame-model.ts) | Derives one `workIndex` sequence for the Viewer and inspection clients. |
| `ReplaySession` | [`replay/session.ts`](src/replay/session.ts) | Owns fresh-backend replay, typed resources, readback, and disposal. |

The protocol, index, model, recorder, and replay layers each have one owner.
Consumers receive derived views and never reconstruct event or resource state.

## Capture and inspect

```ts
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
} from '@forgeax/engine-rhi-debug';

const attachment = attachRecorder(backend, { maxBytes: 16 * 1024 * 1024 });
const captured = await attachment.captureFrame();
if (!captured.ok) return captured;

const decoded = decodeTape(captured.value.bytes);
if (!decoded.ok) return decoded;

const model = buildFrameModel(decoded.value.tape);
const replay = await openReplay(decoded.value.tape, createFreshBackend);
if (!replay.ok) return replay;

const inspection = await replay.value.inspectWork(model.works[0].workIndex);
replay.value.dispose();
```

The host supplies the real RHI backend and owns the file write. The package
owns recording, encoding, decoding, replay, and readback contracts. Expected
failures are `Result` values, not message-parsed exceptions.

## v7 tape rules

The decoder accepts only the current single-file format:

- the magic is `RHITAPE` and `formatVersion` is `7`;
- the JSON envelope is canonical and the digest covers the canonical payload;
- typed arrays, handle references, blob references, and lifecycle transitions
  are validated at the boundary;
- all referenced resources must have a valid create/dispose history;
- versions 2 through 6 are rejected explicitly, even when their payload looks
  compatible with v7.

Invalid cardinality, non-canonical JSON, digest mismatch, unknown event data,
or an invalid lifecycle transition returns a closed protocol error before
replay starts.

## One work index

`FrameModel.works` is the only selection vocabulary. Every work item has a
stable `workIndex`, event linkage, pipeline state, resource references, and
readback metadata. EventBrowser, PipelineState, TextureViewer, and
ResourceInspector consume that key, so selecting one work item keeps all four
views aligned.

## Replay and readback

`openReplay` requires a `ReplayBackend` factory. The factory is called only for
the requested operation and must return a fresh backend. `ResourceTable` owns
typed handle generations and disposal; stale generations fail closed. The
readback matrix is explicit: supported color/depth formats use the backend
path, unsupported formats return `readback-unsupported`, and transfer or map
failures return `readback-failed`. Every successful session and every failed
setup path releases backend resources before returning.

## Structured errors

The public operation boundary uses `RhiDebugError`. Consumers should narrow
`.detail` after switching on `.code` and keep the switch exhaustive:

```ts
function explain(error: RhiDebugError): string {
  switch (error.code) {
    case 'tape-invalid':
    case 'tape-version-unsupported':
    case 'replay-capability-mismatch':
    case 'replay-event-failed':
    case 'replay-position-invalid':
    case 'readback-failed':
    case 'readback-unsupported':
    case 'capture-unavailable':
    case 'capture-busy':
    case 'capture-snapshot-failed':
    case 'capture-timeout':
      return `${error.code}: ${error.hint}`;
  }
}
```

`.detail` is typed per code. `.expected` and `.hint` are display and recovery
fields; they are not substitutes for the discriminant.

| Code | Detail to inspect | Recovery action |
|:--|:--|:--|
| `tape-version-unsupported` | found and expected versions | capture or decode a v7 tape |
| `tape-invalid` | decode/validate stage and event | obtain complete canonical bytes |
| `replay-capability-mismatch` | replay cause | use a fresh device with recorded capabilities |
| `replay-event-failed` | event index, kind, stage, cause | inspect that event; later work is invalid |
| `replay-position-invalid` | requested and available work count | choose `FrameModel.works[].workIndex` |
| `readback-unsupported` | resource and format | select a supported readback target |
| `readback-failed` | copy/map phase and cause | retry on a fresh replay session |

The Viewer adds its own closed `preview-*` union. It is not added to
`RhiDebugErrorCode`; `preview-not-applicable` is the required branch for
compute, missing stage, incomplete facts, no WebGPU, or capability mismatch.
All error panels retain `.code`, `.detail`, `.expected`, and `.hint`, and never
classify failures with `startsWith`, regex, or free-form message parsing.

## Host and package boundaries

| Boundary | Allowed responsibility |
|:--|:--|
| RHI debug core | Pure tape protocol, recorder, index, model, replay, and readback contracts. |
| Browser host | DOM file input, WebGPU backend creation, and one `.rhitape` download/upload. |
| Node host / DevKit | File reads and writes, operation discovery, and fresh backend provisioning. |
| Dawn host | Native backend construction and pixel evidence. |
| Viewer | Read-only model and local no-WebGPU structural fallback. |

The core stays free of DOM, Node filesystem APIs, PNG packages, and Viewer
state. The Vite plugin is a serve-only transport for one raw tape artifact.

## Validation

```bash
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm exec tsc -b packages/rhi-debug/tsconfig.json --pretty false
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm --filter @forgeax/engine-rhi-debug exec vitest run --config vitest.config.ts src/__tests__
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm --filter @forgeax/engine-rhi-debug build
```

Browser and Dawn gates belong to the host and application packages. They must
exercise the same `.rhitape` bytes and the same `workIndex` used by offline
inspection.
