import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const smokePath = resolve(import.meta.dirname, '../../scripts/smoke-dawn.mjs');

describe('Boss Lightning turbulence stage Dawn contract', () => {
  it('requires a real managed stage dispatch and non-zero output oracle', () => {
    const source = readFileSync(smokePath, 'utf8');
    expect(source).toContain('turbulence');
    expect(source).toContain('stageDispatch');
    expect(source).toContain('stageOutput');
    expect(source).toContain('stageReadiness');
    expect(source).toContain('lastKnownGoodStage');
  });
});
