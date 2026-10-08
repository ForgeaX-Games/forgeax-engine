import * as naga from '@forgeax/engine-naga';
import { afterEach, expect, it, vi } from 'vitest';
import * as compiler from '../../compile.js';
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

it('shares concurrent real composition and keeps every result independently mutable', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const compile = createMaterialProgramCompiler();
  const [firstResult, secondResult] = await Promise.all([
    compile(source, options),
    compile(source, options),
  ]);
  const first = firstResult.unwrap();
  const second = secondResult.unwrap();
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  first.deps.push('consumer-mutation');
  Object.assign(first.reflection, { consumerMutation: true });
  expect(second.deps).not.toContain('consumer-mutation');
  expect(second.reflection).not.toHaveProperty('consumerMutation');
  expect(compose).toHaveBeenCalledTimes(1);
});

it('releases concurrent failed composition and permits the same input to retry', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const compile = createMaterialProgramCompiler();
  const bad = {
    ...options,
    imports: { 'test::color': '#define_import_path test::color\ninvalid source' },
  };
  const results = await Promise.all([compile(source, bad), compile(source, bad)]);
  expect(results.every((result) => !result.ok)).toBe(true);
  expect(compose).toHaveBeenCalledTimes(1);
  expect((await compile(source, bad)).ok).toBe(false);
  expect(compose).toHaveBeenCalledTimes(2);
  expect((await compile(source, options)).ok).toBe(true);
});

it('shares composition across entry selections while validating every selected entry', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const compile = createMaterialProgramCompiler();
  const alternate = `${source}\n@vertex fn vs_alternate() -> @builtin(position) vec4<f32> { return vec4<f32>(1.0); }`;
  const first = (await compile(alternate, options)).unwrap();
  const second = (
    await compile(alternate, {
      ...options,
      id: 'test::alternate-selection',
      renderEntries: { ...options.renderEntries, vertex: 'vs_alternate' },
    })
  ).unwrap();
  expect(second).toEqual(first);
  expect((await compile(alternate, { ...options, renderEntries: { vertex: 'missing' } })).ok).toBe(
    false,
  );
  expect(
    (
      await compile(alternate, {
        ...options,
        renderEntries: { ...options.renderEntries, colorFormats: ['r32uint'] },
      })
    ).ok,
  ).toBe(false);
  expect(compose).toHaveBeenCalledTimes(1);
});

it('reuses composition without sharing mutable results or material state', async () => {
  const underlying = vi.spyOn(naga, 'composeShader');
  const compile = createMaterialProgramCompiler();
  const first = (await compile(source, options)).unwrap();
  const expected = structuredClone(first);
  first.deps.push('consumer-mutation');
  Object.assign(first.reflection, { consumerMutation: true });
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
  const underlying = vi.spyOn(naga, 'composeShader');
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

it('bounds pending composition entries and does not reinsert evicted completions', async () => {
  const result = await compiler.compileShader('@compute @workgroup_size(1) fn main() {}');
  vi.spyOn(compiler, 'compileShaderProgram').mockResolvedValue(result);
  const completions: Array<() => void> = [];
  const compose = vi
    .spyOn(naga, 'composeShader')
    .mockImplementation(
      (entry) => new Promise<string>((resolve) => completions.push(() => resolve(entry))),
    );
  const compile = createMaterialProgramCompiler();
  const entry = (i: number) => `@compute @workgroup_size(1) fn main() { let value = ${i}u; }`;
  const pending = Array.from({ length: 129 }, (_, i) => compile(entry(i)));
  try {
    expect(compose).toHaveBeenCalledTimes(129);
    completions[0]?.();
    expect((await pending[0])?.ok).toBe(true);
    const repeated = compile(entry(0));
    pending.push(repeated);
    expect(compose).toHaveBeenCalledTimes(130);
  } finally {
    for (const complete of completions) complete();
    await Promise.all(pending);
  }
});

it('does not retain oversized pending inputs or completed WGSL payloads', async () => {
  const entry = '@compute @workgroup_size(1) fn main() {}';
  const result = await compiler.compileShader(entry);
  vi.spyOn(compiler, 'compileShaderProgram').mockResolvedValue(result);
  // Three-byte UTF-8 content keeps the same byte limit with fewer scanned characters.
  const oversized = `/*${'\u0800'.repeat(Math.ceil((16 * 1024 * 1024) / 3))}*/\n${entry}`;
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(16 * 1024 * 1024);
  const compose = vi.spyOn(naga, 'composeShader').mockResolvedValue(entry);
  const compile = createMaterialProgramCompiler();
  expect((await Promise.all([compile(oversized), compile(oversized)])).every((r) => r.ok)).toBe(
    true,
  );
  expect(compose).toHaveBeenCalledTimes(2);
  compose.mockResolvedValue(oversized);
  expect((await compile(entry)).ok).toBe(true);
  expect((await compile(entry)).ok).toBe(true);
  expect(compose).toHaveBeenCalledTimes(4);
});

it('evicts older inputs instead of retaining an unbounded material history', async () => {
  const result = await compiler.compileShader('@compute @workgroup_size(1) fn main() {}');
  // This gate measures bounded composition retention; other cases exercise real validation.
  vi.spyOn(compiler, 'compileShaderProgram').mockResolvedValue(result);
  const underlying = vi.spyOn(naga, 'composeShader').mockImplementation(async (source) => source);
  const compile = createMaterialProgramCompiler();
  const entry = (i: number) => `@compute @workgroup_size(1) fn main() { let value = ${i}u; }`;
  for (let i = 0; i < 129; i++) expect((await compile(entry(i))).ok).toBe(true);
  expect((await compile(entry(0))).ok).toBe(true);
  expect(underlying).toHaveBeenCalledTimes(130);
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

it('reuses composition for absent defines without changing pure compiler output', async () => {
  const plain = (await compiler.compileShader(source, options)).unwrap();
  const flaggedOptions = { ...options, defines: { UNUSED_CAPABILITY: true } };
  const flagged = (await compiler.compileShader(source, flaggedOptions)).unwrap();
  expect(flagged).toEqual(plain);
  const compose = vi.spyOn(naga, 'composeShader');
  const validation = vi.spyOn(compiler, 'compileShaderProgram');
  const compile = createMaterialProgramCompiler();
  expect((await compile(source, options)).unwrap()).toEqual(plain);
  expect((await compile(source, flaggedOptions)).unwrap()).toEqual(flagged);
  expect(compose).toHaveBeenCalledTimes(1);
  expect(validation).toHaveBeenCalledTimes(1);
});

it('reflects dynamic offsets independently of retained composition', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const compile = createMaterialProgramCompiler();
  const entry = `@group(0) @binding(0) var<uniform> offset: vec4<f32>;
@group(0) @binding(1) var<storage, read_write> output: vec4<f32>;
@compute @workgroup_size(1) fn main() { output = offset; }`;
  const first = (await compile(entry)).unwrap();
  const second = (await compile(entry, { dynamicOffsets: [{ group: 0, binding: 0 }] })).unwrap();
  expect(second.wgsl).toBe(first.wgsl);
  expect(second.bindings[0]?.entries[0]?.buffer?.hasDynamicOffset).toBe(true);
  expect(first.bindings[0]?.entries[0]?.buffer?.hasDynamicOffset).toBe(false);
  expect(compose).toHaveBeenCalledTimes(1);
});

it('does not let a retained composition hide malformed unused defines', async () => {
  const compile = createMaterialProgramCompiler();
  expect((await compile(source, options)).ok).toBe(true);
  const malformed = { ...options, defines: { UNUSED: 1 } as unknown as Record<string, boolean> };
  const expected = await compiler.compileShader(source, malformed);
  const actual = await compile(source, malformed);
  expect(expected.ok).toBe(false);
  expect(actual.ok).toBe(false);
  if (!expected.ok && !actual.ok) expect(actual.error.code).toBe(expected.error.code);
});

it('shares actual WGSL validation while retaining each source dependency projection', async () => {
  const compile = createMaterialProgramCompiler();
  const validation = vi.spyOn(compiler, 'compileShaderProgram');
  const first = (await compile(source, options)).unwrap();
  const expanded = {
    ...options,
    id: 'test::different-owner',
    imports: {
      ...options.imports,
      'test::unused': '#define_import_path test::unused\nfn unused() -> f32 { return 1.0; }',
    },
  };
  const second = (await compile(source, expanded)).unwrap();
  expect(second.wgsl).toBe(first.wgsl);
  expect(second.deps).toEqual(['test::color', 'test::unused']);
  expect(first.deps).toEqual(['test::color']);
  expect(validation).toHaveBeenCalledTimes(1);
  expect(second).toEqual((await compiler.compileShader(source, expanded)).unwrap());
});

it('retains one composition while validating many independent entry selections', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const compile = createMaterialProgramCompiler();
  const expected = (await compiler.compileShader(source, options)).unwrap();
  compose.mockClear();
  for (let index = 0; index < 130; index++) {
    const actual = (await compile(source, { ...options, id: `test::selection-${index}` })).unwrap();
    expect(actual).toEqual(expected);
  }
  expect((await compile(source, { ...options, renderEntries: { vertex: 'missing' } })).ok).toBe(
    false,
  );
  expect(compose).toHaveBeenCalledTimes(1);
});
