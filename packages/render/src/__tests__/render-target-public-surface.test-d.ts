import { describe, expectTypeOf, it } from 'vitest';
import type {
  RenderError,
  RenderErrorCode,
  Renderer,
  RenderTarget,
  RenderTargetDescriptor,
  RenderTargetFormat,
  RenderTargetReadbackTicket,
  RenderTargetShape,
  RenderTargetTextureSource,
} from '../index';

const formats = [
  'rgba16float',
  'rgba8unorm',
  'rgba8unorm-srgb',
] as const satisfies readonly RenderTargetFormat[];
const shapes = ['2d', 'cube'] as const satisfies readonly RenderTargetShape[];

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 512,
  height: 256,
  format: 'rgba8unorm-srgb',
  mipLevels: 'full',
  sampleCount: 1,
  depth: 'depth24plus-stencil8',
  sampled: true,
  readback: true,
};

describe('RenderTarget public surface', () => {
  it('keeps the descriptor vocabulary closed and color-domain based', () => {
    expectTypeOf<RenderTargetDescriptor['format']>().toEqualTypeOf<RenderTargetFormat>();
    expectTypeOf<RenderTargetDescriptor['shape']>().toEqualTypeOf<RenderTargetShape>();
    expectTypeOf(formats).toMatchTypeOf<readonly RenderTargetFormat[]>();
    expectTypeOf(shapes).toMatchTypeOf<readonly RenderTargetShape[]>();
    // @ts-expect-error target descriptors do not carry a second color-space fact.
    const withColorSpace: RenderTargetDescriptor = { ...descriptor, colorSpace: 'srgb' };
    void withColorSpace;
    // @ts-expect-error array targets are outside the first public target vocabulary.
    const arrayTarget: RenderTargetDescriptor = { ...descriptor, shape: 'array' };
    void arrayTarget;
  });

  it('exposes opaque target values and typed Renderer operations', () => {
    const renderer = undefined as unknown as Renderer;
    const target = undefined as unknown as RenderTarget;
    const source = undefined as unknown as RenderTargetTextureSource;
    const ticket = undefined as unknown as RenderTargetReadbackTicket;

    expectTypeOf(renderer.createRenderTarget(descriptor)).toMatchTypeOf<
      | { readonly ok: true; readonly value: RenderTarget }
      | { readonly ok: false; readonly error: RenderError }
    >();
    expectTypeOf(renderer.resizeRenderTarget).parameter(0).toEqualTypeOf<RenderTarget>();
    expectTypeOf(renderer.createRenderTargetTextureSource)
      .parameter(0)
      .toEqualTypeOf<RenderTarget>();
    expectTypeOf(renderer.requestTargetReadback).parameter(0).toEqualTypeOf<RenderTarget>();
    expectTypeOf(renderer.destroyRenderTarget).parameter(0).toEqualTypeOf<RenderTarget>();
    expectTypeOf(source).not.toEqualTypeOf(target);
    expectTypeOf(ticket).not.toEqualTypeOf(target);
    // @ts-expect-error opaque target values are not numeric handles.
    const numericIdentity: number = target;
    void numericIdentity;
    void source;
    void ticket;
  });

  it('keeps target failures in the closed RenderError family', () => {
    const targetCodes = [
      'render-target-descriptor-invalid',
      'render-target-capability-missing',
      'render-target-state-invalid',
      'render-target-operation-failed',
    ] as const satisfies readonly RenderErrorCode[];
    expectTypeOf<(typeof targetCodes)[number]>().toEqualTypeOf<
      Extract<RenderErrorCode, `${string}target${string}`>
    >();
  });
});
