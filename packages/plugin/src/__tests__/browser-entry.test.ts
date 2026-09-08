import { describe, expect, it } from 'vitest';
import * as browserEntry from '../browser';

describe('browser plugin entry', () => {
  it('selects a browser condition without evaluating the Node loader', () => {
    expect('CatalogLoader' in browserEntry).toBe(false);
    expect(browserEntry.Context).toBeDefined();
    expect(browserEntry.defineToolPlugin).toBeDefined();
  });
});
