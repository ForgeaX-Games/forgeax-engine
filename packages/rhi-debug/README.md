# @forgeax/engine-rhi-debug

The RHI debug package records one self-contained v7 frame tape, decodes it
strictly, and replays it on a fresh backend for deterministic inspection. The
artifact is one `.rhitape` file. The same artifact is the input to summary,
replay, readback, and the read-only Viewer.

> [!IMPORTANT]
> The shortest AI workflow is `captureFrame -> decodeTape -> buildFrameModel ->
> openReplay.inspectWork`. Keep the returned digest with the bytes. Do not
> infer a second artifact, a paired input, or a live inspection owner.

Capture requests arriving between frames start recording at the next snapshot
boundary. Work submitted before that boundary is excluded from the one-frame
tape. Hosts must keep rendering resources stable while `frameBoundary()` seeds
its snapshot; the Render Worker waits for that promise before consuming its next
publication.

## AI cold-start manifest

| Step | Input | Stable result | Next coordinate |
|:--|:--|:--|:--|
| Capture | one bounded frame | `EncodedTape { bytes, digest }` | retain the same digest and bytes |
| Decode | `.rhitape` bytes | `V7Tape` or `tape-*` error | `buildFrameModel(tape)` |
| Project | `V7Tape` | JSON-safe `FrameModel` arrays | choose `works[n].workIndex` |
| Inspect | same tape + fresh `ReplaySession` | pipeline, bindings, resources, or error | pass `workIndex` to panels |
| Readback | `resourceId` + optional subresource | typed pixels or `readback-*` error | display with provenance |
| Preview | selected raster shader facts | viewer-private `preview` or `preview-*` | never write canonical facts |

`FrameModel.works[].bindings` rows report each binding's static `bufferOffset` and
the `dynamicOffset` applied by the draw's latest `setBindGroup` (in layout binding
order; `null` for a static binding), so the effective slot is their sum.

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
Recorder blob deduplication uses the same SHA-256 digest as the tape codec.
Short rolling hashes are not valid content identities: ordinary all-one half
float color and full float depth textures can collide, as can equally sized
buffer payloads. Blob keys remain opaque v7 references; a previously corrupted
capture must be recorded again because deduplication discarded its original
bytes. Dawn and browser capture/replay tests protect this boundary with two
distinct buffer payloads that collided under the former rolling hash.
Consumers receive derived views and never reconstruct event or resource state.
Captured buffer and texture descriptors retain their producer labels, including
bootstrap resources. Inspect them through `FrameModel.resources[].descriptor.desc.label`;
labels aid navigation while `resourceId` and `workIndex` remain the actual keys.
`buildResourceLifecycle(tape)` joins bootstrap ownership with recorded destruction.
Bootstrap rows have `createdEventIndex: null`; frame event indices are never shifted.
Counts and descriptor byte estimates describe the captured resource closure, not
allocations created during this frame or driver memory. Locate indirect consumers
through the selected work's `bindings`, vertex/index buffers and attachments;
`resources[].consumers` only lists direct event references.

## Capture and inspect

```ts
import { buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';

// App owns the recorder-enabled frame boundary. Retain the returned bytes and digest.
const captured = await app.rhiCapture?.captureFrame();
if (!captured?.ok) return captured;
const decoded = decodeTape(captured.value.bytes);
if (!decoded.ok) return decoded;
const model = buildFrameModel(decoded.value);
const backend = await createFreshBackend(decoded.value);
const replay = await openReplay(decoded.value, backend);
if (!replay.ok) return replay;
try {
  return await replay.value.inspectWork(model.works[0].workIndex, ['pipeline', 'bindings', 'pixels']);
} finally {
  await replay.value.dispose();
  // The host also releases its backend device.
}
```

The host supplies the real RHI backend and owns the file write. The package
owns recording, encoding, decoding, replay, and readback contracts. Expected
failures are `Result` values, not message-parsed exceptions.

Recorder attachment preserves both the asynchronous shader factory and an
optional `createShaderModuleImmediate` factory on the explicit RHI backend.
Pipeline handles retain native identity. Calls to `getBindGroupLayout(index)`
record the originating pipeline and index, so automatic layouts participate in
bootstrap dependency closure and are recovered from the recreated pipeline
during replay.

## File-first inspection

```sh
forgeax debug rhi capture --json
forgeax debug rhi summary --artifact frame.rhitape --json
forgeax debug rhi inspect --artifact frame.rhitape --work-index 22 --fields '["pipeline","bindings","pixels"]' --json
```

The CLI derives the artifact digest from the file. An optional `--digest
sha256:...` verifies expected identity and returns `artifact-digest-mismatch`
before replay if the file changed. Recorder and CLI use `tapeDigest` for the
same SHA-256 artifact identity.

`rhi.summary` returns `summary.works[]`: work/event/pass indices, draw or dispatch
kind, debug groups, pipeline identity, entry points and attachments. Shader
source stays in `rhi.inspect`; the summary does not repeat it per draw.
`summarizeFrame(buildFrameModel(tape))` exposes the same projection to library
callers without requiring a GPU.

> [!WARNING]
> `FrameModel.unseededResources` and `summary.unseededResources` list retained
> buffers/textures with no captured initial bytes. Replay starts them at zero.
> Pixel evidence requires a captured producer before the first read, or a new
> capture that includes the initial contents. A successful replay alone does
> not establish pixel fidelity. An empty list establishes only that no entire
> bootstrap buffer/texture seed is absent, not equivalence to the live image.

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

`openReplay(tape, backend)` uses the caller's fresh device and shader factory.
`ResourceTable` owns replay resources and typed handle generations; stale
generations fail closed. Session disposal releases replay resources; the
supplied backend remains owned by its caller.

`inspectWork(..., ['pixels'])` reads the first color attachment's resolve target
when present, after finishing the selected work's pass. Direct reads of an
unresolved multisampled texture return `readback-unsupported` before any copy.
`works[].attachments.colorResolveViewHandleIds` lists each color attachment's
resolve view in attachment order (`null` for a single-sample attachment), so a
multisampled multi-target pass such as weighted blended OIT accumulation exposes
every readable 1x target id for `readResourceAtWork`.
Partial replay closes command and pass debug groups still open at the selected
work, deriving the scopes from the recorded prefix without running later draws.
The remaining readback matrix is explicit: supported color/depth formats use
the backend path, unsupported formats return `readback-unsupported`, and
transfer or map failures return `readback-failed`.
`r32uint` readback preserves the original four bytes per texel, including all
packed material and lighting-context bits; it does not normalize or convert
integer values through floating point. `rg32uint` preserves two words and
`rgba32uint` preserves four (8 and 16 bytes/texel). Use `readResourceAtWork` with the selected color
attachment handle to inspect a later MRT target; `inspectWork` previews the
first color attachment.
Fresh-device requests derive required WGSL features from captured `enable`
directives, including bootstrap shaders. An unenabled required feature fails
with `replay-capability-mismatch` before replay resource creation.

Retained `depth32float` textures are snapshotted across every array layer and
mip level. Replay restores the exact floats through a depth-only raster pass,
so a cached shadow map remains valid even when its producer is absent from the
captured frame. Other depth/stencil and multisampled initial contents are not
seeded; their producing work must be included in the capture.
`readResource(resourceId, subresource)` reads the captured initial state.
`readResourceAtWork(resourceId, workIndex, subresource)` replays through the
selected work before reading, including compute storage outputs. Its
`provenance.selectedWorkIndex` identifies that post-work state. Use this form
when checking what a dispatch produced; initial bytes are not output evidence.

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

### Timestamp-bearing frame capture

Render, compute and empty-compute pass timestamps retain their QuerySet handle
identity in v7 events. Capture closure includes a QuerySet created before the
capture window; validation and resource lineage treat it as a referenced
resource. Replay replaces its serialized descriptor object with the fresh
device's QuerySet while preserving beginning/end indices. A missing identity
is a structured replay failure, never a request to silently remove timestamps.

## Render bundle capture

Bundle commands are retained by the recorder when the bundle is created, even while no
frame is being captured. `executeBundles` expands those commands at each execution into
the canonical v7 event stream. Every draw retains the ordinary `workIndex`, pipeline,
binding and resource lineage; there is no parallel bundle inspector or replay registry.
`resetRenderState` marks native bundle boundaries and replays through `executeBundles([])`.
It clears pipeline, bind-group and vertex/index state while retaining pass dynamic state.
Foreign/unrecorded bundles fail explicitly instead of producing a tape with missing draws.

[Real Browser/Dawn fixture](../runtime/src/__tests__/render-bundle.fixture.ts) covers a
bundle created before capture, copied dynamic-offset slices, live uniform updates, direct
and indirect indexed/non-indexed draws, seeded resources and fresh-device pixel replay.

The [changing-scene stress fixture](../runtime/src/__tests__/render-bundle-stress.fixture.ts)
compares every frame against direct rendering and replays selected frames on a fresh
device. Coverage includes list churn, resource replacement, pass state, live buffer
data and eight simultaneous passes. Queue uploads to retained resources between a
selected draw and its command-buffer submission are included in replay: they precede
that draw on the GPU even when the draw was recorded first. Uploads after that
submission and subsequent draws are excluded from the selected work prefix.

Reverse-Z uses the ordinary v7 tape: native clear/comparison/bias state and
projection bytes are recorded without reinterpretation. `replayDeviceRequest`
derives `depth32float-stencil8` from bootstrap and frame texture descriptors,
so the fresh device enables that optional feature before recreating resources.

### Structured compute and ray-query buffers

`inspectBufferRecords(session, resourceId, workIndex, layout, { first, count })`
replays the selected work and decodes only the requested buffer range. A layout
contains a byte `stride` and named fields with byte `offset`, scalar `type`
(`u32`, `i32`, or `f32`) and `components` (1–4). Calls accept at most 4,096 records,
64 fields, and 16 MiB. Invalid layouts/ranges return `readback-failed`; replay
and resource failures retain their existing codes.

The output retains resource/generation/work provenance and absolute record
indices. Integer identities remain integers; nonfinite floats become the JSON-safe
strings `NaN`, `+Infinity`, and `-Infinity`. `decodeBufferRecords` exposes the same
interpretation for an already-read exact range. The producer supplies the layout;
RHI Debug does not infer material/BSDF or ray semantics from buffer labels.

The existing `rhi.inspect` operation and `forgeax debug rhi inspect` command accept
an optional `buffer` object containing `resourceId`, `layout`, `first`, and `count`;
the response adds `bufferRecords`. Use `rhi.summary` / binding inspection to select
the resource and work, then pass `--buffer '{...}'`. The same v7 tape remains the
only capture artifact. See [ray-query verification](../../scripts/raytracing/README.md).

> [!NOTE]
> Portable compute traversal is captured and replayed. Native hardware verification
> currently rebuilds acceleration structures from the captured world-space input;
> it is **scene re-execution**, not capture/replay of native BLAS/TLAS commands.


### Capture memory and retry

Snapshot exceptions and timeouts preserve the same `detail.progress`: queue drain
versus resource readback, resource counts, current handle/kind/size, and elapsed
time. A queue rejection before readback has no current resource; do not attribute
it to a texture or shader. The original cause remains alongside this progress.
A rejection from a cancelled older generation omits progress from a newer capture.

`CaptureFrameOptions.byteBudget` bounds the uncompressed initial-resource payload,
derived from the same format/block, array-layer and mip layout used for readback.
Mappable scratch, multisample contents and unsupported depth/stencil seeds are excluded;
their existing unseeded-resource diagnostics remain authoritative. This budget is not a
bound on final tape size, total process memory or driver allocations.

Resource snapshots batch at most 32 resources and target at most 32 MiB of padded
staging allocations. A larger individual resource runs alone, so the staging bound is
`max(32 MiB, largest resource staging size)`. Full seed bytes and the encoded tape
still need CPU residency. Internal readback bytes transfer into the blob pool without
another copy; caller-owned queue uploads are copied, including the exact typed-array
view. Uncompressed encoding borrows those immutable bytes only until it fills the
final independent container.

Snapshot blobs use asynchronous native SHA-256 with the same content keys as
synchronous queue uploads. Hash completion rechecks capture generation before
publishing bytes or events; a cancelled digest cannot seed a later capture.
This also lets the existing snapshot deadline run while large seeds are hashed.

An aborted or lost generation cannot settle a later capture. The same attachment
supports retry after budget refusal or cancellation. The real Browser/Dawn regression
`snapshot-memory` captures three complete array/mip textures, asserts staging bytes,
and replays two draws after producer disposal, including a changed subarray upload.
It also holds a real native digest across cancellation and rearming, then verifies
that only the new generation can populate the blob pool.
