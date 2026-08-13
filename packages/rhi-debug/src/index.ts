// @forgeax/engine-rhi-debug/src/index.ts — package barrel.

import type { CaptureFramesOptions } from './capture-options';

export type { CaptureFramesOptions } from './capture-options';

export {
  type CapsMismatchDetail,
  DebugError,
  type DebugErrorCode,
  type DebugErrorDetail,
  type DeterministicViolationDetail,
  type RhiCapsRecordedKey,
} from './errors';
export {
  analyzeMergeability,
  type MergeabilityGroup,
  type MergeabilityReport,
  type MergeabilityRun,
} from './mergeability';
export { pixelDeltaAbsMean } from './pixel-diff';
export {
  type LiveLinearHdrReadback,
  type LiveObservationDescriptor,
  type LiveObservationLease,
  type LiveObservationSource,
  type NamedLinearHdrReadback,
  type NamedLinearHdrReadbackMetadata,
  type ResolvedTextureDescriptor,
  readbackDrawRt,
  readbackLiveLinearHdr,
  readbackNamedLinearHdr,
  readbackTexturePixels,
  resolveAttachmentSize,
  resolveTextureDescriptor,
} from './readback';
export {
  type CreateShaderModuleFn,
  type DebugRhiInstance,
  PER_EVENT_OVERHEAD,
  TAPE_FORMAT_VERSION,
  wrap,
  wrapCreateShaderModule,
} from './recorder';
// Node-free capture primitives (recorder-core). assembleReport is the D-3
// single-writer report helper reused by the vite-plugin-rhi-debug HTTP endpoint
// so browser-uploaded tapes land byte-identical to the Node finalize() tail.
export {
  type AssembledReport,
  assembleReport,
  type FinalizeToMemoryValue,
  finalizeToMemory,
  generateRunId,
} from './recorder-core';
// Inspector exports are NOT re-exported from the barrel to avoid pulling
// pngjs (Node.js dep) into downstream bundles (e.g., the app package).
// Import from '@forgeax/engine-rhi-debug/inspector' for inspector APIs.
export type { Replay } from './replayer';
export { adaptReplayFormat, createReplay, replayInitialData } from './replayer';
// w10: DebugRhiAdapter type inlined here (was in rpc-bridge.ts, which is deleted).
// wireDebugRhiInspector deleted alongside routing layer removal.

/**
 * DebugRhiAdapter shape (w10: inlined from deleted rpc-bridge.ts).
 * Three RPC surfaces: captureFrames / inspectAt / replayDispose.
 */
export interface DebugRhiAdapter {
  captureFrames(
    frames: number,
    label?: string,
    options?: CaptureFramesOptions,
  ): Promise<{
    readonly tapes: Array<{
      readonly frameIdx: number;
      readonly runId: string;
      readonly tapePath: string;
      readonly reportPath: string;
    }>;
  }>;
  inspectAt(
    tapePath: string,
    drawIdx: number,
    fields?: readonly ('bindings' | 'drawCall' | 'rt')[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<Record<string, unknown>>;
  replayDispose(tapePath: string): Promise<{ readonly ok: boolean }>;
}
export {
  buildResourceLifecycle,
  type ResourceByteEstimate,
  type ResourceKind,
  type ResourceLifecycleEntry,
  type ResourceLifecycleSummary,
  type ResourceOrigin,
} from './resource-lifecycle';
export type { PassOffset } from './tape-format';
export {
  computePassOffsets,
  deserializeTape,
  serializeTape,
} from './tape-format';
export { decodeTexelRaw, decodeToRgba8, halfToFloat } from './texel-decode';
export {
  bytesPerTexel,
  type ChannelType,
  type FormatInfo,
  formatInfo,
} from './texel-layout';
export type {
  HandleId,
  InspectBindingEntry,
  InspectDrawCall,
  InspectFields,
  InspectReport,
  RhiCallEvent,
  RhiCallEventInitialData,
  RhiCapsRecorded,
  Tape,
} from './types';
// CLI subcommands (capture-frame / inspect-at) are NOT re-exported from the barrel:
// they depend on inspector-client (WS) and are Node.js-only. Import from
// '@forgeax/engine-rhi-debug/cli' for CLI functions.
