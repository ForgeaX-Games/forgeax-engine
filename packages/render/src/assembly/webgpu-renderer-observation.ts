import type { Buffer } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { RendererContractFailureError } from '../errors/render';
import { getTextureIdentity } from '../record/frame-snapshot';
import type { FrameReceipt, FrameReceiptObservation, RenderResult } from '../render-contract';
import type { TypedFrameObservationCapture } from '../typed-render-graph-primitives';

/** Dispose receipt-bound readback buffers while retaining failed ownership. */
export function disposeObservationCaptureSet(
  captures: readonly TypedFrameObservationCapture[],
  destroyed: WeakSet<Buffer>,
  failures: WeakMap<Buffer, RendererContractFailureError>,
  fire: (failure: RendererContractFailureError) => void,
): RendererContractFailureError | undefined {
  let firstFailure: RendererContractFailureError | undefined;
  for (const capture of captures) {
    if (destroyed.has(capture.buffer)) continue;
    const previousFailure = failures.get(capture.buffer);
    try {
      const result = capture.device.destroyBuffer(capture.buffer);
      if (result.ok) {
        destroyed.add(capture.buffer);
        failures.delete(capture.buffer);
        continue;
      }
      const failure = new RendererContractFailureError(
        'observe',
        `destroying ${capture.domain} receipt-bound readback failed: ${result.error.code}`,
      );
      failures.set(capture.buffer, failure);
      if (previousFailure === undefined) fire(failure);
      firstFailure ??= failure;
    } catch (cause) {
      const failure = new RendererContractFailureError(
        'observe',
        `destroying ${capture.domain} receipt-bound readback threw: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      failures.set(capture.buffer, failure);
      if (previousFailure === undefined) fire(failure);
      firstFailure ??= failure;
    }
  }
  return firstFailure;
}

/** Validate and project color readbacks against the submitted frame identity. */
export function projectReceiptColorObservations(
  receipt: FrameReceipt,
  captures: readonly {
    readonly capture: TypedFrameObservationCapture;
    readonly bytes: Uint8Array;
  }[],
  requestedDomains: readonly TypedFrameObservationCapture['domain'][],
  backendId: FrameReceipt['backendId'],
): RenderResult<
  NonNullable<FrameReceiptObservation['observations']>,
  RendererContractFailureError
> {
  const graphGenerations = new Set(captures.map(({ capture }) => capture.graphGeneration));
  if (
    captures.some(
      ({ capture }) =>
        capture.frameNumber !== receipt.frameId ||
        capture.deviceGeneration !== receipt.deviceGeneration ||
        capture.backendId !== backendId ||
        (receipt.graphGeneration !== undefined &&
          capture.graphGeneration !== receipt.graphGeneration),
    ) ||
    graphGenerations.size !== 1
  ) {
    return err(
      new RendererContractFailureError(
        'observe',
        'receipt-bound color-domain captures crossed frame, device, backend, or graph identity',
      ),
    );
  }
  const byDomain = new Map(
    captures.map(({ capture, bytes }) => [capture.domain, { capture, bytes }]),
  );
  if (
    byDomain.size !== captures.length ||
    requestedDomains.some((domain) => !byDomain.has(domain))
  ) {
    return err(
      new RendererContractFailureError(
        'observe',
        'receipt-bound color-domain captures must contain one source per requested domain',
      ),
    );
  }
  const read: NonNullable<FrameReceiptObservation['observations']>[number][] = [];
  for (const domain of requestedDomains) {
    const resolved = byDomain.get(domain);
    if (resolved === undefined) continue;
    const { capture, bytes } = resolved;
    const observation = {
      bytes,
      metadata: {
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        ...(receipt.backendId === undefined ? {} : { backendId: receipt.backendId }),
        format: capture.format,
        graphGeneration: capture.graphGeneration,
        textureIdentity: getTextureIdentity(capture.texture),
        readbackIdentity: getTextureIdentity(
          capture.buffer as unknown as import('@forgeax/engine-rhi').Texture,
        ),
        width: capture.width,
        height: capture.height,
        bytesPerRow: capture.bytesPerRow,
        footprint: { resourceCount: 1, bindGroupCount: 0 },
      },
    };
    if (domain === 'visible-surface') {
      const records = capture.surfaceRecords;
      if (records === undefined)
        return err(
          new RendererContractFailureError(
            'observe',
            'visible-surface capture is missing its same-frame records',
          ),
        );
      read.push({ ...observation, domain, records: records.slice() });
    } else {
      read.push({ ...observation, domain });
    }
  }
  return ok(Object.freeze(read));
}
