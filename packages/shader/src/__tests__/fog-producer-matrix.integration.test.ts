import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SHADER_FILES = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'unlit.wgsl',
  'sprite.wgsl',
  'sprite-lit.wgsl',
  'msdf-text.wgsl',
  'skybox.wgsl',
] as const;

const shaderSource = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;

function producerContract(source: string): boolean {
  return (
    /#import\s+forgeax_view::common::\{[^}]*\bFogRay\b[^}]*\}/.test(source) &&
    /#import\s+forgeax_view::fog::\{[^}]*\bapply_fog\b[^}]*\}/.test(source) &&
    count(source, /\bapply_fog\s*\(/g) === 1 &&
    count(source, /\bFogRay\s*\(/g) >= 1 &&
    (source.includes('view.fog') || source.includes('viewParams.fog'))
  );
}

function body(source: string, entry: string, nextEntry: string): string {
  const start = source.indexOf(entry);
  const end = nextEntry === '' ? -1 : source.indexOf(nextEntry, start + entry.length);
  return source.slice(start, end === -1 ? source.length : end);
}

describe('built-in Fog producer matrix', () => {
  it('requires one shared Fog module call and a real FogRay for every built-in output', () => {
    for (const file of SHADER_FILES) {
      const source = shaderSource(file);
      expect(producerContract(source), file).toBe(true);
    }
  });

  it('keeps deferred G-buffer and temporal/reactive outputs free of Fog', () => {
    const pbr = shaderSource('default-standard-pbr.wgsl');
    const gbuffer = body(pbr, 'fn fs_gbuffer', 'struct TemporalVsOut');
    const temporal = body(pbr, 'fn fs_temporal', '');

    expect(gbuffer).not.toContain('applySceneFog(');
    expect(gbuffer).not.toContain('apply_fog(');
    expect(temporal).not.toContain('applySceneFog(');
    expect(temporal).not.toContain('apply_fog(');
  });

  it('turns deletion, duplication, and non-scene output coverage into red verdicts', () => {
    const source = shaderSource('default-standard-pbr.wgsl');
    expect(producerContract(source)).toBe(true);

    const deleted = source.replace(/#import\s+forgeax_view::fog::\{[^\n]+\}\n?/, '');
    expect(producerContract(deleted)).toBe(false);

    const duplicated = `${source}\n${source.match(/\bapply_fog\s*\([\s\S]*?\);/)?.[0] ?? ''}`;
    expect(producerContract(duplicated)).toBe(false);

    const gbufferStart = source.indexOf('fn fs_gbuffer');
    const gbufferFogged = `${source.slice(0, gbufferStart)}${source
      .slice(gbufferStart)
      .replace(
        'let baseUv =',
        'let _falsify = applySceneFog(vec3<f32>(1.0), 1.0, vec3<f32>(0.0));\n  let baseUv =',
      )}`;
    expect(gbufferFogged).not.toBe(source);
    expect(body(gbufferFogged, 'fn fs_gbuffer', 'struct TemporalVsOut')).toContain(
      'applySceneFog(',
    );
  });
});
