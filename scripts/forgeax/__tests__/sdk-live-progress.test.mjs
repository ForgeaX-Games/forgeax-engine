import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { sdkStage } from '../sdk-stage.mjs';

const verifier = await readFile(new URL('../verify-sdk.mjs', import.meta.url), 'utf8');
const start = verifier.indexOf('const execFileAsync =');
const end = verifier.indexOf('const args =', start);
assert.ok(start >= 0 && end > start);
const invoke = new Function(
  'execute',
  'sdkStage',
  'process',
  `${verifier.slice(start, end)}\nreturn execFileAsync;`,
);

test('source View progress reaches stderr before its child can finish', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'sdk-live-progress-'));
  const acknowledgement = resolve(root, 'observed');
  const messages = [];
  const writes = [];
  const run = invoke(promisify(execFile), sdkStage, {
    stderr: {
      write(chunk) {
        messages.push(String(chunk));
        if (messages.join('').includes('live-error-channel'))
          writes.push(writeFile(acknowledgement, 'observed'));
      },
    },
    stdout: { write: () => assert.fail('progress must not contaminate the final JSON') },
  });
  try {
    const result = await run(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');
process.stdout.write('live-stage');process.stderr.write('live-error-channel');
const poll=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(poll);clearTimeout(deadline);}},10);
const deadline=setTimeout(()=>{clearInterval(poll);process.exitCode=17;},2000);`,
        acknowledgement,
      ],
      { streamOutput: true },
    );
    assert.equal(result.stdout, 'live-stage');
    assert.equal(result.stderr, 'live-error-channel');
    assert.ok(messages.join('').includes('live-stage'));
    assert.ok(messages.join('').includes('live-error-channel'));
  } finally {
    await Promise.all(writes);
    await rm(root, { recursive: true, force: true });
  }
});

test('only the source View child opts into live output', () => {
  assert.equal(verifier.match(/streamOutput: true/g)?.length, 1);
  assert.match(
    verifier,
    /verifyPublicSourceViewTool[\s\S]*verify-diagnostic-pages\.mjs[\s\S]*streamOutput: true/,
  );
});
