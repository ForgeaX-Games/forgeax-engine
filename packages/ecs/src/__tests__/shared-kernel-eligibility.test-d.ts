import { expectTypeOf, it } from 'vitest';
import { defineComponent } from '../component';
import { defineSharedKernel, type QuerySpan } from '../index';

const Position = defineComponent('SharedKernelTypesPosition', { x: 'f32' });
function run(spans: readonly QuerySpan[]): void {
  void spans;
}

it('derives access only from the QueryDescriptor tuple', () => {
  const kernel = defineSharedKernel(import.meta.url, {
    name: 'typed',
    queries: [{ write: [Position] }],
    run,
  });
  expectTypeOf(kernel.queries[0]?.write?.[0]).toMatchTypeOf<typeof Position | undefined>();
});
