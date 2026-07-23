# @forgeax/engine-net-websocket

WebSocket backend for NetEndpoint -- Node listener + browser connection.

## Platform entries

| Entry | Factory | Return type |
| --- | --- | --- |
| `@forgeax/engine-net-websocket/browser` | `connectWebSocketClientEndpoint(url, options?)` | `Promise<Result<NetEndpoint, EndpointError>>` |
| `@forgeax/engine-net-websocket/node` | `connectWebSocketClientEndpoint(url, options?)` | `Promise<Result<NetEndpoint, EndpointError>>` |
| `@forgeax/engine-net-websocket/node` | `listenWebSocketEndpoint(options)` | `Promise<Result<NetEndpoint, EndpointError>>` |

Both factories expose byte transport and peer lifecycle only. Replication,
profiles, codecs, retry, and gameplay remain in `@forgeax/engine-net`.

## Errors

Every failed result carries an `EndpointError` with `code`, `expected`, `hint`,
and code-specific `detail`.

| Code | Expected | Hint |
| --- | --- | --- |
| `peer-not-found` | target peer exists in the connection set | use a `PeerId` from a connect event and handle disconnects |
| `connection-closed` | peer connection is alive | poll for the disconnect event and handle lifecycle |
| `send-failed` | bytes are delivered or the connection fails | peer may have disconnected or the buffer may be full |
| `already-closed` | endpoint is open for the operation | create a new endpoint |
| `connection-failed` | connection or listen bind succeeds | verify the address and port, then retry |

## Queue configuration

`maxQueuedEvents` defaults to `1024` on both client and server factories. When
the bounded queue is full, the incoming event is dropped, the socket is closed,
and a terminal `peer-disconnected` event is retained for polling.

## Minimal usage

Node server:

```ts
import { listenWebSocketEndpoint } from '@forgeax/engine-net-websocket/node';

const server = await listenWebSocketEndpoint({ port: 8787 });
if (!server.ok) throw server.error;
const events = server.value.poll();
```

Browser client:

```ts
import { connectWebSocketClientEndpoint } from '@forgeax/engine-net-websocket/browser';

const client = await connectWebSocketClientEndpoint('ws://localhost:8787');
if (!client.ok) throw client.error;
client.value.poll();
```

For the replication protocol and `NetSession` integration, see
[`@forgeax/engine-net` replication docs](../net/README.md).
