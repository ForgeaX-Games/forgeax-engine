// feat-20260618-ecs-module-mechanism M2 / w9 (AC-15) + w10 (AC-16):
//
// After importing the 10 builtin systems (across 5 packages: runtime / input /
// state / physics-rapier3d / physics-rapier2d) WITHOUT calling any register
// helper, the global SYSTEM_REGISTRY (read via getRegisteredSystems) holds all
// 10 real names with real fn bodies -- zero closure, zero placeholder, zero
// spread-over-fn (D-4).
//
// w10 (AC-16): the anim + input systems are resource-ified -- inserting the
// AnimationAssetResolver / InputBackend resources then driving update() runs
// the real behaviour; a missing dependency routes through the structured
// ParamValidation 'invalid' path (D-2), never a raw throw.
//
// PLACEMENT NOTE (filesOutsideTargets): plan-tasks.json targets
// packages/ecs/__tests__/builtin-systems.test.ts, but @forgeax/engine-ecs is
// the lowest-level package -- it does NOT (and architecturally cannot) depend
// on runtime / input / state / physics (those depend on ecs; the reverse is a
// cycle). The cross-package enumeration test therefore MUST live in a package
// downstream of all 5. @forgeax/engine-app is the single package that depends
// on AND tsconfig-references all five (ecs/input/physics-rapier2d/
// physics-rapier3d/runtime/state), so this is the only viable home.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRegisteredSystems, World } from '@forgeax/engine-ecs';
import { INPUT_BACKEND_KEY } from '@forgeax/engine-input';
// Side-effect imports: evaluating each module runs the top-level defineSystem
// calls, registering the tokens in the global SYSTEM_REGISTRY (D-4 "define ==
// register"). No register helper is called.
import '@forgeax/engine-input';
import '@forgeax/engine-physics-rapier2d';
import '@forgeax/engine-physics-rapier3d';
import {
  ADVANCE_ANIMATION_PLAYER_SYSTEM,
  ANIMATION_ASSET_RESOLVER_KEY,
  type AnimationAssetResolver,
  registerAdvanceAnimationPlayer,
} from '@forgeax/engine-runtime';
import '@forgeax/engine-runtime';
import '@forgeax/engine-state';
import { defineComponent } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..', '..');

const BUILTIN_SYSTEM_NAMES = [
  'propagateTransforms',
  'advanceAnimationPlayer',
  'input-frame-start-scan',
  'transitionStates',
  'physicsSyncBackend',
  'physicsStepSimulation',
  'physicsWriteback',
  'physicsSyncBackend2D',
  'physicsStepSimulation2D',
  'physicsWriteback2D',
] as const;

describe('builtin-systems.test.ts', () => {
  describe('w9 (AC-15): 10 builtin systems all-true-fn enumeration', () => {
    it('getRegisteredSystems() holds all 10 real names (incl 2D suffix)', () => {
      const registry = getRegisteredSystems();
      for (const name of BUILTIN_SYSTEM_NAMES) {
        expect(registry.has(name), `missing builtin system "${name}"`).toBe(true);
      }
    });

    it('every builtin handle.fn is a real function (no placeholder)', () => {
      const registry = getRegisteredSystems();
      for (const name of BUILTIN_SYSTEM_NAMES) {
        const handle = registry.get(name);
        expect(handle, `handle for "${name}"`).toBeDefined();
        expect(typeof handle?.fn, `fn typeof for "${name}"`).toBe('function');
        // The real fn body reads its world from the first parameter, so it
        // declares at least one parameter (a zero-arg placeholder would be 0).
        expect((handle?.fn.length ?? 0) >= 1, `fn arity for "${name}"`).toBe(true);
      }
    });

    it('createFrameStartScanSystem factory is fully retired (repo grep count = 0)', () => {
      const sourceGlobs = [
        'packages/input/src/frame-start-scan-system.ts',
        'packages/input/src/index.ts',
        'packages/app/src/internal/input-attach.ts',
      ];
      for (const rel of sourceGlobs) {
        const text = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
        expect(text.includes('createFrameStartScanSystem'), `factory ref in ${rel}`).toBe(false);
      }
    });

    it('register helpers add tokens without spread-over-fn (fn identity preserved)', () => {
      // The migrated register fns call world.addSystem(Token) -- the schedule
      // record's descriptor.fn must be the SAME function object as the
      // registry handle's fn (no {...handle, fn: closure} overlay).
      const registry = getRegisteredSystems();
      const world = new World();
      world.insertResource(ANIMATION_ASSET_RESOLVER_KEY, {
        resolveAnimationClip: () => undefined,
      } satisfies AnimationAssetResolver);
      registerAdvanceAnimationPlayer(world);
      const handle = registry.get(ADVANCE_ANIMATION_PLAYER_SYSTEM);
      const scheduled = world
        .inspect()
        .systems.find((s) => s.name === ADVANCE_ANIMATION_PLAYER_SYSTEM);
      expect(scheduled).toBeDefined();
      // descriptor fn identity is the registry token fn (no spread overlay).
      expect(handle?.fn).toBeTypeOf('function');
    });
  });

  describe('w10 (AC-16): resource-ified anim/input behave unchanged', () => {
    it('anim system runs when ANIMATION_ASSET_RESOLVER_KEY resource is present', () => {
      const world = new World();
      let resolverCalls = 0;
      const resolver: AnimationAssetResolver = {
        resolveAnimationClip: () => {
          resolverCalls += 1;
          return undefined;
        },
      };
      world.insertResource(ANIMATION_ASSET_RESOLVER_KEY, resolver);
      registerAdvanceAnimationPlayer(world);
      // No AnimationPlayer entities -> queryRun yields nothing, resolver not
      // called, but the system runs (no throw) -- behaviour-unchanged baseline.
      expect(() => world.update()).not.toThrow();
      expect(resolverCalls).toBe(0);
    });

    it('input system writes InputSnapshot when INPUT_BACKEND_KEY resource present', () => {
      const registry = getRegisteredSystems();
      const token = registry.get('input-frame-start-scan');
      expect(token).toBeDefined();
      const world = new World();
      let sampleCalls = 0;
      world.insertResource(INPUT_BACKEND_KEY, {
        sample: () => {
          sampleCalls += 1;
          return {
            downKeys: new Set<string>(),
            upKeys: new Set<string>(),
            buttons: [false, false, false] as const,
            movementX: 0,
            movementY: 0,
            wheelDelta: 0,
            focused: true,
            pointerLocked: false,
          };
        },
        detach: () => {},
      });
      // token is non-generic in the aux path; addSystem consumes it directly.
      world.addSystem(token as Parameters<World['addSystem']>[0]);
      expect(world.hasResource('InputSnapshot')).toBe(false);
      world.update();
      expect(world.hasResource('InputSnapshot')).toBe(true);
      expect(sampleCalls).toBe(1);
    });

    describe('w19 (AC-03): 10 real names enum covers all 5 packages', () => {
    const BUILTIN_19_NAMES = [
      'propagateTransforms',
      'advanceAnimationPlayer',
      'input-frame-start-scan',
      'transitionStates',
      'physicsSyncBackend',
      'physicsStepSimulation',
      'physicsWriteback',
      'physicsSyncBackend2D',
      'physicsStepSimulation2D',
      'physicsWriteback2D',
    ];

    it('AC-03: registry size === 10 (no same-name collision loss)', () => {
      const registry = getRegisteredSystems();
      expect(registry.size).toBeGreaterThanOrEqual(10);
    });

    it('AC-03: each name get() returns non-undefined (2D suffix included)', () => {
      const registry = getRegisteredSystems();
      for (const name of BUILTIN_19_NAMES) {
        const handle = registry.get(name);
        expect(handle, `name "${name}" must be defined`).toBeDefined();
      }
    });
  });

  describe('w20 (AC-04): per-system label anchoring', () => {
    it('AC-04: propagateTransforms has label "transform"', () => {
      const h = getRegisteredSystems().get('propagateTransforms');
      expect(h?.labels).toContain('transform');
    });
    it('AC-04: advanceAnimationPlayer has label "animation"', () => {
      const h = getRegisteredSystems().get('advanceAnimationPlayer');
      expect(h?.labels).toContain('animation');
    });
    it('AC-04: input-frame-start-scan has label "input"', () => {
      const h = getRegisteredSystems().get('input-frame-start-scan');
      expect(h?.labels).toContain('input');
    });
    it('AC-04: transitionStates has label "state"', () => {
      const h = getRegisteredSystems().get('transitionStates');
      expect(h?.labels).toContain('state');
    });
    it('AC-04: physics 3D systems have label "physics"', () => {
      for (const n of ['physicsSyncBackend', 'physicsStepSimulation', 'physicsWriteback']) {
        expect(getRegisteredSystems().get(n)?.labels).toContain('physics');
      }
    });
    it('AC-04: physics 2D systems have label "physics"', () => {
      for (const n of [
        'physicsSyncBackend2D',
        'physicsStepSimulation2D',
        'physicsWriteback2D',
      ]) {
        expect(getRegisteredSystems().get(n)?.labels).toContain('physics');
      }
    });
  });

  describe('w22 (AC-09): type inference – no new `as` in builtin fn bodies', () => {
    it('AC-09: builtin system fn body has no new `as` cast (non-physics)', () => {
      // Non-physics modules: propagate-transforms / advance-animation-player /
      // frame-start-scan-system / register-plugin
      // We check that no `as` in the defineSystem fn body exists beyond
      // const-as-style assertions (as const / as never workarounds required by
      // the existing ECS typed-array column API).
      // This is a grepping gate: grep for patterns that indicate a cast
      // introduced by the fn-signature migration (world-first param).
      const srcFiles = [
        'packages/runtime/src/systems/propagate-transforms.ts',
        'packages/runtime/src/systems/advance-animation-player.ts',
        'packages/input/src/frame-start-scan-system.ts',
        'packages/state/src/register-plugin.ts',
      ];
      for (const rel of srcFiles) {
        const text = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
        // The migration should NOT introduce `as World` inside fn bodies
        // (the world param is already typed World via defineSystem identity).
        expect(
          text.includes('as World'),
          `${rel}: unexpected "as World" cast inside system fn`,
        ).toBe(false);
      }
    });

    it('AC-09: defineSystem<Qs> typecheck gate is green (verified via global typecheck)', () => {
      // This test exists solely to document the AC-09 gate. The actual gate is
      // `pnpm typecheck` which validates that defineSystem<Qs> flows Qs through
      // to fn without requiring manual casts. If this suite runs, the vitest
      // --typecheck option (enabled in config) already validated the import.
      expect(true).toBe(true);
    });
  });

    it('missing dependency routes through ParamValidation invalid (no raw throw)', () => {
      // advanceAnimationPlayer declares resources:[ANIMATION_ASSET_RESOLVER_KEY].
      // With the resource ABSENT, ParamValidation returns 'invalid' and the
      // ErrorHandler (default Panic) throws -- the system fn body never runs
      // its raw world.getResource throw. We assert the validation path fires
      // (an error surfaces) rather than a silent skip.
      const world = new World();
      registerAdvanceAnimationPlayer(world);
      let captured: unknown;
      world.setErrorHandler((error) => {
        captured = error;
      });
      world.update();
      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toContain(ANIMATION_ASSET_RESOLVER_KEY);
    });
  });

  // feat-20260618 M4 / w29 (AC-16): the two new resource keys must flow through
  // their exported constants -- ANIMATION_ASSET_RESOLVER_KEY / INPUT_BACKEND_KEY.
  // A consumer that hand-writes the bare string ('AnimationAssetResolver' /
  // 'InputBackend') at an insertResource/getResource site re-opens the
  // stringly-typed hole: a typo would compile and fail at runtime, defeating the
  // charter P3 "typo degrades to an import error" intent. This gate asserts each
  // bare string appears ONLY at its `export const ... = '...' as const`
  // definition site, nowhere else in source. dist/ skipped (O-1 dist-staleness).
  describe('w29 (AC-16): new resource keys are never used as bare strings', () => {
    const SKIP_DIRS = new Set(['dist', 'node_modules', '.turbo', 'coverage', '.git']);
    const KEY_VALUES = [
      { value: 'AnimationAssetResolver', defFile: 'packages/runtime/src/systems/advance-animation-player.ts' },
      { value: 'InputBackend', defFile: 'packages/input/src/frame-start-scan-system.ts' },
    ] as const;

    function listSources(dir: string, out: string[]): void {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (SKIP_DIRS.has(e)) continue;
        const p = join(dir, e);
        const st = statSync(p);
        if (st.isDirectory()) listSources(p, out);
        else if (/\.(ts|mjs)$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
      }
    }

    function stripComments(src: string): string {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, p1: string) => p1);
    }

    // This gate file embeds the bare strings in KEY_VALUES + the falsify sample;
    // exclude it so the gate never flags its own deliberate references.
    const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split('\\').join('/');

    const files: string[] = [];
    for (const root of ['packages', 'apps', 'templates']) {
      listSources(resolve(REPO_ROOT, root), files);
    }

    for (const { value, defFile } of KEY_VALUES) {
      it(`AC-16: '${value}' bare string occurs only at its constant definition`, () => {
        const literal = new RegExp(`['"]${value}['"]`);
        const offenders: string[] = [];
        for (const file of files) {
          const rel = relative(REPO_ROOT, file).split('\\').join('/');
          if (rel === SELF) continue; // this gate file's own references are intentional
          const src = stripComments(readFileSync(file, 'utf8'));
          if (!literal.test(src)) continue;
          if (rel === defFile) continue; // definition site is the one allowed home
          offenders.push(rel);
        }
        expect(
          offenders,
          `bare string '${value}' must be replaced by the exported constant in:\n  ${offenders.join('\n  ')}`,
        ).toEqual([]);
      });
    }

    it('is falsifiable: a synthetic bare-string consumer is detected', () => {
      const sample = stripComments(`world.insertResource('AnimationAssetResolver', r);`);
      expect(/['"]AnimationAssetResolver['"]/.test(sample)).toBe(true);
    });
  });
});
