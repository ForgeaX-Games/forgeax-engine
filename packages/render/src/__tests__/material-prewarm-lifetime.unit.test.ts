import { err, ok, RhiError, type ShaderModule } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { prewarmMaterialShaderVariants } from '../assembly/shader-prewarm-policy';

const variant = (key: string, source = key) => ({
  definesKey: key,
  defines: {},
  composedWgsl: source,
});

describe('material prewarm candidate lifetime', () => {
  it('deduplicates sources across bounded batches and preserves every exact draw label', async () => {
    const variants = Array.from({ length: 25 }, (_, i) => variant(String(i), String(i % 9)));
    const modules = new Map<string, ShaderModule>();
    const seeded = new Map<string, ShaderModule>();
    let active = 0;
    let peak = 0;
    const compile = vi.fn(async (row: ReturnType<typeof variant>) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return ok({ source: row.composedWgsl } as unknown as ShaderModule);
    });
    await prewarmMaterialShaderVariants('material', variants, modules, compile, (label, module) =>
      seeded.set(label, module),
    );
    expect(compile).toHaveBeenCalledTimes(9);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    expect(seeded.size).toBe(25);
    for (const row of variants)
      expect(seeded.get(`module-material#${row.definesKey}`)).toBe(modules.get(row.composedWgsl));
  });

  it('settles late sibling compilation before rejecting a failed candidate', async () => {
    const failure = new RhiError({
      code: 'shader-compile-failed',
      expected: 'valid fixture shader',
      hint: 'intentional compile failure',
    });
    let finishLate = () => {};
    const late = new Promise<void>((resolve) => {
      finishLate = resolve;
    });
    const seed = vi.fn();
    let terminal = false;
    const pending = prewarmMaterialShaderVariants(
      'material',
      [variant('bad'), variant('late')],
      new Map(),
      async (row) => {
        if (row.definesKey === 'bad') return err(failure);
        await late;
        return ok({} as ShaderModule);
      },
      seed,
    );
    const checked = pending.catch((error: unknown) => {
      terminal = true;
      expect(error).toBe(failure);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(terminal).toBe(false);
    expect(seed).not.toHaveBeenCalled();
    finishLate();
    await checked;
    expect(terminal).toBe(true);
    expect(seed).not.toHaveBeenCalled();
  });
});
