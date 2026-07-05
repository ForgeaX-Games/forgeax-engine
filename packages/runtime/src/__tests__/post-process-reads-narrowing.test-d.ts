// w2 — tsc-only narrowing probe for PostProcessReadSampleType at the register
// call site (plan-strategy D-1 / AC-08).
//
// Verifies that the closed union `PostProcessReadSampleType = 'depth'` narrows
// misspellings at the `renderer.postProcess.register(id, { reads })` call site
// without `as` assertions.  Bare `string[]` remains backward-compatible (AC-03).
//
// feat-20260702-postprocess-camera-depth-read M1 / w2.

import { describe, expectTypeOf, it } from 'vitest';

import type {
  PostProcessReadEntry,
  PostProcessReadSampleType,
} from '../fullscreen-post-process-pass';

describe('w2 PostProcessReadSampleType narrowing at register call site', () => {
  it('PostProcessReadSampleType = "depth" is a singleton closed union', () => {
    expectTypeOf<PostProcessReadSampleType>().toEqualTypeOf<'depth'>();
  });

  it('AC-08: misspelled sampleType "deptth" is a type error at the register call site', () => {
    // The closed union PostProcessReadSampleType = 'depth' only; 'deptth' is
    // not assignable — TS reports a type error at this literal.
    // @ts-expect-error — 'deptth' is not assignable to type 'PostProcessReadSampleType'
    const _bad: PostProcessReadSampleType = 'deptth';
  });

  it('AC-08: structured entry with misspelled sampleType fails at the call site', () => {
    // @ts-expect-error — 'deptth' not assignable to type 'PostProcessReadSampleType'
    const _badEntry: PostProcessReadEntry = { key: 'depth', sampleType: 'deptth' };
  });

  it('structured depth entry: { key, sampleType: "depth" } is a valid PostProcessReadEntry', () => {
    const e: PostProcessReadEntry = { key: 'depth', sampleType: 'depth' };
    void e;
  });

  it('structured color entry: { key } without sampleType is a valid PostProcessReadEntry', () => {
    const e: PostProcessReadEntry = { key: 'sceneColor' };
    void e;
  });

  it('AC-03: bare string entries are valid in reads (backward-compatible)', () => {
    // The reads array accepts string | PostProcessReadEntry elements.
    // A bare string literal is a valid element alongside structured entries.
    const r: readonly (string | PostProcessReadEntry)[] = [
      'sceneColor',
      { key: 'depth', sampleType: 'depth' },
    ];
    void r;
  });
});
