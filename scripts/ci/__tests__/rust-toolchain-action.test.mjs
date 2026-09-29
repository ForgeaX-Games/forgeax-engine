import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const action = readFileSync(resolve('.github/actions/setup-rust-toolchain/action.yml'), 'utf8');
const script = action
  .split('      run: |\n')[1]
  .split('\n')
  .map((line) => line.slice(8))
  .join('\n');

function fixture(installed) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-rust-action-'));
  const bin = join(root, 'cargo/bin');
  mkdirSync(bin, { recursive: true });
  const executable = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  executable(
    'curl',
    'if [[ "$*" == "--help all" ]]; then echo --retry-all-errors; exit 0; fi; echo unexpected-network-download >&2; exit 99',
  );
  executable('rustc', 'echo fixture-rustc');
  executable(
    'rustup',
    `echo "$*" >> "$RUST_TEST_LOG"
case "$1 $2" in
  "toolchain list") echo "$RUST_TEST_INSTALLED-x86_64-unknown-linux-gnu (default)" ;;
  "target list") echo "wasm32-unknown-unknown (installed)" ;;
  "component list")
    printf 'rustfmt-x86_64-unknown-linux-gnu (installed)\\n'
    for index in {1..2048}; do printf 'fixture-component-%s-x86_64-unknown-linux-gnu\\n' "$index"; done
    printf 'clippy-x86_64-unknown-linux-gnu (installed)\\n'
    ;;
esac`,
  );
  const log = join(root, 'rust.log');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      CARGO_HOME: join(root, 'cargo'),
      RUSTUP_HOME: join(root, 'rustup'),
      RUNNER_TEMP: root,
      GITHUB_ENV: join(root, 'env'),
      GITHUB_PATH: join(root, 'path'),
      RUST_TOOLCHAIN: '1.93',
      RUST_TARGETS: 'wasm32-unknown-unknown',
      RUST_COMPONENTS: 'rustfmt, clippy',
      RUST_TEST_INSTALLED: installed,
      RUST_TEST_LOG: log,
    },
  });
  return { root, result, calls: readFileSync(log, 'utf8') };
}

test('Rust bootstrap finds a warm installation outside PATH without network or reinstall', () => {
  const { root, result, calls } = fixture('1.93');
  try {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /reusing installed 1\.93/);
    assert.doesNotMatch(calls, /toolchain install|target add|component add/);
    assert.match(calls, /default 1\.93/);
    assert.equal(readFileSync(join(root, 'path'), 'utf8').trim(), join(root, 'cargo/bin'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a different installed Rust version still hydrates the exact requested components and target', () => {
  const { root, result, calls } = fixture('1.930');
  try {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      calls,
      /toolchain install 1\.93 --profile minimal --no-self-update --target wasm32-unknown-unknown --component rustfmt --component clippy/,
    );
    assert.doesNotMatch(result.stdout, /reusing installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared CI producers and Native use the existing runner-local Rust bootstrap', () => {
  for (const name of [
    'ci.yml',
    'native-ray-query.yml',
    'sdk-pr-preflight.yml',
    'sdk-release-candidate.yml',
  ]) {
    const workflow = readFileSync(resolve('.github/workflows', name), 'utf8');
    assert.doesNotMatch(workflow, /uses: dtolnay\/rust-toolchain/);
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-rust-toolchain/);
  }
});
