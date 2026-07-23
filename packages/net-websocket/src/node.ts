import {
  ENDPOINT_ERROR_HINTS,
  ENDPOINT_EXPECTED,
  EndpointError,
  type EndpointEvent,
  type NetEndpoint,
  type PeerId,
} from '@forgeax/engine-net';
import { err, ok, type Result } from '@forgeax/engine-types';
import WebSocket, { WebSocketServer } from 'ws';
import { BoundedEventQueue } from './event-queue';
import { createWebSocketClientEndpoint } from './websocket-client-core';

export interface ListenWebSocketEndpointOptions {
  readonly port: number;
  readonly host?: string;
  readonly maxPeers?: number;
  readonly maxQueuedEvents?: number | undefined;
}

export interface ConnectWebSocketClientEndpointOptions {
  readonly maxQueuedEvents?: number | undefined;
}

const DEFAULT_MAX_QUEUED_EVENTS = 1024;

export function connectWebSocketClientEndpoint(
  url: string,
  options: ConnectWebSocketClientEndpointOptions = {},
): Promise<Result<NetEndpoint, EndpointError>> {
  return createWebSocketClientEndpoint(
    WebSocket as unknown as import('./websocket-client-core').WebSocketConstructor,
    {
      url,
      maxQueuedEvents: options.maxQueuedEvents,
      toBytes: toBytes,
    },
  );
}

export function listenWebSocketEndpoint(
  options: ListenWebSocketEndpointOptions,
): Promise<Result<NetEndpoint, EndpointError>> {
  return new Promise((resolve) => {
    const host = options.host ?? '127.0.0.1';
    const address = `ws://${host}:${options.port}`;
    const queue = new BoundedEventQueue(options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS);
    const terminalEvents: EndpointEvent[] = [];
    const peers = new Map<PeerId, WebSocket>();
    const disconnectedPeers = new Set<PeerId>();
    const sockets = new Map<WebSocket, PeerId>();
    const maxPeers = options.maxPeers ?? Number.POSITIVE_INFINITY;
    let nextPeerId = 1;
    let settled = false;
    let closed = false;
    const server = new WebSocketServer({ host, port: options.port, perMessageDeflate: false });

    const endpoint: NetEndpoint = {
      poll: () => [...queue.drain(), ...terminalEvents.splice(0)],
      send: (peerId, data) => {
        if (closed) return alreadyClosed('The WebSocket listener endpoint is closed.');
        const socket = peers.get(peerId);
        if (!socket && disconnectedPeers.has(peerId))
          return err(
            new EndpointError({
              code: 'connection-closed',
              expected: ENDPOINT_EXPECTED['connection-closed'],
              hint: ENDPOINT_ERROR_HINTS['connection-closed'],
              detail: { peerId },
            }),
          );
        if (!socket)
          return err(
            new EndpointError({
              code: 'peer-not-found',
              expected: ENDPOINT_EXPECTED['peer-not-found'],
              hint: ENDPOINT_ERROR_HINTS['peer-not-found'],
              detail: { peerId },
            }),
          );
        if (socket.readyState !== socket.OPEN)
          return err(
            new EndpointError({
              code: 'connection-closed',
              expected: ENDPOINT_EXPECTED['connection-closed'],
              hint: ENDPOINT_ERROR_HINTS['connection-closed'],
              detail: { peerId },
            }),
          );
        try {
          socket.send(data, { binary: true });
          return ok(undefined);
        } catch (cause) {
          return err(
            new EndpointError({
              code: 'send-failed',
              expected: ENDPOINT_EXPECTED['send-failed'],
              hint: ENDPOINT_ERROR_HINTS['send-failed'],
              detail: { peerId, cause: normalizeCause(cause) },
            }),
          );
        }
      },
      close: () => {
        if (closed) return alreadyClosed('The WebSocket listener endpoint is already closed.');
        closed = true;
        for (const socket of peers.values()) socket.close();
        server.close();
        return ok(undefined);
      },
    };

    const enqueue = (event: EndpointEvent, socket?: WebSocket): void => {
      if (queue.enqueue(event)) return;
      if (event.kind !== 'peer-disconnected') {
        terminalEvents.push({ kind: 'peer-disconnected', peerId: event.peerId });
      }
      socket?.close();
    };

    server.on('connection', (socket) => {
      if (closed || peers.size >= maxPeers) {
        socket.close();
        return;
      }
      const peerId = nextPeerId++ as PeerId;
      peers.set(peerId, socket);
      sockets.set(socket, peerId);
      enqueue({ kind: 'peer-connected', peerId }, socket);
      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          socket.close();
          return;
        }
        const bytes = toBytes(data);
        if (!bytes) {
          socket.close();
          return;
        }
        enqueue({ kind: 'message', peerId, data: bytes }, socket);
      });
      socket.on('close', () => {
        if (!peers.delete(peerId)) return;
        disconnectedPeers.add(peerId);
        sockets.delete(socket);
        enqueue({ kind: 'peer-disconnected', peerId });
      });
      socket.on('error', () => socket.close());
    });
    server.on('error', (cause) => {
      if (settled) return;
      settled = true;
      resolve(connectionFailed(address, cause));
    });
    server.on('listening', () => {
      if (settled) return;
      settled = true;
      resolve(ok(endpoint));
    });
  });
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array)
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}

function connectionFailed(address: string, cause: unknown): Result<never, EndpointError> {
  return err(
    new EndpointError({
      code: 'connection-failed',
      expected: ENDPOINT_EXPECTED['connection-failed'],
      hint: ENDPOINT_ERROR_HINTS['connection-failed'],
      detail: { address, cause: normalizeCause(cause) },
    }),
  );
}

function alreadyClosed(cause: string): Result<never, EndpointError> {
  return err(
    new EndpointError({
      code: 'already-closed',
      expected: ENDPOINT_EXPECTED['already-closed'],
      hint: ENDPOINT_ERROR_HINTS['already-closed'],
      detail: { cause },
    }),
  );
}

function normalizeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'WebSocket operation failed without a platform error message.';
}
