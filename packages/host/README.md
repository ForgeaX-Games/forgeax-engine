# @forgeax/engine-host

A business-neutral frontend/backend pair. Each side owns a native Cordis Context. Protocol v2 transfers one frozen root program/configuration projection with a revision and sessionGeneration; activation returns a native Fiber.

```ts
import { createBackendHost } from '@forgeax/engine-host/backend';
import { createFrontendHost } from '@forgeax/engine-host/frontend';

const backend = await createBackendHost();
const frontend = await createFrontendHost({ assembly: backend.assembly.current });
await frontend.dispose();
await backend.dispose();
```

| Boundary | Contract |
|:--|:--|
| Root resolution | Inject `resolveRoot`; code must already be compiled for the target |
| Asset integration | Inject `activateRoot` to use the domain's validated asset reader |
| Readiness | External native startup barrier; pending descendants are not active |
| Replacement | New revision requires a fresh JavaScript environment |
| Cancellation | Disconnect aborts activation and releases owned contributions |
| Cleanup | Finite deadline; failures remain observable, borrowed Contexts survive |

Offline clients pass an assembly directly. Connected clients request it over Host transport and report the accepted revision/generation. Backend subscriptions observe reports without controlling publication. Stale reports are rejected. The existing capability request, cancellation and disconnection protocol remains the transport owner.

Host does not depend on Pack, project schema, World or Renderer. Those domain owners install ordinary plugins. `entryId` survives only in the external activation-report projection for wire consumers; it names a native Fiber within its session.

An owner may bind a distinct frontend projection to an authenticated connection:
`backend.bindProjection(caller, { assembly })` returns its disposer.
Only a live caller with its transport-issued capability is accepted; superseded reports are rejected. Use the caller supplied by the transport admission event, and register the
returned disposer with the owning plugin Fiber. Assembly fetches and activation
reports then use that connection's declared projection; default-assembly
notifications do not reach it. This does not activate backend plugins or change
peer assemblies. Rebinding replaces the projection, while an older disposer
cannot withdraw a replacement. Withdrawal fails the connection closed until
explicit rebinding or disconnect; it never falls back to another realm's
assembly. Disconnect and Host disposal release the retained binding.

The Host owns only this connection/assembly seam. Project, execution, admission
policy, snapshot lifetime and target semantics remain in the consuming domain
plugin. Hosts without a bound projection retain their normal assembly path.
