import { describe, expect, it } from 'vitest';
import { EXECUTION_REQUESTED_TIERS, EXECUTION_TIERS } from '../index';

describe('execution public affordance', () => {
  it('advertises only stable tier names', () => {
    expect(EXECUTION_TIERS).toEqual(['main-serial', 'engine-worker', 'shared']);
    expect(EXECUTION_REQUESTED_TIERS).toEqual(['auto', ...EXECUTION_TIERS]);
  });
});
