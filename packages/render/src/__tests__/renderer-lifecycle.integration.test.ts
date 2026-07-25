import { describe, expect, it } from 'vitest';
import { constructRenderer } from '../construct-renderer';

describe('renderer lifecycle', () => {
  it('rejects missing construction input', async () => {
    await expect(constructRenderer(undefined, { rhi })).rejects.toBeDefined();
  });
});

import { rhi } from '@forgeax/engine-rhi-null';
