# `@forgeax/engine-tool-runtime`

AI tools follow one discoverable proposition: `list -> describe -> run -> terminal`.
This focused package owns the realm-neutral contract only. A contribution keeps its
descriptor and executor together, while DevKit and other hosts provide the authority
and physical realm.

Preview descriptors may add a portable `preview` contract containing `realm`, a
`ToolSubjectRef`, and a `SnapshotRef`; `evidence` remains the required
`ArtifactRef` kind list. `defineTool` rejects a preview contract whose realm does
not match its descriptor, so a consumer cannot silently execute in another realm.

```ts
const tool = defineTool({
  id: 'author.write',
  title: 'Write author state',
  summary: 'Writes one project value.',
  realm: 'build',
  argsSchema,
  resultSchema,
  evidence: [],
}, async (args, context) => ({ ok: true, value: await write(args, context.signal) }));
```

Terminal payloads contain only typed results, serialized `snapshotAfter`, `ArtifactRef`
values, and an optional `ToolCleanupReport`. A live handle, canvas, renderer, page,
Fiber, or carrier is never part of the portable contract. Providers call
`context.setCleanupReport` before terminal; the runtime publishes one terminal only
after required evidence and lexical cleanup are complete. A non-zero resource census
turns a would-be success into `tool-cleanup-failed`.

This package has no filesystem, Vite, WebGPU, Editor, or second registry dependency.

## Fiber-local typed capabilities

`defineToolCapability<T>(id)` creates only a static identity. A host adapter passes
one `capabilityResolver` when it runs a selected Entry; the executor obtains a
Fiber-local service with `context.require(capability)`. The result is a typed
`{ ok: true, value }` or a closed `ToolRuntimeError`. The token never enters tool
arguments, terminal results, artifacts, or a second service registry.

```ts
const previewHost = defineToolCapability<PreviewHost>('previewHost');
const contribution = defineTool(descriptor, async (_args, context) => {
  const host = context.require(previewHost);
  if (!host.ok) return host;
  return host.value.withSession(context.signal);
});
```

The resolver is valid only while the owning ToolRun lease is active. A missing
service returns `tool-capability-unavailable`; a resolver retained past terminal
returns `tool-run-terminal`. Hosts bridge their active Cordis Context through
`@forgeax/engine-plugin` and do not expose raw Context to executors.

## Optional service boundary

`createServiceCapability` accepts a workload-scoped `ServiceAdmissionRef` and
validates its tool, descriptor, recipe, code, browser, backend, 300-frame sample,
correctness, threshold, cleanup, and eviction facts. A missing or mismatched report
produces the closed `tool-service-capability-absent` state; callers cannot admit a
service with a boolean. `createAuthenticatedLoopbackTransport`
accepts only loopback HTTP and a bearer token; its request is structured-clone
safe and carries descriptor/recipe digests plus JSON arguments. The transport
does not add an operation registry or transfer live World, Renderer, Canvas,
Context, Fiber, or GPU handles. Hosts must retain a private executor and use it
when admission is absent or when the disposable service is deleted.

## Capability migration

Migration is a finite, versioned contract rather than a live runtime handoff.
`createCapabilityToken` records source and expected target probes;
`probeMigrationTarget` must succeed before a target is used. A migration recipe
carries only JSON arguments, `SnapshotRef`, and `ArtifactRef` values. Recursive
live `world`, `renderer`, `canvas`, `context`, `fiber`, `page`, `carrier`, `ui`,
`selection`, `draft`, `undo`, and `session` state is rejected with
`tool-migration-live-state`.

> [!IMPORTANT]
> A target probe failure is a structured capability failure. It never transfers
> a live World, Renderer, Canvas, Context, Fiber, page, carrier, or UI session.

## Authenticated ephemeral visible carrier

The visible carrier transport is an ephemeral two-process boundary. A host
publishes a POD offer containing `offerId`, loopback `endpoint`, bearer token,
`generation`, `descriptorDigest`, `recipeDigest`, and `expiresAt`. The consumer
must complete `lease -> start -> execute -> exit`; the transport never creates a
ToolRun, registry, World, or fallback executor.

`createAuthenticatedCarrierTransport` authenticates every request and exposes
structured failures with stable `code`, `expected`, `hint`, and optional
`detail`. Digest/auth failures require a fresh offer. Provider exit after
`start` is terminal (`carrier-provider-exit` or `carrier-exited`): report one
failure and never execute through a second fallback path. Capture and cleanup
failures remain structured so retry is allowed only from a safe snapshot.
