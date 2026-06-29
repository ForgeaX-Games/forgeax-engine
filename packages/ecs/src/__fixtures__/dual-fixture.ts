// feat-20260618-ecs-module-mechanism M3 / w23 (AC-10):
// Fixture module that calls BOTH defineComponent and defineSystem at top level.
// Importing this module registers entries into the global component ledger
// (nameToToken) AND the global system registry (SYSTEM_REGISTRY). The
// dual-registry-fixture test verifies both registries are independently
// enumerable and never cross-contaminate.
//
// NOTE: import from barrel (../index) NOT from ../component / ../schedule
// directly. The barrel runs the essential-component invariant check that
// ensures Entity owns id=0 before any user defineComponent call.

import { defineComponent, defineSystem } from '../index';

export const DualFixturePos = defineComponent('DualFixturePos', { x: 'f32', y: 'f32' });

export const DualFixtureSystem = defineSystem({
  name: 'dual-fixture-system',
  queries: [{ with: [DualFixturePos] }],
  fn: (_world, _queryResults, _commands) => {},
});
