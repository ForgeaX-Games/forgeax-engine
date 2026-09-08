# Hello M33 Intelligence Worker

> [!NOTE]
> This app is an evidence host for the `@forgeax/engine-intelligence` contract. The provider stays on the Host; the Engine World and its `Update` polling system run in a real `engine-worker`. The legacy M26 page remains available at `/`; M27 uses `/m27.html`; M28 uses `/m28.html`; M29 uses `/m29.html`; M30 uses `/m30.html`; M31 uses `/m31.html`; M32 uses `/m32.html`; M33 uses `/m33.html`.

## Run the gauntlet

```sh
pnpm --filter @forgeax/hello-intelligence-worker gauntlet
```

The `gauntlet` script runs the M27 input-boundary baseline and the M28 close-fault scenario, each with a normal case plus a red falsifier case. With `maxInputChars = 4`, M27 proves exact-limit input, structured invalid-input refusal, healthy sibling progress, and same-provider `SessionRef` retry.

M28 makes the Host provider reject during disposal while one Worker activity is still active. The normal case proves terminal-only World mutation, close idempotency, late callback quarantine, and a valid activity through a fresh same-page `MessageChannel`/runtime/client. Its close-ordering probe observes the legacy failure if callbacks become visible during `runtime.close()`.

M29 makes the Worker optimistic limit larger than the Host runtime limit. The
normal case keeps activity A live, accepts B optimistically, receives one
structured Host capacity rejection for B, proves B is removed from the Worker
active set, completes A, and retries B through the same SessionRef and binding.
The falsifier drops the `intelligence-rejected` message at the Host/realm seam;
the Worker must catch that missing terminal instead of claiming recovery.

M30 creates provider-A and provider-B bindings on the same page. Provider A first returns a terminal
`SessionRef`; provider B's Worker client rejects that ref synchronously before allocating identity,
capacity, or sending a MessagePort submission. A valid provider-B request and provider-A same-session
retry then complete through the same Worker. Its falsifier bypasses the provider-B client guard and sends
the mismatched submission directly to the Host runtime, which the browser runner must catch.

M31 constrains both sides of the transport to `maxPollEvents = 1`. Two Host
activities emit interleaved text and terminal events while the Worker issues
one poll credit at a time. The normal case records exact request/response
accounting, per-activity sequence delivery, no starvation, terminal-only
authoritative mutation, and a same-client activity after both terminals free
optimistic capacity. The falsifier duplicates one event at the Host/realm seam;
the Worker must reject the sequence violation while the normal control remains
green.

M32 starts provider-B work and one outstanding B poll, then the Host directly
 calls `IntelligencePortBinding.close()`. The normal case proves that the Worker
 receives `intelligence-closed`, clears active/rejected/backlog/poll-credit
 state, refuses submit and cancel with structured `intelligence-closed`, and
 keeps provider-A usable. It creates provider-C through a fresh same-page
 `MessageChannel`/runtime/client, proves terminal-only World mutation, and
 settles repeated client, binding, provider, and `ExecutionApp.stop()` cleanup.
 Provider-B intentionally invokes two late callbacks after close; the runtime
 quarantines both. The headed Chrome falsifier suppresses the Host closed
 notification and keeps the raw port open, so post-close identity/transport
 effects and the hanging client close are observable and must be caught.

M33 keeps the M32 live-work/poll setup but injects a synchronous throw only while
the Host binding publishes `intelligence-closed`. The binding's shared close task
must settle, release the physical port exactly once, remove Host authority, and
quarantine provider callbacks even though the Worker cannot receive that failed
terminal notification. The page then creates a fresh same-page provider-C
`MessageChannel`/runtime/client/binding and proves valid work plus terminal-only
World mutation. The paired falsifier preserves the notification fault while
suppressing physical release; it must expose the uncontained release failure.

Run the headed M33 journey, including its red falsifier, with:

```sh
pnpm build:engine
pnpm --filter @forgeax/hello-intelligence-worker build
node apps/hello/intelligence-worker/scripts/m33-smoke-browser.mjs --gauntlet
```

The falsifiers deliberately write partial output into authoritative World state before a terminal and retain the pre-fix close-ordering oracle. They must be caught while the controls remain green and the page and Worker remain free of uncaught errors.

## Evidence

Set `FORGEAX_GAUNTLET_ARTIFACT_DIR` to persist the canvas PNG and JSON reports. The M27, M28, and M29 scripts publish their respective evidence files when the red cases are enabled.

| Boundary | Witness |
| :-- | :-- |
| Host / Worker transport | `MessageChannel`, `bootstrapPort`, and `createIntelligencePortClient` |
| Frame authority | Worker plugin polls from an ECS `Update` system |
| Input recovery | exact-limit `abcd`, empty and limit-plus-one structured refusal, no identity/port/provider dispatch, healthy sibling, same-`SessionRef` retry |
| Close recovery | rejecting Host provider, terminal runtime state, idempotent close, late callback quarantine, fresh same-page binding |
| Host rejection recovery | Worker limit two versus Host limit one, one failed capacity terminal, optimistic-set release, sibling preservation, same-`SessionRef` retry |
| Provider-scoped session recovery | Provider-A terminal `SessionRef`, provider-B synchronous mismatch before identity/capacity/port/runtime/provider effects, same-page B success, A retry, and raw-submit falsifier |
| One-credit backlog | Host/client `maxPollEvents=1`, one outstanding poll, interleaved two-activity sequence proof, terminal capacity release, same-client recovery, duplicate-event falsifier |
| Host binding close recovery | Direct Host binding close during a live Worker activity/poll, synchronous `intelligence-closed` publication throw, awaited physical release, Host authority removal, provider-A survival, fresh provider-C channel, late callback quarantine, physical-release falsifier |
| Lifecycle | Worker client, Host binding/provider, and App `stop()` are called repeatedly |
| Visual/live path | Chrome, WebGPU canvas, explicit `execution.tier = 'engine-worker'` |
