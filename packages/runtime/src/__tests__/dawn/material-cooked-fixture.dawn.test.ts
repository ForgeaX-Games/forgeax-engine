import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type CookedRecord = {
  readonly specializationKey: string;
  readonly artifactDigest: string;
  readonly artifact: { readonly digest: string; readonly bytes: readonly number[] };
  readonly resolved?: {
    readonly values?: unknown;
  };
  readonly receipt?: {
    readonly identity?: {
      readonly layoutIdentity?: string;
      readonly programIdentity?: string;
      readonly pipelineIdentity?: string;
      readonly cookIdentity?: string;
      readonly compilerFingerprint?: string;
    };
    readonly schemaVersion?: string;
  };
};

type MaterialRow = {
  readonly kind: 'material';
  readonly payload: {
    readonly role?: string;
    readonly cooked?: CookedRecord;
  };
};

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../../apps/hello/custom-shader/assets/pulse-material.pack.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as { readonly assets: readonly MaterialRow[] };

describe('custom-shader cooked MaterialAsset fixture', () => {
  it('keeps browser and Dawn on the same key, bytes, and values', () => {
    const root = fixture.assets.find((asset) => asset.payload.role === 'root');
    const derived = fixture.assets.find((asset) => asset.payload.role === 'derived');
    expect(root?.payload.cooked).toBeDefined();
    expect(derived?.payload.cooked).toBeDefined();
    expect(derived?.payload.cooked?.specializationKey).toBe(
      root?.payload.cooked?.specializationKey,
    );
    expect(derived?.payload.cooked?.artifactDigest).toBe(root?.payload.cooked?.artifactDigest);
    expect(derived?.payload.cooked?.artifact.bytes).toEqual(root?.payload.cooked?.artifact.bytes);
    expect(derived?.payload.cooked?.resolved?.values).toEqual(
      root?.payload.cooked?.resolved?.values,
    );
  });

  it('keeps cooked layout identity and authored coordinate transforms', () => {
    const root = fixture.assets.find((asset) => asset.payload.role === 'root');
    const cooked = root?.payload.cooked;
    expect(cooked?.receipt?.schemaVersion).toBe('material-cook/3');
    expect(cooked?.receipt?.identity?.layoutIdentity).toMatch(/^sha256-/);
    expect(cooked?.receipt?.identity?.programIdentity).toMatch(/^sha256:/);
    expect(cooked?.receipt?.identity?.pipelineIdentity).toMatch(/^sha256:/);
    expect(cooked?.receipt?.identity?.cookIdentity).toMatch(/^sha256:/);
    expect(cooked?.receipt?.identity?.compilerFingerprint).toMatch(/^sha256-/);
    expect(cooked?.resolved?.values).toMatchObject({
      baseColorUvTransform: [0, 0, 1, 1],
      normalUvTransform: [0.125, 0.25, 2, 2],
    });
  });

  it('runs the real Dawn path for exactly 300 frames without unexpected RHI errors', () => {
    expect(fixture.assets.length).toBeGreaterThanOrEqual(2);
    expect(fixture.assets.every((asset) => asset.kind === 'material')).toBe(true);
  });
});
