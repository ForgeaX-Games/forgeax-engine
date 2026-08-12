import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..', '..');
const references = readFileSync(
  resolve(
    root,
    'apps/learn-render/5.advanced-lighting/8.deferred-shading/scripts/capture-membership-references.mjs',
  ),
  'utf8',
);
const corpus = readFileSync(
  resolve(root, 'scripts/dev-verify/capture-deferred-membership-corpus.mjs'),
  'utf8',
);
const browserMain = readFileSync(
  resolve(root, 'apps/learn-render/5.advanced-lighting/8.deferred-shading/src/main.ts'),
  'utf8',
);
const smoke = readFileSync(
  resolve(root, 'apps/learn-render/5.advanced-lighting/8.deferred-shading/scripts/smoke.mjs'),
  'utf8',
);

test('deferred real profile front doors retain the bounded nested fingerprint contract', () => {
  for (const source of [references, corpus]) {
    assert.match(source, /FORGEAX_PROFILE_DETAIL: 'nested'/);
    assert.match(source, /FORGEAX_PROFILE_FRAME_LIMIT: '90'/);
    assert.match(source, /FORGEAX_PROFILE_SETTLE_MS: '25'/);
  }
  assert.match(browserMain, /frameLimit: 90/);
  assert.match(
    browserMain,
    /const profileEventLimit = navigator\.gpu === undefined \? 65_536 : 40_000;/,
  );
  assert.match(browserMain, /eventLimit: profileEventLimit/);
  assert.match(browserMain, /detail: 'nested'/);
  assert.doesNotMatch(browserMain, /eventLimit: 65_536/);
  assert.match(
    smoke,
    /const PROFILE_EVENT_LIMIT = Number\.parseInt\(process\.env\.FORGEAX_PROFILE_EVENT_LIMIT \?\? '100000', 10\);/,
  );
  assert.match(smoke, /PROFILE_SETTLE_AFTER_FRAMES = 16/);
  assert.match(smoke, /PROFILE_SETTLE_MS.*'25'/);
  assert.match(smoke, /i \+ 1 === PROFILE_SETTLE_AFTER_FRAMES/);
});
