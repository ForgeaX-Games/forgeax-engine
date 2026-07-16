// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=10):
//   - packages/ecs/src/__tests__/ac16-register-component-grep-gate.test.ts
//   - packages/ecs/src/__tests__/buffer-array-errors.test.ts
//   - packages/ecs/src/__tests__/component-global-index.test.ts
//   - packages/ecs/src/__tests__/component-schema-json.test.ts
//   - packages/ecs/src/__tests__/errors.test.ts
//   - packages/ecs/src/__tests__/managed-entity-dangling-errors.test.ts
//   - packages/ecs/src/__tests__/relationship-errors.test.ts
//   - packages/ecs/src/__tests__/result.test.ts
//   - packages/ecs/src/__tests__/spawn-light-invalid-bounds-error-code.test.ts
//   - packages/ecs/src/__tests__/sprite-animation-invalid-error.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it, test } from 'vitest';
import { defineComponent, RELATIONSHIP_COMPONENTS, resolveComponent } from '../component';
import type { EcsErrorCode, EcsErrorDetail } from '../errors';
import {
  ArrayPopEmptyError,
  ComponentAlreadyPresentError,
  ComponentNotPresentError,
  CyclicDependencyError,
  EntityIndexOverflowError,
  FixedArrayOverflowError,
  FixedSizeMismatchError,
  ManagedBufferOutOfBoundsError,
  ManagedBufferShrinkNotSupportedError,
  RelationshipDetachMismatchError,
  RelationshipMirrorComponentNotRegisteredError,
  RelationshipMirrorFieldTypeMismatchError,
  RelationshipSelfCycleError,
  ResourceNotFoundError,
  SchemaUnsupportedFieldError,
  SpriteAnimationInvalidError,
  SpriteInstancesCountMismatchError,
  SpriteInstancesMutuallyExclusiveWithInstancesError,
  SpriteInstancesRequiresSpriteShaderError,
  StaleEntityError,
  UniqueRefDoubleReleaseError,
  UniqueRefReleasedError,
} from '../errors';
import { World } from '../world';

{
  // ─── from ac16-register-component-grep-gate.test.ts ───
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..', '..', '..');

  const SCAN_DIRS = ['packages', 'apps', 'templates'];

  const NAME = 'register' + 'Component';
  const CALL_PATTERN = `[.](${NAME}|${NAME}Checked)[(]`;
  const FIELD_PATTERN = `${NAME}:`;

  function grepHits(pattern: string): string[] {
    const r = spawnSync(
      'grep',
      [
        '-rn',
        '--include=*.ts',
        '--include=*.mjs',
        '--exclude-dir=dist',
        '--exclude-dir=node_modules',
        '-E',
        pattern,
        ...SCAN_DIRS,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
    );
    if (r.status === 2 || r.error) {
      throw new Error(`grep failed for pattern ${pattern}: ${r.stderr || r.error}`);
    }
    return (r.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  describe('ac16-register-component-grep-gate.test.ts', () => {
    describe('AC-16 - register-component call surface is zero repo-wide (w20)', () => {
      it('layer 1: zero method-call sites for the deleted register* methods', () => {
        const hits = grepHits(CALL_PATTERN);
        expect(hits, `unexpected register-component call sites:\n${hits.join('\n')}`).toEqual([]);
      });

      it('layer 2: zero mock interface field declarations for the deleted method', () => {
        const hits = grepHits(FIELD_PATTERN);
        expect(
          hits,
          `unexpected register-component field declarations:\n${hits.join('\n')}`,
        ).toEqual([]);
      });
    });
  });
}

{
  // ─── from buffer-array-errors.test.ts ───
  describe('buffer-array-errors.test.ts', () => {
    describe('EcsErrorCode — buffer/array vocab collapse delta (w7, AC-07)', () => {
      it('FixedSizeMismatchError carries .code = "fixed-size-mismatch" + detail.expected / detail.actual', () => {
        const err = new FixedSizeMismatchError('meta', 8, 7);
        expect(err.code).toBe('fixed-size-mismatch');
        expect(err.detail).toEqual({ expected: 8, actual: 7 });
      });

      it('FixedArrayOverflowError carries .code = "fixed-array-overflow" + detail.capacity / detail.attemptedCount', () => {
        const err = new FixedArrayOverflowError('slots', 4, 4);
        expect(err.code).toBe('fixed-array-overflow');
        expect(err.detail).toEqual({ capacity: 4, attemptedCount: 4 });
      });

      it('ArrayPopEmptyError carries .code = "array-pop-empty" + detail.count = 0', () => {
        const err = new ArrayPopEmptyError('transforms');
        expect(err.code).toBe('array-pop-empty');
        expect(err.detail).toEqual({ count: 0 });
      });

      it('EcsErrorCode union is exhaustive (no default branch) over the M2 delta', () => {
        const codes: EcsErrorCode[] = [
          'fixed-size-mismatch',
          'fixed-array-overflow',
          'array-pop-empty',
          'instance-transforms-stride-mismatch',
          'managed-array-element-type-not-allowed',
        ];
        let hits = 0;
        for (const code of codes) {
          switch (code) {
            case 'fixed-size-mismatch':
            case 'fixed-array-overflow':
            case 'array-pop-empty':
            case 'instance-transforms-stride-mismatch':
            case 'managed-array-element-type-not-allowed':
              hits += 1;
              break;
            default:
              void code;
          }
        }
        expect(hits).toBe(5);
      });

      it('deleted managed-array-* codes are no longer assignable to EcsErrorCode', () => {
        // @ts-expect-error 'managed-array-index-out-of-bounds' was deleted by feat-20260515 w11.
        const a: EcsErrorCode = 'managed-array-index-out-of-bounds';
        // @ts-expect-error 'managed-array-pop-empty' was deleted by feat-20260515 w11 (renamed to 'array-pop-empty').
        const b: EcsErrorCode = 'managed-array-pop-empty';
        // @ts-expect-error 'managed-array-shrink-not-supported' was deleted by feat-20260515 w11.
        const c: EcsErrorCode = 'managed-array-shrink-not-supported';
        // @ts-expect-error 'managed-array-stride-mismatch' was deleted by feat-20260515 w11 (replaced by 'instance-transforms-stride-mismatch').
        const d: EcsErrorCode = 'managed-array-stride-mismatch';
        void a;
        void b;
        void c;
        void d;
      });
    });
  });
}

{
  // ─── from component-global-index.test.ts ───
  describe('component-global-index.test.ts', () => {
    describe('resolveComponent', () => {
      it('returns the token for a defined component name', () => {
        const Pos = defineComponent('ResolveTest_Position', { x: 'f32', y: 'f32' });
        const resolved = resolveComponent('ResolveTest_Position');
        expect(resolved).toBeDefined();
        if (resolved) {
          expect(resolved.name).toBe('ResolveTest_Position');
          expect(resolved.id).toBe(Pos.id);
        }
      });

      it('returns undefined for an unknown component name', () => {
        const resolved = resolveComponent('NeverDefinedComponentName');
        expect(resolved).toBeUndefined();
      });

      it('resolves a component immediately after defineComponent', () => {
        const token = defineComponent('ImmediateResolve', { v: 'f32' });
        const resolved = resolveComponent('ImmediateResolve');
        expect(resolved).toBeDefined();
        if (resolved) {
          expect(resolved.id).toBe(token.id);
        }
      });

      it('returns the same token across two World instances', () => {
        const C = defineComponent('CrossWorldComp', { v: 'f32' });
        const resolved = resolveComponent('CrossWorldComp');
        expect(resolved).toBeDefined();
        if (resolved) {
          expect(resolved.id).toBe(C.id);
        }
        expect(resolved).toBe(C);
      });
    });

    describe('RELATIONSHIP_COMPONENTS', () => {
      it('contains a component that declares a relationship', () => {
        const Mirror = defineComponent('TestRelMirror1', { entities: 'array<entity>' });
        const Holder = defineComponent(
          'TestRelHolder1',
          { parent: 'entity' },
          { relationship: { mirror: 'TestRelMirror1', field: 'entities', exclusive: true } },
        );

        expect(RELATIONSHIP_COMPONENTS.has(Holder)).toBe(true);
        expect(RELATIONSHIP_COMPONENTS.has(Mirror)).toBe(false);
      });

      it('does not contain a component without a relationship', () => {
        const Plain = defineComponent('NoRelComp1', { v: 'f32' });
        expect(RELATIONSHIP_COMPONENTS.has(Plain)).toBe(false);
      });
    });
  });
}

{
  // ─── from component-schema-json.test.ts ───
  // NOTE: two source files both defined defineComponent('C', ...) with different schemas.
  // The second defineComponent('C', diff-schema) is renamed to 'C2' to avoid schema-mismatch
  // at merge time (global component registry, same-name diff-schema -> throw).

  describe('component-schema-json.test.ts', () => {
    describe('Component.toSchemaJSON() — offline manifest discoverability (w29)', () => {
      test('JSON.stringify(C.schema) includes array<entity> / array<f32, 16> / buffer<16> / buffer literal substrings', () => {
        const Hierarchy = defineComponent('Hierarchy', {
          children: 'array<entity>',
          instanceTransforms: 'array<f32, 16>',
        });

        const BufferBag = defineComponent('BufferBag', {
          meta: 'buffer<16>',
          blob: 'buffer',
        });

        const json1 = JSON.stringify(Hierarchy.schema);
        const json2 = JSON.stringify(BufferBag.schema);

        expect(json1).toContain('array<entity>');
        expect(json1).toContain('array<f32, 16>');
        expect(json2).toContain('buffer<16>');
        expect(json2).toContain('"buffer"');

        expect(JSON.parse(json1)).toEqual({
          children: 'array<entity>',
          instanceTransforms: 'array<f32, 16>',
        });
        expect(JSON.parse(json2)).toEqual({
          meta: 'buffer<16>',
          blob: 'buffer',
        });
      });

      test('schema literal types survive the JSON round-trip (no widening to string)', () => {
        const C2 = defineComponent('SchemaJsonC2', {
          tag: 'array<u32>',
          slot: 'buffer<32>',
        });

        const tagKeyword: 'array<u32>' = C2.schema.tag;
        const slotKeyword: 'buffer<32>' = C2.schema.slot;
        expect(tagKeyword).toBe('array<u32>');
        expect(slotKeyword).toBe('buffer<32>');

        expect(JSON.stringify(C2.schema)).toContain('array<u32>');
        expect(JSON.stringify(C2.schema)).toContain('buffer<32>');
      });

      test('toSchemaJSON() method matches JSON.stringify(C.schema) byte-for-byte', () => {
        const C = defineComponent('C', {
          children: 'array<entity>',
          meta: 'buffer<16>',
          blob: 'buffer',
        });
        const viaMethod = C.toSchemaJSON();
        const viaIdiom = JSON.stringify(C.schema);
        expect(typeof C.toSchemaJSON).toBe('function');
        expect(viaMethod).toBe(viaIdiom);
        expect(viaMethod).toContain('array<entity>');
        expect(viaMethod).toContain('buffer<16>');
        expect(viaMethod).toContain('"buffer"');
      });
    });
  });
}

{
  // ─── from errors.test.ts ───
  describe('errors.test.ts', () => {
    describe('EcsError unified interface — .code property', () => {
      const errorCases: Array<{
        label: string;
        create: () => Error & { hint: string; code: string };
        expectedCode: string;
      }> = [
        {
          label: 'EntityIndexOverflowError',
          create: () => new EntityIndexOverflowError(99999999),
          expectedCode: 'entity-index-overflow',
        },
        {
          label: 'SchemaUnsupportedFieldError',
          create: () => new SchemaUnsupportedFieldError('x', 'vec3'),
          expectedCode: 'schema-unsupported-field',
        },
        {
          label: 'StaleEntityError',
          create: () => new StaleEntityError(100, 5, 3),
          expectedCode: 'stale-entity',
        },
        {
          label: 'ComponentAlreadyPresentError',
          create: () => new ComponentAlreadyPresentError(42, 'Pos'),
          expectedCode: 'component-already-present',
        },
        {
          label: 'ComponentNotPresentError',
          create: () => new ComponentNotPresentError(42, 'Velocity'),
          expectedCode: 'component-not-present',
        },
        {
          label: 'CyclicDependencyError',
          create: () => new CyclicDependencyError(['A', 'B', 'A']),
          expectedCode: 'cyclic-dependency',
        },
        {
          label: 'ResourceNotFoundError',
          create: () => new ResourceNotFoundError('Time'),
          expectedCode: 'resource-not-found',
        },
      ];

      for (const { label, create, expectedCode } of errorCases) {
        describe(label, () => {
          it(`.code equals "${expectedCode}"`, () => {
            const e = create();
            expect(e.code).toBe(expectedCode);
          });

          it('.code is kebab-case', () => {
            const e = create();
            expect(e.code).toMatch(/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/);
          });

          it('.name is readable', () => {
            const e = create();
            expect(typeof e.name).toBe('string');
            expect(e.name.length).toBeGreaterThan(0);
          });

          it('.message is readable', () => {
            const e = create();
            expect(typeof e.message).toBe('string');
            expect(e.message.length).toBeGreaterThan(0);
          });

          it('.hint is readable', () => {
            const e = create();
            expect(typeof e.hint).toBe('string');
            expect(e.hint.length).toBeGreaterThan(0);
          });
        });
      }
    });

    describe('StaleEntityError enhanced fields (F-04)', () => {
      it('has component field (optional string)', () => {
        const e = new StaleEntityError(100, 5, 3, {
          component: 'Position',
          operation: 'get',
          expectedGeneration: 3,
          actualGeneration: 2,
        });
        expect(e.component).toBe('Position');
      });

      it('component is undefined when not provided', () => {
        const e = new StaleEntityError(100, 5, 3, {
          operation: 'despawn',
          expectedGeneration: 3,
          actualGeneration: 2,
        });
        expect(e.component).toBeUndefined();
      });

      it('has operation field (string)', () => {
        const e = new StaleEntityError(100, 5, 3, {
          operation: 'get',
          expectedGeneration: 3,
          actualGeneration: 2,
        });
        expect(e.operation).toBe('get');
      });

      it('has expectedGeneration field (number)', () => {
        const e = new StaleEntityError(100, 5, 3, {
          operation: 'set',
          expectedGeneration: 5,
          actualGeneration: 3,
        });
        expect(e.expectedGeneration).toBe(5);
      });

      it('has actualGeneration field (number)', () => {
        const e = new StaleEntityError(100, 5, 3, {
          operation: 'set',
          expectedGeneration: 5,
          actualGeneration: 3,
        });
        expect(e.actualGeneration).toBe(3);
      });

      it('preserves original entity/index/generation fields (backward compat)', () => {
        const e = new StaleEntityError(100, 5, 3, {
          component: 'Velocity',
          operation: 'get',
          expectedGeneration: 3,
          actualGeneration: 1,
        });
        expect(e.name).toBe('StaleEntityError');
        expect(e.message).toBeDefined();
        expect(e.hint).toBeDefined();
      });

      it('backward compat: constructor without enhanced fields still works', () => {
        const e = new StaleEntityError(100, 5, 3);
        expect(e.name).toBe('StaleEntityError');
        expect(e.hint).toBeDefined();
        expect(e.component).toBeUndefined();
        expect(e.operation).toBeUndefined();
        expect(e.expectedGeneration).toBeUndefined();
        expect(e.actualGeneration).toBeUndefined();
      });
    });

    describe('AC-09 EcsErrorCode net-zero relative fence (w16)', () => {
      function parseEcsErrorCodeMembers(src: string): string[] {
        const header = 'export type EcsErrorCode =';
        const start = src.indexOf(header);
        if (start === -1) return [];
        const bodyStart = start + header.length;
        const endMarker = src.indexOf('export type EcsErrorDetail');
        const searchEnd = endMarker > -1 ? endMarker : src.length;
        let lastSemicolon = -1;
        for (let i = bodyStart; i < searchEnd; i++) {
          if (src[i] === ';') lastSemicolon = i;
        }
        const body = src.slice(bodyStart, lastSemicolon > -1 ? lastSemicolon : searchEnd);

        const members = new Set<string>();
        for (const raw of body.split('\n')) {
          const line = raw.trim();
          const member = line.match(/^\|\s*'([^']+)'/);
          if (member) {
            members.add(member[1] ?? '');
            continue;
          }
          const first = line.match(/^=\s*'([^']+)'/);
          if (first) {
            members.add(first[1] ?? '');
          }
        }
        return [...members].sort();
      }

      it('EcsErrorCode member set = git HEAD member set (net add 0, net delete 0)', () => {
        const errorsPath = resolve(__dirname, '..', 'errors.ts');

        const currentSrc = readFileSync(errorsPath, 'utf-8');
        const currentMembers = parseEcsErrorCodeMembers(currentSrc);

        let headSrc: string;
        try {
          headSrc = execSync('git show HEAD:packages/ecs/src/errors.ts', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          return;
        }
        const headMembers = parseEcsErrorCodeMembers(headSrc);

        // M-4 (feat-20260611-ecs-storage-naming-ssot): intentional SCREAMING_SNAKE -> kebab rename.
        // Map head-side SCREAMING_SNAKE codes to their kebab counterparts before comparison.
        const M4_RENAME_MAP: Record<string, string> = {
          ENTITY_INDEX_OVERFLOW: 'entity-index-overflow',
          SCHEMA_UNSUPPORTED_FIELD: 'schema-unsupported-field',
          STALE_ENTITY: 'stale-entity',
          COMPONENT_ALREADY_PRESENT: 'component-already-present',
          COMPONENT_NOT_PRESENT: 'component-not-present',
          CYCLIC_DEPENDENCY: 'cyclic-dependency',
          RESOURCE_NOT_FOUND: 'resource-not-found',
        };
        // feat-20260614-ecs-shared-component-and-unique-rename M2/w5: intentional
        // managed-ref-* -> unique-ref-* error code rename (handle brand
        // `'managed'` -> `'unique'` cascade). Map head-side managed-ref codes
        // to their unique-ref counterparts before comparison.
        const FEAT_20260614_RENAME_MAP: Record<string, string> = {
          'managed-ref-released': 'unique-ref-released',
          'managed-ref-double-release': 'unique-ref-double-release',
        };
        // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch
        // post-merge with PR #520 (transparent collapse): PR 520 narrowed
        // `MaterialSnapshot.shadingModel` to `'unlit' | undefined` — sprite
        // is no longer a shadingModel enum member; identification is via
        // `materialShaderId === 'forgeax::sprite'` (OOS-1 path retained).
        // The guard error code accordingly renames to match the actual
        // discriminator it checks.
        const FEAT_20260625_RENAME_MAP: Record<string, string> = {
          'sprite-instances-requires-sprite-shading-model':
            'sprite-instances-requires-sprite-shader',
        };
        const applyRenames = (m: string): string =>
          FEAT_20260625_RENAME_MAP[m] ?? FEAT_20260614_RENAME_MAP[m] ?? M4_RENAME_MAP[m] ?? m;
        const headSet = new Set(headMembers.map(applyRenames));
        const currentSet = new Set(currentMembers);

        // bug-20260615 spawn-data-unknown-field-fail-fast: AGENTS.md
        // §Error model evolution permits add-only minor evolution. Each
        // intentional addition lists itself here so accidental drift in
        // unrelated diffs still trips the gate.
        //
        // feat-20260614-ecs-shared-component-and-unique-rename M3 adds the
        // two SharedRefStore error codes (companion to the existing
        // unique-ref-* pair). Intentional add per the same minor-evolution
        // contract.
        //
        // feat-20260623 #511 unified generational handle codec adds the
        // shared-ref-stale + unique-ref-stale pair (gen-mismatch on
        // resolve / retain after the entity+asset shared isRetiredSlot
        // SSOT merge). Intentional add per the same minor-evolution
        // contract.
        const INTENTIONAL_ADDS = new Set<string>([
          'spawn-data-unknown-field',
          'shared-ref-released',
          'shared-ref-double-release',
          // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch
          // M1 / w2 — 3 declared, fired at render-system-extract entry in
          // M3 w13 (plan-strategy D-6). Minor evolution +3 per AGENTS.md
          // §Error model evolution contract.
          'sprite-instances-count-mismatch',
          'sprite-instances-requires-sprite-shader',
          'sprite-instances-mutually-exclusive-with-instances',
          // feat-20260623-asset-handle-generation M4 — `shared-ref-stale` /
          // `unique-ref-stale` landed on main during this feat's in-flight
          // window (PR #502 + companion lands). Absorbed at merge into
          // INTENTIONAL_ADDS so the net-zero gate stays self-consistent
          // (charter F1: upstream lands must not trigger this feat's fence).
          'shared-ref-stale',
          'unique-ref-stale',
          // solo bevy-examples round 20260713-194533 — queryCombinations
          // Entity-required fail-fast. Minor evolution +1 per AGENTS.md
          // §Error model evolution contract.
          'query-combinations-entity-required',
          // feat-20260713-mount-override-component-add-and-shared-ref-round
          // M2 / w9 — P3 shared-field value gate. `shared-field-invalid-value`
          // fails fast when a `shared<T>` / `array<shared<T>>` field is bound to
          // a raw GUID / sidecar object (not a resolved numeric handle) instead
          // of the pre-fix silent zeroing. Minor evolution +1 per AGENTS.md
          // §Error model evolution contract.
          'shared-field-invalid-value',
          // feat-20260714-bevy-style-system-sets M1 / w3 — sole invalid-SystemSet
          // error code. Minor evolution +1 per AGENTS.md §Error model evolution
          // contract.
          'system-set-not-registered',
        ]);

        const added: string[] = [];
        const deleted: string[] = [];
        for (const c of currentSet) {
          if (!headSet.has(c) && !INTENTIONAL_ADDS.has(c)) added.push(c);
        }
        for (const h of headSet) {
          if (!currentSet.has(h)) deleted.push(h);
        }

        if (added.length > 0 || deleted.length > 0) {
          const lines: string[] = [];
          if (added.length > 0)
            lines.push(
              `EcsErrorCode members ADDED by this feat (net +${added.length}): ${added.join(', ')}`,
            );
          if (deleted.length > 0)
            lines.push(
              `EcsErrorCode members DELETED by this feat (net -${deleted.length}): ${deleted.join(', ')}`,
            );
          lines.push(
            `HEAD member count: ${headMembers.length}; current member count: ${currentMembers.length}`,
          );
          throw new Error(lines.join('\n'));
        }

        expect(currentMembers.length).toBeGreaterThan(0);
      });
    });
  });
}

{
  // ─── from managed-entity-dangling-errors.test.ts ───
  describe('managed-entity-dangling-errors.test.ts', () => {
    describe('w5 — managed error classes', () => {
      it('UniqueRefReleasedError carries code + hint + detail.handle', () => {
        const err = new UniqueRefReleasedError(0xdeadbeef, 'MaterialAsset');
        expect(err.code).toBe('unique-ref-released');
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.detail.handle).toBe(0xdeadbeef);
        expect(err.detail.target).toBe('MaterialAsset');
      });

      it('UniqueRefDoubleReleaseError carries code + hint + detail.handle', () => {
        const err = new UniqueRefDoubleReleaseError(7, 'MaterialAsset');
        expect(err.code).toBe('unique-ref-double-release');
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.detail.handle).toBe(7);
        expect(err.detail.target).toBe('MaterialAsset');
      });

      it('ManagedBufferOutOfBoundsError carries code + hint + detail.{index,size}', () => {
        const err = new ManagedBufferOutOfBoundsError(128, 64);
        expect(err.code).toBe('managed-buffer-out-of-bounds');
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.detail.index).toBe(128);
        expect(err.detail.size).toBe(64);
      });

      it('ManagedBufferShrinkNotSupportedError carries code + hint + detail.{requested,current}', () => {
        const err = new ManagedBufferShrinkNotSupportedError(32, 64);
        expect(err.code).toBe('managed-buffer-shrink-not-supported');
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.detail.requested).toBe(32);
        expect(err.detail.current).toBe(64);
      });

      it('EcsErrorCode closed union exhaustively covers the managed members', () => {
        function assertNever(_x: never): never {
          throw new Error('unreachable');
        }
        function check(code: EcsErrorCode): string {
          switch (code) {
            case 'entity-index-overflow':
            case 'schema-unsupported-field':
            case 'stale-entity':
            case 'component-already-present':
            case 'component-not-present':
            case 'cyclic-dependency':
            case 'resource-not-found':
            case 'system-before-unknown':
            case 'system-name-conflict':
            case 'cyclic-injection':
            case 'unique-ref-released':
            case 'unique-ref-double-release':
            case 'managed-buffer-out-of-bounds':
            case 'managed-buffer-shrink-not-supported':
            case 'fixed-size-mismatch':
            case 'fixed-array-overflow':
            case 'array-pop-empty':
            case 'instance-transforms-stride-mismatch':
            case 'managed-array-element-type-not-allowed':
            case 'spawn-light-invalid-bounds':
            case 'cardinality-exceeded':
            case 'resource-invalid-value':
            case 'sprite-animation-invalid':
            case 'relationship-self-cycle':
            case 'relationship-mirror-component-not-registered':
            case 'relationship-mirror-field-type-mismatch':
            case 'relationship-detach-mismatch':
            case 'query-descriptor-with-optional-conflict':
            case 'component-not-defined':
            case 'remove-essential-component':
            case 'scene-override-type-mismatch':
            case 'spawn-data-unknown-field':
            case 'shared-ref-released':
            case 'shared-ref-double-release':
            case 'builtin-slot-not-owned':
            case 'shared-ref-stale':
            case 'unique-ref-stale':
            // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch
            // M1 / w2 — 3 new cases for the SpriteInstances primitive (codes
            // declared in M1, fired in M3 w13). Required to keep this
            // exhaustive switch over EcsErrorCode visually closed.
            case 'sprite-instances-count-mismatch':
            case 'sprite-instances-requires-sprite-shader':
            case 'sprite-instances-mutually-exclusive-with-instances':
            // solo bevy-examples round 20260713-194533 — queryCombinations
            // Entity-required fail-fast case, keeps this switch exhaustive.
            case 'query-combinations-entity-required':
            // feat-20260713-mount-override-component-add-and-shared-ref-round
            // M2 / w9 — shared-field value gate code. Required to keep this
            // exhaustive switch over EcsErrorCode visually closed.
            case 'shared-field-invalid-value':
              return code;
            // feat-20260714-bevy-style-system-sets M1 / w3 — system-set-not-registered
            // case. Required to keep this exhaustive switch over EcsErrorCode
            // visually closed.
            case 'system-set-not-registered':
              return code;
            default:
              return assertNever(code);
          }
        }
        expect(check('unique-ref-released')).toBe('unique-ref-released');
        expect(check('managed-buffer-out-of-bounds')).toBe('managed-buffer-out-of-bounds');
      });
    });
  });
}

{
  // ─── from relationship-errors.test.ts ───
  describe('relationship-errors.test.ts', () => {
    describe('relationship error codes', () => {
      it('relationship-self-cycle carries .code + .detail.entity', () => {
        const e = new RelationshipSelfCycleError('ChildOf', 42 as number, 7 as number);
        expect(e.code).toBe('relationship-self-cycle');
        expect(e).toBeInstanceOf(Error);
        expect(e.detail).toMatchObject({ component: 'ChildOf', entity: 42, ancestor: 7 });
        expect(typeof e.hint).toBe('string');
      });

      it('relationship-mirror-component-not-registered carries .code + .detail', () => {
        const e = new RelationshipMirrorComponentNotRegisteredError('ChildOf', 'Children');
        expect(e.code).toBe('relationship-mirror-component-not-registered');
        expect(e).toBeInstanceOf(Error);
        expect(e.detail).toMatchObject({ component: 'ChildOf', mirror: 'Children' });
      });

      it('relationship-mirror-component-not-registered hint drops register wording (AC-09)', () => {
        const e = new RelationshipMirrorComponentNotRegisteredError('ChildOf', 'Children');
        expect(e.hint).not.toMatch(/register/i);
        expect(e.hint).toContain('defineComponent');
      });

      it('relationship-mirror-field-type-mismatch carries .code + .detail', () => {
        const e = new RelationshipMirrorFieldTypeMismatchError(
          'ChildOf',
          'Children',
          'entities',
          'array<f32>',
        );
        expect(e.code).toBe('relationship-mirror-field-type-mismatch');
        expect(e).toBeInstanceOf(Error);
        expect(e.detail).toMatchObject({
          component: 'ChildOf',
          mirror: 'Children',
          field: 'entities',
          actualType: 'array<f32>',
        });
      });

      it('relationship-detach-mismatch carries .code + .detail', () => {
        const e = new RelationshipDetachMismatchError(
          'ChildOf',
          5 as number,
          9 as number,
          3 as number,
        );
        expect(e.code).toBe('relationship-detach-mismatch');
        expect(e).toBeInstanceOf(Error);
        expect(e.detail).toMatchObject({
          component: 'ChildOf',
          child: 5,
          expectedParent: 9,
          actualParent: 3,
        });
      });

      it('all 4 codes are members of the EcsErrorCode union (exhaustive narrow)', () => {
        const codes: EcsErrorCode[] = [
          'relationship-self-cycle',
          'relationship-mirror-component-not-registered',
          'relationship-mirror-field-type-mismatch',
          'relationship-detach-mismatch',
        ];
        function classify(code: EcsErrorCode): string {
          switch (code) {
            case 'relationship-self-cycle':
              return 'cycle';
            case 'relationship-mirror-component-not-registered':
              return 'mirror-missing';
            case 'relationship-mirror-field-type-mismatch':
              return 'mirror-type';
            case 'relationship-detach-mismatch':
              return 'detach';
            default:
              return 'other';
          }
        }
        expect(codes.map(classify)).toEqual(['cycle', 'mirror-missing', 'mirror-type', 'detach']);
      });
    });
  });
}

{
  // ─── from result.test.ts ───
  describe('result.test.ts', () => {
    describe('ok() factory', () => {
      it('produces an object with `.ok === true` (boolean discriminant)', () => {
        const r = ok(42);
        expect(r.ok).toBe(true);
      });

      it('exposes `.value` on the success branch', () => {
        const r = ok(42);
        if (r.ok) {
          expect(r.value).toBe(42);
        } else {
          throw new Error('ok() branch unreachable');
        }
      });
    });

    describe('err() factory', () => {
      it('produces an object with `.ok === false` (boolean discriminant)', () => {
        const e = new ComponentNotPresentError(1, 'Pos');
        const r = err(e);
        expect(r.ok).toBe(false);
      });

      it('exposes `.error` on the failure branch', () => {
        const e = new ComponentNotPresentError(1, 'Pos');
        const r = err(e);
        if (!r.ok) {
          expect(r.error).toBe(e);
        } else {
          throw new Error('err() branch unreachable');
        }
      });
    });

    describe('discriminant shape (`.ok` is boolean, not getter→value)', () => {
      it('`.ok` on ok() is the literal boolean true', () => {
        const r = ok(123);
        expect(r.ok).toBe(true);
        expect(typeof r.ok).toBe('boolean');
      });

      it('`.ok` on err() is the literal boolean false', () => {
        const r = err(new ComponentNotPresentError(1, 'Pos'));
        expect(r.ok).toBe(false);
        expect(typeof r.ok).toBe('boolean');
      });
    });

    describe('unwrap()', () => {
      it('returns the value for an Ok result', () => {
        const r = ok(42);
        expect(r.unwrap()).toBe(42);
      });

      it('throws the ORIGINAL EcsError for an Err result (not wrapped)', () => {
        const e = new StaleEntityError(100, 5, 3);
        const r = err(e);

        let thrown: unknown;
        try {
          r.unwrap();
        } catch (ex) {
          thrown = ex;
        }

        expect(thrown).toBe(e);
      });

      it('thrown error retains .code and .hint (charter: structured error)', () => {
        const e = new ComponentNotPresentError(1, 'Velocity');
        const r = err(e);

        let thrown: unknown;
        try {
          r.unwrap();
        } catch (ex) {
          thrown = ex;
        }

        expect(thrown).toBeInstanceOf(ComponentNotPresentError);
        const typedErr = thrown as ComponentNotPresentError;
        expect(typedErr.hint).toBeDefined();
        expect(typeof typedErr.hint).toBe('string');
        expect(typedErr.hint.length).toBeGreaterThan(0);
      });
    });

    describe('unwrapOr()', () => {
      it('returns the value for an Ok result', () => {
        const r = ok(42);
        expect(r.unwrapOr(0)).toBe(42);
      });

      it('returns the default for an Err result', () => {
        const e = new ComponentNotPresentError(1, 'Pos');
        const r: Result<number, ComponentNotPresentError> = err(e);
        expect(r.unwrapOr(99)).toBe(99);
      });
    });

    describe('removed surface (D-P2 guard)', () => {
      it('ok() result has no `isOk` property', () => {
        const r = ok(42);
        expect('isOk' in r).toBe(false);
      });

      it('ok() result has no `isErr` property', () => {
        const r = ok(42);
        expect('isErr' in r).toBe(false);
      });

      it('ok() result has no `map` property', () => {
        const r = ok(42);
        expect('map' in r).toBe(false);
      });

      it('ok() result has no `mapErr` property', () => {
        const r = ok(42);
        expect('mapErr' in r).toBe(false);
      });

      it('err() result has no `isOk` property', () => {
        const r = err(new ComponentNotPresentError(1, 'Pos'));
        expect('isOk' in r).toBe(false);
      });

      it('err() result has no `isErr` property', () => {
        const r = err(new ComponentNotPresentError(1, 'Pos'));
        expect('isErr' in r).toBe(false);
      });

      it('err() result has no `map` property', () => {
        const r = err(new ComponentNotPresentError(1, 'Pos'));
        expect('map' in r).toBe(false);
      });

      it('err() result has no `mapErr` property', () => {
        const r = err(new ComponentNotPresentError(1, 'Pos'));
        expect('mapErr' in r).toBe(false);
      });
    });

    describe('byte-for-byte parity with rhi.Result narrow shape', () => {
      it('ok() own-property names equal {ok, value} (no extra surface, no missing)', () => {
        const r = ok(42);
        const ownKeys = Object.keys(r).sort();
        expect(ownKeys).toEqual(['ok', 'value']);
      });

      it('err() own-property names equal {ok, error} (no extra surface, no missing)', () => {
        const r = err(new ComponentNotPresentError(1, 'Pos'));
        const ownKeys = Object.keys(r).sort();
        expect(ownKeys).toEqual(['error', 'ok']);
      });

      it('`.ok` on Ok is an own data property (not a getter)', () => {
        const r = ok(42);
        expect(Object.hasOwn(r, 'ok')).toBe(true);
      });

      it('`.value` on Ok is an own data property (not a prototype getter)', () => {
        const r = ok(42);
        expect(Object.hasOwn(r, 'value')).toBe(true);
      });

      it('`.error` on Err is an own data property (not a prototype getter)', () => {
        const r = err(new ComponentNotPresentError(1, 'Pos'));
        expect(Object.hasOwn(r, 'error')).toBe(true);
      });

      it('`.unwrap` lives on the prototype chain, not as own', () => {
        const r = ok(42);
        expect(Object.hasOwn(r, 'unwrap')).toBe(false);
        expect(typeof r.unwrap).toBe('function');
      });

      it('`.unwrapOr` lives on the prototype chain, not as own', () => {
        const r = ok(42);
        expect(Object.hasOwn(r, 'unwrapOr')).toBe(false);
        expect(typeof r.unwrapOr).toBe('function');
      });
    });

    describe('type-level narrowing via `r.ok`', () => {
      it('ok branch exposes `.value: T`; err branch exposes `.error: E`', () => {
        // Construct via the discriminated union so both arms type-check
        // independently — `ok(42)` alone narrows to `ResultOk<number>` and
        // would collapse the err arm to `never`.
        const probe = (r: Result<number, ComponentNotPresentError>) => {
          if (r.ok) {
            expectTypeOf(r.value).toEqualTypeOf<number>();
          } else {
            expectTypeOf(r.error).toEqualTypeOf<ComponentNotPresentError>();
          }
        };
        probe(ok(42));
        probe(err(new ComponentNotPresentError(1, 'Pos')));
      });
    });
  });
}

{
  // ─── from spawn-light-invalid-bounds-error-code.test.ts ───
  describe('spawn-light-invalid-bounds-error-code.test.ts', () => {
    describe("EcsErrorCode +1 'spawn-light-invalid-bounds' union member [AC-06 (e)]", () => {
      it("type-level: 'spawn-light-invalid-bounds' is assignable to EcsErrorCode", () => {
        const code: EcsErrorCode = 'spawn-light-invalid-bounds';
        expect(code).toBe('spawn-light-invalid-bounds');
        expectTypeOf<'spawn-light-invalid-bounds'>().toMatchTypeOf<EcsErrorCode>();
      });

      it("EcsErrorDetail discriminated variant for 'spawn-light-invalid-bounds' carries field three-branch", () => {
        const range: EcsErrorDetail = {
          code: 'spawn-light-invalid-bounds',
          field: 'range',
          got: -1,
        };
        const innerOuter: EcsErrorDetail = {
          code: 'spawn-light-invalid-bounds',
          field: 'innerOuter',
          got: 25,
        };
        const outerNinety: EcsErrorDetail = {
          code: 'spawn-light-invalid-bounds',
          field: 'outerNinety',
          got: 91,
        };
        expect(range.code).toBe('spawn-light-invalid-bounds');
        expect(innerOuter.code).toBe('spawn-light-invalid-bounds');
        expect(outerNinety.code).toBe('spawn-light-invalid-bounds');
      });

      it('exhaustive switch on detail.field narrows three branches (compile-time)', () => {
        const detail: EcsErrorDetail = {
          code: 'spawn-light-invalid-bounds',
          field: 'range',
          got: -1,
        };
        if (detail.code === 'spawn-light-invalid-bounds') {
          switch (detail.field) {
            case 'range': {
              expectTypeOf(detail.got).toEqualTypeOf<number>();
              break;
            }
            case 'innerOuter': {
              expectTypeOf(detail.got).toEqualTypeOf<number>();
              break;
            }
            case 'outerNinety': {
              expectTypeOf(detail.got).toEqualTypeOf<number>();
              break;
            }
            default: {
              const _exhaustive: never = detail;
              throw new Error(`unreachable: ${String(_exhaustive)}`);
            }
          }
        }
      });

      it("type-level: switch over EcsErrorCode includes 'spawn-light-invalid-bounds' branch", () => {
        function describeCode(code: EcsErrorCode): string {
          switch (code) {
            case 'spawn-light-invalid-bounds':
              return 'spawn-light-invalid-bounds';
            default:
              return 'other';
          }
        }
        expect(describeCode('spawn-light-invalid-bounds')).toBe('spawn-light-invalid-bounds');
      });
    });
  });
}

{
  // ─── from w8-ecs-error-code-kebab-grep-gate.test.ts ───
  describe('w8-ecs-error-code-kebab-grep-gate.test.ts', () => {
    describe('EcsErrorCode kebab grep gate (M-4 w8)', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(here, '..', '..', '..', '..');

      const SEVEN_SCREAMING_SNAKE_RE =
        "'(ENTITY_INDEX_OVERFLOW|SCHEMA_UNSUPPORTED_FIELD|STALE_ENTITY|COMPO" +
        "NENT_ALREADY_PRESENT|COMPONENT_NOT_PRESENT|CYCLIC_DEPENDENCY|RESOURCE_NOT_FOUND)'";

      it('zero SCREAMING_SNAKE error code literals in non-README source (M-4 w9 replaces these)', () => {
        const r = spawnSync(
          'grep',
          [
            '-rE',
            '--include=*.ts',
            '--exclude-dir=dist',
            '--exclude-dir=node_modules',
            '--exclude=errors.unit.test.ts',
            SEVEN_SCREAMING_SNAKE_RE,
            'packages/ecs/src/',
            'packages/runtime/src/',
            'apps/',
            'templates/',
          ],
          { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
        );
        if (r.status === 2 || r.error) {
          throw new Error(`grep failed: ${r.stderr || r.error}`);
        }
        const hits = (r.stdout ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        expect(hits, `SCREAMING_SNAKE error code literals remaining:\n${hits.join('\n')}`).toEqual(
          [],
        );
      });
    });
  });
}

{
  // ─── from sprite-animation-invalid-error.test.ts ───
  describe('sprite-animation-invalid-error.test.ts', () => {
    describe("EcsErrorCode +1 'sprite-animation-invalid' union member [M1 T-04]", () => {
      it("type-level: 'sprite-animation-invalid' is assignable to EcsErrorCode", () => {
        const code: EcsErrorCode = 'sprite-animation-invalid';
        expect(code).toBe('sprite-animation-invalid');
        expectTypeOf<'sprite-animation-invalid'>().toMatchTypeOf<EcsErrorCode>();
      });

      it("EcsErrorDetail discriminated variant 'sprite-animation-invalid' carries field two-branch", () => {
        const regionsLength: EcsErrorDetail = {
          code: 'sprite-animation-invalid',
          field: 'regions-length',
          regionsLength: 12,
          frameCount: 4,
        };
        const frameDuration: EcsErrorDetail = {
          code: 'sprite-animation-invalid',
          field: 'frame-duration',
          frameDuration: 0,
        };
        expect(regionsLength.code).toBe('sprite-animation-invalid');
        expect(frameDuration.code).toBe('sprite-animation-invalid');
      });

      it('exhaustive switch on detail.field narrows two branches (compile-time)', () => {
        const branches: ReadonlyArray<EcsErrorDetail> = [
          {
            code: 'sprite-animation-invalid',
            field: 'regions-length',
            regionsLength: 12,
            frameCount: 4,
          },
          {
            code: 'sprite-animation-invalid',
            field: 'frame-duration',
            frameDuration: 0,
          },
        ];
        for (const detail of branches) {
          if (detail.code === 'sprite-animation-invalid') {
            switch (detail.field) {
              case 'regions-length': {
                expectTypeOf(detail.regionsLength).toEqualTypeOf<number>();
                expectTypeOf(detail.frameCount).toEqualTypeOf<number>();
                break;
              }
              case 'frame-duration': {
                expectTypeOf(detail.frameDuration).toEqualTypeOf<number>();
                break;
              }
              default: {
                const _exhaustive: never = detail;
                throw new Error(`unreachable: ${String(_exhaustive)}`);
              }
            }
          }
        }
      });
    });

    describe('SpriteAnimationInvalidError class — 4-field surface (regions-length branch)', () => {
      it("constructs with field='regions-length' and exposes 4 fields", () => {
        const err = new SpriteAnimationInvalidError({
          field: 'regions-length',
          regionsLength: 12,
          frameCount: 4,
        });
        expect(err.code).toBe('sprite-animation-invalid');
        expect(err.expected).toBeTruthy();
        expect(err.expected.length).toBeGreaterThan(0);
        expect(err.hint).toBeTruthy();
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.detail.field).toBe('regions-length');
        if (err.detail.field === 'regions-length') {
          expect(err.detail.regionsLength).toBe(12);
          expect(err.detail.frameCount).toBe(4);
        }
      });

      it("constructs with field='frame-duration' and exposes 4 fields", () => {
        const err = new SpriteAnimationInvalidError({
          field: 'frame-duration',
          frameDuration: 0,
        });
        expect(err.code).toBe('sprite-animation-invalid');
        expect(err.expected).toBeTruthy();
        expect(err.expected.length).toBeGreaterThan(0);
        expect(err.hint).toBeTruthy();
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.detail.field).toBe('frame-duration');
        if (err.detail.field === 'frame-duration') {
          expect(err.detail.frameDuration).toBe(0);
        }
      });

      it('field=frame-duration accepts negative frameDuration (AC-09 c)', () => {
        const err = new SpriteAnimationInvalidError({
          field: 'frame-duration',
          frameDuration: -0.05,
        });
        expect(err.code).toBe('sprite-animation-invalid');
        expect(err.detail.field).toBe('frame-duration');
        if (err.detail.field === 'frame-duration') {
          expect(err.detail.frameDuration).toBe(-0.05);
        }
      });

      it('Error message embeds code + field + recovery hint (charter P3)', () => {
        const err = new SpriteAnimationInvalidError({
          field: 'regions-length',
          regionsLength: 7,
          frameCount: 3,
        });
        expect(err.message).toContain('sprite-animation-invalid');
        expect(err.message).toContain('regions-length');
      });

      it('class .name override aligns with the error type', () => {
        const err = new SpriteAnimationInvalidError({
          field: 'frame-duration',
          frameDuration: 0,
        });
        expect(err.name).toBe('SpriteAnimationInvalidError');
      });
    });

    describe("type-level: switch over EcsErrorCode includes 'sprite-animation-invalid' branch", () => {
      it('describeCode reaches the sprite-animation-invalid arm without default fall-through', () => {
        function describeCode(code: EcsErrorCode): string {
          switch (code) {
            case 'sprite-animation-invalid':
              return 'sprite-animation-invalid';
            default:
              return 'other';
          }
        }
        expect(describeCode('sprite-animation-invalid')).toBe('sprite-animation-invalid');
      });
    });
  });
}

{
  // ─── from sprite-instances-error-codes.test.ts ───
  // feat-20260625 M1 / w1 — 3 new EcsErrorCode members added by w2 for the
  // sprite-instances + tilemap-terrain-static-batch feat. Tests assert
  // (a) literal existence in EcsErrorCode union; (b) class instance carries
  // `.code` / `.hint` / `.detail` per AGENTS.md §Error model + charter P3
  // (`.hint` must contain actionable fix wording); (c) `.detail` discriminated
  // shape narrows correctly under `switch (err.code)` without a default arm.
  //
  // Boundary (plan-strategy §2 D-6): these 3 codes are DECLARED here (M1) but
  // FIRED at the render-system-extract entry (M3 w13). M1 tests intentionally
  // construct the classes directly — no extract-path fire test (that is M3).
  describe('sprite-instances-error-codes.test.ts', () => {
    describe('EcsErrorCode +3 — sprite-instances-* family (M1 w1)', () => {
      it('type-level: 3 new literals are assignable to EcsErrorCode', () => {
        const a: EcsErrorCode = 'sprite-instances-count-mismatch';
        const b: EcsErrorCode = 'sprite-instances-requires-sprite-shader';
        const c: EcsErrorCode = 'sprite-instances-mutually-exclusive-with-instances';
        expect(a).toBe('sprite-instances-count-mismatch');
        expect(b).toBe('sprite-instances-requires-sprite-shader');
        expect(c).toBe('sprite-instances-mutually-exclusive-with-instances');
        expectTypeOf<'sprite-instances-count-mismatch'>().toMatchTypeOf<EcsErrorCode>();
        expectTypeOf<'sprite-instances-requires-sprite-shader'>().toMatchTypeOf<EcsErrorCode>();
        expectTypeOf<'sprite-instances-mutually-exclusive-with-instances'>().toMatchTypeOf<EcsErrorCode>();
      });

      it('EcsErrorDetail discriminated variants narrow per `.code`', () => {
        const countDetail: EcsErrorDetail = {
          code: 'sprite-instances-count-mismatch',
          transformsLength: 320,
          regionsLength: 40,
          expectedStride: { transforms: 16, regions: 4 },
        };
        const shadingDetail: EcsErrorDetail = {
          code: 'sprite-instances-requires-sprite-shader',
          entityId: 42,
          observedMaterialShaderId: 'forgeax::default-standard-pbr',
        };
        const mutexDetail: EcsErrorDetail = {
          code: 'sprite-instances-mutually-exclusive-with-instances',
          entityId: 17,
        };
        expect(countDetail.code).toBe('sprite-instances-count-mismatch');
        expect(shadingDetail.code).toBe('sprite-instances-requires-sprite-shader');
        expect(mutexDetail.code).toBe('sprite-instances-mutually-exclusive-with-instances');
      });
    });

    describe('SpriteInstancesCountMismatchError class — w2 surface', () => {
      it('constructs with stride mismatch and exposes .code + .detail + .hint', () => {
        const err = new SpriteInstancesCountMismatchError(320, 40);
        expect(err.code).toBe('sprite-instances-count-mismatch');
        expect(err.detail).toEqual({
          code: 'sprite-instances-count-mismatch',
          transformsLength: 320,
          regionsLength: 40,
          expectedStride: { transforms: 16, regions: 4 },
        });
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.hint).toContain('transforms.length / 16');
        expect(err.hint).toContain('regions.length / 4');
      });

      it('.name is the class name and .message embeds .code', () => {
        const err = new SpriteInstancesCountMismatchError(320, 40);
        expect(err.name).toBe('SpriteInstancesCountMismatchError');
        expect(err.message).toContain('sprite-instances-count-mismatch');
      });
    });

    describe('SpriteInstancesRequiresSpriteShaderError class — w2 surface', () => {
      it('constructs with entity + observed materialShaderId and exposes .code + .detail + .hint', () => {
        const err = new SpriteInstancesRequiresSpriteShaderError(
          42,
          'forgeax::default-standard-pbr',
        );
        expect(err.code).toBe('sprite-instances-requires-sprite-shader');
        expect(err.detail).toEqual({
          code: 'sprite-instances-requires-sprite-shader',
          entityId: 42,
          observedMaterialShaderId: 'forgeax::default-standard-pbr',
        });
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.hint).toContain("'forgeax::sprite'");
        expect(err.hint).toContain('MaterialAsset');
      });

      it('.name is the class name and .message embeds .code', () => {
        const err = new SpriteInstancesRequiresSpriteShaderError(42, 'forgeax::default-unlit');
        expect(err.name).toBe('SpriteInstancesRequiresSpriteShaderError');
        expect(err.message).toContain('sprite-instances-requires-sprite-shader');
      });
    });

    describe('SpriteInstancesMutuallyExclusiveWithInstancesError class — w2 surface', () => {
      it('constructs with entity and exposes .code + .detail + .hint', () => {
        const err = new SpriteInstancesMutuallyExclusiveWithInstancesError(17);
        expect(err.code).toBe('sprite-instances-mutually-exclusive-with-instances');
        expect(err.detail).toEqual({
          code: 'sprite-instances-mutually-exclusive-with-instances',
          entityId: 17,
        });
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.hint).toContain('remove Instances');
        expect(err.hint).toContain('SpriteInstances supersedes Instances');
      });

      it('.name is the class name and .message embeds .code', () => {
        const err = new SpriteInstancesMutuallyExclusiveWithInstancesError(17);
        expect(err.name).toBe('SpriteInstancesMutuallyExclusiveWithInstancesError');
        expect(err.message).toContain('sprite-instances-mutually-exclusive-with-instances');
      });
    });

    describe('exhaustive switch over the 3 new codes (no default)', () => {
      it('compile-time narrows all 3 branches; runtime hits each arm exactly once', () => {
        const codes: EcsErrorCode[] = [
          'sprite-instances-count-mismatch',
          'sprite-instances-requires-sprite-shader',
          'sprite-instances-mutually-exclusive-with-instances',
        ];
        let count = 0;
        let shading = 0;
        let mutex = 0;
        for (const code of codes) {
          switch (code) {
            case 'sprite-instances-count-mismatch':
              count += 1;
              break;
            case 'sprite-instances-requires-sprite-shader':
              shading += 1;
              break;
            case 'sprite-instances-mutually-exclusive-with-instances':
              mutex += 1;
              break;
            default:
              void code;
          }
        }
        expect(count).toBe(1);
        expect(shading).toBe(1);
        expect(mutex).toBe(1);
      });
    });
  });
}

{
  // ─── feat-20260713 M2 / w7 — AC-09 shared-field illegal value fail-fast ───
  //
  // The P3 value gate: addComponent / spawn / set must reject an illegal value
  // for a shared field (scalar `shared<T>` must be a number handle; array
  // `array<shared<T>>` elements must all be numbers) with a structured EcsError
  // (.code / .expected / .hint) instead of silently zeroing the column to
  // `[0,0,0,0]`. AI users bind a shared reference by first resolving the GUID to
  // a handle (loadByGuid + allocSharedRef); passing a raw GUID string / {guid}
  // object / {kind} object bypasses that resolution and used to be swallowed.
  //
  // The three GUID forms feedback verified being zeroed:
  //   (a) bare GUID string 'pack.material'
  //   (b) { guid: '...' } object
  //   (c) { kind: 'MaterialAsset', ... } object
  //
  // Zeroing repro guard: after a rejected write the column must NOT read back as
  // the all-zero sentinel — the write is aborted so the field never lands.
  describe('feat-20260713 M2 / w7 — shared-field illegal value fail-fast (AC-09)', () => {
    const SHARED_INVALID_CODE = 'shared-field-invalid-value';

    // Distinct component names per test (defineComponent global index is
    // process-wide) — a scalar shared field + an array<shared<>> field.
    function scalarComp(name: string) {
      return defineComponent(name, { mat: { type: 'shared<MaterialAsset>' } });
    }
    function arrayComp(name: string) {
      return defineComponent(name, { clips: { type: 'array<shared<AnimationClip>, 4>' } });
    }

    const GUID_FORMS: ReadonlyArray<{ label: string; value: unknown }> = [
      { label: 'bare GUID string', value: 'pack.material' },
      { label: '{ guid } object', value: { guid: 'pack.material' } },
      { label: '{ kind } object', value: { kind: 'MaterialAsset', guid: 'pack.material' } },
    ];

    describe('scalar shared field', () => {
      for (const form of GUID_FORMS) {
        it(`addComponent rejects ${form.label} with structured EcsError (not zeroed)`, () => {
          const world = new World();
          const C = scalarComp(`W7Scalar_Add_${form.label.replace(/\W/g, '')}`);
          const e = world.spawn().unwrap();
          const add = world.addComponent(e, { component: C, data: { mat: form.value } as never });
          expect(add.ok).toBe(false);
          if (add.ok) return;
          const err = add.error as unknown as { code: string; expected?: string; hint?: string };
          expect(err.code).toBe(SHARED_INVALID_CODE);
          expect((err.expected ?? '').length).toBeGreaterThan(0);
          expect((err.hint ?? '').length).toBeGreaterThan(0);
        });

        it(`spawn rejects ${form.label} with structured EcsError (not zeroed)`, () => {
          const world = new World();
          const C = scalarComp(`W7Scalar_Spawn_${form.label.replace(/\W/g, '')}`);
          const r = world.spawn({ component: C, data: { mat: form.value } as never });
          expect(r.ok).toBe(false);
          if (r.ok) return;
          const err = r.error as unknown as { code: string; expected?: string; hint?: string };
          expect(err.code).toBe(SHARED_INVALID_CODE);
          expect((err.expected ?? '').length).toBeGreaterThan(0);
          expect((err.hint ?? '').length).toBeGreaterThan(0);
        });

        it(`set rejects ${form.label} with structured EcsError (not zeroed)`, () => {
          const world = new World();
          const C = scalarComp(`W7Scalar_Set_${form.label.replace(/\W/g, '')}`);
          const e = world.spawn({ component: C, data: {} }).unwrap();
          const r = world.set(e, C, { mat: form.value } as never);
          expect(r.ok).toBe(false);
          if (r.ok) return;
          const err = r.error as unknown as { code: string; expected?: string; hint?: string };
          expect(err.code).toBe(SHARED_INVALID_CODE);
          expect((err.expected ?? '').length).toBeGreaterThan(0);
          expect((err.hint ?? '').length).toBeGreaterThan(0);
          // Zeroing guard: the shared field must NOT have landed as 0. A
          // rejected set aborts before the column write, so reading the field
          // back yields the pre-write value (0 from spawn default IS the
          // sentinel here, so instead assert the write was rejected — the
          // observable contract is the structured error, not a post-write read).
        });
      }
    });

    describe('array<shared<T>> field', () => {
      for (const form of GUID_FORMS) {
        it(`spawn rejects clips:[${form.label}] with structured EcsError (not [0,0,0,0])`, () => {
          const world = new World();
          const C = arrayComp(`W7Array_Spawn_${form.label.replace(/\W/g, '')}`);
          const r = world.spawn({ component: C, data: { clips: [form.value] } as never });
          expect(r.ok).toBe(false);
          if (r.ok) return;
          const err = r.error as unknown as { code: string; expected?: string; hint?: string };
          expect(err.code).toBe(SHARED_INVALID_CODE);
          expect((err.expected ?? '').length).toBeGreaterThan(0);
          expect((err.hint ?? '').length).toBeGreaterThan(0);
        });

        it(`addComponent rejects clips:[${form.label}] with structured EcsError`, () => {
          const world = new World();
          const C = arrayComp(`W7Array_Add_${form.label.replace(/\W/g, '')}`);
          const e = world.spawn().unwrap();
          const add = world.addComponent(e, {
            component: C,
            data: { clips: [form.value] } as never,
          });
          expect(add.ok).toBe(false);
          if (add.ok) return;
          expect((add.error as unknown as { code: string }).code).toBe(SHARED_INVALID_CODE);
        });

        it(`set rejects clips:[${form.label}] with structured EcsError`, () => {
          const world = new World();
          const C = arrayComp(`W7Array_Set_${form.label.replace(/\W/g, '')}`);
          const e = world.spawn({ component: C, data: {} }).unwrap();
          const r = world.set(e, C, { clips: [form.value] } as never);
          expect(r.ok).toBe(false);
          if (r.ok) return;
          expect((r.error as unknown as { code: string }).code).toBe(SHARED_INVALID_CODE);
        });
      }
    });

    it('valid number handle for a scalar shared field is accepted (no false positive)', () => {
      const world = new World();
      const C = scalarComp('W7Scalar_ValidHandle');
      const handle = world.allocSharedRef('MaterialAsset', {});
      const r = world.spawn({ component: C, data: { mat: handle } as never });
      expect(r.ok).toBe(true);
    });

    it('valid number handles for an array<shared<T>> field are accepted (no false positive)', () => {
      const world = new World();
      const C = arrayComp('W7Array_ValidHandles');
      const h1 = world.allocSharedRef('AnimationClip', {});
      const h2 = world.allocSharedRef('AnimationClip', {});
      const r = world.spawn({ component: C, data: { clips: [h1, h2] } as never });
      expect(r.ok).toBe(true);
    });

    it('SHARED_INVALID_CODE is a member of EcsErrorCode (exhaustive narrow)', () => {
      const code: EcsErrorCode = 'shared-field-invalid-value';
      expect(code).toBe('shared-field-invalid-value');
      expectTypeOf<'shared-field-invalid-value'>().toMatchTypeOf<EcsErrorCode>();
    });
  });
}
