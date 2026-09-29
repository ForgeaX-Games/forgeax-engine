import { beforeAll, describe, expect, it } from 'vitest';

interface NodeFs {
  readFileSync(path: string, encoding: string): string;
}

interface NodePath {
  dirname(path: string): string;
  resolve(...parts: string[]): string;
}

interface NodeUrl {
  fileURLToPath(url: string): string;
}

interface CompilerModule {
  compileShader(
    source: string,
    options: {
      readonly id: string;
      readonly imports?: Readonly<Record<string, string>>;
    },
  ): Promise<{ readonly ok: boolean; readonly error?: { readonly code: string } }>;
}

let source = '';
let producerSource = '';

beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ 'node:fs')) as unknown as NodeFs;
  const path = (await import(/* @vite-ignore */ 'node:path')) as unknown as NodePath;
  const url = (await import(/* @vite-ignore */ 'node:url')) as unknown as NodeUrl;
  source = fs.readFileSync(
    path.resolve(
      path.dirname(url.fileURLToPath(import.meta.url)),
      '..',
      'atmosphere-daylight.wgsl',
    ),
    'utf8',
  );
  producerSource = fs.readFileSync(
    path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'atmosphere-cubemap.wgsl'),
    'utf8',
  );
});

describe('bounded analytic daylight artifact', () => {
  it('passes the build-time Naga validation path', async () => {
    const compiler = (await import(
      /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
    )) as unknown as CompilerModule;
    const result = await compiler.compileShader(source, {
      id: 'forgeax_environment::daylight',
    });
    expect(result.ok).toBe(true);
  });

  it('validates the sole cubemap producer caller through composition', async () => {
    const compiler = (await import(
      /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
    )) as unknown as CompilerModule;
    const result = await compiler.compileShader(producerSource, {
      id: 'forgeax_environment::cubemap',
      imports: { 'forgeax_environment::daylight': source },
    });
    expect(result.ok).toBe(true);
    expect(producerSource.match(/daylight_sky_radiance\s*\(/g) ?? []).toHaveLength(1);
    expect(producerSource).toContain('atmosphere.circumsolarStrength');
    expect(producerSource).toContain('atmosphere.circumsolarWidth');
    expect(producerSource).not.toMatch(/-input\.direction\.y/);
  });
});
