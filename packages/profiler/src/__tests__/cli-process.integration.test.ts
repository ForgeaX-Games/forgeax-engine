import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/cli/valid-capture.json', import.meta.url));

function readFixture(): string {
  return readFileSync(fixturePath, 'utf8');
}

function runCli(args: readonly string[], input: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    input,
    encoding: 'utf8',
  });
}

function parseObject(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

describe('profiler CLI public process contract', () => {
  it('prints deterministic summary, frame, and phase JSON through the built entry', () => {
    const input = readFixture();
    const summary = runCli(['summary'], input);
    const summaryRepeat = runCli(['summary'], input);
    const frame = runCli(['frame', '--frame-id', '2'], input);
    const phase = runCli(['phase', '--source', 'render', '--phase', 'submit'], input);

    expect(summary.status).toBe(0);
    expect(summary.stderr).toBe('');
    expect(parseObject(summary.stdout)).toEqual(parseObject(summaryRepeat.stdout));
    expect(parseObject(summary.stdout)).toMatchObject({
      query: 'summary',
      captureId: 'capture-0042',
      completeness: { status: 'complete' },
    });
    expect(frame.status).toBe(0);
    expect(parseObject(frame.stdout)).toMatchObject({ query: 'frame', frameId: 2 });
    expect(phase.status).toBe(0);
    expect(parseObject(phase.stdout)).toMatchObject({
      query: 'phase',
      source: 'render',
      phase: 'submit',
    });
  });

  it('accepts file input and keeps invalid input on stderr as one error object', () => {
    const fromFile = runCli(['summary', '--file', fixturePath], '');
    const invalid = runCli(['summary'], '{"schemaVersion":');

    expect(fromFile.status).toBe(0);
    expect(fromFile.stderr).toBe('');
    expect(parseObject(fromFile.stdout)).toMatchObject({ captureId: 'capture-0042' });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).toBe('');
    expect(parseObject(invalid.stderr)).toEqual({
      error: {
        code: 'cli-input-invalid-json',
        expected: expect.any(String),
        hint: expect.any(String),
        detail: expect.any(Object),
      },
    });
  });
});
