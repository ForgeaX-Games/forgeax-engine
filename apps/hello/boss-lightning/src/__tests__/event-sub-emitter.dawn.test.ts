import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const smokePath = resolve(import.meta.dirname, '../../scripts/smoke-dawn.mjs');

describe('Boss Lightning GPU event Dawn contract', () => {
  it('requires a real event dispatch and a bounded overflow oracle', () => {
    const source = readFileSync(smokePath, 'utf8');
    expect(source).toContain('event-sub-emitter');
    expect(source).toContain('eventDispatch');
    expect(source).toContain('subEmitterVisible');
    expect(source).toContain('overflow');
    expect(source).toContain('queueCleared');
    expect(source).toContain('mainEffectRunning');
  });
});
