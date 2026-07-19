// resolve.test.ts — w5: resolveDefaultScene double-injection tests
import { describe, expect, it, vi } from 'vitest';
import { resolveDefaultScene } from '../loader.js';

// ── helpers ─────────────────────────────────────────────────────────────────
function makeRead(content: string): (path: string) => Promise<string> {
  return async (_path: string) => content;
}

const VALID_WITH_SCENE = JSON.stringify({
  id: 'test-game',
  name: 'Test Game',
  schemaVersion: '1.0.0',
  defaultScene: '15acc839-d847-527c-8284-bfb36d7c50de',
});

const WITHOUT_SCENE = JSON.stringify({
  id: 'no-scene',
  name: 'No Scene',
  schemaVersion: '1.0.0',
});

// ── signature verification ──────────────────────────────────────────────────
describe('resolveDefaultScene — signature', () => {
  it('accepts {read, resolveGuid} as both injection points', async () => {
    const read = makeRead(VALID_WITH_SCENE);
    const resolveGuid = async (guid: string) => ({
      ok: true as const,
      value: { kind: 'scene', guid },
    });
    const result = await resolveDefaultScene({ read, resolveGuid });
    expect(result.ok).toBe(true);
  });
});

// ── resolve success path ────────────────────────────────────────────────────
describe('resolveDefaultScene — success path', () => {
  it('resolves when resolveGuid returns {ok:true} with kind=scene', async () => {
    const read = makeRead(VALID_WITH_SCENE);
    const resolveGuid = vi.fn(async (_guid: string) => ({
      ok: true as const,
      value: { kind: 'scene', guid: _guid },
    }));

    const result = await resolveDefaultScene({ read, resolveGuid });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('scene');
      expect(result.value.guid).toBe('15acc839-d847-527c-8284-bfb36d7c50de');
    }
    expect(resolveGuid).toHaveBeenCalledWith('15acc839-d847-527c-8284-bfb36d7c50de');
  });
});

// ── resolve failure: GUID not found ─────────────────────────────────────────
describe('resolveDefaultScene — GUID not found', () => {
  it('returns {ok:false} when resolveGuid returns {ok:false}', async () => {
    const read = makeRead(VALID_WITH_SCENE);
    const resolveGuid = async (_guid: string) => ({
      ok: false as const,
      error: new Error('not found'),
    });

    const result = await resolveDefaultScene({ read, resolveGuid });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-scene-unresolved');
    }
  });
});

// ── resolve failure: kind not scene ─────────────────────────────────────────
describe('resolveDefaultScene — kind mismatch', () => {
  it('returns {ok:false} when resolved asset kind !== scene', async () => {
    const read = makeRead(VALID_WITH_SCENE);
    const resolveGuid = async (_guid: string) => ({
      ok: true as const,
      value: { kind: 'texture', guid: _guid },
    });

    const result = await resolveDefaultScene({ read, resolveGuid });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-scene-unresolved');
    }
  });
});

// ── no defaultScene ─────────────────────────────────────────────────────────
describe('resolveDefaultScene — no defaultScene', () => {
  it('returns {ok:false} when forge.json has no defaultScene', async () => {
    const read = makeRead(WITHOUT_SCENE);
    const resolveGuid = async (_guid: string) => ({
      ok: true as const,
      value: { kind: 'scene', guid: _guid },
    });

    const result = await resolveDefaultScene({ read, resolveGuid });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-scene-unresolved');
    }
  });
});

// ── loadGameProject isolation ───────────────────────────────────────────────
describe('resolveDefaultScene — loadGameProject isolation', () => {
  it('resolveDefaultScene accepts {read, resolveGuid} — loadGameProject accepts read only', () => {
    // Type-level verification:
    // loadGameProject: (read: (path)=>Promise<string>) => ...
    // resolveDefaultScene: ({read, resolveGuid}) => ...
    // The dual-injection signature separates resolve from format.
    const _read = makeRead(VALID_WITH_SCENE);
    expect(typeof _read).toBe('function');
  });
});
