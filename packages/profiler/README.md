# @forgeax/engine-profiler

> **One capability: opt-in, bounded CPU capture with a schema-valid offline artifact.** Start a capture, drive the App and Render loop, finish it, then inspect the same `ProfileCapture` in memory, through the CLI, or through the Remote `profiler` root.

## One-screen takeoff

```ts
import {
  buildProfileModel,
  createProfiler,
  validateProfileCapture,
} from '@forgeax/engine-profiler';

const profiler = createProfiler();
const started = profiler.startCapture({ frameLimit: 120, eventLimit: 1024 });
if (!started.ok) throw started.error;

// Drive the App or Render loop here.
const finished = started.value.finish();
if (!finished.ok) throw finished.error;

const checked = validateProfileCapture(finished.value);
if (!checked.ok) throw checked.error;
const model = buildProfileModel(checked.value);
if (!model.ok) throw model.error;
console.log(model.value.summary.completeness.status, model.value.summary.recordCount);
```

Pass the same `profiler` to `createApp({ renderer, world, profiler })` or to the canvas-form options. The capability is opt-in; an App without it does not create capture records or artifacts.

## Progressive disclosure

| Need | Public entry | Result |
|:--|:--|:--|
| Start a bounded capture | `createProfiler().startCapture(limits)` | `Result<RecorderSession, ProfilerError>` |
| Finish and retain the artifact | `session.finish()` | `Result<ProfileCapture, ProfilerError>` |
| Validate persisted JSON | `validateProfileCapture(value)` | schema and semantic validation |
| Build an offline summary | `buildProfileModel(capture)` | frame and phase projections |
| Query from a shell | `forgeax-engine-profiler summary --file artifact.json` | structured JSON on stdout |

`ProfileCapture` is the portable boundary. It carries the fixed version, time unit, bounded frame and event evidence, owner phase catalog, and `completeness` status. `complete`, `partial`, and `overflow` are explicit outcomes; an overflow artifact remains useful and records its affected frame range.

## Limits and allocation evidence

Always set both `frameLimit` and `eventLimit` to positive safe integers. The recorder retains bounded arrays and fixed records, reports dropped events after overflow, and never presents an overflow artifact as complete. A host can pass `allocationReport` to `createProfiler` to count profiler-owned event object allocations; the deterministic D-6 gate requires zero allocations while the profiler is off.

```ts
const allocationReport = { profilerEventObjectAllocations: 0 };
const profiler = createProfiler({ allocationReport });
```

The phase catalog is exposed as `profiler.phaseCatalog`. App and Render owners publish their catalogs; consumers should read that relation rather than copy phase names into another list.

## Offline and CLI workflow

```sh
forgeax-engine-profiler summary --file profile-capture.json
forgeax-engine-profiler frame --file profile-capture.json --frame-id 12
forgeax-engine-profiler phase --file profile-capture.json --source render --phase record
```

The CLI reads one `ProfileCapture` JSON object from `--file` or stdin and emits structured JSON. It does not reconnect to a live App. The same artifact can be checked before analysis:

This is a copyable schema-valid complete artifact. The owner catalog is part of the artifact, so a
consumer can validate and analyze it without a separately maintained phase list.

```json
{
  "schemaVersion": "1.0",
  "captureId": "capture-0001",
  "timeUnit": "microseconds",
  "frameLimit": 1,
  "eventLimit": 8,
  "phaseCatalog": {
    "app": [
      "frame-total",
      "world-update-primary",
      "draw-source",
      "world-update-injected",
      "renderer-draw"
    ],
    "render": ["extract", "bind-groups", "features", "sort", "record"]
  },
  "records": [
    {
      "kind": "phase",
      "source": "app",
      "frameId": 1,
      "phase": "frame-total",
      "startMicros": 1000,
      "endMicros": 1100,
      "durationMicros": 100
    }
  ],
  "completeness": {
    "status": "complete",
    "retainedEventCount": 1,
    "droppedEventCount": 0
  }
}
```

```ts
const input = JSON.parse(text);
const result = validateProfileCapture(input);
if (!result.ok) {
  console.error(result.error.code, result.error.detail.path, result.error.hint);
}
```

## Errors and boundaries

Expected failures return `Result`; inspect `.ok`, then use `.error.code`, `.error.expected`, `.error.hint`, and `.error.detail`. The closed error union is defined in `packages/profiler/src/errors.ts`; keep exhaustive handling there instead of parsing messages or reproducing the member list in a consumer.

Profiler owns capture records, bounds, allocation evidence, and offline projections. It does not own GPU timestamps, ECS scheduling, a browser UI, a network method, or a live trace service. Remote exposure remains the host's explicit `profiler` root opt-in through the existing `eval` and `introspect` methods.

## Public surface

| Entry | Purpose |
|:--|:--|
| `createProfiler(options?)` | Creates an opt-in bounded recorder with an optional sink, clock, catalog, and allocation report. |
| `ProfileCapture` | Versioned artifact accepted by validation, model building, and the CLI. |
| `validateProfileCapture(value)` | Validates schema and semantic invariants before offline use. |
| `buildProfileModel(capture)` | Projects retained records into summaries without changing the artifact. |
| `createProfileClock()` | Supplies the default monotonic microsecond clock. |

The package root is the only supported import path for these entries. See `schema/profile-capture.schema.json` for the artifact contract and `scripts/bench/profiler-overhead.mjs` for the deterministic D-6 consumer gate.
