import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EndpointErrorCode } from '@forgeax/engine-net';

const packageRoot = resolve(import.meta.dirname, '..');

describe('net-websocket README contract', () => {
  it('documents importable browser and node exports', async () => {
    const readme = await readFile(resolve(packageRoot, 'README.md'), 'utf8');
    const browser = await import('@forgeax/engine-net-websocket/browser');
    const node = await import('@forgeax/engine-net-websocket/node');

    expect(browser.connectWebSocketClientEndpoint).toBeTypeOf('function');
    expect(node.connectWebSocketClientEndpoint).toBeTypeOf('function');
    expect(node.listenWebSocketEndpoint).toBeTypeOf('function');

    expect(readme).toContain('@forgeax/engine-net-websocket/browser');
    expect(readme).toContain('@forgeax/engine-net-websocket/node');
    for (const name of ['connectWebSocketClientEndpoint', 'listenWebSocketEndpoint']) {
      expect(readme).toContain(name);
    }
  });

  it('keeps the README error table aligned with EndpointErrorCode', async () => {
    const readme = await readFile(resolve(packageRoot, 'README.md'), 'utf8');
    const errorsSection = readme.split('## Errors')[1]?.split('## Queue configuration')[0] ?? '';
    const documented = [...errorsSection.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
    const expected: EndpointErrorCode[] = [
      'peer-not-found',
      'connection-closed',
      'send-failed',
      'already-closed',
      'connection-failed',
    ];

    expect(documented).toEqual(expect.arrayContaining(expected));
    expect(expected).toEqual(expect.arrayContaining(documented));
  });
});
