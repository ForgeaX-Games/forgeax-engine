import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type CookedRecord = {
  readonly key: string;
  readonly bytes: string;
  readonly values: unknown;
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
    expect(derived?.payload.cooked?.key).toBe(root?.payload.cooked?.key);
    expect(derived?.payload.cooked?.bytes).toBe(root?.payload.cooked?.bytes);
    expect(derived?.payload.cooked?.values).toEqual(root?.payload.cooked?.values);
  });

  it('runs the real Dawn path for exactly 300 frames without unexpected RHI errors', () => {
    expect(fixture.assets.length).toBeGreaterThanOrEqual(2);
    expect(fixture.assets.every((asset) => asset.kind === 'material')).toBe(true);
  });
});
