/// <reference types="@webgpu/types" />

import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';

export function resolveTimestampQueries(args: {
  rawEncoder: GPUCommandEncoder;
  rawQuerySet: GPUQuerySet;
  firstQuery: number;
  queryCount: number;
  rawDestination: GPUBuffer;
  destinationOffset: number;
}): Result<void, RhiError> {
  try {
    args.rawEncoder.resolveQuerySet(
      args.rawQuerySet,
      args.firstQuery,
      args.queryCount,
      args.rawDestination,
      args.destinationOffset,
    );
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'underlying GPUCommandEncoder.resolveQuerySet to succeed',
        hint: `resolveQuerySet raised: ${message}`,
      }),
    );
  }
}

export function writeTimestamp(args: {
  rawEncoder: GPUCommandEncoder;
  rawQuerySet: GPUQuerySet;
  queryIndex: number;
}): void {
  const encoderWithTimestamp = args.rawEncoder as unknown as {
    writeTimestamp?: (querySet: GPUQuerySet, queryIndex: number) => void;
  };
  if (typeof encoderWithTimestamp.writeTimestamp !== 'function') {
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'underlying GPUCommandEncoder.writeTimestamp to be callable',
      hint: 'timestamp-query is advertised but the raw encoder has no writeTimestamp method',
    });
  }
  try {
    encoderWithTimestamp.writeTimestamp(args.rawQuerySet, args.queryIndex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'underlying GPUCommandEncoder.writeTimestamp to succeed',
      hint: `writeTimestamp raised: ${message}`,
    });
  }
}
