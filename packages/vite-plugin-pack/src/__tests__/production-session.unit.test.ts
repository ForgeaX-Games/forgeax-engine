import { describe, expect, it } from 'vitest';
import { createProductionSession } from '../production/session.js';

describe('ProductionSession', () => {
  it('coalesces concurrent requests into one inventory and one producer task', async () => {
    let inventoryCalls = 0;
    let producerCalls = 0;
    const session = createProductionSession({
      inventory: async () => {
        inventoryCalls += 1;
        return [{ sourceKey: 'source-a', guids: ['guid-a', 'guid-b'] }];
      },
      produce: async ({ declaration }) => {
        producerCalls += 1;
        void declaration;
      },
      publish: async () => undefined,
    });

    const first = session.start();
    const second = session.start();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(firstResult.status).toBe('accepted');
    expect(inventoryCalls).toBe(1);
    expect(producerCalls).toBe(1);
    await session.close();
  });

  it('keeps one producer task for a declaration with multiple GUIDs', async () => {
    const declarations: string[][] = [];
    const session = createProductionSession({
      inventory: async () => [{ sourceKey: 'source-a', guids: ['guid-a', 'guid-b'] }],
      produce: async ({ declaration }) => {
        declarations.push([...declaration.guids]);
      },
      publish: async () => undefined,
    });

    const result = await session.start();

    expect(result.status).toBe('accepted');
    expect(declarations).toEqual([['guid-a', 'guid-b']]);
    await session.close();
  });
});
