import { describe, expect, it } from 'vitest';

describe('Rapier 3D root surface', () => {
  it('does not project unused vector bridges', async () => {
    const root = (await import('../src/index')) as Record<string, unknown>;
    expect(root).not.toHaveProperty('toRapierVec3');
    expect(root).not.toHaveProperty('fromRapierVec3');
    expect(root).not.toHaveProperty('toRapierQuat');
    expect(root).not.toHaveProperty('fromRapierQuat');
    expect(root).toHaveProperty('loadRapier3D');
    expect(root).toHaveProperty('registerPhysicsSystems');
  });
});
