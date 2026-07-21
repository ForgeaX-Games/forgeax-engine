import { Update } from '@forgeax/engine-ecs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import { InputSet } from '@forgeax/engine-input';
import { PhysicsSet } from '@forgeax/engine-physics';
import { AnimationSet, TransformSet } from '@forgeax/engine-runtime';
import { StateSet } from '@forgeax/engine-state';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appIndex = resolve(here, '..', 'src', 'index.ts');

describe('SystemSet root-entry token chain', () => {
  it('configures tokens imported from every owner root entry', () => {
    const world = new World();

    expect(world.configureSets(Update, { set: TransformSet, before: [AnimationSet] }).ok).toBe(true);
    expect(world.configureSets(Update, { set: InputSet, before: [StateSet] }).ok).toBe(true);
    expect(world.configureSets(Update, { set: PhysicsSet, after: [StateSet] }).ok).toBe(true);
  });

  it('does not make the app root a second InputSet entry point', () => {
    expect(readFileSync(appIndex, 'utf8')).not.toMatch(/\bInputSet\b/);
  });
});
