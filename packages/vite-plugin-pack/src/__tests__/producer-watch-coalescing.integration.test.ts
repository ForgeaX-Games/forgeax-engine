import { describe, expect, it, vi } from 'vitest';
import { createSourcePackageCoalescer } from '../producer/source-package-publication.js';

describe('source-package producer coalescing', () => {
  it('shares concurrent demand and permits one recook after invalidation', async () => {
    const coalescer = createSourcePackageCoalescer();
    let revision = 0;
    const produce = vi.fn(async () => ({ revision: ++revision }));

    const concurrent = await Promise.all([
      coalescer.ensure('source/meta.json', produce),
      coalescer.ensure('source/meta.json', produce),
    ]);

    expect(produce).toHaveBeenCalledTimes(1);
    expect(concurrent[0]).toEqual({ revision: 1 });
    expect(concurrent[1]).toEqual({ revision: 1 });

    coalescer.invalidate('source/meta.json');
    await expect(coalescer.ensure('source/meta.json', produce)).resolves.toEqual({ revision: 2 });
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('does not leave a failed producer promise blocking retry', async () => {
    const coalescer = createSourcePackageCoalescer();
    let attempts = 0;
    const produce = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('fixture conversion failed');
      return { revision: attempts };
    });

    await expect(coalescer.ensure('source/meta.json', produce)).rejects.toThrow(
      'fixture conversion failed',
    );
    await expect(coalescer.ensure('source/meta.json', produce)).resolves.toEqual({ revision: 2 });
  });
});
