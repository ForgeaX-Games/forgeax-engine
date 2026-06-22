// w23 — Renderer.draw / ready Result<void, RhiError> shape assertions.
//
// Charter: proposition 4 (explicit failure - Result.err over reject /
// fan-out-only) + proposition 5 (consistent abstraction - draw / ready
// both expose the same .ok discriminator).
//
// Anchors: requirements AC-13 (Renderer.draw/ready Result form);
//          plan-strategy D-P7 break-point #4; w23 test SSOT.

import type { Result, RhiError } from '@forgeax/engine-rhi';
import { describe, expectTypeOf, it } from 'vitest';
import type { Renderer } from '../renderer';

describe('AC-13 — Renderer.draw returns Result<void, RhiError>', () => {
  it('Renderer.draw(world) return type is Result<void, RhiError>', () => {
    type RetType = ReturnType<Renderer['draw']>;
    expectTypeOf<RetType>().toEqualTypeOf<Result<void, RhiError>>();
  });
});

describe('AC-13 — Renderer.ready is Promise<Result<void, RhiError>>', () => {
  it('Renderer.ready type is Promise<Result<void, RhiError>>', () => {
    type ReadyType = Renderer['ready'];
    expectTypeOf<ReadyType>().toEqualTypeOf<Promise<Result<void, RhiError>>>();
  });
});
