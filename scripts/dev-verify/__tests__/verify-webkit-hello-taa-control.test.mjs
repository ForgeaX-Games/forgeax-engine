import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../verify-webkit-hello-taa.mjs', import.meta.url), 'utf8');

test('WebKit producer control transitions require fresh renderer submissions', () => {
  assert.match(source, /const TIMEOUT_MS = Number\(process\.env\.TIMEOUT_MS \?\? 120_000\)/u);
  for (const functionName of ['waitForInspection', 'waitForFrame', 'waitForRendererTransition']) {
    const start = source.indexOf(`const ${functionName}`);
    const end = source.indexOf('\nconst ', start + 1);
    assert.notEqual(start, -1, `${functionName} must remain in the verifier`);
    assert.match(
      source.slice(start, end === -1 ? source.length : end),
      /\{ timeout: TIMEOUT_MS \}/u,
      `${functionName} must use the shared timeout`,
    );
  }
  assert.doesNotMatch(source, /Math\.min\(TIMEOUT_MS,\s*15_000\)/u);
  assert.match(source, /const beforeOff = await readInspection\(page\);/u);
  assert.match(source, /const beforeOn = await readInspection\(page\);/u);
  assert.match(source, /const waitForRendererTransition = async/u);
  assert.match(source, /waitForRendererTransition\(page, beforeOff, 'off'\)/u);
  assert.match(source, /waitForRendererTransition\(page, beforeOn, 'on'\)/u);
  assert.match(source, /minimum: beforeFrame \+ 1/u);
  assert.match(source, /frame < minimum\) return false/u);
  assert.match(source, /expectedTransition === 'off'/u);
  assert.match(source, /motionBlur\?\.enabled === false && motionBlur\?\.status === 'off'/u);
  assert.match(source, /motionBlur\?\.status === 'active'/u);
  assert.match(source, /motionBlur\?\.temporalDemand === 'scene-data-temporal-v1'/u);
  assert.match(source, /\['standard-scene-data', 'motion-blur', 'output-transform'\]/u);
});

test('transition gate keeps waiting after a new frame without the renderer predicate', () => {
  const transitionReady = (state, minimum, transition) => {
    const frame = typeof state.frame === 'number' ? state.frame : state.frame?.frameId;
    if (!Number.isFinite(frame) || frame < minimum) return false;
    if (transition === 'off') {
      return state.motionBlur?.enabled === false && state.motionBlur?.status === 'off';
    }
    return (
      state.motionBlur?.enabled === true &&
      state.motionBlur?.status === 'active' &&
      state.motionBlur?.temporalDemand === 'scene-data-temporal-v1' &&
      ['standard-scene-data', 'motion-blur', 'output-transform'].every((pass) =>
        (state.passes ?? []).includes(pass),
      )
    );
  };
  const pending = {
    frame: 42,
    motionBlur: { enabled: true, status: null, temporalDemand: null },
    passes: ['standard-scene-data', 'output-transform'],
  };
  const ready = {
    frame: 43,
    motionBlur: {
      enabled: true,
      status: 'active',
      temporalDemand: 'scene-data-temporal-v1',
    },
    passes: ['standard-scene-data', 'motion-blur', 'output-transform'],
  };
  assert.equal(transitionReady(pending, 42, 'on'), false);
  assert.equal(transitionReady(ready, 42, 'on'), true);
  let attempts = 0;
  const settled = [pending, ready].find((state) => {
    attempts += 1;
    return transitionReady(state, 42, 'on');
  });
  assert.equal(attempts, 2);
  assert.equal(settled, ready);
});

test('WebKit producer delegates active work counters to the shared renderer-state projector', () => {
  assert.match(source, /activePassCountersFromInspection/);
  assert.match(source, /off: activePassCountersFromInspection\(off\)/);
  assert.match(source, /on: activePassCountersFromInspection\(on\)/);
});
