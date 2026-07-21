# @forgeax/engine-net

> **Host-neutral memory transport and profile-driven ECS replication.**
>
> Start at `NetEndpoint`; add `NetSession` to bind a transport to a World; then declare one `defineReplication` profile and attach `AuthorityCoordinator` / `ReplicaCoordinator`. `NetEntityId` is the only cross-World identity. Local ECS handles never cross the boundary.

`@forgeax/engine-net` depends on `@forgeax/engine-ecs`, `@forgeax/engine-plugin`, and `@forgeax/engine-types`. It has no WebSocket, browser, app, or runtime dependency.

## 1. Endpoint: complete bytes and lifecycle

`NetEndpoint` is the transport seam: complete `Uint8Array` messages, transport-issued `PeerId`, and connect/disconnect lifecycle. It does not know World, schema, profile, or codec policy.

```ts
import { createMemoryEndpointPair } from '@forgeax/engine-net';

const [serverEndpoint, clientEndpoint] = createMemoryEndpointPair();
const [{ peerId }] = serverEndpoint.poll();
serverEndpoint.send(peerId, new Uint8Array([1, 2, 3]));
```

The memory pair is deterministic and is suitable for headless tests. Its delay, duplicate, malformed-byte, and forced-disconnect controls are test-only fault injection; they are not transport recovery, reconnect, or resync APIs.

## 2. Session: host integration

`NetSession` owns endpoint polling, peer observation, bounded raw game messages, and attached replication coordinators. Call `receiveEvents()` before simulation work and `publish()` after authoritative work. The session surfaces actual peer IDs; games do not retain a concrete endpoint.

```ts
import { NetSession } from '@forgeax/engine-net';

const authoritySession = new NetSession({ endpoint: serverEndpoint, maxRawMessages: 32 });
const replicaSession = new NetSession({ endpoint: clientEndpoint, maxRawMessages: 32 });

authoritySession.receiveEvents();
replicaSession.receiveEvents();
// World simulation happens here.
authoritySession.publish();
replicaSession.receiveEvents();
```

Use `getPeerSnapshot()`, `sendRaw()`, and `drainRawMessages()` only for host/game protocol outside the replication profile. A raw message is not trusted replication state.

## 3. Profile: select portable ECS state once

`defineReplication` fixes the selected entity query, ordered component list, portable schema projection, limits, and fingerprint. It returns a structured error when a selected component is transient or contains process-local reference data.

```ts
import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  createAuthorityCoordinator,
  createReplicaCoordinator,
  defineReplication,
} from '@forgeax/engine-net';

const Networked = defineComponent('Networked', { enabled: 'bool' });
const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
const profile = defineReplication({
  name: 'game-state',
  entities: { with: [Networked] },
  components: [Networked, Position],
}).unwrap();

const authority = createAuthorityCoordinator(new World(), profile);
const replica = createReplicaCoordinator(new World(), profile, clientEndpoint);
authoritySession.attachAuthority(authority);
replicaSession.attachReplica(replica, profile.limits);
```

The authority publishes an initial full snapshot, suppresses canonically unchanged component replacements, sends complete component replacement/add/remove operations, and publishes a fresh full baseline when a peer connects later. `NetEntityId` is non-zero, authority-issued, and never reused; it maps each World’s distinct local `EntityHandle` values.

## 4. Replication evidence and failure handling

Incoming replication bytes are decoded, bounded, profile-checked, identity-checked, and reference-closed before mutation. Same-batch spawn references may resolve forward; cross-batch unresolved references do not queue. A rejected sender is disconnected and the replica World is unchanged.

The deterministic memory model tests prove NetEntityId-keyed semantic convergence between separately allocated Worlds for:

- initial full publication, unchanged publication, and late join;
- scalar and `array<entity>` reference remap;
- component replacement, add, and removal;
- spawn/despawn and identity cleanup;
- malformed, truncated, over-limit, schema, ordering, identity, and unresolved-reference rejection with zero mutation; and
- fatal stop after a real post-validation ECS write invariant failure.

A post-validation ECS apply invariant failure returns `apply-invariant-failed` and permanently stops that `ReplicaCoordinator`; create a new session/coordinator rather than continuing from partial trusted state.

## Structured recovery

Expected failures are closed unions carrying `.code`, `.expected`, `.hint`, and code-narrowed `.detail`. Exhaustively handle the code; the hint states the supported next action.

```ts
const errors = replicaSession.receiveEvents();
for (const error of errors) {
  switch (error.code) {
    case 'decode-invalid-payload':
    case 'decode-limit-exceeded':
    case 'ordering-invalid-tick':
    case 'identity-invalid':
    case 'schema-invalid':
    case 'remap-unresolved-reference':
      // Sender is disconnected; retain the unchanged replica World.
      break;
    case 'apply-invariant-failed':
      // This coordinator is stopped; inspect detail and create a fresh session.
      break;
    case 'handshake-profile-mismatch':
      // Do not attach/apply across incompatible profiles.
      break;
  }
}
```

## Codec and remap details

The replication codec is the sole canonical byte/limit authority. `ReplicationLimits` bound message bytes, entities, component operations, strings, buffers, and arrays before mutation. Component data is reflection-projected through the ECS externalization kernel. Entity and `array<entity>` fields contain NetEntityIds on the wire and are remapped through the replica identity map during apply.

## Out of scope

This package deliberately does **not** provide:

| Capability | Status |
|:--|:--|
| WebSocket, Node listener, browser/process E2E, or gameplay/Snake surface | Not implemented |
| Reconnect, ACK ledger, resync, packet-loss recovery, pending unresolved-reference queue | Not implemented |
| Client prediction, interpolation, rollback, or lockstep | Not implemented |
| Per-entity authority, ownership, or authority transfer | Not implemented |
| Socket-specific retry or automatic recovery after a disconnect/fatal apply | Not implemented |

## Entry points

| Export | Purpose |
|:--|:--|
| `NetEndpoint`, `PeerId` | Transport-only bytes and peer lifecycle contract |
| `createMemoryEndpointPair` | Deterministic memory transport pair |
| `NetSession`, `netPlugin` | World-facing session integration |
| `defineReplication`, `ReplicationProfile` | Portable selected ECS replication contract |
| `AuthorityCoordinator`, `ReplicaCoordinator` | Authority publication and atomic replica apply |
| `NetEntityId` | Opaque cross-World entity identity |
| `NetError`, `EndpointError` | Closed structured expected failures |

## Source map

- Endpoint contract and memory transport: `src/endpoint/`
- Session host seam: `src/session/`
- Profile, codec, identity, authority, and replica: `src/replication/`
- Convergence and rejection evidence: `__tests__/memory-*.integration.test.ts`, `__tests__/replica-fatal-stop.test.ts`
