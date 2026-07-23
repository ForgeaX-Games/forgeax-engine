import { describe, expect, it } from 'vitest';
import { connectWebSocketClientEndpoint } from '../src/browser';

describe('browser WebSocket endpoint', () => {
  it('returns connection-failed when no listener accepts the connection', async () => {
    const url = 'ws://127.0.0.1:1';
    const result = await connectWebSocketClientEndpoint(url);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('connection-failed');
      expect(result.error.detail.address).toBe(url);
    }
  });
});
