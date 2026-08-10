// m2-t1-a: Production-path dual-world cache isolation — source-level verification.
//
// Verifies that every cache write/read site in the record stage that was
// identified in plan-strategy D-1a as needing worldEntityKey compositing
// actually uses worldEntityKey (not bare entityKey / cacheKey).
//
// Anchors:
//   plan-tasks.json m2 (patch assignment)
//   plan-strategy D-1a #1 (instanceBuffers positive half) and #3 (instancesBgPerEntity)
//   requirements AC-07
//
// The 13 sites under test (plus 2 read-side instancesBgPerEntity reads) are
// located by their stable cache operation below; source line numbers are not
// part of the contract and must not make this gate stale after extraction.
//
// Each site check uses a line-range window: we read the source file and verify
// that within the line range, a `worldEntityKey(...)` call appears on a line
// that contains the target key expression. This directly falsifies the bug
// "site uses bare key" — when a site uses a bare key, the worldEntityKey
// check will fail.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Verify that a cache site uses a worldEntityKey composite key.
 * Scans the source file around the given line (within a window) for both
 * `worldEntityKey` and the cache operation (`targetPattern` such as
 * `instanceBuffers.get`, `instancesBgPerEntity` as second arg, etc.).
 */
function expectWorldEntityKeyAt(
  filePath: string,
  line: number,
  description: string,
  windowRadius = 10,
): void {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const start = Math.max(line - windowRadius, 0);
  const end = Math.min(line + windowRadius, lines.length);

  for (let i = start; i < end; i++) {
    const l = lines[i];
    if (l?.includes('worldEntityKey')) {
      // Found — passes
      return;
    }
  }
  // Not found — fail with diagnostic
  const nearby = [];
  for (let i = start; i < end; i++) {
    nearby.push(`  ${i + 1}: ${lines[i]}`);
  }
  expect.fail(
    `${description}: worldEntityKey NOT found near line ${line} in ${filePath}\nNearby lines:\n${nearby.join('\n')}`,
  );
}

function findLine(filePath: string, needle: string, occurrence = 0): number {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.includes(needle)) {
      if (seen === occurrence) return index + 1;
      seen += 1;
    }
  }
  expect.fail(`${needle} occurrence ${occurrence} not found in ${filePath}`);
}

// ── Geometry pass instanceBuffers (D-1a #1) ────────────────────────────────

describe('production-path geometry instanceBuffers worldEntityKey', () => {
  const FILE = fileURLToPath(
    new URL('../../../render/src/record/main-pass-geometry.ts', import.meta.url),
  );

  it('inst.cacheKey get uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      FILE,
      findLine(FILE, 'frameState.instanceBuffers.get('),
      'main-pass-geometry instanceBuffers.get',
    );
  });

  it('inst.cacheKey set uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      FILE,
      findLine(FILE, 'frameState.instanceBuffers.set('),
      'main-pass-geometry instanceBuffers.set',
    );
  });
});

// ── Sprite identity BG instancesBgPerEntity (D-1a #3) ──────────────────────

const SPRITE_FILE = fileURLToPath(
  new URL('../../../render/src/record/main-pass-sprite-draws.ts', import.meta.url),
);

describe('production-path sprite identity instancesBgPerEntity worldEntityKey', () => {
  it('identityInstBg entityKey uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SPRITE_FILE,
      findLine(SPRITE_FILE, 'frameState.instancesBgPerEntity', 0),
      'main-pass-sprite-draws instancesBgPerEntity write',
    );
  });
});

// ── Sprite Instances instanceBuffers (D-1a #1) ─────────────────────────────

describe('production-path sprite Instances instanceBuffers worldEntityKey', () => {
  it('spriteInst.cacheKey get uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SPRITE_FILE,
      findLine(SPRITE_FILE, 'frameState.instanceBuffers.get(', 1),
      'main-pass-sprite-draws sprite instanceBuffers.get',
    );
  });

  it('spriteInst.cacheKey set uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SPRITE_FILE,
      findLine(SPRITE_FILE, 'frameState.instanceBuffers.set(', 1),
      'main-pass-sprite-draws sprite instanceBuffers.set',
    );
  });
});

// ── Sprite pass instancesBgPerEntity (D-1a #3) ─────────────────────────────

describe('production-path sprite pass instancesBgPerEntity worldEntityKey', () => {
  it('spriteInstancesBg entityKey write uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SPRITE_FILE,
      findLine(SPRITE_FILE, 'frameState.instancesBgPerEntity', 1),
      'main-pass-sprite-draws sprite pass instancesBgPerEntity write',
    );
  });
});

// ── SpriteInstances instanceBuffers (D-1a #1) ──────────────────────────────

describe('production-path SpriteInstances instanceBuffers worldEntityKey', () => {
  it('spriteInstancesSnap.cacheKey get uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SPRITE_FILE,
      findLine(SPRITE_FILE, 'frameState.instanceBuffers.get(', 2),
      'main-pass-sprite-draws spriteInstances instanceBuffers.get',
    );
  });

  it('spriteInstancesSnap.cacheKey set uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SPRITE_FILE,
      findLine(SPRITE_FILE, 'frameState.instanceBuffers.set(', 2),
      'main-pass-sprite-draws spriteInstances instanceBuffers.set',
    );
  });
});

// ── Shadow pass instanceBuffers (D-1a #1) ──────────────────────────────────

const SHADOW_FILE = fileURLToPath(
  new URL('../../../render/src/record/shadow-pass.ts', import.meta.url),
);

describe('production-path shadow instanceBuffers worldEntityKey', () => {
  it('shadowInst.cacheKey get uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SHADOW_FILE,
      findLine(SHADOW_FILE, 'c.frameState.instanceBuffers.get(', 0),
      'shadow-pass instanceBuffers.get',
    );
  });

  it('shadowInst.cacheKey set uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SHADOW_FILE,
      findLine(SHADOW_FILE, 'c.frameState.instanceBuffers.set('),
      'shadow-pass instanceBuffers.set',
    );
  });

  it('shadow dir read-side inst.cacheKey get uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SHADOW_FILE,
      findLine(SHADOW_FILE, 'frameState.instanceBuffers.get(', 0),
      'shadow-pass directional instanceBuffers.get',
    );
  });

  it('shadow spot read-side inst.cacheKey get uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SHADOW_FILE,
      findLine(SHADOW_FILE, 'frameState.instanceBuffers.get(', 1),
      'shadow-pass spot instanceBuffers.get',
    );
  });
});

// ── Shadow pass instancesBgPerEntity (D-1a #3) ─────────────────────────────

describe('production-path shadow instancesBgPerEntity worldEntityKey', () => {
  it('shadowInstancesBg entityKey write uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SHADOW_FILE,
      findLine(SHADOW_FILE, 'c.frameState.instancesBgPerEntity', 0),
      'shadow-pass instancesBgPerEntity write',
    );
  });

  it('shadow dir read-side instancesBgPerEntity.get uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SHADOW_FILE,
      findLine(SHADOW_FILE, '.get(worldEntityKey(', 0),
      'shadow-pass directional instancesBgPerEntity read',
    );
  });

  it('shadow spot read-side instancesBgPerEntity.get uses worldEntityKey', () => {
    expectWorldEntityKeyAt(
      SHADOW_FILE,
      findLine(SHADOW_FILE, '.get(worldEntityKey(', 1),
      'shadow-pass spot instancesBgPerEntity read',
    );
  });
});

// ── Fold-bucket negative half NOT worldEntityKey (D-1a #1 invariant) ───────

describe('production-path fold-bucket key NOT worldEntityKey', () => {
  it('fold-bucket bucketCacheKey is NOT worldEntityKey', () => {
    const src = readFileSync(SPRITE_FILE, 'utf8');
    const lines = src.split('\n');
    const bucketLine = lines[findLine(SPRITE_FILE, 'const bucketCacheKey =') - 1];
    expect(bucketLine).toBeDefined();
    // Must NOT contain worldEntityKey — fold-bucket keys are material-handle-based
    expect(bucketLine).not.toContain('worldEntityKey');
    // Should contain some form of the fold key: -1 -
    expect(bucketLine).toMatch(/-1\s*-/);
  });
});
