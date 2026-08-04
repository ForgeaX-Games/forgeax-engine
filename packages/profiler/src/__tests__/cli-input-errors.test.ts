import { describe, expect, it } from 'vitest';
import { runProfilerCli } from '../cli.js';

function expectStructuredError(
  result: { stdout: string; stderr: string; exitCode: number },
  code: string,
): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe('');
  const parsed = JSON.parse(result.stderr) as {
    error?: { code?: string; expected?: string; hint?: string; detail?: unknown };
  };
  expect(parsed).toEqual({
    error: {
      code,
      expected: expect.any(String),
      hint: expect.any(String),
      detail: expect.anything(),
    },
  });
}

describe('profiler CLI input error contract', () => {
  it('rejects empty stdin without producing a summary', () => {
    expectStructuredError(runProfilerCli(['summary'], ''), 'cli-input-empty');
  });

  it('rejects malformed JSON from stdin', () => {
    expectStructuredError(
      runProfilerCli(['summary'], '{"schemaVersion":'),
      'cli-input-invalid-json',
    );
  });

  it('rejects a missing file before model analysis', () => {
    expectStructuredError(
      runProfilerCli(['summary', '--file', '/tmp/forgeax-profiler-missing-capture.json'], ''),
      'cli-input-file-read-failed',
    );
  });

  it('rejects schema-invalid JSON as a structured artifact error', () => {
    expectStructuredError(
      runProfilerCli(['summary'], '{"schemaVersion":"1.0"}'),
      'profile-artifact-invalid',
    );
  });

  it('rejects unsupported artifact versions without guessing fields', () => {
    expectStructuredError(
      runProfilerCli(
        ['summary'],
        JSON.stringify({
          schemaVersion: '9.0',
          captureId: 'capture-0001',
          timeUnit: 'microseconds',
          frameLimit: 1,
          eventLimit: 1,
          phaseCatalog: { app: [], render: [] },
          records: [],
          completeness: { status: 'partial', retainedEventCount: 0, droppedEventCount: 0 },
        }),
      ),
      'profile-artifact-incompatible',
    );
  });

  it('rejects non-positive and unsafe frame identifiers', () => {
    const input = JSON.stringify({
      schemaVersion: '1.0',
      captureId: 'capture-0001',
      timeUnit: 'microseconds',
      frameLimit: 1,
      eventLimit: 1,
      phaseCatalog: { app: ['input'], render: [] },
      records: [],
      completeness: { status: 'partial', retainedEventCount: 0, droppedEventCount: 0 },
    });

    expectStructuredError(runProfilerCli(['frame', '--frame-id', '0'], input), 'cli-query-invalid');
    expectStructuredError(
      runProfilerCli(['frame', '--frame-id', '9007199254740992'], input),
      'cli-query-invalid',
    );
  });

  it('rejects unknown flags and missing phase selectors', () => {
    const input = JSON.stringify({
      schemaVersion: '1.0',
      captureId: 'capture-0001',
      timeUnit: 'microseconds',
      frameLimit: 1,
      eventLimit: 1,
      phaseCatalog: { app: ['input'], render: [] },
      records: [],
      completeness: { status: 'partial', retainedEventCount: 0, droppedEventCount: 0 },
    });

    expectStructuredError(runProfilerCli(['summary', '--unknown'], input), 'cli-arguments-invalid');
    expectStructuredError(
      runProfilerCli(['phase', '--source', 'app'], input),
      'cli-arguments-invalid',
    );
  });
});
