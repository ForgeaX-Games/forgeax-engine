import { describe, expect, it } from 'vitest';
import {
  createWebSocketClientEndpoint,
  type WebSocketConstructor,
  type WebSocketLike,
} from '../src/websocket-client-core';

const invalidMaxQueuedEvents = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

describe('WebSocket client core option preflight', () => {
  it('fulfills structured failures before constructing a WebSocket', async () => {
    let constructions = 0;
    const WebSocket: WebSocketConstructor = class implements WebSocketLike {
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readonly readyState = this.CONNECTING;
      binaryType?: string;
      onopen: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;

      constructor(_url: string) {
        constructions += 1;
      }

      send(_data: Uint8Array): void {}

      close(): void {}
    };
    const url = 'ws://127.0.0.1:8787';

    for (const maxQueuedEvents of invalidMaxQueuedEvents) {
      const result = await createWebSocketClientEndpoint(WebSocket, {
        url,
        maxQueuedEvents,
        toBytes: () => undefined,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('connection-failed');
        expect(result.error.detail.address).toBe(url);
        expect(result.error.detail.cause).toBe('maxQueuedEvents must be a positive integer');
      }
    }

    expect(constructions).toBe(0);
  });
});
