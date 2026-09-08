import { createServer, type Server, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { NetEndpointConnector } from '@forgeax/engine-net';

interface ConnectorEntry {
  readonly createWebSocketConnector?: (url: string) => NetEndpointConnector;
}

describe('WebSocket connector cancellation contract', () => {
  it('aborts a pending Node connection with a structured failure and closes its socket', async () => {
    const server = createServer();
    let acceptedSocket: Socket | undefined;
    const accepted = new Promise<void>((resolve) => {
      server.once('connection', (socket) => {
        acceptedSocket = socket;
        socket.on('error', () => undefined);
        resolve();
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const url = `ws://127.0.0.1:${address.port}`;

    try {
      const entry = (await import('../src/node')) as unknown as ConnectorEntry;
      expect(entry.createWebSocketConnector).toBeTypeOf('function');
      if (entry.createWebSocketConnector === undefined) return;
      const controller = new AbortController();
      const pending = entry.createWebSocketConnector(url).connect(controller.signal);
      await accepted;
      controller.abort();
      controller.abort();

      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('connection-failed');
        expect(result.error.detail.address).toBe(url);
        expect(result.error.detail.cause).toMatch(/abort/i);
      }
    } finally {
      acceptedSocket?.destroy();
      await closeServer(server);
    }
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
