// @forgeax/engine-rhi-debug/src/recorder/lifecycle -- capture state and snapshot lifecycle.

/// <reference types="@webgpu/types" />

import type { Result, RhiDevice } from '@forgeax/engine-rhi';
import { err as makeErr, ok as makeOk } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import {
  readbackBufferBytes,
  readbackBufferBytesBatch,
  readbackTexturePixels,
  readbackTexturePixelsBatch,
} from '../readback';
import { computeTextureLayout, projectTextureExtent } from '../texel-layout';
import type { HandleId, RhiCallEvent, Tape } from '../types';
import {
  _collectFrameReferencedHandleIds,
  _computeClosure,
  _getCreateEventReferencedHandleIds,
  _topoSortClosure,
} from './closure';
import {
  isDepthOrStencilFormat,
  isMappableBuffer,
  isSnapshottableColorTexture,
  pushSnapshotEvent,
  type RecorderInternal,
  RecorderState,
  reconcileSwapchainViewFormats,
  SNAPSHOT_RESOURCE_BATCH_SIZE,
  SNAPSHOT_TIMEOUT_MS,
  snapshotStageOf,
  snapshotTimeoutDetail,
  storeBlob,
  TAPE_FORMAT_VERSION,
} from './core';

export function createRecorderLifecycle(s: RecorderInternal) {
  function arm(frames: number): Result<void, RhiDebugError> {
    if (
      s.state === RecorderState.Armed ||
      s.state === RecorderState.Snapshotting ||
      s.state === RecorderState.Recording ||
      s.state === RecorderState.Finalizing
    ) {
      return makeErr(
        createRhiDebugError('capture-busy', {
          stage: 'capture',
          cause: 'arm() called while the recorder is already capturing',
        }),
      );
    }
    if (s.state === RecorderState.Error) {
      return makeErr(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: 'the recorder is in an error state; dispose the failed capture before re-arming',
        }),
      );
    }

    s.state = RecorderState.Armed;
    // A previous bounded snapshot may still be unwinding after its timeout.
    // Its generation fence prevents stale cleanup from touching this capture;
    // reset the suppression latch here so the new capture can record normally.
    s._skipRecord = false;
    s.snapshotGeneration += 1;
    s.requestedFrames = frames;
    s.recordedFrames = 0;
    s.events = [];
    s.blobPool = new Map();
    s.snapshotSeededHandles.clear();
    s.snapshotProgress = undefined;
    s.frameIdx = 0;
    s.bootstrap = true;
    s.valid = true;
    return makeOk(undefined);
  }

  function onFrameEnd(): void {
    if (s.state === RecorderState.Idle) {
      s.frameIdx++;
      s.bootstrap = false;
      return;
    }

    // Snapshotting = the async frame-header snapshot loop is mid-flight. Its
    // readbacks await between resources, so the host rAF loop CAN fire
    // onFrameEnd while the loop is still pushing initialData events. If we let
    // that tick advance the state machine (Recording -> frameMark -> Finalizing
    // -> Idle), the still-running snapshot loop's later pushEvent() calls hit
    // the Idle gate and are silently dropped -- the exact race that lost every
    // texture initialData (material default textures all-zero -> black cube).
    // Ignore the tick entirely: snapshotAllLiveResources() sets Recording when
    // it completes, and the NEXT onFrameEnd records the real frame.
    if (s.state === RecorderState.Snapshotting) {
      s.bootstrap = false;
      return;
    }

    // Armed at frame end -> recording. This is the fallback for hosts that
    // never call snapshotAllLiveResources() (the snapshot loop is opt-in at the
    // seam); they record straight from Armed with no frame-header snapshot.
    if (s.state === RecorderState.Armed) {
      s.state = RecorderState.Recording;
      s.bootstrap = false;
    }

    if (s.state === RecorderState.Recording) {
      // Emit frameMark at end of this frame
      s.events.push({ kind: 'frameMark', frameIdx: s.frameIdx });
      s.recordedFrames++;
      s.frameIdx++;

      if (s.recordedFrames >= s.requestedFrames) {
        s.state = RecorderState.Finalizing;
        if (s.onFrameEndUnsubscribe) {
          s.onFrameEndUnsubscribe();
          s.onFrameEndUnsubscribe = undefined;
        }
        s.state = RecorderState.Idle;
      }
      return;
    }

    // finalizing or error: no-op
    s.frameIdx++;
  }

  function getTape(): Tape | RhiDebugError | undefined {
    if (s.events.length === 0) return undefined;

    reconcileSwapchainViewFormats(s);

    // Pre-scan s.events for create* declarations: handleIds whose
    // create event is already carried by the frame events (transient
    // per-frame resources like swapchain textures, command encoders).
    // These handles do NOT need bootstrap prefixing -- they were born
    // during the recorded frame and their create event is in s.events.
    // Collect handleIds that are directly declared by create* events in s.events.
    // Only include the handleId field of the create event itself — NOT backward-refs
    // (layoutHandleId, resourceHandleIds, etc.) from _getCreateEventReferencedHandleIds.
    //
    // Backward-refs from in-frame create events often point to persistent resources
    // (buffers, textures, pipelines) that were created before arm(). Including them
    // in inFrameHandleIds would exclude those resources from bootstrap prefixing,
    // causing tapes to be non-self-contained (missing create* events for early handles).
    //
    // Swapchain textures that have no createTexture event are handled elsewhere:
    // createTextureView (line 1237) detects missing bootstrap entries and constructs
    // faithful createTexture events at capture time, so they are already in both
    // bootstrapCreates and s.events.
    const inFrameHandleIds = new Set<HandleId>();
    for (const e of s.events) {
      // create* events declare handleId (or resultHandleId for createTextureView).
      if (
        e.kind.startsWith('create') &&
        'handleId' in e &&
        typeof (e as { handleId: unknown }).handleId === 'string'
      ) {
        inFrameHandleIds.add((e as { handleId: HandleId }).handleId);
      }
      // createTextureView declares the result via resultHandleId.
      if (
        e.kind === 'createTextureView' &&
        'resultHandleId' in e &&
        typeof (e as { resultHandleId: unknown }).resultHandleId === 'string'
      ) {
        inFrameHandleIds.add((e as { resultHandleId: HandleId }).resultHandleId);
      }
      // createCommandEncoder declares the cmd via cmdHandleId.
      if (
        e.kind === 'createCommandEncoder' &&
        'cmdHandleId' in e &&
        typeof (e as { cmdHandleId: unknown }).cmdHandleId === 'string'
      ) {
        inFrameHandleIds.add((e as { cmdHandleId: HandleId }).cmdHandleId);
      }
      // beginRenderPass / beginComputePass declare passHandleId.
      if (
        (e.kind === 'beginRenderPass' || e.kind === 'beginComputePass') &&
        'passHandleId' in e &&
        typeof (e as { passHandleId: unknown }).passHandleId === 'string'
      ) {
        inFrameHandleIds.add((e as { passHandleId: HandleId }).passHandleId);
      }
    }

    // Collect frame-referenced handleIds from per-frame events.
    const allFrameHandleIds = _collectFrameReferencedHandleIds(s.events);

    // Exclude handles whose create event is already in s.events:
    // only compute bootstrap closure for handles that need prefixing.
    const prefixSeedIds = new Set<HandleId>();
    for (const hId of allFrameHandleIds) {
      if (!inFrameHandleIds.has(hId)) {
        prefixSeedIds.add(hId);
      }
    }

    // Transitive closure from bootstrapCreates
    const { closure, missing } = _computeClosure(
      prefixSeedIds,
      s.bootstrapCreates,
      inFrameHandleIds,
    );

    if (missing !== null) {
      // Missing create — return error (hint refined in w9)
      const referencingEventIndex = s.events.findIndex((event) => {
        try {
          return JSON.stringify(event).includes(missing);
        } catch {
          return false;
        }
      });
      const referencingEventKind =
        referencingEventIndex >= 0 ? s.events[referencingEventIndex]?.kind : undefined;
      const referencingCreate = [...s.bootstrapCreates.entries()].find(([, event]) =>
        _getCreateEventReferencedHandleIds(event).includes(missing),
      );
      return createRhiDebugError('tape-invalid', {
        stage: 'validate',
        cause: `handleId '${missing}' has no create event in bootstrap table; referenced by event ${referencingEventIndex} (${referencingEventKind ?? 'unknown'}) and bootstrap ${referencingCreate?.[0] ?? 'unknown'} (${referencingCreate?.[1].kind ?? 'unknown'})`,
        handleId: missing,
        eventIndex: referencingEventIndex,
      });
    }

    // Topological sort: dependencies (leaf resources) before dependents
    const prefixEvents: RhiCallEvent[] = _topoSortClosure(closure, s.bootstrapCreates);

    // dedup: only prefix create events not already in s.events.
    const dedupedPrefx = prefixEvents.filter((e) => {
      if ('handleId' in e && typeof (e as { handleId: unknown }).handleId === 'string') {
        return !inFrameHandleIds.has((e as { handleId: HandleId }).handleId);
      }
      return true;
    });

    return {
      formatVersion: TAPE_FORMAT_VERSION,
      rhiCapsRecorded: s.recordedCaps ?? {
        canvasFormat: 'bgra8unorm' as GPUTextureFormat,
        rgba16floatRenderable: false,
        float32Filterable: false,
        textureCompressionBc: false,
        textureCompressionEtc2: false,
        textureCompressionAstc: false,
        storageBuffer: false,
        timestampQuery: false,
      },
      events: [...dedupedPrefx, ...s.events],
      blobPool: s.blobPool,
    };
  }

  function getState(): string {
    return s.state;
  }
  function getEvents(): readonly RhiCallEvent[] {
    return s.events;
  }
  function getBlobPool(): ReadonlyMap<string, ArrayBuffer> {
    return s.blobPool;
  }

  function transitionToError(): void {
    if (
      s.state === RecorderState.Recording ||
      s.state === RecorderState.Armed ||
      s.state === RecorderState.Snapshotting
    ) {
      s.state = RecorderState.Error;
      s.snapshotGeneration += 1;
      s._skipRecord = false;
      s.valid = false;
      if (s.onFrameEndUnsubscribe) {
        s.onFrameEndUnsubscribe();
        s.onFrameEndUnsubscribe = undefined;
      }
    }
  }

  function disposeError(): void {
    if (s.state === RecorderState.Error) {
      s.state = RecorderState.Idle;
      s.snapshotGeneration += 1;
      s._skipRecord = false;
      s.events = [];
      s.blobPool = new Map();
      s.valid = true;
      s.snapshotProgress = undefined;
    }
  }

  /**
   * Snapshot a resource's GPU bytes into the tape as an initialData event.
   *
   * Reads the resource shape from the descriptor registry, copies the bytes
   * back from the GPU via readbackBufferBytes (buffer) / readbackTexturePixels
   * (texture), stores them in the blobPool (djb2 hash-dedup), and pushes an
   * `initialData` event into the stream. The snapshot's own copy/submit are
   * wrapped in `_skipRecord = true` so they never leak into the tape event
   * stream (D-8 isolation).
   *
   * Async because the GPU readback chain (copyToBuffer -> submit ->
   * onSubmittedWorkDone -> mapAsync) is inherently asynchronous; the M1 stub
   * locked a sync signature, but no caller existed yet — the frame-header loop
   * added here is the first consumer (Change stance: optimal > compatible).
   *
   * Returns Result with {handleId, dataHash} on success, or
   * capture-snapshot-failed (with structured snapshot detail) on a
   * failure, so AI users can switch-exhaustive narrow the code (D-3).
   */
  async function snapshotResource(
    handleId: HandleId,
    snapshotGeneration?: number,
  ): Promise<Result<{ handleId: HandleId; dataHash: string }, RhiDebugError>> {
    type SnapshotResult = Result<{ handleId: HandleId; dataHash: string }, RhiDebugError>;
    const fail = (
      stage: 'copy' | 'map' | 'store',
      _expected: string,
      hint: string,
    ): SnapshotResult =>
      makeErr(
        createRhiDebugError('capture-snapshot-failed', {
          stage: 'snapshot',
          cause: `${stage}: ${hint}`,
          handleId,
        }),
      );

    const entry = s.descriptorTable.get(handleId);
    if (entry === undefined) {
      return fail(
        'copy',
        'handleId present in descriptor registry',
        `no live resource registered for handleId '${handleId}'; it may have been destroyed or never created through the recorder proxy`,
      );
    }

    const device = s.capturedDevice;
    if (device === undefined) {
      return fail(
        'copy',
        'a captured RhiDevice to drive GPU readback',
        'no device has been acquired through the recorder proxy yet; drive requestAdapter().requestDevice() before snapshotting',
      );
    }

    // Resolve the unwrapped real device — readback issues copy/submit/mapAsync
    // through it. The proxy device would re-record those calls were it not for
    // the _skipRecord guard below; using the real device sidesteps the proxy
    // entirely for the readback staging buffer.
    const realDevice = (device as RhiDevice & { _realDevice?: RhiDevice })._realDevice ?? device;
    const snapshotIsActive = () =>
      snapshotGeneration === undefined ||
      (s.state === RecorderState.Snapshotting && s.snapshotGeneration === snapshotGeneration);
    const cancelled = () =>
      makeErr(
        createRhiDebugError('capture-snapshot-failed', {
          stage: 'snapshot',
          cause:
            'snapshot was cancelled after a timeout or recorder error; discard this capture and retry',
          handleId,
        }),
      );

    let bytes: ArrayBuffer;
    const prevSkip = s._skipRecord;
    s._skipRecord = true;
    try {
      if (entry.kind === 'buffer') {
        const size = typeof entry.size === 'number' ? entry.size : 0;
        const res = await readbackBufferBytes(realDevice, entry.resource, size);
        if (!res.ok) return fail(snapshotStageOf(res.error), res.error.expected, res.error.hint);
        if (!snapshotIsActive()) return cancelled();
        bytes = res.value;
      } else {
        const { width, height, layerCount } = projectTextureExtent(entry.size);
        const layout = computeTextureLayout(
          entry.format,
          width,
          height,
          layerCount,
          entry.mipLevelCount ?? 1,
        );
        if (layout === undefined) {
          // Should not happen: the snapshot loop's isSnapshottableColorTexture
          // gate already excludes formats with no texel size. Fail fast rather
          // than emit a corrupt seed.
          return fail(
            'copy',
            'a snapshottable color format with a known texel size',
            `format '${entry.format}' has no byte layout; the snapshot gate should have skipped it`,
          );
        }
        try {
          // Read every (layer, mip) subresource and concatenate tight into one
          // blob in the canonical order computeTextureLayout defines; the seed
          // side walks the same layout to writeTexture each slice back.
          const blob = new Uint8Array(layout.totalBytes);
          for (const slice of layout.slices) {
            if (!snapshotIsActive()) return cancelled();
            const sub = await readbackTexturePixels(
              realDevice,
              entry.resource,
              slice.width,
              slice.height,
              {
                bytesPerBlock: layout.bytesPerBlock,
                blockWidth: layout.blockWidth,
                blockHeight: layout.blockHeight,
                mipLevel: slice.mip,
                baseArrayLayer: slice.layer,
              },
            );
            if (!snapshotIsActive()) return cancelled();
            blob.set(sub.subarray(0, slice.byteLength), slice.byteOffset);
          }
          bytes = blob.buffer.slice(
            blob.byteOffset,
            blob.byteOffset + blob.byteLength,
          ) as ArrayBuffer;
        } catch (e) {
          return fail(
            'copy',
            'texture GPU byte readback to succeed',
            `readbackTexturePixels failed: ${String(e)}`,
          );
        }
      }
    } finally {
      // A retry may begin before a timed-out readback promise settles. Do not
      // let the stale generation restore its old suppression bit over the new
      // capture's active snapshot; only the generation that acquired it may
      // release it.
      if (snapshotGeneration === undefined || s.snapshotGeneration === snapshotGeneration) {
        s._skipRecord = prevSkip;
      }
    }

    if (!snapshotIsActive()) return cancelled();

    // storeBlob: djb2 hash-dedup into the unified blobPool (D-1, no separate
    // init-data pool). Reuses the same tag space as writeBuffer/writeTexture.
    let dataHash: string;
    try {
      dataHash = storeBlob(s, bytes);
    } catch (e) {
      return fail(
        'store',
        'storeBlob to hash + insert the snapshot bytes',
        `storeBlob failed: ${String(e)}`,
      );
    }

    pushSnapshotEvent(s, { kind: 'initialData', handleId, dataHash });
    s.snapshotSeededHandles.add(handleId);
    return makeOk({ handleId, dataHash });
  }

  /**
   * Frame-header snapshot loop (D-5, C-3, C-4): with the recorder in the
   * Snapshotting middle state, await all submitted work, then snapshot every
   * live resource in the descriptor registry (full-table dump, no size
   * threshold / allowlist trimming — that for-loop is the single Phase 2
   * policy seam, OOS-4 / OOS-5). On full success the recorder advances to
   * Recording; a single snapshot failure aborts with its Result so the
   * caller fails fast (architecture §5) rather than recording a partial seed.
   */
  async function snapshotAllLiveResources(
    timeoutMs = SNAPSHOT_TIMEOUT_MS,
  ): Promise<Result<void, RhiDebugError>> {
    if (s.state !== RecorderState.Armed && s.state !== RecorderState.Snapshotting) {
      return makeErr(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: `snapshotAllLiveResources called while recorder is in '${s.state}' state; arm() before the frame-header snapshot`,
        }),
      );
    }
    const snapshotGeneration = s.snapshotGeneration;
    s.state = RecorderState.Snapshotting;

    const timeoutError = () =>
      createRhiDebugError('capture-timeout', snapshotTimeoutDetail(s.snapshotProgress, timeoutMs));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<Result<void, RhiDebugError>>((resolve) => {
      timer = setTimeout(() => {
        // The caller may have timed out first, disposed the failed capture,
        // and already started a new generation. A late timer from that stale
        // snapshot must not poison the retry that now owns the recorder.
        if (s.state === RecorderState.Snapshotting && s.snapshotGeneration === snapshotGeneration) {
          transitionToError();
        }
        resolve(makeErr(timeoutError()));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        runSnapshotAllLiveResources(snapshotGeneration),
        timeoutResult,
      ]);
      if (
        !result.ok &&
        s.state === RecorderState.Snapshotting &&
        s.snapshotGeneration === snapshotGeneration
      ) {
        transitionToError();
      }
      return result;
    } catch (error) {
      if (s.state === RecorderState.Snapshotting && s.snapshotGeneration === snapshotGeneration) {
        transitionToError();
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function runSnapshotAllLiveResources(
    snapshotGeneration: number,
  ): Promise<Result<void, RhiDebugError>> {
    s.snapshotProgress = {
      startedAt: Date.now(),
      stage: 'queue-drain',
      totalResources: s.descriptorTable.size,
      completedResources: 0,
      skippedResources: 0,
      currentHandleId: null,
      currentKind: null,
      currentSizeBytes: null,
    };

    // C-3 conservative timing: drain queued work so snapshots read frame-outside
    // / historical content, never a half-written in-frame value (A-2).
    const device = s.capturedDevice;
    const realDevice =
      device === undefined
        ? undefined
        : ((device as RhiDevice & { _realDevice?: RhiDevice })._realDevice ?? device);
    if (realDevice !== undefined) {
      const prevSkip = s._skipRecord;
      s._skipRecord = true;
      try {
        await realDevice.queue.onSubmittedWorkDone();
      } finally {
        if (s.snapshotGeneration === snapshotGeneration) s._skipRecord = prevSkip;
      }
      if (s.snapshotProgress !== undefined) {
        s.snapshotProgress = { ...s.snapshotProgress, stage: 'resource-readback' };
      }
      if (s.state !== RecorderState.Snapshotting || s.snapshotGeneration !== snapshotGeneration) {
        return makeErr(
          createRhiDebugError('capture-snapshot-failed', {
            stage: 'snapshot',
            cause: 'snapshot was cancelled while queued GPU work was draining',
          }),
        );
      }
    }

    const liveEntries = [...s.descriptorTable.entries()];
    const candidates = liveEntries.filter(([handleId, entry]) => {
      // Mappable buffers are staging scratch, not seedable authored resources.
      if (entry.kind === 'buffer' && isMappableBuffer(entry.usage)) {
        if (s.snapshotProgress !== undefined) {
          s.snapshotProgress = {
            ...s.snapshotProgress,
            skippedResources: s.snapshotProgress.skippedResources + 1,
          };
        }
        return false;
      }
      // Depth/stencil and multisample textures cannot be faithfully re-seeded.
      if (
        entry.kind === 'texture' &&
        (isDepthOrStencilFormat(entry.format) ||
          !isSnapshottableColorTexture(entry.format, entry.size, entry.sampleCount))
      ) {
        if (s.snapshotProgress !== undefined) {
          s.snapshotProgress = {
            ...s.snapshotProgress,
            skippedResources: s.snapshotProgress.skippedResources + 1,
          };
        }
        return false;
      }
      // Preserve the existing transient-texture policy: a texture destroyed
      // before its turn is skipped, while a resource already admitted to a
      // batch retains its seed even if it is released during that batch.
      if (entry.kind === 'texture' && !s.descriptorTable.has(handleId)) {
        if (s.snapshotProgress !== undefined) {
          s.snapshotProgress = {
            ...s.snapshotProgress,
            skippedResources: s.snapshotProgress.skippedResources + 1,
          };
        }
        return false;
      }
      return true;
    });

    const snapshotIsActive = () =>
      s.state === RecorderState.Snapshotting && s.snapshotGeneration === snapshotGeneration;
    const cancelledResult = () =>
      makeErr(
        createRhiDebugError('capture-snapshot-failed', {
          stage: 'snapshot',
          cause: 'snapshot was cancelled while live resources were being seeded',
        }),
      );

    // No captured device is an existing error path for snapshotResource. Keep
    // it serial and deterministic rather than manufacturing a batch surface.
    if (realDevice === undefined) {
      for (const [handleId, entry] of candidates) {
        if (s.snapshotProgress !== undefined) {
          s.snapshotProgress = {
            ...s.snapshotProgress,
            stage: 'resource-readback',
            currentHandleId: handleId,
            currentKind: entry.kind,
            currentSizeBytes:
              entry.kind === 'buffer' && typeof entry.size === 'number' ? entry.size : null,
          };
        }
        const result = await snapshotResource(handleId, snapshotGeneration);
        if (!result.ok) return result;
        if (s.snapshotProgress !== undefined) {
          s.snapshotProgress = {
            ...s.snapshotProgress,
            completedResources: s.snapshotProgress.completedResources + 1,
            currentHandleId: null,
            currentKind: null,
            currentSizeBytes: null,
          };
        }
      }
    } else {
      let offset = 0;
      while (offset < candidates.length) {
        const first = candidates[offset];
        if (first === undefined) break;
        const kind = first[1].kind;
        const batchEntries: typeof candidates = [];
        while (
          offset < candidates.length &&
          batchEntries.length < SNAPSHOT_RESOURCE_BATCH_SIZE &&
          candidates[offset]?.[1].kind === kind
        ) {
          const candidate = candidates[offset];
          if (candidate !== undefined) batchEntries.push(candidate);
          offset += 1;
        }

        if (s.snapshotProgress !== undefined) {
          s.snapshotProgress = {
            ...s.snapshotProgress,
            stage: 'resource-readback',
            currentHandleId: batchEntries[0]?.[0] ?? null,
            currentKind: kind,
            currentSizeBytes:
              kind === 'buffer' && typeof batchEntries[0]?.[1].size === 'number'
                ? batchEntries[0][1].size
                : null,
          };
        }

        if (kind === 'buffer') {
          const batch = await readbackBufferBytesBatch(
            realDevice,
            batchEntries.map(([handleId, entry]) => ({
              handleId,
              buffer: entry.resource,
              size: typeof entry.size === 'number' ? entry.size : 0,
            })),
            {
              onResourceStart: (handleId) => {
                const entry = s.descriptorTable.get(handleId);
                if (s.snapshotProgress !== undefined && entry !== undefined) {
                  s.snapshotProgress = {
                    ...s.snapshotProgress,
                    currentHandleId: handleId,
                    currentKind: 'buffer',
                    currentSizeBytes: typeof entry.size === 'number' ? entry.size : null,
                  };
                }
              },
              onResourceComplete: () => {
                if (s.snapshotProgress !== undefined) {
                  s.snapshotProgress = {
                    ...s.snapshotProgress,
                    completedResources: s.snapshotProgress.completedResources + 1,
                    currentHandleId: null,
                    currentKind: null,
                    currentSizeBytes: null,
                  };
                }
              },
              isCancelled: () => !snapshotIsActive(),
            },
          );
          if (!batch.ok) return batch;
          if (!snapshotIsActive()) return cancelledResult();
          for (const [handleId] of batchEntries) {
            const bytes = batch.value.get(handleId);
            if (bytes === undefined) {
              return makeErr(
                createRhiDebugError('capture-snapshot-failed', {
                  stage: 'snapshot',
                  cause: 'the batched GPU readback returned no bytes for a live buffer',
                  handleId,
                  resourceKind: 'buffer',
                }),
              );
            }
            const dataHash = storeBlob(s, bytes);
            pushSnapshotEvent(s, { kind: 'initialData', handleId, dataHash });
            s.snapshotSeededHandles.add(handleId);
          }
        } else {
          const requests = batchEntries.map(([handleId, entry]) => {
            const { width, height, layerCount } = projectTextureExtent(entry.size);
            const layout = computeTextureLayout(
              entry.format,
              width,
              height,
              layerCount,
              entry.mipLevelCount ?? 1,
            );
            if (layout === undefined) {
              throw new Error(`texture '${handleId}' has no snapshottable byte layout`);
            }
            return {
              handleId,
              texture: entry.resource,
              bytesPerBlock: layout.bytesPerBlock,
              blockWidth: layout.blockWidth,
              blockHeight: layout.blockHeight,
              totalBytes: layout.totalBytes,
              slices: layout.slices,
            };
          });
          const batch = await readbackTexturePixelsBatch(realDevice, requests, {
            onResourceStart: (handleId) => {
              if (s.snapshotProgress !== undefined) {
                s.snapshotProgress = {
                  ...s.snapshotProgress,
                  currentHandleId: handleId,
                  currentKind: 'texture',
                  currentSizeBytes: null,
                };
              }
            },
            isCancelled: () => !snapshotIsActive(),
          });
          if (!batch.ok) return batch;
          if (!snapshotIsActive()) return cancelledResult();
          for (const [handleId] of batchEntries) {
            // A transient texture can be released while its batch is waiting
            // on the GPU. The copy was intentionally isolated and cleaned up,
            // but the released handle must not become a seed for the next
            // frame. Buffers retain the historical batch behavior above.
            if (!s.descriptorTable.has(handleId)) {
              if (s.snapshotProgress !== undefined) {
                s.snapshotProgress = {
                  ...s.snapshotProgress,
                  skippedResources: s.snapshotProgress.skippedResources + 1,
                  currentHandleId: null,
                  currentKind: null,
                  currentSizeBytes: null,
                };
              }
              continue;
            }
            const bytes = batch.value.get(handleId);
            if (bytes === undefined) {
              return makeErr(
                createRhiDebugError('capture-snapshot-failed', {
                  stage: 'snapshot',
                  cause: 'the batched GPU readback returned no bytes for a live texture',
                  handleId,
                  resourceKind: 'texture',
                }),
              );
            }
            const dataHash = storeBlob(s, bytes);
            pushSnapshotEvent(s, { kind: 'initialData', handleId, dataHash });
            s.snapshotSeededHandles.add(handleId);
            if (s.snapshotProgress !== undefined) {
              s.snapshotProgress = {
                ...s.snapshotProgress,
                completedResources: s.snapshotProgress.completedResources + 1,
                currentHandleId: null,
                currentKind: null,
                currentSizeBytes: null,
              };
            }
          }
        }
        if (!snapshotIsActive()) return cancelledResult();
      }
    }

    if (s.snapshotProgress !== undefined) {
      s.snapshotProgress = {
        ...s.snapshotProgress,
        currentHandleId: null,
        currentKind: null,
        currentSizeBytes: null,
      };
    }

    if (s.state !== RecorderState.Snapshotting || s.snapshotGeneration !== snapshotGeneration) {
      return makeErr(
        createRhiDebugError('capture-snapshot-failed', {
          stage: 'snapshot',
          cause: 'snapshot was cancelled before the full live-resource table was seeded',
        }),
      );
    }
    s.state = RecorderState.Recording;
    return makeOk(undefined);
  }

  // --------------------------------------------------
  // proxy construction
  // --------------------------------------------------

  return {
    arm,
    onFrameEnd,
    getTape,
    getState,
    getEvents,
    getBlobPool,
    transitionToError,
    disposeError,
    snapshotResource,
    snapshotAllLiveResources,
  };
}
