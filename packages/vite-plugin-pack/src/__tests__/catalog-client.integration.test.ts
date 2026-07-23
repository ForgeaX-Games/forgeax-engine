import { describe, expect, it } from 'vitest';

import {
  CATALOG_DELTA_EVENT,
  type CatalogHotChannel,
  createCatalogClient,
  reloadAssetHost,
} from '../catalog-client.js';

describe('catalog client', () => {
  it('forwards only a neutral catalog delta and unregisters cleanly', async () => {
    let listener: ((data: unknown) => void) | undefined;
    const hot: CatalogHotChannel = {
      on(event, next) {
        expect(event).toBe(CATALOG_DELTA_EVENT);
        listener = next;
      },
      off(event, next) {
        expect(event).toBe(CATALOG_DELTA_EVENT);
        expect(next).toBe(listener);
        listener = undefined;
      },
    };
    const client = createCatalogClient(async () => [], hot);
    const received: unknown[] = [];
    const unsubscribe = client.subscribe((delta) => received.push(delta));

    listener?.({ added: [], changed: [], removed: ['019e2cc6-0c86-79da-aa76-b0984c86d45a'] });
    listener?.({ kind: 'source' });
    expect(await client.enumerate()).toEqual([]);
    expect(received).toEqual([
      { added: [], changed: [], removed: ['019e2cc6-0c86-79da-aa76-b0984c86d45a'] },
    ]);

    unsubscribe();
    listener?.({ added: [], changed: [], removed: [] });
    expect(received).toHaveLength(1);
  });

  it('makes static sources safely enumerable without a subscription event', async () => {
    const client = createCatalogClient(async () => [], undefined);
    expect(await client.enumerate()).toEqual([]);
    expect(() => client.subscribe(() => {})).not.toThrow();
  });

  it('requests a full reload only when an engine host explicitly chooses that policy', () => {
    const calls: string[] = [];
    reloadAssetHost()({ ws: { send: (payload) => calls.push(payload.type) } });
    expect(calls).toEqual(['full-reload']);
  });
});
