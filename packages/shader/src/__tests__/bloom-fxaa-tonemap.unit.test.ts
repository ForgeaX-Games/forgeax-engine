import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shaderRoot = resolve(import.meta.dirname, '..');
const tonemap = readFileSync(resolve(shaderRoot, 'tonemap.wgsl'), 'utf8');
const bloom = readFileSync(resolve(shaderRoot, 'bloom-blur.wgsl'), 'utf8');
const fxaa = readFileSync(resolve(shaderRoot, 'fxaa.wgsl'), 'utf8');

describe('post shader color-domain contract', () => {
  it('marks tone as the only HDR-to-LDR transition', () => {
    expect(tonemap).toContain('linearHdrColorDomain');
    expect(tonemap).toContain('linearLdrColorDomain');
  });

  it('keeps bloom and FXAA in linear domains', () => {
    expect(bloom).toContain('linearHdrColorDomain');
    expect(fxaa).toContain('linearLdrColorDomain');
    expect(fxaa).toContain('linearToSrgbOetf');
  });

  it('does not blend into an encoded destination', () => {
    expect(`${tonemap}\n${bloom}\n${fxaa}`).not.toContain('encodedDestinationBlend');
  });

  it('preserves source alpha through the output pass', () => {
    expect(tonemap).toContain('let source = textureSample(hdr, samp, in.uv);');
    expect(tonemap).toContain('return vec4<f32>(mapped, source.a);');
    expect(tonemap).not.toContain('return vec4<f32>(mapped, 1.0);');
  });
});
