import { describe, expect, it, vi } from 'vitest';

describe('scene ChildOf module', () => {
  it('registers its Children mirror when imported directly', async () => {
    vi.resetModules();
    const { ChildOf } = await import('../components/child-of');
    const { Children } = await import('../components/children');

    expect(ChildOf.relationship?.mirror).toBe('Children');
    expect(Children.schema.entities).toBe('array<entity>');
  });
});
