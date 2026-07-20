// wgsl-language.ts -- shared WGSL CodeMirror StreamLanguage + HighlightStyle.
//
// Single source for the WGSL tokenizer + dark-theme highlight palette, consumed
// by both CodeMirrorWidget (F1 read-only display) and CodeMirrorShader (F2 edit
// mode). Extracted in M3/w15 so the ~130-line tokenizer is defined once (DRY).

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';

// ============================================================================
// WGSL stream tokenizer (CM6 StreamLanguage)
// ============================================================================

const wgslKeywords = new Set([
  'alias',
  'break',
  'case',
  'const',
  'const_assert',
  'continue',
  'continuing',
  'default',
  'diagnostic',
  'discard',
  'else',
  'enable',
  'false',
  'fn',
  'for',
  'if',
  'let',
  'loop',
  'override',
  'requires',
  'return',
  'struct',
  'switch',
  'true',
  'var',
  'while',
]);

const wgslTypes = new Set([
  'bool',
  'f16',
  'f32',
  'i32',
  'u32',
  'vec2',
  'vec3',
  'vec4',
  'mat2x2',
  'mat2x3',
  'mat2x4',
  'mat3x2',
  'mat3x3',
  'mat3x4',
  'mat4x2',
  'mat4x3',
  'mat4x4',
  'array',
  'atomic',
  'ptr',
  'sampler',
  'sampler_comparison',
  'texture_1d',
  'texture_2d',
  'texture_2d_array',
  'texture_3d',
  'texture_cube',
  'texture_cube_array',
  'texture_depth_2d',
  'texture_depth_2d_array',
  'texture_depth_cube',
  'texture_depth_cube_array',
  'texture_depth_multisampled_2d',
  'texture_multisampled_2d',
  'texture_storage_1d',
  'texture_storage_2d',
  'texture_storage_2d_array',
  'texture_storage_3d',
]);

const wgslBuiltins = new Set([
  'abs',
  'acos',
  'acosh',
  'all',
  'any',
  'arrayLength',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'ceil',
  'clamp',
  'cos',
  'cosh',
  'countLeadingZeros',
  'countOneBits',
  'countTrailingZeros',
  'cross',
  'degrees',
  'determinant',
  'distance',
  'dot',
  'dot4I8Packed',
  'dot4U8Packed',
  'exp',
  'exp2',
  'extractBits',
  'faceForward',
  'firstLeadingBit',
  'firstTrailingBit',
  'floor',
  'fma',
  'fract',
  'frexp',
  'insertBits',
  'inverseSqrt',
  'ldexp',
  'length',
  'log',
  'log2',
  'max',
  'min',
  'mix',
  'modf',
  'normalize',
  'pack2x16float',
  'pack2x16snorm',
  'pack2x16unorm',
  'pack4x8snorm',
  'pack4x8unorm',
  'pow',
  'quantizeToF16',
  'radians',
  'reflect',
  'refract',
  'reverseBits',
  'round',
  'saturate',
  'select',
  'sign',
  'sin',
  'sinh',
  'smoothstep',
  'sqrt',
  'step',
  'storageBarrier',
  'tan',
  'tanh',
  'textureBarrier',
  'textureDimensions',
  'textureGather',
  'textureGatherCompare',
  'textureLoad',
  'textureNumLayers',
  'textureNumLevels',
  'textureNumSamples',
  'textureSample',
  'textureSampleBias',
  'textureSampleCompare',
  'textureSampleCompareLevel',
  'textureSampleGrad',
  'textureSampleLevel',
  'textureStore',
  'trunc',
  'unpack2x16float',
  'unpack2x16snorm',
  'unpack2x16unorm',
  'unpack4x8snorm',
  'unpack4x8unorm',
  'workgroupBarrier',
  'workgroupUniformLoad',
]);

/**
 * WGSL StreamLanguage tokenizer. CM6 StringStream.match() returns
 * boolean | RegExpMatchArray | null; we use match() + stream.current() to
 * classify the matched identifier text.
 */
export const wgslLanguage = StreamLanguage.define({
  startState() {
    return {};
  },
  token(stream, _state) {
    if (stream.eatSpace()) return null;

    // Line comment
    const matchedSlash = stream.match('//', true);
    if (matchedSlash) {
      stream.skipToEnd();
      return 'comment';
    }

    // Strings
    if (stream.peek() === '"') {
      stream.next();
      for (;;) {
        const ch = stream.peek();
        if (ch === undefined) break;
        if (ch === '"') {
          stream.next();
          break;
        }
        if (ch === '\\') stream.next();
        stream.next();
      }
      return 'string';
    }

    // Attributes: @group, @binding, @location, etc.
    if (stream.peek() === '@') {
      stream.next();
      while (/[\w_]/.test(stream.peek() ?? '')) stream.next();
      return 'keyword';
    }

    // Hex float: 0x1.0p+1
    if (stream.match(/0[xX][0-9a-fA-F_]*\.[0-9a-fA-F_]+[pP][+-]?\d+/, true)) {
      return 'number';
    }

    // Hex int: 0xFF, 0x1A_B
    if (stream.match(/0[xX][0-9a-fA-F_]+/, true)) return 'number';

    // Decimal float with dot: 1.0f, 2.5, .5
    if (stream.match(/\d*\.\d+([eE][+-]?\d+)?[fh]?/, true)) return 'number';

    // Decimal with exponent: 1e10, 1e+10f
    if (stream.match(/\d+[eE][+-]?\d+[fh]?/, true)) return 'number';

    // Plain integer: 42, 42u, 42i
    if (stream.match(/\d+[uifh]?/, true)) return 'number';

    // Identifiers -- consume with match, then classify with current()
    if (stream.match(/[a-zA-Z_][\w]*/, true)) {
      const word = stream.current();
      if (wgslKeywords.has(word)) return 'keyword';
      if (wgslTypes.has(word)) return 'typeName';
      if (wgslBuiltins.has(word)) return 'builtin';
      return 'variableName';
    }

    // Operators / punctuation -- consume and skip
    if (/[+\-*/%&|^~!=<>?:;,()[\]{}]/.test(stream.peek() ?? '')) {
      stream.next();
      return 'operator';
    }

    stream.next();
    return null;
  },
});

// ============================================================================
// WGSL highlight style (dark-theme colors, coordinated with viewer theme)
// ============================================================================

const wgslHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#c678dd' },
  { tag: tags.typeName, color: '#e5c07b' },
  { tag: tags.variableName, color: '#abb2bf' },
  { tag: tags.definition(tags.variableName), color: '#61afef' },
  { tag: tags.special(tags.variableName), color: '#e06c75' },
  { tag: tags.comment, color: '#5c6370', fontStyle: 'italic' },
  { tag: tags.string, color: '#98c379' },
  { tag: tags.number, color: '#d19a66' },
  { tag: tags.operator, color: '#56b6c2' },
  { tag: tags.punctuation, color: '#abb2bf' },
]);

/** The syntax-highlighting extension pairing the WGSL style with the editor. */
export const wgslHighlighting: Extension = syntaxHighlighting(wgslHighlightStyle);
