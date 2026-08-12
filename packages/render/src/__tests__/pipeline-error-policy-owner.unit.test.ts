import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  PipelineError,
  type PipelineErrorCode,
  type PipelineErrorDetail,
  type PipelineErrorDetailFor,
  type PipelineError as PipelineErrorType,
} from '../pipeline-errors';

const expectedCodes = [
  'pipeline-already-registered',
  'pipeline-not-found',
] as const satisfies readonly PipelineErrorCode[];

const evidence = [
  {
    code: 'pipeline-already-registered',
    error: new PipelineError({
      code: 'pipeline-already-registered',
      detail: { id: 'forgeax::urp' },
    }),
    expected: 'each pipeline id is registered at most once',
    hint: "pipeline id 'forgeax::urp' is already registered; same-id re-register is forbidden. Pick a distinct id (engine builtins use the forgeax:: prefix; user pipelines use <package>::<id>).",
    message:
      "pipeline: pipeline-already-registered (pipeline id 'forgeax::urp' is already registered; same-id re-register is forbidden. Pick a distinct id (engine builtins use the forgeax:: prefix; user pipelines use <package>::<id>).)",
  },
  {
    code: 'pipeline-not-found',
    error: new PipelineError({
      code: 'pipeline-not-found',
      detail: { handle: 42 },
    }),
    expected: 'installPipeline receives a handle to a registered pipeline',
    hint: 'no pipeline is registered for handle 42. First registerPipeline(id, impl), then register a RenderPipelineAsset { kind:"render-pipeline", pipelineId: id } and install the returned handle.',
    message:
      'pipeline: pipeline-not-found (no pipeline is registered for handle 42. First registerPipeline(id, impl), then register a RenderPipelineAsset { kind:"render-pipeline", pipelineId: id } and install the returned handle.)',
  },
] as const;

describe('PipelineError policy ownership', () => {
  it('preserves the exact two-code vocabulary and public type', () => {
    expect(expectedCodes).toHaveLength(2);
    expect(new Set(expectedCodes).size).toBe(2);
    expectTypeOf<PipelineErrorCode>().toEqualTypeOf<(typeof expectedCodes)[number]>();
  });

  it('preserves every expected value, dynamic hint, and message byte-for-byte', () => {
    for (const { code, error, expected, hint, message } of evidence) {
      expect(error.code).toBe(code);
      expect(error.expected).toBe(expected);
      expect(error.hint).toBe(hint);
      expect(error.message).toBe(message);
    }

    const otherId = new PipelineError({
      code: 'pipeline-already-registered',
      detail: { id: 'game::custom' },
    });
    const otherHandle = new PipelineError({
      code: 'pipeline-not-found',
      detail: { handle: 9001 },
    });
    expect(otherId.hint).toBe(
      "pipeline id 'game::custom' is already registered; same-id re-register is forbidden. Pick a distinct id (engine builtins use the forgeax:: prefix; user pipelines use <package>::<id>).",
    );
    expect(otherId.message).toBe(`pipeline: pipeline-already-registered (${otherId.hint})`);
    expect(otherHandle.hint).toBe(
      'no pipeline is registered for handle 9001. First registerPipeline(id, impl), then register a RenderPipelineAsset { kind:"render-pipeline", pipelineId: id } and install the returned handle.',
    );
    expect(otherHandle.message).toBe(`pipeline: pipeline-not-found (${otherHandle.hint})`);
  });

  it('preserves correlated constructor inference and detail aliases', () => {
    expectTypeOf<PipelineErrorDetail>().toEqualTypeOf<PipelineErrorDetailFor<PipelineErrorCode>>();

    const previouslyRegistered = new PipelineError({
      code: 'pipeline-already-registered',
      detail: { id: 'forgeax::urp' },
    });
    expectTypeOf(previouslyRegistered).toEqualTypeOf<
      Extract<PipelineErrorType, { readonly code: 'pipeline-already-registered' }>
    >();
    expectTypeOf(previouslyRegistered.detail).toEqualTypeOf<
      Extract<PipelineErrorType, { readonly code: 'pipeline-already-registered' }>['detail']
    >();
    expectTypeOf(previouslyRegistered.detail.id).toEqualTypeOf<string>();

    const notFound = new PipelineError({
      code: 'pipeline-not-found',
      detail: { handle: 42 },
    });
    expectTypeOf(notFound).toEqualTypeOf<
      Extract<PipelineErrorType, { readonly code: 'pipeline-not-found' }>
    >();
    expectTypeOf(notFound.detail).toEqualTypeOf<
      Extract<PipelineErrorType, { readonly code: 'pipeline-not-found' }>['detail']
    >();
    expectTypeOf(notFound.detail.handle).toEqualTypeOf<number>();
  });

  it('preserves Error identity, stack, own-key order, and descriptors', () => {
    const error = new PipelineError({
      code: 'pipeline-already-registered',
      detail: { id: 'forgeax::urp' },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PipelineError);
    expect(error.name).toBe('PipelineError');
    expect(typeof error.stack).toBe('string');
    expect(error.stack).toContain(`PipelineError: ${error.message}`);
    expect(Object.keys(error)).toEqual(['code', 'expected', 'hint', 'detail', 'name']);
    expect(Object.getOwnPropertyNames(error)).toEqual([
      'stack',
      'message',
      'code',
      'expected',
      'hint',
      'detail',
      'name',
    ]);

    const descriptors = Object.getOwnPropertyDescriptors(error);
    for (const field of ['name', 'code', 'expected', 'hint', 'detail'] as const) {
      expect(descriptors[field]).toMatchObject({
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    expect(descriptors.message).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: true,
    });
    expect(descriptors.stack).toMatchObject({
      configurable: true,
      enumerable: false,
    });
    expect(typeof descriptors.stack?.get).toBe('function');
    expect(typeof descriptors.stack?.set).toBe('function');
  });
});
