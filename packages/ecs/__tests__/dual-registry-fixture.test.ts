// feat-20260618-ecs-module-mechanism M3 / w23 (AC-10):
// A single fixture module calls both defineComponent + defineSystem; importing
// it makes them visible via getRegisteredComponents() and getRegisteredSystems()
// -- the two registries are independent and never cross-contaminate each other.
//
// Constraints: plan-strategy section 5.3 -- fixture-module import, two
// registries independently enumerable.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '..', 'src', '__fixtures__', 'dual-fixture.ts');

describe('dual-registry-fixture.test.ts', () => {
  it('AC-10: fixture content defines both families at top level', () => {
    const src = readFileSync(fixturePath, 'utf8');
    expect(src).toContain('defineComponent');
    expect(src).toContain('defineSystem');
  });

  it('AC-10: import evaluates fixture; both registries see their items', async () => {
    // Dynamic import evaluates at test-time; vitest transforms TS and
    // the side-effect registers the component + system in the globals.
    await import('../src/__fixtures__/dual-fixture');

    // Dynamic ESM from barrel to avoid hoisted static import collision.
    const { getRegisteredComponents, getRegisteredSystems } =
      await import('../src/index');

    const comps = getRegisteredComponents();
    expect(comps.get('DualFixturePos')).toBeDefined();

    const systems = getRegisteredSystems();
    expect(systems.get('dual-fixture-system')).toBeDefined();
  });

  it('AC-10: registries do not cross-contaminate', async () => {
    const { getRegisteredComponents, getRegisteredSystems } =
      await import('../src/index');

    const comps = getRegisteredComponents();
    const systems = getRegisteredSystems();

    // No system name appears in component registry.
    expect(comps.has('dual-fixture-system')).toBe(false);
    // No component name appears in system registry.
    expect(systems.has('DualFixturePos')).toBe(false);
  });
});