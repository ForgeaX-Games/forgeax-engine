import { expectTypeOf, it } from 'vitest';
import type { ExecutionReport, ExecutionTier } from '../index';

it('exposes stable report fields without transport internals', () => {
  const report = null as unknown as ExecutionReport;
  expectTypeOf(report.actualTier).toEqualTypeOf<ExecutionTier | null>();
  expectTypeOf(report.world.partialWrite).toBeBoolean();
  expectTypeOf(report.world.retryable).toBeBoolean();
  expectTypeOf(report.kernelDispatch.dispatched).toBeNumber();
  expectTypeOf(report.performance.hostFrameMs).toMatchTypeOf<object | null>();
  expectTypeOf(report.audio.owner).toEqualTypeOf<'host'>();
  // @ts-expect-error transport identities are private
  void report.workerId;
  // @ts-expect-error SAB shards are private
  void report.shards;
});
