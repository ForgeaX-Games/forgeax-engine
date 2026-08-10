import { expectTypeOf, it } from 'vitest';
import type { App, CreateAppOptions, ExecutionControl, ExecutionReport } from '../index';

it('discovers execution from the public App surface', () => {
  const app = null as unknown as App;
  const options = null as unknown as CreateAppOptions;
  expectTypeOf(app.execution).toEqualTypeOf<ExecutionControl>();
  expectTypeOf(app.execution.report()).toEqualTypeOf<ExecutionReport>();
  expectTypeOf(options.execution?.bootstrap).toEqualTypeOf<string | URL | undefined>();
});
