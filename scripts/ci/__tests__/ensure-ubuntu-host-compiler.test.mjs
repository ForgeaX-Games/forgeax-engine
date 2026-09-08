import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const script = readFileSync(resolve('scripts/ci/ensure-ubuntu-host-compiler.sh'), 'utf8');

test('Ubuntu compiler bootstrap isolates update and install to the selected source', () => {
  assert.match(
    script,
    /apt_options=\(\s+-o "Dir::Etc::sourcelist=\$ubuntu_source"\s+-o 'Dir::Etc::sourceparts=-'\s+\)/s,
  );
  assert.match(script, /sudo apt-get "\$\{apt_options\[@\]\}" update/);
  assert.match(
    script,
    /sudo DEBIAN_FRONTEND=noninteractive apt-get \\\n\s+"\$\{apt_options\[@\]\}" \\\n\s+install -y --no-install-recommends build-essential/,
  );
});
