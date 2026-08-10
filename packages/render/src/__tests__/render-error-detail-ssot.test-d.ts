import { describe, expectTypeOf, it } from 'vitest';
import type {
  PipelineErrorCode,
  PipelineErrorDetail,
  PipelineErrorDetailFor,
  PipelineError as PipelineErrorType,
  PipelineNotFoundDetail,
  PipelinePreviouslyRegisteredDetail,
} from '../pipeline-errors';
import { PipelineError } from '../pipeline-errors';
import type {
  FullscreenInputNotFoundDetail,
  PostProcessErrorCode,
  PostProcessErrorDetail,
  PostProcessErrorDetailFor,
  PostProcessError as PostProcessErrorType,
  PostProcessNotFoundDetail,
  PostProcessParamsSizeMismatchDetail,
  PostProcessParamsUpdateSizeMismatchDetail,
  PostProcessPreviouslyRegisteredDetail,
  SsaoBiasNegativeDetail,
  SsaoRadiusNonPositiveDetail,
} from '../post-process-errors';
import { PostProcessError } from '../post-process-errors';

type ExpectedPostProcessDetails = {
  readonly 'post-process-already-registered': PostProcessPreviouslyRegisteredDetail;
  readonly 'post-process-not-found': PostProcessNotFoundDetail;
  readonly 'fullscreen-input-not-found': FullscreenInputNotFoundDetail;
  readonly 'ssao-radius-non-positive': SsaoRadiusNonPositiveDetail;
  readonly 'ssao-bias-negative': SsaoBiasNegativeDetail;
  readonly 'params-size-mismatch': PostProcessParamsSizeMismatchDetail;
  readonly 'params-update-size-mismatch': PostProcessParamsUpdateSizeMismatchDetail;
};

type ExpectedPostProcessCodes = keyof ExpectedPostProcessDetails;
type DetailFor<C extends PostProcessErrorCode> = Extract<
  PostProcessErrorType,
  { readonly code: C }
>['detail'];

type ExpectedPipelineDetails = {
  readonly 'pipeline-already-registered': PipelinePreviouslyRegisteredDetail;
  readonly 'pipeline-not-found': PipelineNotFoundDetail;
};

type ExpectedPipelineCodes = keyof ExpectedPipelineDetails;
type PipelineDetailFor<C extends PipelineErrorCode> = Extract<
  PipelineErrorType,
  { readonly code: C }
>['detail'];

describe('render error detail aliases derive from their code resolvers', () => {
  it('preserves the complete pipeline detail union', () => {
    expectTypeOf<PipelineErrorDetail>().toEqualTypeOf<PipelineErrorDetailFor<PipelineErrorCode>>();
  });

  it('keeps the exact two-code vocabulary and derives the public code view', () => {
    expectTypeOf<PipelineErrorCode>().toEqualTypeOf<ExpectedPipelineCodes>();
    expectTypeOf<ExpectedPipelineCodes>().toEqualTypeOf<PipelineErrorCode>();
    expectTypeOf<PipelineErrorType['code']>().toEqualTypeOf<PipelineErrorCode>();
    expectTypeOf<PipelineErrorCode>().toEqualTypeOf<PipelineErrorType['code']>();
  });

  it('preserves every pipeline code/detail correlation in the mapped error view', () => {
    expectTypeOf<PipelineDetailFor<'pipeline-already-registered'>>().toMatchTypeOf<
      ExpectedPipelineDetails['pipeline-already-registered']
    >();
    expectTypeOf<PipelineDetailFor<'pipeline-not-found'>>().toMatchTypeOf<
      ExpectedPipelineDetails['pipeline-not-found']
    >();
  });

  it('preserves the complete post-process detail union', () => {
    expectTypeOf<PostProcessErrorDetail>().toEqualTypeOf<
      PostProcessErrorDetailFor<PostProcessErrorCode>
    >();
  });

  it('keeps the exact seven-code vocabulary and derives the public code view', () => {
    expectTypeOf<PostProcessErrorCode>().toEqualTypeOf<ExpectedPostProcessCodes>();
    expectTypeOf<ExpectedPostProcessCodes>().toEqualTypeOf<PostProcessErrorCode>();
    expectTypeOf<PostProcessErrorType['code']>().toEqualTypeOf<PostProcessErrorCode>();
    expectTypeOf<PostProcessErrorCode>().toEqualTypeOf<PostProcessErrorType['code']>();
  });

  it('preserves every code/detail correlation in the mapped error view', () => {
    expectTypeOf<DetailFor<'post-process-already-registered'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['post-process-already-registered']
    >();
    expectTypeOf<DetailFor<'post-process-not-found'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['post-process-not-found']
    >();
    expectTypeOf<DetailFor<'fullscreen-input-not-found'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['fullscreen-input-not-found']
    >();
    expectTypeOf<DetailFor<'ssao-radius-non-positive'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['ssao-radius-non-positive']
    >();
    expectTypeOf<DetailFor<'ssao-bias-negative'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['ssao-bias-negative']
    >();
    expectTypeOf<DetailFor<'params-size-mismatch'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['params-size-mismatch']
    >();
    expectTypeOf<DetailFor<'params-update-size-mismatch'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['params-update-size-mismatch']
    >();
  });

  it('rejects unknown codes and mismatched code/detail pairs', () => {
    // @ts-expect-error unknown literals are outside the closed code view.
    const invalidPipelineCode: PipelineErrorCode = 'pipeline-not-real';
    void invalidPipelineCode;

    new PipelineError({
      code: 'pipeline-not-found',
      // @ts-expect-error the detail must match the selected code.
      detail: { id: 'already-registered' },
    });

    // @ts-expect-error unknown literals are outside the closed code view.
    const invalidCode: PostProcessErrorCode = 'post-process-not-real';
    void invalidCode;

    new PostProcessError({
      code: 'post-process-not-found',
      // @ts-expect-error the detail must match the selected code.
      detail: { readsKey: 'hdrColor', passName: 'tonemap' },
    });
  });

  it('preserves generic PipelineError constructor inference for each selected variant', () => {
    const previouslyRegistered = new PipelineError({
      code: 'pipeline-already-registered',
      detail: { id: 'forward' },
    });
    expectTypeOf(previouslyRegistered).toEqualTypeOf<
      Extract<PipelineErrorType, { readonly code: 'pipeline-already-registered' }>
    >();
    expectTypeOf(previouslyRegistered.detail.id).toEqualTypeOf<string>();

    const notFound = new PipelineError({
      code: 'pipeline-not-found',
      detail: { handle: 42 },
    });
    expectTypeOf(notFound).toEqualTypeOf<
      Extract<PipelineErrorType, { readonly code: 'pipeline-not-found' }>
    >();
    expectTypeOf(notFound.detail.handle).toEqualTypeOf<number>();
  });

  it('supports exhaustive PipelineError narrowing across every mapped variant', () => {
    const describePipeline = (error: PipelineErrorType): string => {
      switch (error.code) {
        case 'pipeline-already-registered':
          expectTypeOf(error.detail.id).toEqualTypeOf<string>();
          return error.detail.id;
        case 'pipeline-not-found':
          expectTypeOf(error.detail.handle).toEqualTypeOf<number>();
          return `${error.detail.handle}`;
      }
      const exhaustive: never = error;
      return exhaustive;
    };

    expectTypeOf(describePipeline).returns.toEqualTypeOf<string>();
  });

  it('preserves generic constructor inference for each selected variant', () => {
    const previouslyRegistered = new PostProcessError({
      code: 'post-process-already-registered',
      detail: { id: 'tonemap' },
    });
    expectTypeOf(previouslyRegistered).toEqualTypeOf<
      Extract<PostProcessErrorType, { readonly code: 'post-process-already-registered' }>
    >();
    expectTypeOf(previouslyRegistered.detail.id).toEqualTypeOf<string>();

    const notFound = new PostProcessError({
      code: 'post-process-not-found',
      detail: { id: 'missing' },
    });
    expectTypeOf(notFound).toEqualTypeOf<
      Extract<PostProcessErrorType, { readonly code: 'post-process-not-found' }>
    >();
    expectTypeOf(notFound.detail.id).toEqualTypeOf<string>();
  });

  it('supports exhaustive narrowing across every mapped variant', () => {
    const describe = (error: PostProcessErrorType): string => {
      switch (error.code) {
        case 'post-process-already-registered':
          expectTypeOf(error.detail.id).toEqualTypeOf<string>();
          return error.detail.id;
        case 'post-process-not-found':
          expectTypeOf(error.detail.id).toEqualTypeOf<string>();
          return error.detail.id;
        case 'fullscreen-input-not-found':
          expectTypeOf(error.detail.readsKey).toEqualTypeOf<string>();
          expectTypeOf(error.detail.passName).toEqualTypeOf<string>();
          return `${error.detail.readsKey}:${error.detail.passName}`;
        case 'ssao-radius-non-positive':
          expectTypeOf(error.detail.paramName).toEqualTypeOf<string>();
          expectTypeOf(error.detail.value).toEqualTypeOf<number>();
          return `${error.detail.paramName}:${error.detail.value}`;
        case 'ssao-bias-negative':
          expectTypeOf(error.detail.paramName).toEqualTypeOf<string>();
          expectTypeOf(error.detail.value).toEqualTypeOf<number>();
          return `${error.detail.paramName}:${error.detail.value}`;
        case 'params-size-mismatch':
          expectTypeOf(error.detail.byteSize).toEqualTypeOf<number>();
          expectTypeOf(error.detail.actualLength).toEqualTypeOf<number>();
          return `${error.detail.byteSize}:${error.detail.actualLength}`;
        case 'params-update-size-mismatch':
          expectTypeOf(error.detail.byteSize).toEqualTypeOf<number>();
          expectTypeOf(error.detail.actualLength).toEqualTypeOf<number>();
          return `${error.detail.byteSize}:${error.detail.actualLength}`;
      }
      const exhaustive: never = error;
      return exhaustive;
    };

    expectTypeOf(describe).returns.toEqualTypeOf<string>();
  });
});
