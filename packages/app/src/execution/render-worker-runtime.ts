import {
  type FrameReceipt,
  querySubmittedTerrainHeight,
  type Renderer,
  type RendererOperationError,
  type RenderPublicationIdentity,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { createRhiDebugError, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import {
  createRhiCapture,
  createRhiInstrumentation,
  type RhiCapture,
} from '../internal/rhi-capture';
import { attachWorkerRhiRecorder } from '../internal/worker-rhi-capture';
import { prepareBootstrapEntry } from './bootstrap-entry';
import type { RenderWorkerInput, RenderWorkerOutput } from './render-worker-protocol';
import { serializableDetail, workerError } from './worker-error';

const scope = globalThis as unknown as {
  postMessage(message: RenderWorkerOutput, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<RenderWorkerInput>) => void) | null;
  close(): void;
};
let renderer: Renderer | undefined;
let publicationIdentity: RenderPublicationIdentity | undefined;
let canvas: OffscreenCanvas | undefined;
let busy = false;
// Includes CPU preparation, the queued successor, and unretired GPU receipts.
// These are the same two publications admitted by the Host, not another queue.
let framesInFlight = 0;
let failed = false;
let shuttingDown = false;
let initializing: Promise<void> | undefined;
let completing: Promise<void> = Promise.resolve();
let attachment: RecorderAttachment | undefined;
let capture: RhiCapture | undefined;
let captureBoundary: ReturnType<RecorderAttachment['frameBoundary']> | undefined;
let gpuPassTimingEnabled = false;
const terrainReceipts = new Map<number, FrameReceipt>();
const captureRequests = new Map<number, AbortController>();
let synchronizeFeatures: (identities: ReadonlySet<string>) => Promise<void> = async () => {};
type DrawMessage = Extract<RenderWorkerInput, { kind: 'draw' }>;

function closeVideoFrames(message: DrawMessage): void {
  for (const row of message.publication.videoFrames) row.frame.close();
  for (const row of message.publication.canvasFrames ?? []) row.frame?.close();
}

function fail(message: RenderWorkerInput, cause: unknown): void {
  if (failed) return;
  failed = true;
  terrainReceipts.clear();
  const operationError = cause as
    | RendererOperationError<'device-operation-failed'>
    | RendererOperationError<'frame-submit-rejected'>
    | undefined;
  scope.postMessage({
    kind: 'failed',
    error: workerError(cause),
    stage: message.kind,
    ...(message.kind === 'draw'
      ? {
          publication: {
            source: message.publication.source,
            epoch: message.publication.epoch,
            revision: message.publication.revision,
            frameId: message.frameId,
          },
        }
      : {}),
    // Native destroy can fence a receipt before renderer health changes.
    recoverable:
      (operationError?.code === 'frame-submit-rejected' &&
        operationError.detail?.accepted === false) ||
      renderer?.state() === 'device-lost' ||
      (operationError?.code === 'device-operation-failed' &&
        operationError.detail?.operation === 'complete-frame' &&
        ['device-lost', 'disposed', 'stale-generation'].some(
          (code) => code === operationError.detail.cause?.code,
        )),
  });
}

async function completeFrame(
  message: DrawMessage,
  frameRenderer: Renderer,
  receipt: FrameReceipt,
  previous: Promise<void>,
  snapshotBoundary?: Promise<unknown>,
): Promise<void> {
  try {
    // Observe this receipt immediately, before the next draw changes frame state.
    const observedTiming = gpuPassTimingEnabled
      ? frameRenderer.observe(receipt, { include: ['timings'] })
      : undefined;
    const completion = receipt.completed.then((result) => {
      if (!result.ok) throw result.error;
    });
    const [, timingResult] = await Promise.all([completion, observedTiming, snapshotBoundary]);
    // Composite receipts/readbacks can finish out of order. The publisher and
    // Host advance only the contiguous completed prefix, never a newer frame.
    await previous;
    if (failed) return;
    const gpuPassTiming = timingResult?.ok === true ? timingResult.value.timings : undefined;
    const buffers = renderPublicationTransfers(message.publication);
    scope.postMessage(
      {
        kind: 'completed',
        revision: message.publication.revision,
        buffers,
        ...(gpuPassTiming === undefined ? {} : { gpuPassTiming }),
        frame: {
          kind: 'frame-complete',
          worldIdentity: message.worldIdentity,
          frameId: message.frameId,
          deviceGeneration: receipt.deviceGeneration,
          ...(receipt.graphGeneration === undefined
            ? {}
            : { graphGeneration: receipt.graphGeneration }),
          ...(receipt.barrelDistortion === undefined
            ? {}
            : { barrelDistortion: receipt.barrelDistortion }),
          presentation: receipt.presentation,
          engineUpdateMs: 0,
          kernelWaitMs: 0,
        },
      },
      buffers,
    );
  } catch (cause) {
    // A failed successor must stop admission even while an older receipt waits.
    fail(message, cause);
  } finally {
    // Observation failure cannot let disposal outrun this frame or its predecessor.
    await Promise.allSettled([previous, receipt.completed]);
    closeVideoFrames(message);
    framesInFlight--;
  }
}

async function receive(message: RenderWorkerInput): Promise<void> {
  if (message.kind === 'dispose') {
    terrainReceipts.clear();
    shuttingDown = true;
    for (const controller of captureRequests.values()) controller.abort();
    try {
      await initializing;
      await drawing;
      await completing;
      renderer?.dispose();
      await attachment?.dispose();
      scope.postMessage({ kind: 'disposed' });
    } catch (cause) {
      scope.postMessage({ kind: 'disposed', error: serializableDetail(cause) });
    } finally {
      scope.close();
    }
    return;
  }
  if (failed) {
    if (message.kind === 'draw') {
      closeVideoFrames(message);
      framesInFlight--;
    }
    return;
  }
  let completionOwnsFrame = false;
  try {
    if (message.kind === 'terrain-height') {
      const receipt = terrainReceipts.get(message.frameId);
      const result =
        receipt === undefined
          ? {
              ok: false as const,
              error: {
                code: 'terrain-query-unavailable' as const,
                expected: 'a retained exact submitted frame from this Worker generation',
                hint: 'query a recent frame in the current Render Worker session',
                detail: { field: 'frameId', actual: message.frameId },
              },
            }
          : await querySubmittedTerrainHeight(receipt, message.request);
      scope.postMessage({ kind: 'terrain-height-result', requestId: message.requestId, result });
      return;
    }
    if (message.kind === 'bounds') {
      scope.postMessage({
        kind: 'bounds-result',
        requestId: message.requestId,
        bounds:
          publicationIdentity === undefined
            ? undefined
            : renderer?.bounds(publicationIdentity, message.entity),
      });
      return;
    }
    if (message.kind === 'capture-cancel') {
      captureRequests.get(message.requestId)?.abort();
      return;
    }
    if (message.kind === 'capture') {
      if (capture === undefined) {
        scope.postMessage({
          kind: 'capture-result',
          requestId: message.requestId,
          result: {
            ok: false,
            error: createRhiDebugError('capture-unavailable', {
              stage: 'capture',
              cause: 'Render Worker recorder is disabled',
            }),
          },
        });
        return;
      }
      const controller = new AbortController();
      captureRequests.set(message.requestId, controller);
      const result = await capture.captureFrame({ ...message.options, signal: controller.signal });
      captureRequests.delete(message.requestId);
      if (!result.ok) {
        scope.postMessage({
          kind: 'capture-result',
          requestId: message.requestId,
          result: { ok: false, error: result.error },
        });
        return;
      }
      const bytes = transferable(result.value.bytes);
      scope.postMessage(
        {
          kind: 'capture-result',
          requestId: message.requestId,
          result: { ok: true, value: { kind: 'rhi-tape', bytes } },
        },
        [bytes.buffer],
      );
      return;
    }
    if (message.kind === 'init') {
      if (renderer !== undefined || busy) throw new Error('Duplicate Render Worker initialization');
      busy = true;
      canvas = message.canvas;
      gpuPassTimingEnabled = message.gpuPassTiming !== undefined;
      const prepared = await prepareBootstrapEntry(message.bootstrapUrl, message.bootstrapData);
      if (!prepared.ok) throw prepared.error;
      if (message.rhiCapture === true) {
        attachment = await attachWorkerRhiRecorder();
        capture = createRhiCapture(attachment);
      }
      const constructed = await constructRuntimeRendererHost(
        canvas,
        {
          ...(attachment === undefined
            ? {}
            : {
                rhi: attachment.backend.rhi,
                rhiInstrumentation: {
                  ...createRhiInstrumentation(attachment),
                  onFrameBoundary: () => {
                    captureBoundary = attachment?.frameBoundary();
                  },
                },
              }),
          publicationSource: message.identity,
          ...(message.gpuPassTiming === undefined ? {} : { gpuPassTiming: message.gpuPassTiming }),
          ...(message.outputColorSpace === undefined
            ? {}
            : { outputColorSpace: message.outputColorSpace }),
          ...(prepared.value.features === undefined ? {} : { features: prepared.value.features }),
          ...(prepared.value.ssrIdentity === undefined
            ? {}
            : { ssrIdentity: prepared.value.ssrIdentity }),
        },
        {
          ...(message.shaderManifestUrl === undefined
            ? {}
            : { shaderManifestUrl: message.shaderManifestUrl }),
          ...(message.build === undefined ? {} : { build: message.build }),
        },
      );
      if (!constructed.ok) throw constructed.error;
      renderer = constructed.value.renderer;
      publicationIdentity = message.identity;
      await prepared.value.configureRenderer?.(renderer);
      const declared = prepared.value.features ?? [];
      const active = new Set(declared.map((feature) => feature.identity));
      synchronizeFeatures = async (identities) => {
        for (const feature of declared) {
          if (identities.has(feature.identity) === active.has(feature.identity)) continue;
          const result = identities.has(feature.identity)
            ? await constructed.value.featureHost.installRenderFeature(feature)
            : await constructed.value.featureHost.uninstallRenderFeature(feature);
          if (!result.ok) throw result.error;
          if (identities.has(feature.identity)) active.add(feature.identity);
          else active.delete(feature.identity);
        }
      };
      busy = false;
      const inspection = renderer.inspect();
      scope.postMessage({
        kind: 'ready',
        capabilities: inspection.capabilities,
        ...(inspection.limits === undefined ? {} : { limits: inspection.limits }),
      });
      return;
    }
    if (renderer === undefined || canvas === undefined || busy)
      throw new Error('Render Worker has no publication credit');
    busy = true;
    if (message.width > 0 && message.height > 0) {
      if (canvas.width !== message.width) canvas.width = message.width;
      if (canvas.height !== message.height) canvas.height = message.height;
    }
    await synchronizeFeatures(
      new Set(message.publication.features.map((feature) => feature.identity)),
    );
    if (failed) return;
    const features: { identity: string; feedback: unknown }[] = [];
    const draw = renderer.draw({
      publication: message.publication,
      onFeatureSourceSubmitted: (identity, feedback) => features.push({ identity, feedback }),
    });
    if (!draw.ok) throw draw.error;
    const receipt = draw.value;
    terrainReceipts.set(message.frameId, receipt);
    while (terrainReceipts.size > 8) {
      const oldest = terrainReceipts.keys().next().value;
      if (oldest === undefined) break;
      terrainReceipts.delete(oldest);
    }
    const snapshotBoundary = captureBoundary;
    captureBoundary = undefined;
    completionOwnsFrame = true;
    completing = completeFrame(message, renderer, receipt, completing, snapshotBoundary);
    if (failed) return;
    scope.postMessage({
      kind: 'submitted',
      revision: message.publication.revision,
      features,
      frame: {
        kind: 'frame-submitted',
        worldIdentity: message.worldIdentity,
        frameId: message.frameId,
        deviceGeneration: receipt.deviceGeneration,
        ...(receipt.graphGeneration === undefined
          ? {}
          : { graphGeneration: receipt.graphGeneration }),
        ...(receipt.barrelDistortion === undefined
          ? {}
          : { barrelDistortion: receipt.barrelDistortion }),
      },
    });
    // Keep the source's submitted-before-completed order and existing credits,
    // while freezing GPU resources until the frame-header snapshot is complete.
    if (snapshotBoundary !== undefined) await snapshotBoundary;
  } catch (cause) {
    fail(message, cause);
  } finally {
    if (message.kind === 'draw') {
      busy = false;
      if (!completionOwnsFrame) {
        closeVideoFrames(message);
        framesInFlight--;
      }
    }
  }
}
let drawing: Promise<void> | undefined;
let queued: DrawMessage | undefined;
scope.onmessage = (event) => {
  const message = event.data;
  if (shuttingDown || failed) {
    if (message.kind === 'draw') closeVideoFrames(message);
    // Disposal still drains the failed worker's submitted GPU work.
    if (message.kind === 'dispose' && !shuttingDown) void receive(message);
    return;
  }
  if (message.kind === 'init') {
    initializing = receive(message);
    return;
  }
  if (message.kind !== 'draw') {
    void receive(message);
    return;
  }
  if (framesInFlight >= 2) {
    fail(message, new Error('Render Worker has no publication credit'));
    closeVideoFrames(message);
    return;
  }
  framesInFlight++;
  if (drawing !== undefined) {
    queued = message;
    return;
  }
  const drain = async (first: DrawMessage): Promise<void> => {
    await receive(first);
    while (queued !== undefined) {
      const next = queued;
      queued = undefined;
      await receive(next);
    }
    drawing = undefined;
  };
  drawing = drain(message);
};

function transferable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? (bytes as Uint8Array<ArrayBuffer>)
    : bytes.slice();
}
