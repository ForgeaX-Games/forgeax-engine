# @forgeax/engine-net

> **Socket open is not authority.** A transport attachment is only a way to
> carry bytes. The realm-neutral `NetSession` contract remains non-authoritative
> until a fresh protocol-v2 baseline is accepted.

`@forgeax/engine-net` owns the application-session vocabulary, replication
packet schema, codec limits, and structured errors. WebSocket mechanics belong
to `@forgeax/engine-net-websocket`; gameplay meaning belongs to the consumer.
Reconnect, ACK ledger, resync, packet-loss recovery, and terminal cleanup are
described by the public contract below.
Socket-specific retry or automatic recovery remains a session policy concern;
the WebSocket package only supplies the endpoint and connector mechanics.

## First entry

Use the public barrel to discover the contract:

```ts
import {
  DEFAULT_NET_RECOVERY_POLICY,
  NetSession,
  createSessionId,
  resolveNetRecoveryPolicy,
} from '@forgeax/engine-net';

const sessionId = createSessionId(17).unwrap();
const policy = resolveNetRecoveryPolicy().unwrap();
const session = new NetSession({ endpoint, maxRawMessages: 32 });
```

`SessionId` is application identity. `PeerId` is transport identity and may
change when a socket is replaced. Never use a reopened socket or a new
`PeerId` as evidence that stale local state is authoritative.

## Lifecycle contract

`NetSessionState` is a closed union owned by one logical session:

| State | Meaning | Legal next states |
|:--|:--|:--|
| `connecting` | Initial endpoint attachment is pending. | `resyncing`, `failed`, `retired` |
| `resyncing` | A transport exists, but no fresh baseline is accepted yet. | `active`, `recovering`, `failed`, `retired` |
| `active` | The current epoch and ordered projection are accepted. | `recovering`, `failed`, `retired` |
| `recovering` | The session is replacing transport state under finite bounds. | `resyncing`, `failed`, `retired` |
| `failed` | Terminal protocol, apply, or recovery failure is observable. | `retired` |
| `retired` | The session owns no further work. | `retired` |

`isLegalNetSessionTransition` checks a transition without changing state.
`transitionNetSessionState` returns a `Result`, rejects a different
`SessionId`, and reports `session-illegal-transition` instead of silently
accepting an invalid replacement.

## Finite recovery policy

`DEFAULT_NET_RECOVERY_POLICY` is deterministic and finite:

| Field | Default | Bound |
|:--|--:|:--|
| `maxSessions` | `64` | Positive safe integer |
| `maxPendingPackets` | `32` | Positive safe integer per session |
| `ackTimeoutMs` | `250` | Positive safe integer |
| `maxPacketRetries` | `3` | Positive safe integer |
| `maxReconnectAttempts` | `5` | Positive safe integer |
| `reconnectDeadlineMs` | `10000` | Positive safe integer |
| `reconnectDelaysMs` | `[0, 100, 200, 400, 800]` | Non-negative safe integers |

`resolveNetRecoveryPolicy` merges overrides and validates the complete result.
Invalid bounds return `recovery-policy-invalid` with `.detail.field` and
`.detail.reason`. No transport package selects these limits or owns a retry
ledger. `NetEndpointConnector.connect(signal)` is the only realm-neutral
replacement-endpoint capability.

## Protocol-v2 packet contract

`ReplicationPacket` is the single machine-readable wire/schema authority. Each
encoded packet begins with the fixed `FXRP2` prefix and a newline. The public
union has exactly these kinds:

| Kind | Required identity | Payload rule |
|:--|:--|:--|
| `session-open` | `sessionId`, `epoch`, `sequence: 0` | Opens an application session. |
| `session-resume` | `sessionId`, `epoch`, `sequence: 0` | Requests the same application session after transport replacement. |
| `baseline` | `sessionId`, `epoch`, `sequence: 1` | Complete authority projection; required first data packet of an epoch. |
| `delta` | `sessionId`, `epoch`, positive `sequence` | Ordered projection after the accepted baseline. |
| `ack` | `sessionId`, `epoch`, `acknowledgedSequence` | Cumulative contiguous watermark. |
| `rejection` | `sessionId`, `epoch`, `sequence` | Structured rejection of a packet kind with a reason. |

Data packets also carry the safe-integer `tick`, profile `fingerprint`, and
projected `entities`. Entity kinds are the closed `upsert` and `despawn`
union. Protocol v1, a wrong prefix, malformed fields, unsafe identity values,
an invalid baseline sequence, and limit violations fail before dispatch.

```ts
import {
  decodeReplicationPacket,
  encodeReplicationPacket,
} from '@forgeax/engine-net';

const encoded = encodeReplicationPacket(packet, profile.limits);
if (!encoded.ok) {
  // Inspect encoded.error.code, expected, hint, and narrowed detail.
  return encoded;
}
const decoded = decodeReplicationPacket(encoded.value, profile.limits);
```

`ReplicationLimits` bound message bytes, entities, component operations,
strings, buffers, and arrays. Typed arrays are represented by an allowlisted
canonical tag and revived only after validation. There is no compatibility
decoder or second batch envelope.

## Structured failure and recovery guidance

Expected failures are `Result` values with `.code`, `.expected`, `.hint`, and
code-narrowed `.detail`. Branch on the code; do not parse error messages.

| Code | Meaning | Next action |
|:--|:--|:--|
| `protocol-unsupported-version` | The peer sent a version other than `2`. | Align the peer build before sending bytes. |
| `session-illegal-transition` | A state replacement is not legal for this session. | Wait for the current state or retire the session. |
| `recovery-policy-invalid` | A configured bound is invalid. | Fix the named field and resolve the policy again. |
| `recovery-rejected` | The authority rejected recovery. | Inspect `.detail.reason`, then dispose or fix admission. |
| `recovery-exhausted` | Finite attempts or deadline were exhausted. | Inspect accounting and create a new session only after terminal retirement. |
| `apply-invariant-failed` | Validated ECS application failed. | Treat the coordinator as terminal; never retry the fatal apply. |

The session snapshot shape is `NetRecoverySnapshot`: it reports `state`, the
stable `sessionId`, `pendingPackets`, `maxPendingPackets`,
`acknowledgedSequence`, `epoch`, `sequence`, `reconnectAttempts`, the latest
structured error, and `ownedResources`. `ownedResources` counts pending
connects, timers, ledgers, and callbacks; every terminal and disposed path
must report zero. `NetRecoveryOutcome` gives stable results for repeated
recovery calls: `started`, `already-recovering`, `already-active`, or `retired`.

## Runnable public evidence

Run the built public-barrel consumers from the repository root:

```bash
node packages/net/__tests__/fixtures/protocol-v2-consumer.mjs
node packages/net/__tests__/fixtures/recovery-session-consumer.mjs
```

The protocol fixture round-trips every packet kind and rejects protocol v1.
The recovery fixture checks every lifecycle state, transition validation,
bounded defaults, and deterministic memory endpoint behavior. These fixtures
import only the shipped `@forgeax/engine-net` barrel.

## Existing ECS replication seam

`defineReplication` selects the portable ECS query, ordered component list,
limits, and profile fingerprint. `AuthorityCoordinator` publishes baseline and
delta `ReplicationPacket` data; `ReplicaCoordinator` validates profile,
identity, ordering, schema, and same-packet references before World mutation.
Local ECS `EntityHandle` values never cross the wire.

```ts
import {
  AuthorityCoordinator,
  ReplicaCoordinator,
  defineReplication,
} from '@forgeax/engine-net';
```

Immediate unresolved-reference rejection remains the one policy: a reference
must already exist or be created in the same data packet. No cross-packet
reference queue is retained.

`ReplicaCoordinator.lastPacketOutcome` is the explicit packet-order result:
`accepted`, `duplicate`, or `ignored-old-epoch`. A duplicate returns success
without World mutation; an old epoch returns success without reviving work; a
gap or invalid new baseline returns a structured error before mutation. The
coordinator never closes a transport. `NetSession` owns endpoint closure,
terminal failure, connector cancellation, and plugin teardown.

## Entry points

| Export | Purpose |
|:--|:--|
| `NetSessionState`, `SessionId`, `NetRecoverySnapshot` | Session identity, lifecycle, and observable accounting types |
| `NetRecoveryPolicy`, `DEFAULT_NET_RECOVERY_POLICY` | Finite deterministic recovery bounds |
| `NetEndpointConnector` | Realm-neutral replacement endpoint capability |
| `ReplicationPacket` | Single protocol-v2 packet/schema union |
| `encodeReplicationPacket`, `decodeReplicationPacket` | Prefix, schema, typed-data, and limit validation |
| `NetError`, `EndpointError` | Closed structured expected failures |
| `NetEndpoint`, `PeerId` | Transport-only bytes and peer lifecycle |
| `NetSession`, `netPlugin` | World-facing session integration |
| `defineReplication`, `ReplicationProfile` | Portable ECS replication contract |
| `AuthorityCoordinator`, `ReplicaCoordinator` | Authority publication and atomic replica apply |

## Source map

- Session policy and public lifecycle: `src/session/recovery.ts`
- Endpoint capability and memory transport: `src/endpoint/`
- Packet manifest, codec, and structured errors: `src/replication/`
- Deterministic public consumers: `__tests__/fixtures/`
