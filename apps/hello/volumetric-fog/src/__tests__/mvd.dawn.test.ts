import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('volumetric fog Dawn MVD probe', () => {
  it('publishes a fresh-head artifact with capability, sample, memory and recovery facts', async () => {
    const expectedFrames = Number.parseInt(
      process.env.SMOKE_MIN_FRAMES ?? (process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? '24' : '60'),
      10,
    );
    const result = await execFileAsync(
      process.execPath,
      [`${import.meta.dirname}/../../scripts/smoke-dawn.mjs`, '--json'],
      { env: { ...process.env, FORGEAX_DAWN_CHILD: '1' } },
    );
    // Native Dawn may print WGSL diagnostics to stdout before the JSON
    // artifact. Select the final object line rather than making the artifact
    // contract depend on a backend's diagnostic stream.
    const artifactLine = result.stdout
      .trim()
      .split(/\r?\n/)
      .findLast((line) => line.trim().startsWith('{') && line.trim().endsWith('}'));
    if (artifactLine === undefined) {
      throw new Error(`volumetric-fog Dawn smoke did not publish JSON: ${result.stdout}`);
    }
    const artifact = JSON.parse(artifactLine) as Record<string, unknown>;
    expect(artifact.backend).toBe('dawn');
    expect(artifact.framesObserved).toBeGreaterThanOrEqual(expectedFrames);
    expect(['pass', 'unavailable', 'mismatch']).toContain(artifact.oracle?.status);
    if (artifact.oracle?.status === 'pass') {
      expect(artifact.pass).toBe(true);
      expect(artifact.readback?.supported).toBe(true);
    } else {
      expect(artifact.pass).toBe(false);
    }
    expect(artifact.sample).toMatchObject({ generation: 1 });
    expect(artifact.recovery).toMatchObject({ status: 'not-needed' });
    expect(typeof artifact.head).toBe('string');
    expect((artifact.head as string).length).toBeGreaterThan(0);
    expect(artifact.memoryBytes).toBeGreaterThan(0);
  });
});
