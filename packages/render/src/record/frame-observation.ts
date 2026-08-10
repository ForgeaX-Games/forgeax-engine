import {
  type CurrentFrameObservationLease,
  createCurrentFrameObservationLease,
  type ResolvedColorTargetDescriptor,
} from '@forgeax/engine-render-graph';
import type { Texture } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ObservationUnavailableError,
  type ObservationUnavailableReason,
} from '../errors/render.js';

export interface FrameObservationSource {
  readonly texture: Texture;
  readonly descriptor: ResolvedColorTargetDescriptor;
  readonly frameId: number;
  readonly pipelineId: 'forgeax::urp' | 'forgeax::hdrp';
  readonly backendId: string;
}

export type FrameObservationReadback = (
  lease: CurrentFrameObservationLease,
) => Promise<Result<Uint8Array, Error>>;

export interface FrameObservationOptions {
  readonly semantic: 'linear-hdr';
  readonly readback: FrameObservationReadback;
}

export interface FrameObservationMetadata {
  readonly format: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly usage: number;
  readonly sample: number;
  readonly frameId: number;
  readonly lifetime: { readonly frameId: number; readonly state: 'active' | 'retired' };
  readonly pipelineId: 'forgeax::urp' | 'forgeax::hdrp';
  readonly backendId: string;
}

export interface FrameObservation {
  readonly bytes: Uint8Array;
  readonly metadata: FrameObservationMetadata;
}

function unavailable(
  reason: ObservationUnavailableReason,
  hint: string,
): Result<never, ObservationUnavailableError> {
  return err(new ObservationUnavailableError(reason, hint));
}

function mapLeaseFailure(code: string, hint: string): Result<never, ObservationUnavailableError> {
  let reason: ObservationUnavailableReason = 'resource';
  if (code === 'observation-stale') reason = 'stale';
  else if (code === 'observation-invalid-format') reason = 'format';
  else if (code === 'observation-missing-copy-src') reason = 'copy-src';
  return unavailable(reason, hint);
}

export async function observeCurrentFrame(
  options: FrameObservationOptions,
  source: FrameObservationSource | undefined,
  currentFrameId: number,
): Promise<Result<FrameObservation, ObservationUnavailableError>> {
  if (options.semantic !== 'linear-hdr') {
    return unavailable('identity', 'request the producer-owned linear-hdr semantic');
  }
  if (source === undefined) {
    return unavailable(
      'no-frame',
      'draw a frame through a supported URP or HDRP producer before requesting observation',
    );
  }
  if (
    (source.pipelineId !== 'forgeax::urp' && source.pipelineId !== 'forgeax::hdrp') ||
    source.backendId.length === 0
  ) {
    return unavailable(
      'identity',
      'observe a producer with explicit pipeline and backend identity',
    );
  }

  const leaseResult = createCurrentFrameObservationLease(
    { ...source.descriptor, texture: source.texture, frameId: source.frameId },
    currentFrameId,
  );
  if (!leaseResult.ok) {
    return mapLeaseFailure(leaseResult.error.code, leaseResult.error.hint);
  }

  let bytesResult: Result<Uint8Array, Error>;
  try {
    bytesResult = await options.readback(leaseResult.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return unavailable('readback-failed', `retry the current-frame readback after: ${message}`);
  }
  if (!bytesResult.ok) {
    return unavailable('readback-failed', bytesResult.error.message);
  }

  const activeResult = leaseResult.value.beginReadback();
  if (!activeResult.ok) {
    return mapLeaseFailure(activeResult.error.code, activeResult.error.hint);
  }

  return ok({
    bytes: bytesResult.value,
    metadata: {
      format: leaseResult.value.descriptor.format,
      size: leaseResult.value.descriptor.size,
      usage: leaseResult.value.descriptor.usage,
      sample: source.descriptor.sample,
      frameId: source.frameId,
      lifetime: leaseResult.value.lifetime,
      pipelineId: source.pipelineId,
      backendId: source.backendId,
    },
  });
}
