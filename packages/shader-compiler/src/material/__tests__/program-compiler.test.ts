import { afterEach, expect, it, vi } from 'vitest';
import * as compiler from '../../index.js';
import { createMaterialProgramCompiler } from '../program-compiler.js';

const source = `#import test::color::{color}
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return color(); }`;
const options = {
  id: 'test::entry',
  imports: {
    'test::color':
      '#define_import_path test::color\nfn color() -> vec4<f32> { return vec4<f32>(0.25); }',
  },
  renderEntries: { vertex: 'vs_main', fragment: 'fs_main' },
};
afterEach(() => vi.restoreAllMocks());

it('reuses validated programs without sharing mutable results or material state', async () => {
  const underlying = vi.spyOn(compiler, 'compileShader');
  const compile = createMaterialProgramCompiler();
  const first = (await compile(source, options)).unwrap();
  const expected = structuredClone(first);
  first.deps.push('consumer-mutation');
  const second = (await compile(source, options)).unwrap();
  expect(second).toEqual(expected);
  expect(underlying).toHaveBeenCalledTimes(1);
  const independent = createMaterialProgramCompiler();
  expect((await independent(source, options)).unwrap()).toEqual(expected);
  expect(underlying).toHaveBeenCalledTimes(2);
});

it('recompiles changed imported bytes and validates changed render entries and formats', async () => {
  const compile = createMaterialProgramCompiler();
  const first = (await compile(source, options)).unwrap();
  const changed = (
    await compile(source, {
      ...options,
      imports: { 'test::color': options.imports['test::color'].replace('0.25', '0.75') },
    })
  ).unwrap();
  expect(changed.wgsl).not.toBe(first.wgsl);
  expect(changed.manifestEntry.hash).not.toBe(first.manifestEntry.hash);
  expect((await compile(source, { ...options, renderEntries: { vertex: 'missing' } })).ok).toBe(
    false,
  );
  expect(
    (
      await compile(source, {
        ...options,
        renderEntries: {
          ...options.renderEntries,
          colorFormats: ['r32uint'],
        },
      })
    ).ok,
  ).toBe(false);
});

it('does not retain failed inputs and accepts their subsequent repair', async () => {
  const underlying = vi.spyOn(compiler, 'compileShader');
  const compile = createMaterialProgramCompiler();
  const bad = {
    ...options,
    imports: { 'test::color': '#define_import_path test::color\ninvalid source' },
  };
  expect((await compile(source, bad)).ok).toBe(false);
  expect((await compile(source, bad)).ok).toBe(false);
  expect(underlying).toHaveBeenCalledTimes(2);
  expect((await compile(source, options)).ok).toBe(true);
});

it('evicts older inputs instead of retaining an unbounded material history', async () => {
  const underlying = vi.spyOn(compiler, 'compileShader');
  const compile = createMaterialProgramCompiler();
  const entry = '@compute @workgroup_size(1) fn main() {}';
  for (let i = 0; i < 65; i++) expect((await compile(entry, { id: `test::${i}` })).ok).toBe(true);
  expect((await compile(entry, { id: 'test::0' })).ok).toBe(true);
  expect(underlying).toHaveBeenCalledTimes(66);
});

it('keeps compile-time branches distinct even when the source string is unchanged', async () => {
  const compile = createMaterialProgramCompiler();
  const entry = `@group(0) @binding(0) var<storage, read_write> output: u32;
@compute @workgroup_size(1) fn main() {
#ifdef ALTERNATE
  output = 2u;
#else
  output = 1u;
#endif
}`;
  const first = (await compile(entry, { defines: { ALTERNATE: false } })).unwrap();
  const second = (await compile(entry, { defines: { ALTERNATE: true } })).unwrap();
  expect(first.wgsl).not.toBe(second.wgsl);
});
