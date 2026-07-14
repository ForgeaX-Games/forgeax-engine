// @ts-nocheck — merged file: pre-existing typecheck patterns from packages/pack/test/ used implicit detail-property accesses that were not validated under tsc rootDir; preserving original behavior post-merge
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
// biome-ignore-all lint/complexity/useLiteralKeys: literal-key accesses from original source files
// biome-ignore-all lint/style/noNonNullAssertion: non-null assertions from original source files
//
// Source files (N=12):
//   - packages/pack/src/__tests__/builtin.test.ts
//   - packages/pack/src/__tests__/gltf-meta-schema.test.ts
//   - packages/pack/src/__tests__/material-asset-validator.test.ts
//   - packages/pack/src/__tests__/scanner-material-step7.test.ts
//   - packages/pack/src/__tests__/scene-schema.test.ts
//   - packages/pack/src/atlas/__tests__/shelf-pack.test.ts
//   - packages/pack/test/builtin.test.ts
//   - packages/pack/test/errors.test.ts
//   - packages/pack/test/guid.test.ts
//   - packages/pack/test/scanner-fail-fast.test.ts
//   - packages/pack/test/scanner.test.ts
//   - packages/pack/test/schema.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackErrorCode, PackErrorDetail } from '@forgeax/engine-types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AtlasImageInput, AtlasRegion } from '../atlas/shelf-pack.js';
import { shelfPack } from '../atlas/shelf-pack.js';
import {
  BUILTIN_HANDLE_CUBE,
  BUILTIN_HANDLE_TRIANGLE,
  deriveBuiltin,
  FORGEAX_NAMESPACE,
} from '../builtin.js';
import { runCliAsset } from '../cli-asset.js';
import { PackError } from '../errors.js';
import { AssetGuid } from '../guid.js';
import { scan } from '../scanner.js';
import {
  buildMaterialAssetValidator,
  buildSceneAssetValidator,
  validateMeta,
  validatePack,
} from '../schema-compiled.js';

const V1_WHITELIST = new Set([
  'f32',
  'i32',
  'u32',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'texture2d',
  'sampler',
]);

{
  // ─── from builtin.test.ts (src/__tests__) ───
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  describe('builtin.test.ts (src/__tests__)', () => {
    describe('BUILTIN_HANDLE_QUAD', () => {
      it('is exported and is a valid UUIDv5 string', async () => {
        const mod = (await import('../builtin.js')) as Record<string, unknown>;
        const quad = mod['BUILTIN_HANDLE_QUAD'];
        expect(typeof quad).toBe('string');
        expect(UUID_RE.test(quad as string)).toBe(true);
      });

      it('equals deriveBuiltin(HANDLE_QUAD) result (UUIDv5 deterministic)', async () => {
        const mod = (await import('../builtin.js')) as Record<string, unknown>;
        const quad = mod['BUILTIN_HANDLE_QUAD'] as string;
        const _deriveBuiltin = mod.deriveBuiltin as (name: string) => Promise<Uint8Array>;
        const rawUuidBytes = await _deriveBuiltin('HANDLE_QUAD');
        const AssetGuidMod = (await import('../guid.js')) as Record<string, unknown>;
        const format = (AssetGuidMod.AssetGuid as Record<string, unknown>).format as (
          guid: Uint8Array,
        ) => string;
        expect(quad).toBe(format(rawUuidBytes));
      });

      it('is distinct from BUILTIN_HANDLE_CUBE and BUILTIN_HANDLE_TRIANGLE', async () => {
        const mod = (await import('../builtin.js')) as Record<string, unknown>;
        const quad = mod['BUILTIN_HANDLE_QUAD'];
        const cube = mod['BUILTIN_HANDLE_CUBE'];
        const triangle = mod['BUILTIN_HANDLE_TRIANGLE'];
        expect(quad).not.toBe(cube);
        expect(quad).not.toBe(triangle);
        expect(cube).not.toBe(triangle);
      });
    });

    describe('BUILTIN_HANDLE_CUBE / BUILTIN_HANDLE_TRIANGLE (regression)', () => {
      it('CUBE constant is deterministic UUIDv5', async () => {
        const mod = (await import('../builtin.js')) as Record<string, unknown>;
        const cube = mod['BUILTIN_HANDLE_CUBE'] as string;
        const _deriveBuiltin = mod.deriveBuiltin as (name: string) => Promise<Uint8Array>;
        const raw = await _deriveBuiltin('HANDLE_CUBE');
        const AssetGuidMod = (await import('../guid.js')) as Record<string, unknown>;
        const format = (AssetGuidMod.AssetGuid as Record<string, unknown>).format as (
          guid: Uint8Array,
        ) => string;
        expect(cube).toBe(format(raw));
      });

      it('TRIANGLE constant is deterministic UUIDv5', async () => {
        const mod = (await import('../builtin.js')) as Record<string, unknown>;
        const triangle = mod['BUILTIN_HANDLE_TRIANGLE'] as string;
        const _deriveBuiltin = mod.deriveBuiltin as (name: string) => Promise<Uint8Array>;
        const raw = await _deriveBuiltin('HANDLE_TRIANGLE');
        const AssetGuidMod = (await import('../guid.js')) as Record<string, unknown>;
        const format = (AssetGuidMod.AssetGuid as Record<string, unknown>).format as (
          guid: Uint8Array,
        ) => string;
        expect(triangle).toBe(format(raw));
      });
    });
  });
}

{
  // ─── from gltf-meta-schema.test.ts ───

  const VALID_HELLO_GLTF_META = {
    schemaVersion: 1,
    kind: 'external-asset-package',
    importer: 'gltf',
    source: 'box.gltf',
    importSettings: {
      defaultSceneIndex: 0,
      diagnostics: {
        matrixTrsCoexistNodes: [],
        nodeNames: ['Box', 'MainCamera'],
        unsupportedExtensions: [],
      },
    },
    subAssets: [
      { guid: '019e2b88-aece-7b6e-bbfe-45d6453d21f3', kind: 'mesh', sourceIndex: 0 },
      { guid: '019e2b88-aecf-7e78-9888-655f0ec62ebc', kind: 'material', sourceIndex: 0 },
      { guid: '019e2b88-aecf-7e78-9888-6560222ee28a', kind: 'scene', sourceIndex: 0 },
    ],
  };

  describe('gltf-meta-schema.test.ts', () => {
    describe('w30 - gltf .meta.json ajv schema (AC-04)', () => {
      it('(a) accepts the hello-gltf importer-emitted box.gltf.meta.json shape verbatim', () => {
        const valid = validateMeta(VALID_HELLO_GLTF_META);
        expect(valid).toBe(true);
        expect(validateMeta.errors).toBeNull();
      });

      it('(a-string) accepts schemaVersion as the legacy semver string form (back-compat oneOf branch)', () => {
        const semverMeta = { ...VALID_HELLO_GLTF_META, schemaVersion: '1.0.0' };
        const valid = validateMeta(semverMeta);
        expect(valid).toBe(true);
      });

      it('(b) rejects subAsset typo: sourceIndx instead of sourceIndex', () => {
        const typo = {
          ...VALID_HELLO_GLTF_META,
          subAssets: [
            { guid: '019e2b88-aece-7b6e-bbfe-45d6453d21f3', kind: 'mesh', sourceIndx: 0 },
          ],
        };
        const valid = validateMeta(typo);
        expect(valid).toBe(false);
        const codes = (validateMeta.errors ?? []).map((e) => e.keyword);
        expect(codes.includes('additionalProperties') || codes.includes('required')).toBe(true);
      });

      it('(c) accepts unknown subAssets[].kind since schema is now open-string (feat-20260629 D-1)', () => {
        const unknownKind = {
          ...VALID_HELLO_GLTF_META,
          subAssets: [
            { guid: '019e2b88-aece-7b6e-bbfe-45d6453d21f3', kind: 'video', sourceIndex: 0 },
          ],
        };
        const valid = validateMeta(unknownKind);
        expect(valid).toBe(true);
      });

      it('(d) accepts the formerly-closed-enum kind values: mesh, material, scene', () => {
        for (const kind of ['mesh', 'material', 'scene'] as const) {
          const meta = {
            ...VALID_HELLO_GLTF_META,
            subAssets: [{ guid: '019e2b88-aece-7b6e-bbfe-45d6453d21f3', kind, sourceIndex: 0 }],
          };
          expect(validateMeta(meta)).toBe(true);
        }
      });

      it('(f) rejects meta missing top-level importer (feat-20260603 importer migration)', () => {
        const { importer: _drop, ...withoutImporter } = VALID_HELLO_GLTF_META;
        const valid = validateMeta(withoutImporter);
        expect(valid).toBe(false);
        const keywords = (validateMeta.errors ?? []).map((e) => e.keyword);
        expect(keywords).toContain('required');
      });

      it('(g) rejects meta with an empty importer key (minLength, replaces the old closed enum)', () => {
        const empty = { ...VALID_HELLO_GLTF_META, importer: '' };
        const valid = validateMeta(empty);
        expect(valid).toBe(false);
        const keywords = (validateMeta.errors ?? []).map((e) => e.keyword);
        expect(keywords).toContain('minLength');
      });

      it('(h) accepts any non-empty importer key (open string, was a closed enum)', () => {
        for (const at of ['image', 'gltf', 'audio', 'font', 'video'] as const) {
          const meta = { ...VALID_HELLO_GLTF_META, importer: at };
          expect(validateMeta(meta)).toBe(true);
        }
      });

      it('(e) free-form importSettings: deeply nested unknown fields stay accepted (path A)', () => {
        const exotic = {
          ...VALID_HELLO_GLTF_META,
          importSettings: {
            defaultSceneIndex: 0,
            diagnostics: {
              matrixTrsCoexistNodes: [],
              nodeNames: ['Box'],
              unsupportedExtensions: [],
            },
            compression: 'zstd',
            mipmap: true,
            animationClipFps: 30,
          },
        };
        expect(validateMeta(exotic)).toBe(true);
      });
    });
  });
}

{
  // ─── from material-asset-validator.test.ts ───

  function makePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      materialShader: 'forgeax::default-standard-pbr',
      paramSchema: [
        { name: 'baseColor', type: 'color', default: [1, 1, 1] },
        { name: 'roughness', type: 'f32', default: 0.5 },
      ],
      paramValues: { baseColor: [1, 0, 0], roughness: 0.8 },
      ...overrides,
    };
  }

  describe('material-asset-validator.test.ts', () => {
    describe('buildMaterialAssetValidator - >= 8 test cases', () => {
      const validate = buildMaterialAssetValidator(V1_WHITELIST);

      it('valid schema-driven material (all 9 type members pass)', () => {
        const v = buildMaterialAssetValidator(V1_WHITELIST);
        const payload = {
          materialShader: 'test',
          paramSchema: [
            { name: 'a', type: 'f32' },
            { name: 'b', type: 'i32' },
            { name: 'c', type: 'u32' },
            { name: 'd', type: 'vec2' },
            { name: 'e', type: 'vec3' },
            { name: 'f', type: 'vec4' },
            { name: 'g', type: 'color' },
            { name: 'h', type: 'texture2d' },
            { name: 'i', type: 'sampler' },
          ],
          paramValues: {},
        };
        const ok = v(payload);
        expect(ok).toBe(true);
      });

      it('invalid param type (boolean) is rejected', () => {
        const payload = makePayload({ paramSchema: [{ name: 'x', type: 'boolean' }] });
        const ok = validate(payload);
        expect(ok).toBe(false);
        expect(validate.errors).toBeDefined();
        expect(validate.errors?.length).toBeGreaterThan(0);
      });

      it('missing materialShader field is rejected', () => {
        const payload = { paramSchema: [{ name: 'a', type: 'f32' }], paramValues: {} };
        const ok = validate(payload);
        expect(ok).toBe(false);
        expect(validate.errors).toBeDefined();
      });

      it('empty paramSchema is accepted', () => {
        const payload = { materialShader: 'test', paramSchema: [], paramValues: {} };
        const ok = validate(payload);
        expect(ok).toBe(true);
      });

      it('paramValues with extra keys absent from paramSchema is accepted (free-form payload)', () => {
        const payload = makePayload({
          paramValues: { baseColor: [1, 0, 0], roughness: 0.8, extra: 42 },
        });
        const ok = validate(payload);
        expect(ok).toBe(true);
      });

      it('unknown top-level key is rejected (additionalProperties: false)', () => {
        const payload = { ...makePayload(), extraField: 'nope' };
        const ok = validate(payload);
        expect(ok).toBe(false);
        expect(validate.errors?.length).toBeGreaterThan(0);
      });

      it('null payload is rejected', () => {
        const ok = validate(null);
        expect(ok).toBe(false);
      });

      it('paramSchema entry missing name field is rejected', () => {
        const payload = makePayload({ paramSchema: [{ type: 'f32' }] });
        const ok = validate(payload);
        expect(ok).toBe(false);
        expect(validate.errors?.length).toBeGreaterThan(0);
      });

      it('each validator instance is independent (no shared state mutation)', () => {
        const v1 = buildMaterialAssetValidator(new Set(['f32']));
        const v2 = buildMaterialAssetValidator(new Set(['f32', 'vec3']));

        const ok1 = v1({
          materialShader: 'x',
          paramSchema: [{ name: 'a', type: 'f32' }],
          paramValues: {},
        });
        expect(ok1).toBe(true);

        const ok2 = v2({
          materialShader: 'x',
          paramSchema: [{ name: 'a', type: 'vec3' }],
          paramValues: {},
        });
        expect(ok2).toBe(true);

        const bad1 = v1({
          materialShader: 'x',
          paramSchema: [{ name: 'a', type: 'vec3' }],
          paramValues: {},
        });
        expect(bad1).toBe(false);
      });

      it('paramSchema entry missing type field is rejected', () => {
        const payload = makePayload({ paramSchema: [{ name: 'a' }] });
        const ok = validate(payload);
        expect(ok).toBe(false);
      });
    });
  });
}

{
  // ─── from scanner-material-step7.test.ts ───

  const VALID_MATERIAL_GUID = 'aa000000-0000-4000-8000-000000000001';
  const INVALID_MATERIAL_GUID = 'aa000000-0000-4000-8000-000000000002';

  function validMaterialPack(): unknown {
    return {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: VALID_MATERIAL_GUID,
          kind: 'material',
          refs: [],
          payload: {
            materialShader: 'forgeax::default-standard-pbr',
            paramSchema: [
              { name: 'baseColor', type: 'color', default: [1, 1, 1] },
              { name: 'roughness', type: 'f32', default: 0.5 },
            ],
            paramValues: { baseColor: [1, 0, 0] },
          },
        },
      ],
    };
  }

  function invalidMaterialPack(): unknown {
    return {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: INVALID_MATERIAL_GUID,
          kind: 'material',
          refs: [],
          payload: {
            materialShader: 'forgeax::default-standard-pbr',
            paramSchema: [{ name: 'x', type: 'boolean' }],
            paramValues: {},
          },
        },
      ],
    };
  }

  function nonMaterialPack(guid: string): unknown {
    return {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [{ guid, kind: 'texture', refs: [], payload: {} }],
    };
  }

  describe('scanner-material-step7.test.ts', () => {
    describe('scanner step-7 — material-payload-schema-check', () => {
      let tempDir: string;

      beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'pack-scanner-step7-'));
      });
      afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
      });

      it('(a) valid schema-driven material passes step-7', async () => {
        await writeFile(
          join(tempDir, 'valid-material.pack.json'),
          JSON.stringify(validMaterialPack()),
          'utf-8',
        );
        const result = await scan([tempDir]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const packFiles = result.value.filter((p) => p.endsWith('.pack.json'));
          expect(packFiles).toHaveLength(1);
        }
      });

      it('(b) invalid param type (boolean) fails step-7 with payload-schema-mismatch', async () => {
        await writeFile(
          join(tempDir, 'invalid-material.pack.json'),
          JSON.stringify(invalidMaterialPack()),
          'utf-8',
        );
        const result = await scan([tempDir]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('payload-schema-mismatch');
          expect(result.error.detail).toBeDefined();
          const detail = result.error.detail as { guid?: string; errors?: readonly unknown[] };
          expect(detail.guid).toBe(INVALID_MATERIAL_GUID.toLowerCase());
          expect((detail.errors ?? []).length).toBeGreaterThan(0);
        }
      });

      it('(c) mixed dir: valid material passes but invalid fails', async () => {
        await writeFile(
          join(tempDir, 'a-valid-material.pack.json'),
          JSON.stringify(validMaterialPack()),
          'utf-8',
        );
        await writeFile(
          join(tempDir, 'b-invalid-material.pack.json'),
          JSON.stringify(invalidMaterialPack()),
          'utf-8',
        );
        const result = await scan([tempDir]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('payload-schema-mismatch');
        }
      });

      it('(d) dir with no material assets passes step-7 trivially', async () => {
        await writeFile(
          join(tempDir, 'texture.pack.json'),
          JSON.stringify(nonMaterialPack('aa000000-0000-4000-8000-000000000003')),
          'utf-8',
        );
        const result = await scan([tempDir]);
        expect(result.ok).toBe(true);
      });
    });

    describe('CLI verify — material-validated count', () => {
      let tempDir: string;
      let io: { stdout: string[]; stderr: string[] };

      beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'pack-cli-step7-'));
        io = { stdout: [], stderr: [] };
      });
      afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
      });

      it('CLI verify prints material-validated: 1 for a valid material dir', async () => {
        await writeFile(
          join(tempDir, 'valid-material.pack.json'),
          JSON.stringify(validMaterialPack()),
          'utf-8',
        );
        const code = await runCliAsset(['verify'], {
          stdoutWrite: (l: string) => {
            io.stdout.push(l);
          },
          stderrWrite: (l: string) => {
            io.stderr.push(l);
          },
          cwd: tempDir,
        });
        expect(code).toBe(0);
        expect(io.stdout).toContain('material-validated: 1');
      });

      it('CLI verify prints material-validated: 0 when no material assets', async () => {
        await writeFile(
          join(tempDir, 'texture.pack.json'),
          JSON.stringify(nonMaterialPack('aa000000-0000-4000-8000-000000000003')),
          'utf-8',
        );
        const code = await runCliAsset(['verify'], {
          stdoutWrite: (l: string) => {
            io.stdout.push(l);
          },
          stderrWrite: (l: string) => {
            io.stderr.push(l);
          },
          cwd: tempDir,
        });
        expect(code).toBe(0);
        expect(io.stdout).toContain('material-validated: 0');
      });

      it('CLI verify exits 1 on invalid material payload', async () => {
        await writeFile(
          join(tempDir, 'invalid-material.pack.json'),
          JSON.stringify(invalidMaterialPack()),
          'utf-8',
        );
        const code = await runCliAsset(['verify'], {
          stdoutWrite: (l: string) => {
            io.stdout.push(l);
          },
          stderrWrite: (l: string) => {
            io.stderr.push(l);
          },
          cwd: tempDir,
        });
        expect(code).toBe(1);
        expect(io.stderr.length).toBeGreaterThan(0);
      });

      it('CLI verify counts only material assets among multiple kinds', async () => {
        await writeFile(
          join(tempDir, 'valid-material.pack.json'),
          JSON.stringify(validMaterialPack()),
          'utf-8',
        );
        await writeFile(
          join(tempDir, 'texture.pack.json'),
          JSON.stringify(nonMaterialPack('aa000000-0000-4000-8000-000000000003')),
          'utf-8',
        );
        const code = await runCliAsset(['verify'], {
          stdoutWrite: (l: string) => {
            io.stdout.push(l);
          },
          stderrWrite: (l: string) => {
            io.stderr.push(l);
          },
          cwd: tempDir,
        });
        expect(code).toBe(0);
        expect(io.stdout).toContain('material-validated: 1');
      });
    });
  });
}

{
  // ─── from scene-schema.test.ts ───

  const TRANSFORM_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      pos: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    },
  } as const;
  const MESH_FILTER_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { mesh: { type: 'string' } },
  } as const;
  const CHILD_OF_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['parent'],
    properties: { parent: { type: 'integer', minimum: 0 } },
  } as const;
  const componentSchemas: Record<string, object> = {
    Transform: TRANSFORM_SCHEMA,
    MeshFilter: MESH_FILTER_SCHEMA,
    ChildOf: CHILD_OF_SCHEMA,
  };
  const sceneValidate = buildSceneAssetValidator(componentSchemas);

  describe('scene-schema.test.ts', () => {
    describe('SceneAsset payload schema - positive cases (w4 / D-P4)', () => {
      it('accepts a valid 3-node payload (Transform + MeshFilter + ChildOf)', () => {
        const payload = {
          kind: 'scene',
          entities: [
            {
              localId: 0,
              components: {
                Transform: { pos: [1, 2, 3] },
                MeshFilter: { mesh: 'cube' },
              },
            },
            {
              localId: 1,
              components: { Transform: { pos: [0, 0, 0] }, ChildOf: { parent: 0 } },
            },
            {
              localId: 2,
              components: { Transform: { pos: [5, 5, 5] }, ChildOf: { parent: 1 } },
            },
          ],
        };
        const ok = sceneValidate(payload);
        expect(ok).toBe(true);
        expect(sceneValidate.errors ?? []).toEqual([]);
      });
    });

    describe('SceneAsset payload schema - typo field name (AC-08(b))', () => {
      it('rejects Transform with typo field `pozX`, ajv error mentions additional properties', () => {
        const payload = {
          kind: 'scene',
          entities: [
            { localId: 0, components: { Transform: { pos: [1, 2, 3] } } },
            { localId: 1, components: { Transform: { pos: [0, 0, 0] } } },
            { localId: 2, components: { Transform: { pozX: 7, pos: [0, 0, 0] } } },
          ],
        };
        const ok = sceneValidate(payload);
        expect(ok).toBe(false);
        const errors = sceneValidate.errors ?? [];
        expect(errors.length).toBeGreaterThan(0);
        const e = errors[0];
        expect(e?.instancePath ?? '').toContain('/entities/2/components/Transform');
        expect(e?.message ?? '').toContain('additional properties');
      });
    });

    describe('SceneAsset payload schema - ChildOf.parent type guard', () => {
      it('rejects ChildOf.parent that is not a non-negative integer', () => {
        const payload = {
          kind: 'scene',
          entities: [{ localId: 0, components: { ChildOf: { parent: -1 } } }],
        };
        const ok = sceneValidate(payload);
        expect(ok).toBe(false);
        const errors = sceneValidate.errors ?? [];
        expect(errors.length).toBeGreaterThan(0);
      });
    });

    describe('SceneAsset payload schema - unregistered component token', () => {
      it('rejects a SceneEntity.components key not in the registered schema map', () => {
        const payload = {
          kind: 'scene',
          entities: [{ localId: 0, components: { MysteryComponent: { foo: 1 } } }],
        };
        const ok = sceneValidate(payload);
        expect(ok).toBe(false);
        const errors = sceneValidate.errors ?? [];
        expect(errors.length).toBeGreaterThan(0);
        const e = errors[0];
        expect(e?.message ?? '').toContain('additional properties');
      });
    });
  });

  describe('mount-override-schema.test.ts', () => {
    // feat-20260713-mount-override-component-add-and-shared-ref-round M1 / w1
    // (AC-03). `mountOverrideSchema.field` is now optional so the override shape
    // carries an implicit component-granular discriminant: an override WITH
    // `field` patches one field (legacy 4-key), an override WITHOUT `field`
    // adds/upserts the whole component (new 3-key). The schema accepts both;
    // `localId` / `comp` / `value` stay required; `additionalProperties: false`
    // rejects any op-tag discriminant (OOS: no `switch (op)` fan-out downstream).
    function makeMountPayload(override: Record<string, unknown>): Record<string, unknown> {
      return {
        kind: 'scene',
        entities: [{ localId: 0, components: { Transform: { pos: [0, 0, 0] } } }],
        mounts: [
          {
            localId: 1,
            source: 0,
            memberFirst: 2,
            memberCount: 1,
            overrides: [override],
          },
        ],
      };
    }

    it('accepts the 4-key patch shape (with field)', () => {
      const ok = sceneValidate(
        makeMountPayload({ localId: 2, comp: 'Transform', field: 'pos', value: [1, 2, 3] }),
      );
      expect(ok).toBe(true);
      expect(sceneValidate.errors ?? []).toEqual([]);
    });

    it('accepts the 3-key add shape (without field)', () => {
      const ok = sceneValidate(
        makeMountPayload({ localId: 2, comp: 'Transform', value: { pos: [1, 2, 3] } }),
      );
      expect(ok).toBe(true);
      expect(sceneValidate.errors ?? []).toEqual([]);
    });

    it('rejects an override missing localId', () => {
      const ok = sceneValidate(makeMountPayload({ comp: 'Transform', value: [1, 2, 3] }));
      expect(ok).toBe(false);
      expect((sceneValidate.errors ?? []).length).toBeGreaterThan(0);
    });

    it('rejects an override missing comp', () => {
      const ok = sceneValidate(makeMountPayload({ localId: 2, value: [1, 2, 3] }));
      expect(ok).toBe(false);
      expect((sceneValidate.errors ?? []).length).toBeGreaterThan(0);
    });

    it('rejects an override missing value', () => {
      const ok = sceneValidate(makeMountPayload({ localId: 2, comp: 'Transform', field: 'pos' }));
      expect(ok).toBe(false);
      expect((sceneValidate.errors ?? []).length).toBeGreaterThan(0);
    });

    it('rejects an override carrying an op discriminant field (additionalProperties:false)', () => {
      const ok = sceneValidate(
        makeMountPayload({ localId: 2, comp: 'Transform', value: [1, 2, 3], op: 'add' }),
      );
      expect(ok).toBe(false);
      const errors = sceneValidate.errors ?? [];
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => (e?.message ?? '').includes('additional properties'))).toBe(true);
    });

    // ═════════════════════════════════════════════════════════════════════════
    // w22 — AC-03 / D-9: serialize→validate round-trip on fold-produced overrides
    //
    // The M5 collect fold emits component-add overrides (no `field`) whose value
    // is a per-field map that may carry shared<T> GUID strings (e.g. the added
    // AnimationPlayer.clips = [GUID, 0, 0, 0]). ajv's mountOverrideSchema must
    // accept that fold-produced shape, and a serialize→validate→deserialize
    // round-trip must not drop the override data. The override value is a free-
    // form object (`value: {}`) at the schema layer — runtime type checks live
    // in the ecs apply path (setSceneOverride / _validateMountOverrides).
    // ═════════════════════════════════════════════════════════════════════════

    const W22_CLIP = 'f1e2d3c4-b5a6-4b7c-8d9e-0f1a2b3c4d5e';

    it('(w22-a) accepts a fold-produced add-override with a shared-field GUID array value', () => {
      const payload = makeMountPayload({
        localId: 2,
        comp: 'Transform',
        // component-add form (no field); value carries a positional array with a
        // GUID string at slot 0 and NULL-sentinel placeholders — the exact shape
        // the fold + serialize wiring emits for AnimationPlayer.clips.
        value: { clips: [W22_CLIP, 0, 0, 0] },
      });
      const ok = sceneValidate(payload);
      expect(ok).toBe(true);
      expect(sceneValidate.errors ?? []).toEqual([]);
    });

    it('(w22-b) accepts an add-override whose value has no shared field at all', () => {
      // component-add with a plain scalar-only value map (the minimal add shape).
      const ok = sceneValidate(
        makeMountPayload({ localId: 2, comp: 'Transform', value: { pos: [9, 9, 9] } }),
      );
      expect(ok).toBe(true);
      expect(sceneValidate.errors ?? []).toEqual([]);
    });

    it('(w22-c) round-trip: JSON serialize → validate → parse preserves override data', () => {
      const override = {
        localId: 2,
        comp: 'Transform',
        value: { clips: [W22_CLIP, 0, 0, 0], pos: [1, 2, 3] },
      };
      const payload = makeMountPayload(override);

      // Simulate the on-disk pack path: JSON.stringify → fetch → JSON.parse.
      const roundTripped = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      const ok = sceneValidate(roundTripped);
      expect(ok).toBe(true);
      expect(sceneValidate.errors ?? []).toEqual([]);

      // No data lost: the override survives the round-trip byte-for-byte.
      const mounts = roundTripped.mounts as Array<Record<string, unknown>>;
      const overrides = mounts[0]?.overrides as Array<Record<string, unknown>>;
      expect(overrides).toHaveLength(1);
      expect(overrides[0]).toEqual(override);
      const value = overrides[0]?.value as Record<string, unknown>;
      expect(value.clips).toEqual([W22_CLIP, 0, 0, 0]);
      expect(value.pos).toEqual([1, 2, 3]);
    });
  });
}

{
  // ─── from shelf-pack.test.ts (src/atlas/__tests__/) ───

  function makeInput(name: string, width: number, height: number): AtlasImageInput {
    return { name, width, height, pixels: new Uint8Array(width * height * 4) };
  }

  function rectsOverlap(a: AtlasRegion, b: AtlasRegion): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  describe('shelf-pack.test.ts', () => {
    describe('shelfPack uniform input (T-25 a)', () => {
      it('packs 100 32x32 sprites into a single atlas with no overlaps', () => {
        const inputs: AtlasImageInput[] = [];
        for (let i = 0; i < 100; i++)
          inputs.push(makeInput(`s${String(i).padStart(3, '0')}`, 32, 32));
        const outcome = shelfPack(inputs, { maxAtlasSize: 4096 });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const { atlasWidth, atlasHeight, regions } = outcome.value;
        expect(regions).toHaveLength(100);
        expect(atlasWidth).toBeLessThanOrEqual(4096);
        expect(atlasHeight).toBeLessThanOrEqual(4096);
        expect(atlasWidth * atlasHeight).toBeGreaterThanOrEqual(100 * 32 * 32);
        for (const r of regions) {
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(atlasWidth);
          expect(r.y + r.h).toBeLessThanOrEqual(atlasHeight);
          expect(r.w).toBe(32);
          expect(r.h).toBe(32);
        }
        for (let i = 0; i < regions.length; i++) {
          for (let j = i + 1; j < regions.length; j++) {
            const a = regions[i] as AtlasRegion;
            const b = regions[j] as AtlasRegion;
            expect(rectsOverlap(a, b)).toBe(false);
          }
        }
        const names = new Set(regions.map((r) => r.name));
        expect(names.size).toBe(100);
      });
    });

    describe('shelfPack mixed input (T-25 b)', () => {
      it('places mixed-size sprites without rectangle overlap and within atlas footprint', () => {
        const inputs: AtlasImageInput[] = [
          makeInput('big-128', 128, 128),
          makeInput('mid-64', 64, 64),
          makeInput('mid-64-b', 64, 64),
          makeInput('small-32', 32, 32),
          makeInput('small-32-b', 32, 32),
          makeInput('tall-32x96', 32, 96),
        ];
        const outcome = shelfPack(inputs, { maxAtlasSize: 4096 });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const { atlasWidth, atlasHeight, regions } = outcome.value;
        expect(regions).toHaveLength(inputs.length);
        let totalArea = 0;
        for (const r of regions) {
          totalArea += r.w * r.h;
          expect(r.x + r.w).toBeLessThanOrEqual(atlasWidth);
          expect(r.y + r.h).toBeLessThanOrEqual(atlasHeight);
        }
        expect(totalArea).toBeLessThanOrEqual(atlasWidth * atlasHeight);
        for (let i = 0; i < regions.length; i++) {
          for (let j = i + 1; j < regions.length; j++) {
            const a = regions[i] as AtlasRegion;
            const b = regions[j] as AtlasRegion;
            expect(rectsOverlap(a, b)).toBe(false);
          }
        }
      });
    });

    describe('shelfPack empty input (T-25 c)', () => {
      it('returns atlas-empty-input sentinel when images.length === 0', () => {
        const outcome = shelfPack([], { maxAtlasSize: 4096 });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.error.code).toBe('atlas-empty-input');
        expect(outcome.error.detail.receivedCount).toBe(0);
      });
    });

    describe('shelfPack oversize input (T-25 d)', () => {
      it('returns atlas-size-exceeded sentinel when an image exceeds maxAtlasSize', () => {
        const inputs = [makeInput('giant', 5000, 5000)];
        const outcome = shelfPack(inputs, { maxAtlasSize: 4096 });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.error.code).toBe('atlas-size-exceeded');
        expect(outcome.error.detail.name).toBe('giant');
        expect(outcome.error.detail.width).toBe(5000);
        expect(outcome.error.detail.height).toBe(5000);
        expect(outcome.error.detail.maxAtlasSize).toBe(4096);
      });
    });
  });
}

{
  // ─── from builtin.test.ts (test/) ───

  describe('builtin.test.ts (test/)', () => {
    describe('FORGEAX_NAMESPACE', () => {
      it('is a valid AssetGuid', () => {
        expect(FORGEAX_NAMESPACE).toBeInstanceOf(Uint8Array);
        expect(FORGEAX_NAMESPACE.length).toBe(16);
      });

      it('is not the RFC 4122 X.500 namespace (6ba7b814-9dad-11d1-80b4-00c04fd430c8)', () => {
        const x500Result = AssetGuid.parse('6ba7b814-9dad-11d1-80b4-00c04fd430c8');
        if (!x500Result.ok) throw new Error('expected ok');
        expect(AssetGuid.equals(FORGEAX_NAMESPACE, x500Result.value)).toBe(false);
      });

      it('matches the expected forgeax namespace UUID', () => {
        const expected = AssetGuid.parse('9a09805a-7623-482e-b322-9fc3591f2a38');
        if (!expected.ok) throw new Error('expected ok');
        expect(AssetGuid.equals(FORGEAX_NAMESPACE, expected.value)).toBe(true);
      });
    });

    describe('deriveBuiltin', () => {
      it('HANDLE_CUBE derives fixed bytes (snapshot)', async () => {
        const guid = await deriveBuiltin('HANDLE_CUBE');
        expect(AssetGuid.format(guid)).toMatchInlineSnapshot(
          '"cbe42beb-8975-5096-b3a1-3dda4cb4c077"',
        );
      });

      it('HANDLE_TRIANGLE derives fixed bytes (snapshot)', async () => {
        const guid = await deriveBuiltin('HANDLE_TRIANGLE');
        expect(AssetGuid.format(guid)).toMatchInlineSnapshot(
          '"22592f07-d967-5116-b29c-fa9781929ba8"',
        );
      });

      it('same name always derives same bytes', async () => {
        const a = await deriveBuiltin('HANDLE_CUBE');
        const b = await deriveBuiltin('HANDLE_CUBE');
        expect(AssetGuid.equals(a, b)).toBe(true);
      });

      it('different names derive different GUIDs', async () => {
        const cube = await deriveBuiltin('HANDLE_CUBE');
        const tri = await deriveBuiltin('HANDLE_TRIANGLE');
        expect(AssetGuid.equals(cube, tri)).toBe(false);
      });
    });

    describe('BUILTIN_HANDLE_CUBE constant', () => {
      it("matches deriveBuiltin('HANDLE_CUBE')", async () => {
        const derived = await deriveBuiltin('HANDLE_CUBE');
        const constant = AssetGuid.parse(BUILTIN_HANDLE_CUBE);
        if (!constant.ok) throw new Error('expected ok');
        expect(AssetGuid.equals(derived, constant.value)).toBe(true);
      });
    });

    describe('BUILTIN_HANDLE_TRIANGLE constant', () => {
      it("matches deriveBuiltin('HANDLE_TRIANGLE')", async () => {
        const derived = await deriveBuiltin('HANDLE_TRIANGLE');
        const constant = AssetGuid.parse(BUILTIN_HANDLE_TRIANGLE);
        if (!constant.ok) throw new Error('expected ok');
        expect(AssetGuid.equals(derived, constant.value)).toBe(true);
      });
    });
  });
}

{
  // ─── from errors.test.ts (test/) ───

  function exhaustiveSwitchCheck(err: PackError): string {
    switch (err.code) {
      case 'pack-malformed-meta':
        return (err.detail as { path: string }).path;
      case 'pack-malformed-pack':
        return (err.detail as { path: string }).path;
      case 'pack-guid-malformed':
        return (err.detail as { raw: string }).raw;
      case 'pack-orphan-meta':
        return (err.detail as { metaPath: string }).metaPath;
      case 'pack-meta-missing':
        return (err.detail as { filePath: string }).filePath;
      case 'pack-guid-collision':
        return (err.detail as { guid: string }).guid;
      case 'pack-cyclic-reference':
        return (err.detail as { cycle: readonly string[] }).cycle[0] ?? '';
      case 'pack-subasset-index-out-of-range':
        return String((err.detail as { sourceIndex: number }).sourceIndex);
    }
  }
  void exhaustiveSwitchCheck;

  describe('errors.test.ts (test/)', () => {
    describe('PackError — 8-member closed set', () => {
      it('pack-malformed-meta: .code + .expected + .hint + detail.ajvErrors', () => {
        const detail: PackErrorDetail = {
          path: 'assets/hero.png.meta.json',
          ajvErrors: [{ instancePath: '/guid', message: 'must match format "uuid"' }],
        };
        const err = new PackError({
          code: 'pack-malformed-meta',
          expected: 'meta.json must satisfy meta.schema.json',
          hint: 'check guid is a valid RFC 4122 UUID',
          detail,
        });
        expect(err.code).toBe('pack-malformed-meta' satisfies PackErrorCode);
        expect(err.expected).toBeTruthy();
        expect(err.hint).toBeTruthy();
        if (err.code === 'pack-malformed-meta') {
          const d = err.detail as { ajvErrors: unknown[]; path: string };
          expect(d.ajvErrors).toHaveLength(1);
          expect(d.path).toBe('assets/hero.png.meta.json');
        }
      });

      it('pack-malformed-pack: .code + detail.ajvErrors', () => {
        const detail: PackErrorDetail = {
          path: 'assets/scene.pack.json',
          ajvErrors: [{ instancePath: '/assets/0/guid', message: 'must match format "uuid"' }],
        };
        const err = new PackError({
          code: 'pack-malformed-pack',
          expected: 'pack.json must satisfy pack.schema.json',
          hint: 'check all asset guid fields are valid 36-char dash-form UUIDs',
          detail,
        });
        expect(err.code).toBe('pack-malformed-pack' satisfies PackErrorCode);
        if (err.code === 'pack-malformed-pack') {
          const d = err.detail as { ajvErrors: unknown[] };
          expect(d.ajvErrors).toHaveLength(1);
        }
      });

      it('pack-guid-malformed: detail.raw + detail.reason', () => {
        const detail: PackErrorDetail = {
          raw: 'not-a-uuid',
          reason: 'expected 36-char RFC 4122 dash-form UUID',
        };
        const err = new PackError({
          code: 'pack-guid-malformed',
          expected: 'all GUID fields must be 36-char RFC 4122 dash-form UUIDs',
          hint: 'use AssetGuid.random() or a UUID v7 generator to produce valid GUIDs',
          detail,
        });
        expect(err.code).toBe('pack-guid-malformed' satisfies PackErrorCode);
        if (err.code === 'pack-guid-malformed') {
          const d = err.detail as { raw: string; reason: string };
          expect(d.raw).toBe('not-a-uuid');
          expect(d.reason).toBeTruthy();
        }
      });

      it('pack-orphan-meta: detail.metaPath + detail.expectedFile', () => {
        const detail: PackErrorDetail = {
          metaPath: 'assets/ghost.png.meta.json',
          expectedFile: 'assets/ghost.png',
        };
        const err = new PackError({
          code: 'pack-orphan-meta',
          expected: 'every .meta.json must have a corresponding source file',
          hint: 'remove orphan .meta.json or add the missing source file',
          detail,
        });
        expect(err.code).toBe('pack-orphan-meta' satisfies PackErrorCode);
        if (err.code === 'pack-orphan-meta') {
          const d = err.detail as { metaPath: string; expectedFile: string };
          expect(d.metaPath).toBe('assets/ghost.png.meta.json');
          expect(d.expectedFile).toBe('assets/ghost.png');
        }
      });

      it('pack-meta-missing: detail.filePath', () => {
        const detail: PackErrorDetail = { filePath: 'assets/hero.png' };
        const err = new PackError({
          code: 'pack-meta-missing',
          expected: 'every source file must have a corresponding .meta.json in strict mode',
          hint: 'run forgeax-engine-remote-asset scan --roots to list files without .meta.json',
          detail,
        });
        expect(err.code).toBe('pack-meta-missing' satisfies PackErrorCode);
        if (err.code === 'pack-meta-missing') {
          const d = err.detail as { filePath: string };
          expect(d.filePath).toBe('assets/hero.png');
        }
      });

      it('pack-guid-collision: detail.paths is [string, string] + detail.guid', () => {
        const detail: PackErrorDetail = {
          paths: ['assets/a.pack.json', 'assets/b.pack.json'],
          guid: '018e7a4d-1234-7abc-8def-000000000001',
        };
        const err = new PackError({
          code: 'pack-guid-collision',
          expected: 'every GUID must be unique across all .pack.json files in the scan roots',
          hint: 'run forgeax-engine-remote-asset verify to list all GUID collisions',
          detail,
        });
        expect(err.code).toBe('pack-guid-collision' satisfies PackErrorCode);
        if (err.code === 'pack-guid-collision') {
          const d = err.detail as { paths: [string, string]; guid: string };
          expect(d.paths).toHaveLength(2);
          expect(d.guid).toBe('018e7a4d-1234-7abc-8def-000000000001');
        }
      });

      it('pack-cyclic-reference: detail.cycle first === last', () => {
        const cycle = [
          '018e7a4d-1234-7abc-8def-000000000001',
          '018e7a4d-1234-7abc-8def-000000000002',
          '018e7a4d-1234-7abc-8def-000000000001',
        ] as const;
        const detail: PackErrorDetail = { cycle };
        const err = new PackError({
          code: 'pack-cyclic-reference',
          expected: 'asset reference graph must be acyclic',
          hint: 'run forgeax-engine-remote-asset verify to list the cycle path',
          detail,
        });
        expect(err.code).toBe('pack-cyclic-reference' satisfies PackErrorCode);
        if (err.code === 'pack-cyclic-reference') {
          const d = err.detail as { cycle: readonly string[] };
          expect(d.cycle.length).toBeGreaterThanOrEqual(3);
          expect(d.cycle[0]).toBe(d.cycle[d.cycle.length - 1]);
        }
      });

      it('pack-subasset-index-out-of-range: detail.metaPath + sourceIndex + max', () => {
        const detail: PackErrorDetail = {
          metaPath: 'assets/tileset.png.meta.json',
          sourceIndex: 5,
          max: 3,
        };
        const err = new PackError({
          code: 'pack-subasset-index-out-of-range',
          expected: 'subAsset.sourceIndex must be < number of sources in the source file',
          hint: 'check subAssets[].sourceIndex does not exceed the actual sub-image count',
          detail,
        });
        expect(err.code).toBe('pack-subasset-index-out-of-range' satisfies PackErrorCode);
        if (err.code === 'pack-subasset-index-out-of-range') {
          const d = err.detail as { metaPath: string; sourceIndex: number; max: number };
          expect(d.metaPath).toBe('assets/tileset.png.meta.json');
          expect(d.sourceIndex).toBe(5);
          expect(d.max).toBe(3);
        }
      });
    });
  });
}

{
  // ─── from guid.test.ts (test/) ───

  describe('guid.test.ts (test/)', () => {
    describe('AssetGuid.parse', () => {
      it('returns Ok(AssetGuid) for a valid RFC4122 dash-form UUID', () => {
        const result = AssetGuid.parse('01957b3a-1234-7abc-89de-123456789abc');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok');
        expect(result.value).toBeInstanceOf(Uint8Array);
        expect(result.value.length).toBe(16);
      });

      it('returns Err(PackError) for a non-UUID string — no throw', () => {
        const result = AssetGuid.parse('not-a-uuid');
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected error');
        expect(result.error.code).toBe('pack-guid-malformed');
        expect(result.error.detail.raw).toBe('not-a-uuid');
      });

      it('returns Err(PackError) for an empty string — no throw', () => {
        const result = AssetGuid.parse('');
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected error');
        expect(result.error.code).toBe('pack-guid-malformed');
        expect(result.error.detail.raw).toBe('');
      });

      it('returns Err(PackError) with pack-guid-malformed code and reason', () => {
        const result = AssetGuid.parse('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz');
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected error');
        expect(result.error.code).toBe('pack-guid-malformed');
        expect(typeof result.error.detail.reason).toBe('string');
      });
    });

    describe('AssetGuid.format', () => {
      it('returns 36-char dash-form string', () => {
        const result = AssetGuid.parse('01957b3a-1234-7abc-89de-123456789abc');
        if (!result.ok) throw new Error('expected ok');
        const formatted = AssetGuid.format(result.value);
        expect(formatted).toHaveLength(36);
        expect(formatted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      });

      it('round-trips through parse and format', () => {
        const original = '01957b3a-1234-7abc-89de-123456789abc';
        const result = AssetGuid.parse(original);
        if (!result.ok) throw new Error('expected ok');
        expect(AssetGuid.format(result.value)).toBe(original);
      });
    });

    describe('AssetGuid.equals', () => {
      it('returns true for two GUIDs parsed from same string', () => {
        const a = AssetGuid.parse('01957b3a-1234-7abc-89de-123456789abc');
        const b = AssetGuid.parse('01957b3a-1234-7abc-89de-123456789abc');
        if (!a.ok || !b.ok) throw new Error('expected ok');
        expect(AssetGuid.equals(a.value, b.value)).toBe(true);
      });

      it('returns false for two different GUIDs', () => {
        const a = AssetGuid.parse('01957b3a-1234-7abc-89de-123456789abc');
        const b = AssetGuid.parse('aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee');
        if (!a.ok || !b.ok) throw new Error('expected ok');
        expect(AssetGuid.equals(a.value, b.value)).toBe(false);
      });
    });

    describe('AssetGuid.random', () => {
      it('generates a UUIDv7 (version bits 4 = 0x7)', () => {
        const guid = AssetGuid.random();
        expect(guid.length).toBe(16);
        const byte6 = guid[6];
        expect(byte6! >> 4).toBe(7);
      });

      it('generates a UUIDv7 (variant bits = 0b10xx)', () => {
        const guid = AssetGuid.random();
        const byte8 = guid[8];
        expect((byte8! >> 6) & 0b11).toBe(0b10);
      });

      it('generates distinct values', () => {
        const a = AssetGuid.random();
        const b = AssetGuid.random();
        expect(AssetGuid.equals(a, b)).toBe(false);
      });
    });
  });
}

{
  // ─── from scanner-fail-fast.test.ts (test/) ───

  const GUID_A = '018e7a4d-1234-7abc-8def-000000000001';
  const GUID_B = '018e7a4d-1234-7abc-8def-000000000002';

  function makePackJson(guid: string, refs: string[] = []) {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [{ guid, kind: 'MeshAsset', payload: {}, refs }],
    });
  }

  function makeMetaJson(source: string, subAssets: unknown[] = []) {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source,
      importSettings: {},
      subAssets,
    });
  }

  describe('scanner-fail-fast.test.ts', () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = join(tmpdir(), `forgeax-scanner-fail-fast-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
    });
    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    describe('scanner fail-fast chain', () => {
      it('(1) pack-guid-collision: two .pack.json with same GUID -> detail.paths + detail.guid', async () => {
        const dir = join(tmpDir, 'collision');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'a.pack.json'), makePackJson(GUID_A));
        await writeFile(join(dir, 'b.pack.json'), makePackJson(GUID_A));

        const result = await scan([dir]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('pack-guid-collision');
          if (result.error.code === 'pack-guid-collision') {
            expect(result.error.detail.paths).toHaveLength(2);
            expect(result.error.detail.guid).toBe(GUID_A);
            const pathSet = new Set(result.error.detail.paths);
            expect(pathSet.has(join(dir, 'a.pack.json'))).toBe(true);
            expect(pathSet.has(join(dir, 'b.pack.json'))).toBe(true);
          }
        }
      });

      it('(2) pack-cyclic-reference: A refs B, B refs A -> detail.cycle first === last', async () => {
        const dir = join(tmpDir, 'cycle');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'a.pack.json'), makePackJson(GUID_A, [GUID_B]));
        await writeFile(join(dir, 'b.pack.json'), makePackJson(GUID_B, [GUID_A]));

        const result = await scan([dir]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('pack-cyclic-reference');
          if (result.error.code === 'pack-cyclic-reference') {
            const cycle = result.error.detail.cycle;
            expect(cycle.length).toBeGreaterThanOrEqual(3);
            expect(cycle[0]).toBe(cycle[cycle.length - 1]);
          }
        }
      });

      it('(3) orphan .meta.json (no source file) -> pack-orphan-meta; missing .meta.json for existing file is ignored (INFO only)', async () => {
        const dir = join(tmpDir, 'orphan');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'hero.png'), Buffer.from('fake png'));
        await writeFile(join(dir, 'ghost.png.meta.json'), makeMetaJson('ghost.png'));

        const result = await scan([dir]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('pack-orphan-meta');
          if (result.error.code === 'pack-orphan-meta') {
            expect(result.error.detail.metaPath).toContain('ghost.png.meta.json');
            expect(result.error.detail.expectedFile).toContain('ghost.png');
          }
        }
      });

      it('(4) pack-malformed-meta: .meta.json missing required guid field -> detail.ajvErrors array', async () => {
        const dir = join(tmpDir, 'malformed');
        await mkdir(dir, { recursive: true });
        const badMeta = JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: 'hero.png',
          importSettings: {},
          subAssets: [{ sourceIndex: 0, kind: 'TextureAsset' }],
        });
        await writeFile(join(dir, 'hero.png.meta.json'), badMeta);

        const result = await scan([dir]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('pack-malformed-meta');
          if (result.error.code === 'pack-malformed-meta') {
            expect(result.error.detail.ajvErrors.length).toBeGreaterThan(0);
            expect(result.error.detail.path).toContain('hero.png.meta.json');
          }
        }
      });
    });
  });
}

{
  // ─── from scanner.test.ts (test/) ───

  async function scanPaths(roots: string[]): Promise<string[]> {
    const result = await scan(roots);
    if (!result.ok) throw new Error(`scan failed unexpectedly: ${result.error.code}`);
    return result.value;
  }

  describe('scanner.test.ts', () => {
    let sTmpDir: string | undefined;

    afterEach(async () => {
      if (sTmpDir !== undefined) {
        await rm(sTmpDir, { recursive: true, force: true });
        sTmpDir = undefined;
      }
    });

    async function setupTmpDir(): Promise<string> {
      sTmpDir = await mkdtemp(join(tmpdir(), 'engine-pack-scanner-test-'));
      return sTmpDir;
    }

    describe('scan - empty directory', () => {
      it('returns empty array for an empty directory', async () => {
        const root = await setupTmpDir();
        const results = await scanPaths([root]);
        expect(results).toEqual([]);
      });
    });

    describe('scan - basic traversal', () => {
      it('discovers .meta.json files', async () => {
        const root = await setupTmpDir();
        await writeFile(
          join(root, 'hero.png.meta.json'),
          JSON.stringify({
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'image',
            source: 'hero.png',
            importSettings: {},
            subAssets: [],
          }),
        );
        await writeFile(join(root, 'hero.png'), Buffer.from('fake png'));
        const results = await scanPaths([root]);
        expect(results.some((p) => p.endsWith('.meta.json'))).toBe(true);
      });

      it('discovers .pack.json files', async () => {
        const root = await setupTmpDir();
        await writeFile(
          join(root, 'assets.pack.json'),
          JSON.stringify({ schemaVersion: '1.0.0', kind: 'internal-text-package', assets: [] }),
        );
        const results = await scanPaths([root]);
        expect(results.some((p) => p.endsWith('.pack.json'))).toBe(true);
      });

      it('discovers both meta and pack in subdirectories', async () => {
        const root = await setupTmpDir();
        const sub = join(root, 'subdir');
        await mkdir(sub);
        await writeFile(
          join(sub, 'foo.png.meta.json'),
          JSON.stringify({
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'image',
            source: 'foo.png',
            importSettings: {},
            subAssets: [],
          }),
        );
        await writeFile(join(sub, 'foo.png'), Buffer.from('fake png'));
        await writeFile(
          join(sub, 'bar.pack.json'),
          JSON.stringify({ schemaVersion: '1.0.0', kind: 'internal-text-package', assets: [] }),
        );
        const results = await scanPaths([root]);
        expect(results.filter((p) => p.endsWith('.meta.json'))).toHaveLength(1);
        expect(results.filter((p) => p.endsWith('.pack.json'))).toHaveLength(1);
      });
    });

    describe('scan - blacklist directories', () => {
      it('skips node_modules directory', async () => {
        const root = await setupTmpDir();
        const nm = join(root, 'node_modules');
        await mkdir(nm);
        await writeFile(join(nm, 'lib.meta.json'), JSON.stringify({ test: true }));
        const results = await scanPaths([root]);
        expect(results).toEqual([]);
      });

      it('skips .git directory', async () => {
        const root = await setupTmpDir();
        const git = join(root, '.git');
        await mkdir(git);
        await writeFile(join(git, 'hooks.meta.json'), JSON.stringify({ test: true }));
        const results = await scanPaths([root]);
        expect(results).toEqual([]);
      });

      it('skips dist directory', async () => {
        const root = await setupTmpDir();
        const dist = join(root, 'dist');
        await mkdir(dist);
        await writeFile(join(dist, 'bundle.pack.json'), JSON.stringify({ test: true }));
        const results = await scanPaths([root]);
        expect(results).toEqual([]);
      });

      it('skips .forgeax-harness directory', async () => {
        const root = await setupTmpDir();
        const kh = join(root, '.forgeax-harness');
        await mkdir(kh);
        await writeFile(join(kh, 'state.meta.json'), JSON.stringify({ test: true }));
        const results = await scanPaths([root]);
        expect(results).toEqual([]);
      });
    });

    describe('scan - whitelist override', () => {
      it('scans a blacklisted directory when given as explicit root', async () => {
        const root = await setupTmpDir();
        const nm = join(root, 'node_modules');
        await mkdir(nm);
        await writeFile(
          join(nm, 'lib.png.meta.json'),
          JSON.stringify({
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'image',
            source: 'lib.png',
            importSettings: {},
            subAssets: [],
          }),
        );
        await writeFile(join(nm, 'lib.png'), Buffer.from('fake png'));
        const results = await scanPaths([nm]);
        expect(results.some((p) => p.endsWith('.meta.json'))).toBe(true);
      });
    });

    describe('verify - importer:shader paramSchema validation', () => {
      it('accepts valid shader sidecar with paramSchema', async () => {
        const root = await setupTmpDir();
        await writeFile(join(root, 'test.wgsl'), Buffer.from('// shader'));
        await writeFile(
          join(root, 'test.wgsl.meta.json'),
          JSON.stringify({
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'shader',
            source: 'test.wgsl',
            importSettings: { materialShaderIdentifier: 'test::shader' },
            subAssets: [
              {
                guid: '00000000-0000-4000-a000-000000000001',
                sourceIndex: 0,
                kind: 'material-shader',
              },
            ],
            paramSchema: [
              { name: 'color', type: 'color' },
              { name: 'intensity', type: 'f32' },
            ],
          }),
        );
        const stdoutParts: string[] = [];
        const stderrParts: string[] = [];
        const exitCode = await runCliAsset(['verify'], {
          stdoutWrite: (l: string) => {
            stdoutParts.push(l);
          },
          stderrWrite: (l: string) => {
            stderrParts.push(l);
          },
          cwd: root,
        });
        expect(exitCode).toBe(0);
        expect(stderrParts).toEqual([]);
        expect(stdoutParts.some((l) => l.includes('shader-validated'))).toBe(true);
      });

      it('rejects shader sidecar with missing paramSchema', async () => {
        const root = await setupTmpDir();
        await writeFile(join(root, 'test.wgsl'), Buffer.from('// shader'));
        await writeFile(
          join(root, 'test.wgsl.meta.json'),
          JSON.stringify({
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'shader',
            source: 'test.wgsl',
            importSettings: { materialShaderIdentifier: 'test::shader' },
            subAssets: [
              {
                guid: '00000000-0000-4000-a000-000000000002',
                sourceIndex: 0,
                kind: 'material-shader',
              },
            ],
          }),
        );
        const stderrParts: string[] = [];
        const exitCode = await runCliAsset(['verify'], {
          stdoutWrite: () => {},
          stderrWrite: (l: string) => {
            stderrParts.push(l);
          },
          cwd: root,
        });
        expect(exitCode).toBe(1);
        expect(stderrParts.length).toBe(1);
        const err = JSON.parse(stderrParts[0]!);
        expect(err.code).toBe('pack-malformed-meta');
      });

      it('rejects shader sidecar with invalid paramSchema type', async () => {
        const root = await setupTmpDir();
        await writeFile(join(root, 'test.wgsl'), Buffer.from('// shader'));
        await writeFile(
          join(root, 'test.wgsl.meta.json'),
          JSON.stringify({
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'shader',
            source: 'test.wgsl',
            importSettings: { materialShaderIdentifier: 'test::shader' },
            subAssets: [
              {
                guid: '00000000-0000-4000-a000-000000000003',
                sourceIndex: 0,
                kind: 'material-shader',
              },
            ],
            paramSchema: [{ name: 'color', type: 'float4' }],
          }),
        );
        const stderrParts: string[] = [];
        const exitCode = await runCliAsset(['verify'], {
          stdoutWrite: () => {},
          stderrWrite: (l: string) => {
            stderrParts.push(l);
          },
          cwd: root,
        });
        expect(exitCode).toBe(1);
        expect(stderrParts.length).toBe(1);
        const err = JSON.parse(stderrParts[0]!);
        expect(err.code).toBe('pack-malformed-meta');
      });

      it('rejects shader sidecar with paramSchema entry missing name', async () => {
        const root = await setupTmpDir();
        await writeFile(join(root, 'test.wgsl'), Buffer.from('// shader'));
        await writeFile(
          join(root, 'test.wgsl.meta.json'),
          JSON.stringify({
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'shader',
            source: 'test.wgsl',
            importSettings: { materialShaderIdentifier: 'test::shader' },
            subAssets: [
              {
                guid: '00000000-0000-4000-a000-000000000004',
                sourceIndex: 0,
                kind: 'material-shader',
              },
            ],
            paramSchema: [{ type: 'color' }],
          }),
        );
        const stderrParts: string[] = [];
        const exitCode = await runCliAsset(['verify'], {
          stdoutWrite: () => {},
          stderrWrite: (l: string) => {
            stderrParts.push(l);
          },
          cwd: root,
        });
        expect(exitCode).toBe(1);
        expect(stderrParts.length).toBe(1);
        const err = JSON.parse(stderrParts[0]!);
        expect(err.code).toBe('pack-malformed-meta');
      });

      it('rejects shader sidecar with empty paramSchema array', async () => {
        const root = await setupTmpDir();
        await writeFile(join(root, 'test.wgsl'), Buffer.from('// shader'));
        await writeFile(
          join(root, 'test.wgsl.meta.json'),
          JSON.stringify({
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'shader',
            source: 'test.wgsl',
            importSettings: { materialShaderIdentifier: 'test::shader' },
            subAssets: [
              {
                guid: '00000000-0000-4000-a000-000000000005',
                sourceIndex: 0,
                kind: 'material-shader',
              },
            ],
            paramSchema: [],
          }),
        );
        const stderrParts: string[] = [];
        const exitCode = await runCliAsset(['verify'], {
          stdoutWrite: () => {},
          stderrWrite: (l: string) => {
            stderrParts.push(l);
          },
          cwd: root,
        });
        expect(exitCode).toBe(1);
        expect(stderrParts.length).toBe(1);
        const err = JSON.parse(stderrParts[0]!);
        expect(err.code).toBe('pack-malformed-meta');
      });
    });
  });
}

{
  // ─── from schema.test.ts (test/) ───

  const validMeta1 = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'hero.png',
    importSettings: { compression: 'zstd', mipmap: true },
    subAssets: [{ guid: '01957b3a-1234-7abc-89de-123456789abc', sourceIndex: 0, kind: 'mesh' }],
  };
  const validMeta2 = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'mesh.glb',
    importSettings: {},
    subAssets: [],
  };
  const validMeta3 = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'audio/bg.ogg',
    importSettings: { format: 'opus' },
    subAssets: [
      { guid: 'a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6', sourceIndex: 0, kind: 'material' },
      { guid: 'b2c3d4e5-f6a7-7b8c-9d0e-f1a2b3c4d5e6', sourceIndex: 0, kind: 'scene' },
    ],
  };
  const validPack1 = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: '01957b3a-1234-7abc-89de-123456789abc',
        kind: 'MaterialAsset',
        payload: { albedo: [1, 0, 0, 1] },
        refs: ['a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6'],
      },
    ],
  };
  const validPack2 = { schemaVersion: '1.0.0', kind: 'internal-text-package', assets: [] };
  const validPack3 = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
        kind: 'MeshAsset',
        payload: { vertexCount: 24 },
        refs: [],
      },
      {
        guid: '11111111-2222-7333-8444-555555555555',
        kind: 'ScriptAsset',
        payload: {},
        refs: ['aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', '01957b3a-1234-7abc-89de-123456789abc'],
      },
    ],
  };

  const invalidMeta_missingGuid = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'hero.png',
    importSettings: {},
    subAssets: [{ sourceIndex: 0, kind: 'mesh' }],
  };
  const invalidMeta_badGuid = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'hero.png',
    importSettings: {},
    subAssets: [{ guid: 'not-a-valid-uuid', sourceIndex: 0, kind: 'mesh' }],
  };
  const invalidMeta_badSourceIndex = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'hero.png',
    importSettings: {},
    subAssets: [
      { guid: '01957b3a-1234-7abc-89de-123456789abc', sourceIndex: 'zero', kind: 'mesh' },
    ],
  };
  const invalidPack_builtinSentinelInRefs = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: '01957b3a-1234-7abc-89de-123456789abc',
        kind: 'MaterialAsset',
        payload: {},
        refs: ['@builtin/HANDLE_CUBE'],
      },
    ],
  };
  const invalidPack_badGuid = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxxxxxxxx',
        kind: 'MeshAsset',
        payload: {},
        refs: [],
      },
    ],
  };
  const invalidPack_missingAssets = { schemaVersion: '1.0.0', kind: 'internal-text-package' };

  describe('schema.test.ts', () => {
    describe('schema validation - meta.json', () => {
      it('accepts valid meta (hero.png with subAssets)', () => {
        expect(validateMeta(validMeta1)).toBe(true);
      });
      it('accepts valid meta with empty subAssets', () => {
        expect(validateMeta(validMeta2)).toBe(true);
      });
      it('accepts valid meta with multiple subAssets', () => {
        expect(validateMeta(validMeta3)).toBe(true);
      });
      it('rejects meta with missing guid in subAssets', () => {
        expect(validateMeta(invalidMeta_missingGuid)).toBe(false);
      });
      it('rejects meta with non-RFC4122 guid format', () => {
        expect(validateMeta(invalidMeta_badGuid)).toBe(false);
      });
      it('rejects meta with sourceIndex as string', () => {
        expect(validateMeta(invalidMeta_badSourceIndex)).toBe(false);
      });
    });

    describe('schema validation - pack.json', () => {
      it('accepts valid pack with one asset and refs', () => {
        expect(validatePack(validPack1)).toBe(true);
      });
      it('accepts valid pack with empty assets', () => {
        expect(validatePack(validPack2)).toBe(true);
      });
      it('accepts valid pack with multiple assets', () => {
        expect(validatePack(validPack3)).toBe(true);
      });
      it('rejects pack with @builtin/ sentinel in refs (AC-11)', () => {
        expect(validatePack(invalidPack_builtinSentinelInRefs)).toBe(false);
      });
      it('rejects pack with invalid guid format in assets', () => {
        expect(validatePack(invalidPack_badGuid)).toBe(false);
      });
      it('rejects pack missing required assets field', () => {
        expect(validatePack(invalidPack_missingAssets)).toBe(false);
      });
    });
  });
}

{
  // ─── AC-17:+AC-5+AC-10 scanner orphan with resolveAssetSource (w14+w15) ───

  interface TestMeta {
    schemaVersion: string;
    kind: string;
    importer: string;
    source?: string;
    importSettings: Record<string, unknown>;
    subAssets: { guid: string; sourceIndex: number; kind: string }[];
  }

  function makeMeta(overrides: Partial<TestMeta> = {}): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'test.png',
      importSettings: {},
      subAssets: [
        { guid: 'aaaaaaaa-bbbb-4000-8000-000000000001', sourceIndex: 0, kind: 'texture' },
      ],
      ...overrides,
    });
  }

  describe('w14-scanner-orphan-optional.test.ts — AC-17 falsification', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'forgeax-ac17-'));
    });
    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('AC-17: omitted source + no companion file → pack-orphan-meta with derived expectedFile', async () => {
      const metaContent = makeMeta({ source: undefined });
      await writeFile(join(tmpDir, 'ghost.png.meta.json'), metaContent);
      // Do NOT create ghost.png — omitted source derives to ghost.png, which is missing

      const result = await scan([tmpDir]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('pack-orphan-meta');
        if (result.error.code === 'pack-orphan-meta') {
          expect(result.error.detail.metaPath).toContain('ghost.png.meta.json');
          expect(result.error.detail.expectedFile).toContain('ghost.png');
          expect(result.error.detail.expectedFile.endsWith('ghost.png')).toBe(true);
        }
      }
    });

    it('AC-17: omitted source + companion file exists → scan passes (derivation succeeds)', async () => {
      const metaContent = makeMeta({ source: undefined });
      await writeFile(join(tmpDir, 'test.png.meta.json'), metaContent);
      await writeFile(join(tmpDir, 'test.png'), Buffer.from('fake png'));

      const result = await scan([tmpDir]);
      expect(result.ok).toBe(true);
    });

    it('AC-17: explicit source=hero.png + companion file → scan passes (backward compat)', async () => {
      await writeFile(join(tmpDir, 'hero.png.meta.json'), makeMeta({ source: 'hero.png' }));
      await writeFile(join(tmpDir, 'hero.png'), Buffer.from('fake png'));

      const result = await scan([tmpDir]);
      expect(result.ok).toBe(true);
    });
  });

  describe('w15-scanner-path-integration.test.ts — AC-5+AC-10', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'forgeax-ac5-'));
    });
    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('AC-5: @name/ path resolves correctly when file exists', async () => {
      const libDir = join(tmpDir, 'lib');
      await mkdir(libDir);
      await writeFile(join(libDir, 'shared.png'), Buffer.from('fake png'));
      const metaContent = JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'image',
        source: '@shared/shared.png',
        importSettings: {},
        subAssets: [
          { guid: 'aaaaaaaa-bbbb-4000-8000-000000000001', sourceIndex: 0, kind: 'texture' },
        ],
      });
      await writeFile(join(tmpDir, 'ref.meta.json'), metaContent);

      // The scan runs inside its own process.cwd() — paths table resolution uses cwd
      // The tmpDir is not the cwd, so @shared/ will report pack-unknown-path.
      // AC-5: we need the path table to be configured at the scan's cwd.
      // For a unit test, we verify instead via resolveAssetSource directly:
      const { resolveAssetSource: resolveAS } = await import('../resolve-asset-source.js');
      const paths = { shared: libDir };
      const result = resolveAS(join(tmpDir, 'ref.meta.json'), '@shared/shared.png', paths);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(join(libDir, 'shared.png'));
      }
    });

    it('AC-10: path configured but file missing → pack-orphan-meta', async () => {
      const libDir = join(tmpDir, 'lib');
      await mkdir(libDir);
      // Do NOT create missing.png in libDir
      const metaContent = JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'image',
        source: '@shared/missing.png',
        importSettings: {},
        subAssets: [
          { guid: 'aaaaaaaa-bbbb-4000-8000-000000000001', sourceIndex: 0, kind: 'texture' },
        ],
      });
      await writeFile(join(tmpDir, 'ref.meta.json'), metaContent);

      // resolveAssetSource resolves the path but does not stat — the resolved path will be returned ok
      const { resolveAssetSource: resolveAS } = await import('../resolve-asset-source.js');
      const paths = { shared: libDir };
      const result = resolveAS(join(tmpDir, 'ref.meta.json'), '@shared/missing.png', paths);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(join(libDir, 'missing.png'));
        // The actual orphan check (stat) is done by the scanner caller
      }
    });

    it('AC-10: scanner reports pack-orphan-meta when resolved path file does not exist', async () => {
      const metaContent = makeMeta({ source: 'nowhere.png' });
      await writeFile(join(tmpDir, 'orphan.meta.json'), metaContent);
      // Do NOT create nowhere.png

      const result = await scan([tmpDir]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('pack-orphan-meta');
        if (result.error.code === 'pack-orphan-meta') {
          expect(result.error.detail.expectedFile).toContain('nowhere.png');
        }
      }
    });
  });

  describe('scanner @name/ end-to-end via cwd package.json — AC-5/AC-8', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpDir = await mkdtemp(join(tmpdir(), 'forgeax-ac5e2e-'));
      process.chdir(tmpDir);
    });
    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('AC-5: scan() passes orphan check for @name/ meta when cwd package.json path table resolves to an existing file', async () => {
      const sharedDir = join(tmpDir, 'shared-lib', 'assets');
      await mkdir(sharedDir, { recursive: true });
      await writeFile(join(sharedDir, 'cross.png'), Buffer.from('fake png'));
      await writeFile(
        join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'ac5-e2e-tmp',
          forgeax: { assets: { paths: { shared: 'shared-lib/assets' } } },
        }),
      );
      const scanRoot = join(tmpDir, 'metas');
      await mkdir(scanRoot, { recursive: true });
      await writeFile(
        join(scanRoot, 'cross.png.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: '@shared/cross.png',
          importSettings: {},
          subAssets: [
            { guid: 'aaaaaaaa-bbbb-4000-8000-000000000001', sourceIndex: 0, kind: 'texture' },
          ],
        }),
      );

      const result = await scan([scanRoot]);
      expect(result.ok).toBe(true);
    });

    it('AC-8: scan() reports pack-unknown-path when @name/ references an undeclared path name', async () => {
      await writeFile(
        join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'ac8-e2e-tmp', forgeax: { assets: { paths: {} } } }),
      );
      const scanRoot = join(tmpDir, 'metas');
      await mkdir(scanRoot, { recursive: true });
      await writeFile(
        join(scanRoot, 'x.png.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: '@nope/x.png',
          importSettings: {},
          subAssets: [
            { guid: 'aaaaaaaa-bbbb-4000-8000-000000000001', sourceIndex: 0, kind: 'texture' },
          ],
        }),
      );

      const result = await scan([scanRoot]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('pack-unknown-path');
      }
    });
  });
}

{
  // ─── AC-1 regression w15 — resolveAssetSource explicit source backwards compat ───

  describe('w15-AC-1-regression.test.ts', () => {
    it('AC-1: explicit source=foo.png with resolveAssetSource == resolve(metaDir, foo.png)', async () => {
      const { resolveAssetSource: resolveAS } = await import('../resolve-asset-source.js');
      const { resolve } = await import('node:path');
      const metaPath = '/home/you/assets/foo.png.meta.json';
      const result = resolveAS(metaPath, 'foo.png', {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(resolve('/home/you/assets', 'foo.png'));
      }
    });

    it('AC-1: explicit source=sub/deep.png with resolveAssetSource == resolve(metaDir, sub/deep.png)', async () => {
      const { resolveAssetSource: resolveAS } = await import('../resolve-asset-source.js');
      const { resolve } = await import('node:path');
      const metaPath = '/home/you/assets/main.meta.json';
      const result = resolveAS(metaPath, 'sub/deep.png', {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(resolve('/home/you/assets', 'sub/deep.png'));
      }
    });

    it('AC-1: omitted source derives from meta filename', async () => {
      const { resolveAssetSource: resolveAS } = await import('../resolve-asset-source.js');
      const { resolve } = await import('node:path');
      const metaPath = '/home/you/assets/foo.png.meta.json';
      const result = resolveAS(metaPath, undefined, {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(resolve('/home/you/assets', 'foo.png'));
      }
    });
  });

  // ─── AC-5/AC-10 source path table scanner integration (w15) ───

  describe('w15-AC-5-AC-10-path-table.test.ts', () => {
    it('AC-5: @shared/ resource resolves correctly when path table configured', async () => {
      const { resolveAssetSource: resolveAS } = await import('../resolve-asset-source.js');
      const { resolve } = await import('node:path');
      const metaPath = '/project/assets/ref.meta.json';
      const paths = { shared: '/project/lib' };
      const result = resolveAS(metaPath, '@shared/tex.png', paths);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(resolve('/project/lib', 'tex.png'));
      }
    });

    it('AC-5: @shared/ with nested rest path', async () => {
      const { resolveAssetSource: resolveAS } = await import('../resolve-asset-source.js');
      const { resolve } = await import('node:path');
      const metaPath = '/project/assets/ref.meta.json';
      const paths = { shared: '/project/lib' };
      const result = resolveAS(metaPath, '@shared/sub/dir/tex.png', paths);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(resolve('/project/lib', 'sub/dir/tex.png'));
      }
    });

    it('AC-10: @unknown/ path name → pack-unknown-path error', async () => {
      const { resolveAssetSource: resolveAS } = await import('../resolve-asset-source.js');
      const metaPath = '/project/assets/ref.meta.json';
      const result = resolveAS(metaPath, '@nope/tex.png', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('pack-unknown-path');
        if (result.error.code === 'pack-unknown-path') {
          expect(result.error.detail.pathName).toBe('nope');
          expect(result.error.detail.knownNames).toEqual([]);
        }
      }
    });
  });
}
