// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=5):
//   - packages/naga/src/__tests__/compose.test.ts
//   - packages/naga/src/__tests__/emit_reflection.test.ts
//   - packages/naga/src/__tests__/errors.test.ts
//   - packages/naga/src/__tests__/parse.test.ts
//   - packages/naga/src/__tests__/validate.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Naga packages share a common vi.mock('@forgeax/engine-wgpu-wasm') pattern.
// Merged into one unified mock that provides all needed functions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileFailed } from '../errors.js';

const _parse = vi.fn();
const _validate = vi.fn();
const _emit_reflection = vi.fn();
const _compose = vi.fn();

vi.mock('@forgeax/engine-wgpu-wasm', () => ({
  ensureReady: vi.fn(async () => ({
    parse: _parse,
    validate: _validate,
    emit_reflection: _emit_reflection,
    compose_shader: _compose,
  })),
}));

{
  // ─── from compose.test.ts ───

  describe('compose.test.ts', () => {
    describe('@forgeax/engine-naga composeShader wrapper', () => {
      beforeEach(() => {
        _compose.mockReset();
        _parse.mockReset();
        _validate.mockReset();
        _emit_reflection.mockReset();
        vi.resetModules();
      });

      afterEach(() => {
        vi.clearAllMocks();
      });

      it('forwards entry + JSON-stringified imports + defines to wasm compose_shader and returns the composed WGSL string (basic #import happy path)', async () => {
        const entry = [
          '#import forgeax_pbr::brdf',
          '@vertex fn vs() -> @builtin(position) vec4<f32> { return brdf::sample(); }',
        ].join('\n');
        const imports = {
          'forgeax_pbr::brdf': [
            '#define_import_path forgeax_pbr::brdf',
            'fn sample() -> vec4<f32> { return vec4<f32>(0.0); }',
          ].join('\n'),
        };
        const defines = { FOO: true };
        const composed = '// composed wgsl\nfn sample() -> vec4<f32> { return vec4<f32>(0.0); }';
        _compose.mockReturnValueOnce(composed);

        const { composeShader } = await import('../index.js');
        const out = await composeShader(entry, imports, defines);

        expect(out).toBe(composed);
        expect(_compose).toHaveBeenCalledTimes(1);
        const call = _compose.mock.calls[0];
        if (!call) throw new Error('compose_shader mock was not called');
        const [forwardedEntry, forwardedImportsJson, forwardedDefinesJson] = call;
        expect(forwardedEntry).toBe(entry);
        expect(JSON.parse(forwardedImportsJson)).toEqual(imports);
        expect(JSON.parse(forwardedDefinesJson)).toEqual(defines);
      });

      it('propagates shader-import-not-found: prefix error from wasm compose_shader JsError', async () => {
        const entry =
          '#import forgeax_missing::mod\n@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }';
        _compose.mockImplementationOnce(() => {
          throw new Error('shader-import-not-found: module forgeax_missing::mod not registered');
        });

        const { composeShader } = await import('../index.js');
        await expect(composeShader(entry, {}, {})).rejects.toThrow(/shader-import-not-found:/);
      });

      it('passes #ifdef defines through to wasm so the upstream composer can eliminate branches (define=true branch retained; define=false branch dropped)', async () => {
        const entry = [
          '#ifdef WANT_FOO',
          'fn foo() -> f32 { return 1.0; }',
          '#endif',
          '#ifdef WANT_BAR',
          'fn bar() -> f32 { return 2.0; }',
          '#endif',
        ].join('\n');

        const composed = 'fn foo() -> f32 { return 1.0; }';
        _compose.mockReturnValueOnce(composed);

        const { composeShader } = await import('../index.js');
        const out = await composeShader(entry, {}, { WANT_FOO: true, WANT_BAR: false });

        expect(out).toBe(composed);
        const call = _compose.mock.calls[0];
        if (!call) throw new Error('compose_shader mock was not called');
        const [, , forwardedDefinesJson] = call;
        expect(JSON.parse(forwardedDefinesJson)).toEqual({ WANT_FOO: true, WANT_BAR: false });
      });
    });
  });
}

{
  // ─── from emit_reflection.test.ts ───

  describe('emit_reflection.test.ts', () => {
    describe('@forgeax/engine-naga emit_reflection wrapper', () => {
      beforeEach(() => {
        _parse.mockReset();
        _validate.mockReset();
        _emit_reflection.mockReset();
        vi.resetModules();
      });

      afterEach(() => {
        vi.clearAllMocks();
      });

      it('returns Result.ok(reflectionJson) and forwards (validated, options_json) verbatim', async () => {
        const validatedHandle = { _tag: 'ValidatedModule' };
        const expectedJson = '[{"label":"@group(0)","entries":[]}]';
        _emit_reflection.mockReturnValueOnce(expectedJson);
        const optionsJson = JSON.stringify({ dynamicOffsets: [{ group: 0, binding: 0 }] });
        const { emit_reflection } = await import('../index.js');
        const r = await emit_reflection(validatedHandle, optionsJson);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value).toBe(expectedJson);
        }
        expect(_emit_reflection).toHaveBeenCalledWith(validatedHandle, optionsJson);
      });

      it('returns Result.err(ShaderError) with non-empty hint when raw emit_reflection throws', async () => {
        _emit_reflection.mockImplementationOnce(() => {
          throw new Error('reflection serialize failed: cyclic type graph');
        });
        const { emit_reflection } = await import('../index.js');
        const r = await emit_reflection({ _tag: 'ValidatedModule' }, '{}');
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('shader-compile-failed');
          expect(r.error.message).toContain('cyclic type graph');
          expect(r.error.hint).toBeTruthy();
          expect(r.error.hint.length).toBeGreaterThan(0);
        }
      });
    });
  });
}

{
  // ─── from errors.test.ts ───

  describe('errors.test.ts', () => {
    describe('compileFailed factory — D-PS-3 path (b) contract', () => {
      it('compileFailed without compilerMessages keeps detail undefined', () => {
        const err = compileFailed({
          message: 'WGSL parse failed at line 3, column 5',
          hint: 'fix the WGSL source at the indicated line/column',
        });
        expect(err.code).toBe('shader-compile-failed');
        expect(err.detail).toBeUndefined();
      });

      it('compileFailed with compilerMessages constructs typed detail (regression smoke)', () => {
        const err = compileFailed({
          message: 'WGSL parse failed',
          hint: 'see ShaderError.detail.compilerMessages',
          compilerMessages: [],
        });
        expect(err.code).toBe('shader-compile-failed');
        expect(err.detail).toBeDefined();
      });
    });
  });
}

{
  // ─── from parse.test.ts ───

  describe('parse.test.ts', () => {
    describe('@forgeax/engine-naga parse wrapper', () => {
      beforeEach(() => {
        _parse.mockReset();
        _validate.mockReset();
        _emit_reflection.mockReset();
        vi.resetModules();
      });

      afterEach(() => {
        vi.clearAllMocks();
      });

      it('returns Result.ok(opaque handle) when raw wasm parse succeeds', async () => {
        const opaqueHandle = { _tag: 'ParsedModule' };
        _parse.mockReturnValueOnce(opaqueHandle);
        const { parse } = await import('../index.js');
        const r = await parse(
          '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value).toBe(opaqueHandle);
        }
        expect(_parse).toHaveBeenCalledTimes(1);
      });

      it('returns Result.err(ShaderError code=shader-compile-failed) with lineNum/linePos when raw parse throws JsError with ParseErrorPayload', async () => {
        const payload = {
          message: "expected ';', found '@'",
          summary: "expected ';', found '@' at line 3 col 12",
          line_num: 3,
          line_pos: 12,
        };
        _parse.mockImplementationOnce(() => {
          throw new Error(JSON.stringify(payload));
        });
        const { parse } = await import('../index.js');
        const r = await parse('invalid wgsl');
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('shader-compile-failed');
          expect(r.error.lineNum).toBe(3);
          expect(r.error.linePos).toBe(12);
          expect(r.error.message).toContain('line 3');
        }
      });

      it('hint is non-empty for every error path (charter proposition 3)', async () => {
        const payload = { message: 'parse failed', line_num: 1, line_pos: 1 };
        _parse.mockImplementationOnce(() => {
          throw new Error(JSON.stringify(payload));
        });
        const { parse } = await import('../index.js');
        const r = await parse('invalid');
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.hint).toBeTruthy();
          expect(r.error.hint.length).toBeGreaterThan(0);
        }
      });
    });
  });
}

{
  // ─── from validate.test.ts ───

  describe('validate.test.ts', () => {
    describe('@forgeax/engine-naga validate wrapper', () => {
      beforeEach(() => {
        _parse.mockReset();
        _validate.mockReset();
        _emit_reflection.mockReset();
        vi.resetModules();
      });

      afterEach(() => {
        vi.clearAllMocks();
      });

      it('returns Result.ok(opaque handle) when raw wasm validate succeeds', async () => {
        const parsedHandle = { _tag: 'ParsedModule' };
        const validatedHandle = { _tag: 'ValidatedModule' };
        _validate.mockReturnValueOnce(validatedHandle);
        const { validate } = await import('../index.js');
        const r = await validate(parsedHandle);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value).toBe(validatedHandle);
        }
        expect(_validate).toHaveBeenCalledTimes(1);
        expect(_validate).toHaveBeenCalledWith(parsedHandle);
      });

      it('returns Result.err(ShaderError) with prose fallback when validator throws non-JSON message', async () => {
        _validate.mockImplementationOnce(() => {
          throw new Error('validate failed: type mismatch in @location(0)');
        });
        const { validate } = await import('../index.js');
        const r = await validate({ _tag: 'ParsedModule' });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('shader-compile-failed');
          expect(r.error.message).toContain('type mismatch');
          expect(r.error.lineNum).toBeUndefined();
          expect(r.error.linePos).toBeUndefined();
          expect(r.error.hint).toBeTruthy();
        }
      });
    });
  });
}
