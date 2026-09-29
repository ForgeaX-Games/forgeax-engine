import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SCRIPT = new URL('../build-auto-exposure-deferred-timing-gate.mjs', import.meta.url);
const HEAD = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

test('builds an explicit non-GPU deferred timing gate without qualifying software timing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-auto-exposure-deferred-'));
  try {
    const bundlePath = join(directory, 'browser-bundle.json');
    const outputPath = join(directory, 'deferred.json');
    const gatePath = join(directory, 'gate.json');
    await writeFile(
      bundlePath,
      JSON.stringify({
        schemaVersion: 'hello-taa-auto-exposure-evidence-bundle/1',
        featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
        testedRevision: HEAD,
        workloads: {
          auto: {
            report: {
              featureEvidence: {
                source: { path: 'apps/hello/taa/src/main.ts', sha256: HASH },
                build: { path: 'apps/hello/taa/dist/index.html', sha256: HASH },
                fixtureIdentity: {
                  asset: { id: 'asset', sha256: HASH },
                  camera: { id: 'camera', sha256: HASH },
                  light: { id: 'light', sha256: HASH },
                  input: { id: 'input', sha256: HASH },
                },
                frameIdentity: {
                  first: 1,
                  last: 300,
                  count: 300,
                  contiguous: true,
                  sequenceSha256: HASH,
                },
                resolution: { width: 1920, height: 1080 },
              },
            },
          },
        },
      }),
    );
    await exec('node', [
      SCRIPT.pathname,
      `--bundle=${bundlePath}`,
      `--head=${HEAD}`,
      `--output=${outputPath}`,
      `--gate-output=${gatePath}`,
    ]);
    const deferred = JSON.parse(await readFile(outputPath, 'utf8'));
    const gate = JSON.parse(await readFile(gatePath, 'utf8'));
    assert.equal(deferred.status, 'blocked');
    assert.equal(deferred.executionMode, 'simulated');
    assert.equal(deferred.physicalGpu, false);
    assert.equal(deferred.timestampQuery, false);
    assert.equal(gate.status, 'blocked');
    assert.equal(gate.ciState, 'blocked');
    assert.equal(gate.deferred, true);
    assert.equal(gate.physicalGpu, false);
    assert.equal(gate.timestampQuery, false);
    assert.equal(gate.source, 'renderer-gpu-pass-timing-deferred');
    assert.equal(gate.identity.testedRevision, HEAD);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
