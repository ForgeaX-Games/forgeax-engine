// schema.test.ts — w2: GameProjectSchema + GuidString refinement tests
import { describe, expect, it } from 'vitest';
import { GameProjectSchema, GuidString } from '../schema.js';

// ── valid full forge.json ──────────────────────────────────────────────────
describe('GameProjectSchema — acceptance', () => {
  it('accepts a valid full forge.json', () => {
    const result = GameProjectSchema.safeParse({
      id: 'hellforge',
      name: 'Hellforge',
      schemaVersion: '1.0.0',
      defaultScene: '15acc839-d847-527c-8284-bfb36d7c50de',
      physics: '3d',
      pointerLock: true,
      input: 'fps',
      preview: {
        skin: {
          sceneGuid: '11111111-1111-1111-1111-111111111111',
          clipGuids: [],
          clipDefault: 'idle',
          scale: 1,
          pos: [0, 0],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal forge.json with only id+name+schemaVersion', () => {
    const result = GameProjectSchema.safeParse({
      id: 'minimal',
      name: 'Minimal Game',
      schemaVersion: '1.0.0',
    });
    expect(result.success).toBe(true);
  });

  it('accepts forge.json without entry (entry is optional)', () => {
    const result = GameProjectSchema.safeParse({
      id: 'no-entry',
      name: 'No Entry Game',
      schemaVersion: '1.0.0',
    });
    expect(result.success).toBe(true);
  });

  it('accepts forge.json without defaultScene (defaultScene is optional)', () => {
    const result = GameProjectSchema.safeParse({
      id: 'no-default',
      name: 'No Default Game',
      schemaVersion: '1.0.0',
    });
    expect(result.success).toBe(true);
  });

  it('accepts forge.json with entry field present', () => {
    const result = GameProjectSchema.safeParse({
      id: 'with-entry',
      name: 'With Entry',
      schemaVersion: '1.0.0',
      entry: 'main.ts',
    });
    expect(result.success).toBe(true);
  });
});

// ── GuidString refinement ───────────────────────────────────────────────────
describe('GuidString refinement', () => {
  it('accepts valid 36-char dash-form UUID v4', () => {
    const result = GuidString.safeParse('d953a1db-483a-4b7d-8b71-b8f144488c48');
    expect(result.success).toBe(true);
  });

  it('accepts valid 36-char dash-form UUID v7', () => {
    const result = GuidString.safeParse('15acc839-d847-527c-8284-bfb36d7c50de');
    expect(result.success).toBe(true);
  });

  it('accepts valid 36-char dash-form UUID (uppercase hex)', () => {
    const result = GuidString.safeParse('7B4D43D4-5B19-5903-8966-F89671D21565');
    expect(result.success).toBe(true);
  });

  it('rejects malformed UUID string (too short)', () => {
    const result = GuidString.safeParse('not-a-guid');
    expect(result.success).toBe(false);
  });

  it('rejects plain slug string (non-UUID)', () => {
    const result = GuidString.safeParse('rogue-encampment');
    expect(result.success).toBe(false);
  });

  it('rejects empty string', () => {
    const result = GuidString.safeParse('');
    expect(result.success).toBe(false);
  });

  it('rejects string with only 35 chars', () => {
    const result = GuidString.safeParse('a2345678-1234-1234-1234-12345678901');
    expect(result.success).toBe(false);
  });
});

// ── strict rejection of unknown fields ──────────────────────────────────────
describe('GameProjectSchema — strict rejection', () => {
  it('rejects scenes[] as unknown field', () => {
    const result = GameProjectSchema.safeParse({
      id: 'has-scenes',
      name: 'Has Scenes',
      schemaVersion: '1.0.0',
      scenes: [{ id: 'l1', name: 'Level 1', pack: 'scenes/level1.pack.json' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // zod puts unrecognized_keys in the first issue
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('rejects any unknown top-level field', () => {
    const result = GameProjectSchema.safeParse({
      id: 'extra-field',
      name: 'Extra',
      schemaVersion: '1.0.0',
      unknownField: 'should not be here',
    });
    expect(result.success).toBe(false);
  });
});

// ── physics union (D-4: all 5 known values) ─────────────────────────────────
describe('GameProjectSchema — physics union', () => {
  const physicsValues = ['3d', '2d', 'rapier-3d', 'rapier-2d', true] as const;

  for (const phys of physicsValues) {
    it(`accepts physics=${JSON.stringify(phys)}`, () => {
      const result = GameProjectSchema.safeParse({
        id: 'phys-test',
        name: 'Physics Test',
        schemaVersion: '1.0.0',
        physics: phys,
      });
      expect(result.success).toBe(true);
    });
  }

  it('rejects arbitrary string for physics', () => {
    const result = GameProjectSchema.safeParse({
      id: 'bad-physics',
      name: 'Bad Physics',
      schemaVersion: '1.0.0',
      physics: 'custom-engine',
    });
    expect(result.success).toBe(false);
  });

  it('rejects number for physics', () => {
    const result = GameProjectSchema.safeParse({
      id: 'bad-physics-num',
      name: 'Bad Physics Num',
      schemaVersion: '1.0.0',
      physics: 42,
    });
    expect(result.success).toBe(false);
  });

  it('accepts physics=false (boolean true/false both valid per D-4)', () => {
    const result = GameProjectSchema.safeParse({
      id: 'physics-false',
      name: 'Physics False',
      schemaVersion: '1.0.0',
      physics: false,
    });
    expect(result.success).toBe(true);
  });
});

// ── pointerLock boolean ─────────────────────────────────────────────────────
describe('GameProjectSchema — pointerLock', () => {
  it('accepts pointerLock=false', () => {
    const result = GameProjectSchema.safeParse({
      id: 'pl-false',
      name: 'PL False',
      schemaVersion: '1.0.0',
      pointerLock: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-boolean pointerLock', () => {
    const result = GameProjectSchema.safeParse({
      id: 'pl-string',
      name: 'PL String',
      schemaVersion: '1.0.0',
      pointerLock: 'true',
    });
    expect(result.success).toBe(false);
  });
});

// ── input string ────────────────────────────────────────────────────────────
describe('GameProjectSchema — input', () => {
  it('accepts input string', () => {
    const result = GameProjectSchema.safeParse({
      id: 'with-input',
      name: 'With Input',
      schemaVersion: '1.0.0',
      input: 'fps',
    });
    expect(result.success).toBe(true);
  });
});

// ── preview.skin nested object ──────────────────────────────────────────────
describe('GameProjectSchema — preview.skin', () => {
  it('accepts full preview.skin object', () => {
    const result = GameProjectSchema.safeParse({
      id: 'with-preview',
      name: 'With Preview',
      schemaVersion: '1.0.0',
      preview: {
        skin: {
          sceneGuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          clipGuids: ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
          clipDefault: 'walk',
          scale: 2.5,
          pos: [100, 200, 300],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal preview.skin (sceneGuid only)', () => {
    const result = GameProjectSchema.safeParse({
      id: 'preview-min',
      name: 'Preview Min',
      schemaVersion: '1.0.0',
      preview: {
        skin: {
          sceneGuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
