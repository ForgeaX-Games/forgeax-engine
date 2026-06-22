// errors.test.ts — w3: GameProjectError code union exhaustive tests
import { describe, expect, it } from 'vitest';
import type { GameProjectErrorCode, GameProjectErrorDetail } from '../errors.js';
import { GameProjectError } from '../errors.js';

// ── helper ───────────────────────────────────────────────────────────────────
function makeErr(code: GameProjectErrorCode): GameProjectError {
  return new GameProjectError({
    code,
    expected: 'test expected',
    hint: 'test hint',
    detail: { path: '/fake/forge.json' },
  });
}

// ── four-property surface ───────────────────────────────────────────────────
describe('GameProjectError — structural surface', () => {
  it('has .code, .expected, .hint, .detail', () => {
    const err = makeErr('forge-missing');
    expect(err).toHaveProperty('code');
    expect(err).toHaveProperty('expected');
    expect(err).toHaveProperty('hint');
    expect(err).toHaveProperty('detail');
  });

  it('.code is readonly (TS compile-time, not runtime)', () => {
    const err = makeErr('forge-missing');
    // TS `readonly` is compile-time only; at runtime the property exists and
    // holds its value. AI users cannot assign via the type (charter P2).
    expect(err.code).toBe('forge-missing');
    expect(typeof err.code).toBe('string');
  });

  it('.expected is readonly (TS compile-time)', () => {
    const err = makeErr('forge-missing');
    expect(err.expected).toBe('test expected');
    expect(typeof err.expected).toBe('string');
  });

  it('.hint is readonly (TS compile-time)', () => {
    const err = makeErr('forge-missing');
    expect(err.hint).toBe('test hint');
    expect(typeof err.hint).toBe('string');
  });

  it('.detail is readonly (TS compile-time)', () => {
    const err = makeErr('forge-missing');
    expect(err.detail).toBeDefined();
    expect(typeof err.detail).toBe('object');
  });
});

// ── code union membership ───────────────────────────────────────────────────
describe('GameProjectError — code union', () => {
  const codes: GameProjectErrorCode[] = [
    'forge-missing',
    'forge-parse-failed',
    'forge-schema-invalid',
    'forge-unknown-field',
    'forge-guid-malformed',
    'forge-scene-unresolved',
  ];

  it('code union has exactly 6 members', () => {
    expect(codes).toHaveLength(6);
  });

  it('each code is constructable', () => {
    for (const c of codes) {
      const err = makeErr(c);
      expect(err.code).toBe(c);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(GameProjectError);
    }
  });

  it('compiles exhaustive switch without default', () => {
    function switchOnCode(code: GameProjectErrorCode): string {
      switch (code) {
        case 'forge-missing':
          return 'missing';
        case 'forge-parse-failed':
          return 'parse-failed';
        case 'forge-schema-invalid':
          return 'schema-invalid';
        case 'forge-unknown-field':
          return 'unknown-field';
        case 'forge-guid-malformed':
          return 'guid-malformed';
        case 'forge-scene-unresolved':
          return 'scene-unresolved';
      }
    }
    expect(switchOnCode('forge-missing')).toBe('missing');
    expect(switchOnCode('forge-scene-unresolved')).toBe('scene-unresolved');
  });
});

// ── per-code detail narrowing ───────────────────────────────────────────────
describe('GameProjectError — detail narrowing per code', () => {
  it('forge-missing detail contains path:string', () => {
    const _detail: Extract<GameProjectErrorDetail, { path: string }> = {
      path: '/some/game/forge.json',
    };
    expect(_detail.path).toBe('/some/game/forge.json');
  });

  it('forge-parse-failed detail contains path + rawMessage', () => {
    const _detail: Extract<GameProjectErrorDetail, { path: string; rawMessage: string }> = {
      path: '/some/forge.json',
      rawMessage: 'Unexpected token',
    };
    expect(_detail.rawMessage).toBe('Unexpected token');
  });

  it('forge-schema-invalid detail contains path + zodErrors', () => {
    const _detail: Extract<GameProjectErrorDetail, { path: string; zodErrors: unknown }> = {
      path: '/some/forge.json',
      zodErrors: [],
    };
    expect(_detail.path).toBe('/some/forge.json');
  });

  it('forge-unknown-field detail contains path + fieldNames', () => {
    const _detail: Extract<GameProjectErrorDetail, { path: string; fieldNames: string[] }> = {
      path: '/some/forge.json',
      fieldNames: ['scenes'],
    };
    expect(_detail.fieldNames).toEqual(['scenes']);
  });

  it('forge-guid-malformed detail contains field + rawInput', () => {
    const _detail: Extract<GameProjectErrorDetail, { field: string; rawInput: string }> = {
      field: 'defaultScene',
      rawInput: 'rogue-encampment',
    };
    expect(_detail.rawInput).toBe('rogue-encampment');
  });

  it('forge-scene-unresolved detail contains guid:string', () => {
    const _detail: Extract<GameProjectErrorDetail, { guid: string }> = {
      guid: '15acc839-d847-527c-8284-bfb36d7c50de',
    };
    expect(_detail.guid).toBe('15acc839-d847-527c-8284-bfb36d7c50de');
  });
});

// ── error message ───────────────────────────────────────────────────────────
describe('GameProjectError — message', () => {
  it('is an instance of Error', () => {
    const err = makeErr('forge-missing');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name GameProjectError', () => {
    const err = makeErr('forge-missing');
    expect(err.name).toBe('GameProjectError');
  });

  it('message contains code for human readability', () => {
    const err = makeErr('forge-missing');
    expect(err.message).toContain('GameProjectError');
    expect(err.message).toContain('forge-missing');
  });
});
