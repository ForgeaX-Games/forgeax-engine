import { describe, expect, it } from 'vitest';
import { compileShader } from '../index.js';

describe('compileShader source-attributed composition failures', () => {
  it('retains structured line and column when composition rejects WGSL syntax', async () => {
    const source = [
      '#define_import_path test::pulse',
      '#import forgeax_view::common',
      '',
      '@fragment',
      'fn fs_main() -> @location(0) vec4<f32> {',
      '  let broken = ;',
      '  return vec4<f32>(1.0);',
      '}',
    ].join('\n');

    const result = await compileShader(source, {
      id: '/workspace/pulse.wgsl',
      imports: {
        'forgeax_view::common': '#define_import_path forgeax_view::common\n',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.lineNum).toBe(6);
    expect(result.error.linePos).toBeGreaterThan(0);
    expect(result.error.expected).toBe('WGSL source parses + validates against naga IR');
    expect(result.error.hint).toContain('indicated line/column');
  });
});
