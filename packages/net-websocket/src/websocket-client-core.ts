import {
  ENDPOINT_ERROR_HINTS,
  ENDPOINT_EXPECTED,
  EndpointError,
  type EndpointEvent,
  type NetEndpoint,
  type PeerId,
} from '@forgeax/engine-net';
import { err, ok, type Result } from '@forgeax/engine-types';
import { BoundedEventQueue } from './event-queue';

export interface WebSocketLike {
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
  readonly readyState: number;
  binaryType?: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export interface WebSocketConstructor {
  new (url: string): WebSocketLike;
}

export interface WebSocketClientCoreOptions {
  readonly url: string;
  readonly maxQueuedEvents?: number | undefined;
  readonly toBytes: (data: unknown) => Uint8Array | Promise<Uint8Array | undefined> | undefined;
}

const DEFAULT_MAX_QUEUED_EVENTS = 1024;
const CLIENT_PEER_ID = 1 as PeerId;

export function createWebSocketClientEndpoint(
  WebSocket: WebSocketConstructor,
  options: WebSocketClientCoreOptions,
): Promise<Result<NetEndpoint, EndpointError>> {
  return new Promise((resolve) => {
    let socket: WebSocketLike;
    try {
      socket = new WebSocket(options.url);
      socket.binaryType = 'arraybuffer';
    } catch (cause) {
      resolve(connectionFailed(options.url, cause));
      return;
    }

    const queue = new BoundedEventQueue(options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS);
    const terminalEvents: EndpointEvent[] = [];
    let opened = false;
    let settled = false;
    let closed = false;
    let locallyClosed = false;
    let messageTail = Promise.resolve();

    const disconnect = (reason: string): void => {
      if (closed) return;
      closed = true;
      queue.close(reason);
      terminalEvents.push({ kind: 'peer-disconnected', peerId: CLIENT_PEER_ID });
    };

    const endpoint: NetEndpoint = {
      poll: () => [...queue.drain(), ...terminalEvents.splice(0)],
      send: (peerId, data) => {
        if (closed) return locallyClosed ? alreadyClosed() : connectionClosed(peerId);
        if (peerId !== CLIENT_PEER_ID)
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
          socket.send(data);
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
        if (closed)
          return err(
            new EndpointError({
              code: 'already-closed',
              expected: ENDPOINT_EXPECTED['already-closed'],
              hint: ENDPOINT_ERROR_HINTS['already-closed'],
              detail: { cause: 'The WebSocket endpoint is already closed.' },
            }),
          );
        locallyClosed = true;
        disconnect('Endpoint close requested.');
        socket.close();
        return ok(undefined);
      },
    };

    socket.onopen = () => {
      if (settled) return;
      opened = true;
      settled = true;
      queue.enqueue({ kind: 'peer-connected', peerId: CLIENT_PEER_ID });
      resolve(ok(endpoint));
    };
    socket.onmessage = ({ data }) => {
      // Blob.arrayBuffer() is asynchronous. Serialize conversion so that
      // ordered WebSocket messages retain their wire order after decoding.
      messageTail = messageTail.then(async () => {
        const bytes = await options.toBytes(data);
        if (!bytes || closed) return;
        if (!queue.enqueue({ kind: 'message', peerId: CLIENT_PEER_ID, data: bytes })) {
          socket.close();
        }
      });
    };
    socket.onerror = (cause) => {
      if (opened) disconnect(`WebSocket error: ${normalizeCause(cause)}`);
      else if (!settled) {
        settled = true;
        resolve(connectionFailed(options.url, cause));
      }
    };
    socket.onclose = (cause) => {
      if (!opened && !settled) {
        settled = true;
        resolve(connectionFailed(options.url, cause));
        return;
      }
      disconnect(`WebSocket closed: ${normalizeCause(cause)}`);
    };
  });
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

function alreadyClosed(): Result<never, EndpointError> {
  return err(
    new EndpointError({
      code: 'already-closed',
      expected: ENDPOINT_EXPECTED['already-closed'],
      hint: ENDPOINT_ERROR_HINTS['already-closed'],
      detail: { cause: 'The WebSocket endpoint is closed.' },
    }),
  );
}

function connectionClosed(peerId: PeerId): Result<never, EndpointError> {
  return err(
    new EndpointError({
      code: 'connection-closed',
      expected: ENDPOINT_EXPECTED['connection-closed'],
      hint: ENDPOINT_ERROR_HINTS['connection-closed'],
      detail: { peerId },
    }),
  );
}

function normalizeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'WebSocket operation failed without a platform error message.';
}
