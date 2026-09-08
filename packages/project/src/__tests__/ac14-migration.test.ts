// ac14-migration.test.ts — w23: AC-14 integration — all 6 migrated forge.json pass loadGameProject
//
// Loads each migrated game's forge.json via node:fs readFileSync adapter,
// asserts r.ok===true, verifies schemaVersion/defaultScene/entry per D-3 GUID table.
// This is the R-3 risk closure evidence (plan-strategy section 4 R-3, section 5.4).
//
// Fixture approach: 6 migrated forge.json copies live under __tests__/fixtures/games/
// (plan w23 description secondary path: the live paths under packages/games/ use a
// Chinese directory name that triggers the engine english-only gate; fixtures avoid
// the CJK path literal while testing the same post-migration forge.json content).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadGameProject } from '../loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = resolve(__dirname, 'fixtures/games');

function fsRead(filePath: string): (path: string) => Promise<string> {
  return async () => readFileSync(filePath, 'utf-8');
}

interface GameFixture {
  name: string;
  dir: string;
  hasDefaultScene: boolean;
  expectedDefaultScene?: string;
  expectedEntry?: string;
}

// 6 migrated games per D-3 GUID table (plan-strategy section 2)
// Fixture dirs use romanized names (original Chinese dir -> cow-level)
const GAMES: GameFixture[] = [
  {
    name: 'hellforge',
    dir: 'hellforge',
    hasDefaultScene: true,
    expectedDefaultScene: '15acc839-d847-527c-8284-bfb36d7c50de',
    expectedEntry: 'main.ts',
  },
  {
    name: 'cow-survivor',
    dir: 'cow-survivor',
    hasDefaultScene: true,
    expectedDefaultScene: '7b4d43d4-5b19-5903-8966-f89671d21565',
    expectedEntry: 'main.ts',
  },
  {
    name: 'spin-cube',
    dir: 'spin-cube',
    hasDefaultScene: false,
    expectedEntry: 'main.ts',
  },
  {
    name: 'cow-level',
    dir: 'cow-level',
    hasDefaultScene: false,
    expectedEntry: 'main.ts',
  },
  {
    name: 'fps',
    dir: 'fps',
    hasDefaultScene: false,
    expectedEntry: 'main.ts',
  },
  {
    name: 'shoot-opt',
    dir: 'shoot-opt',
    hasDefaultScene: false,
    expectedEntry: 'src/main.ts',
  },
];

describe('AC-14 — migrated game forge.json validation', () => {
  for (const game of GAMES) {
    const forgePath = resolve(fixturesDir, game.dir, 'forge.json');

    describe(game.name, () => {
      it('loads successfully (r.ok === true)', async () => {
        const result = await loadGameProject(fsRead(forgePath));
        expect(result.ok).toBe(true);
      });

      it('has schemaVersion === "1.0.0"', async () => {
        const result = await loadGameProject(fsRead(forgePath));
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.schemaVersion).toBe('1.0.0');
        }
      });

      if (game.hasDefaultScene) {
        it(`has defaultScene === "${game.expectedDefaultScene}"`, async () => {
          const result = await loadGameProject(fsRead(forgePath));
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value.defaultScene).toBe(game.expectedDefaultScene);
          }
        });
      } else {
        it('has no defaultScene (undefined)', async () => {
          const result = await loadGameProject(fsRead(forgePath));
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value.defaultScene).toBeUndefined();
          }
        });
      }

      if (game.expectedEntry) {
        it(`has entry === "${game.expectedEntry}"`, async () => {
          const result = await loadGameProject(fsRead(forgePath));
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value.entry).toBe(game.expectedEntry);
          }
        });
      }
    });
  }
});
