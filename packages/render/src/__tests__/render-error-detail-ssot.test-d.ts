import { describe, expectTypeOf, it } from 'vitest';
import type {
  PipelineErrorCode,
  PipelineErrorDetail,
  PipelineErrorDetailFor,
} from '../pipeline-errors';
import type {
  PostProcessErrorCode,
  PostProcessErrorDetail,
  PostProcessErrorDetailFor,
} from '../post-process-errors';

describe('render error detail aliases derive from their code resolvers', () => {
  it('preserves the complete pipeline detail union', () => {
    expectTypeOf<PipelineErrorDetail>().toEqualTypeOf<PipelineErrorDetailFor<PipelineErrorCode>>();
  });

  it('preserves the complete post-process detail union', () => {
    expectTypeOf<PostProcessErrorDetail>().toEqualTypeOf<
      PostProcessErrorDetailFor<PostProcessErrorCode>
    >();
  });
});
