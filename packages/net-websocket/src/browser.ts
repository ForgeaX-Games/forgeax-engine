import type { EndpointError, NetEndpoint } from '@forgeax/engine-net';
import type { Result } from '@forgeax/engine-types';
import { createWebSocketClientEndpoint, type WebSocketConstructor } from './websocket-client-core';

export interface ConnectWebSocketClientEndpointOptions {
  readonly maxQueuedEvents?: number | undefined;
}

export function connectWebSocketClientEndpoint(
  url: string,
  options: ConnectWebSocketClientEndpointOptions = {},
): Promise<Result<NetEndpoint, EndpointError>> {
  return createWebSocketClientEndpoint(WebSocket as unknown as WebSocketConstructor, {
    url,
    maxQueuedEvents: options.maxQueuedEvents,
    toBytes,
  });
}

function toBytes(data: unknown): Uint8Array | Promise<Uint8Array | undefined> | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return undefined;
}
