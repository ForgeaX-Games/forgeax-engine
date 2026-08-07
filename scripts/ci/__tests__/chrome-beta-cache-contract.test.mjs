import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const action = readFileSync(
  resolve('.github/actions/install-playwright-chrome-beta/action.yml'),
  'utf8',
);

test('Chrome Beta cache outage cannot evict a valid Linux host install', () => {
  assert.match(action, /id: chrome-beta-host/);
  assert.match(action, /reusing host install/);
  assert.match(action, /! ldd .*grep -q 'not found'/);
  assert.equal(
    action.match(
      /if: runner\.os == 'Linux' && steps\.chrome-beta-host\.outputs\.installed != 'true'/g,
    )?.length,
    2,
  );
  assert.match(action, /Verify Chrome Beta binary \(Linux only\)/);
  assert.match(action, /host reuse\/install/);
});
