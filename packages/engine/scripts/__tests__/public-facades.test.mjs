import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { startNativePlugin } from '@forgeax/engine/plugin';
import * as physics from '@forgeax/engine/physics';
import { describe, expect, it } from 'vitest';
import { publicEngineFacades, publicEngineMembers } from '../public-facades.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('public engine facades', () => {
  it('forwards default only for physical targets that declare one', async () => {
    const members = await publicEngineMembers(repositoryRoot, ['ddc', 'physics', 'types']);
    const facades = publicEngineFacades(members);
    const rapier3d = facades.find(({ source }) => source === '@forgeax/engine-physics/rapier3d');
    const types = facades.find(({ source }) => source === '@forgeax/engine-types');

    expect(rapier3d?.hasDefault).toBe(true);
    expect(types?.hasDefault).toBe(false);
    expect(facades.find(({ source }) => source === '@forgeax/engine-ddc')?.hasDefault).toBe(false);
  });

  it('emits declarations for nested user-facing facade imports', async () => {
    const declaration = await readFile(
      resolve(repositoryRoot, 'packages/engine/dist/facades/pack/guid.d.ts'),
      'utf8',
    );

    expect(declaration).toContain("export * from '@forgeax/engine-pack/guid';");
  });

  it('resolves the built Rapier3D default through the user-facing umbrella', async () => {
    const module = await import('@forgeax/engine/physics/rapier3d');

    expect(module.default).toMatchObject({ name: 'physics', provide: 'physics' });
  });

  it('keeps the Rapier3D preset on the root physics component-token instance', async () => {
    const artifact = await readFile(resolve(repositoryRoot, 'packages/physics/dist/rapier3d.mjs'), 'utf8');
    expect(artifact).not.toContain('CharacterController');
    expect(artifact).not.toContain('defineComponent');

    const preset = await import('@forgeax/engine/physics/rapier3d');
    const world = new World();
    const context = await createWorldContext(world);
    try {
      const activated = await startNativePlugin(context, preset.default);
      expect(activated.ok).toBe(true);
      if (!activated.ok) throw activated.error;

      expect(world.components.resolve('CharacterController')).toBe(physics.CharacterController);
      expect(world.hasResource('PhysicsWorld')).toBe(true);
    } finally {
      await context.fiber.dispose();
    }
    expect(world.components.resolve('CharacterController')).toBeUndefined();
    expect(world.hasResource('PhysicsWorld')).toBe(false);
  });
});
