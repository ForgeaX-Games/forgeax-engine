// shader-edit-type-inference.test-d.ts -- AC-04: compile-error structured-field
// type inference at the F2 edit -> apply consumption path.
//
// Simulates the two error-consumption code paths a CodeMirrorShader apply
// handler walks (parse/validate -> naga ShaderError; GPU createShaderModule ->
// RhiError). Asserts TypeScript narrows + reads the line-number-bearing fields
// through property access alone -- NO `as` type assertion (charter P3 explicit
// failure; AC-04 automated AC; research Finding 4).
//
// Truthful field shapes (read from source, not the prose):
//   - ShaderError.code / .lineNum / .linePos are top-level surface fields:
//     .code: ShaderErrorCode, .lineNum / .linePos: number | undefined
//     (naga/src/errors.ts -- always property-accessible, no narrowing needed).
//   - RhiError.detail is RhiErrorDetail | undefined, a FLAT union with no `code`
//     discriminant on its members (rhi/src/errors.ts). The shader-compile path's
//     member RhiShaderCompileDetail is the only one carrying `compilerMessages`,
//     so `'compilerMessages' in detail` narrows the union WITHOUT `as`.
//   - GPUCompilationMessage.lineNum is spec-typed `number`; the array element
//     access `compilerMessages[0]` is `GPUCompilationMessage | undefined` under
//     noUncheckedIndexedAccess, so `compilerMessages[0]?.lineNum` is
//     `number | undefined`.
//
// Related: requirements AC-04; plan-strategy D-3; research Finding 4.

/// <reference types="@webgpu/types" />

import type { ShaderError } from '@forgeax/engine-naga';
import type { RhiError } from '@forgeax/engine-rhi';
import { describe, expectTypeOf, it } from 'vitest';

describe('AC-04: compile-error structured-field type inference (no `as`)', () => {
  it('naga ShaderError parse path: .code guards line-number access, no `as`', () => {
    // Simulate the parse/validate failure consumer: when .code is the compile
    // path, read the line-number-bearing fields through property access. The
    // ShaderErrorCode union is the shared SSOT (@forgeax/engine-types); the apply
    // handler keys on the compile-failed member, not an exhaustive switch.
    function consumeShaderError(err: ShaderError): { line: number | undefined; msg: string } {
      if (err.code === 'shader-compile-failed') {
        return { line: err.lineNum, msg: err.message };
      }
      return { line: undefined, msg: err.hint };
    }
    expectTypeOf(consumeShaderError).returns.toEqualTypeOf<{
      line: number | undefined;
      msg: string;
    }>();
  });

  it('naga ShaderError.lineNum / .linePos: number | undefined via property access', () => {
    function readLine(err: ShaderError) {
      return err.lineNum;
    }
    function readCol(err: ShaderError) {
      return err.linePos;
    }
    // Top-level surface fields; no narrowing required.
    expectTypeOf(readLine).returns.toEqualTypeOf<number | undefined>();
    expectTypeOf(readCol).returns.toEqualTypeOf<number | undefined>();
  });

  it('naga ShaderError.code: shader-compile-failed assignable to .code field', () => {
    function readCode(err: ShaderError) {
      return err.code;
    }
    // 'shader-compile-failed' is one member of the closed union; assert it is
    // assignable to the code field type (property access, no `as`).
    expectTypeOf<'shader-compile-failed'>().toMatchTypeOf<ReturnType<typeof readCode>>();
  });

  it('GPU RhiError: detail narrows to compilerMessages via `in`, no `as`', () => {
    // Simulate the createShaderModule(device, {code}) failure consumer:
    // code is 'shader-compile-failed', detail carries RhiShaderCompileDetail.
    // The flat RhiErrorDetail union has no `code` discriminant, so narrow with
    // an `in` operator check (NOT a cast).
    function readGpuLine(err: RhiError): number | undefined {
      if (err.code !== 'shader-compile-failed') return undefined;
      const detail = err.detail;
      if (detail === undefined) return undefined;
      if (!('compilerMessages' in detail)) return undefined;
      // detail is now narrowed to RhiShaderCompileDetail (the only union member
      // with compilerMessages) -- property access, no `as`.
      return detail.compilerMessages[0]?.lineNum;
    }
    expectTypeOf(readGpuLine).returns.toEqualTypeOf<number | undefined>();
  });

  it('GPU RhiError: compilerMessages element is GPUCompilationMessage | undefined', () => {
    function readFirstMessage(err: RhiError): GPUCompilationMessage | undefined {
      if (err.code !== 'shader-compile-failed') return undefined;
      const detail = err.detail;
      if (detail === undefined || !('compilerMessages' in detail)) return undefined;
      return detail.compilerMessages[0];
    }
    // noUncheckedIndexedAccess makes the element access include undefined.
    expectTypeOf(readFirstMessage).returns.toEqualTypeOf<GPUCompilationMessage | undefined>();
  });

  it('GPU RhiError: compilerMessages[].message / .type / .linePos via property access', () => {
    function readFields(err: RhiError) {
      if (err.code !== 'shader-compile-failed') return undefined;
      const detail = err.detail;
      if (detail === undefined || !('compilerMessages' in detail)) return undefined;
      const msg = detail.compilerMessages[0];
      if (msg === undefined) return undefined;
      // Per the GPUCompilationMessage spec, lineNum / linePos are number (not
      // optional); message is string; type is GPUCompilationMessageType.
      return { message: msg.message, line: msg.lineNum, col: msg.linePos, type: msg.type };
    }
    expectTypeOf(readFields).returns.toEqualTypeOf<
      { message: string; line: number; col: number; type: GPUCompilationMessageType } | undefined
    >();
  });
});
