// @forgeax/engine-rhi-debug/src/index.ts -- v7 public contract.
//
// AI cold-start path: one .rhitape ArtifactRef, one FrameModel workIndex, and one
// fresh ReplaySession. Consumers should use structured Result errors and keep
// browser, Node, and backend ownership at their host boundaries.

export {
  createRhiDebugError,
  type RhiDebugError,
  type RhiDebugErrorCode,
  type RhiDebugErrorDetail,
  type RhiDebugErrorFor,
} from './errors';
export type {
  CommandEntry,
  FrameModel,
  FramePass,
  JsonValue,
  ResourceConsumer,
  ResourceEntry,
  WorkBinding,
  WorkEntry,
  WorkPipeline,
} from './frame-model';
export {
  buildFrameModel,
  buildResourceLifecycle,
  type ResourceByteEstimate,
  type ResourceKind,
  type ResourceLifecycleEntry,
  type ResourceLifecycleSummary,
} from './frame-model';
export { decodeTape, encodeTape } from './protocol/codec';
export type { EventCategory, EventSemantics } from './protocol/event-semantics';
export {
  EVENT_SEMANTICS,
  eventKinds,
  isWorkEvent,
  resourceKindForEvent,
  workEventKinds,
} from './protocol/event-semantics';
export type {
  TapeIndex,
  TapePassEntry,
  TapeResourceEntry,
  TapeWorkEntry,
} from './protocol/tape-index';
export { buildTapeIndex } from './protocol/tape-index';
export type {
  BootstrapResource,
  InitialDataSlice,
  RhiCallEvent as V7RhiCallEvent,
  RhiCapsRecorded as V7RhiCapsRecorded,
  RhiDebugResult,
  Tape as V7Tape,
  TapeBlob as V7TapeBlob,
  TapeBlobCompression,
  TapeEncodeOptions,
} from './protocol/types';
export {
  TAPE_FORMAT_VERSION as V7_TAPE_FORMAT_VERSION,
  TAPE_MAGIC,
} from './protocol/types';
export { readbackTexturePixels } from './readback';
export {
  attachRecorder,
  type CaptureFrameOptions,
  type CreateShaderModuleFn,
  type EncodedTape,
  type RecordableBackend,
  type RecorderAttachment,
  type RecorderBackend,
  type RecorderOptions,
} from './recorder/session';
export { replayDeviceRequest } from './replay/device-request';
export {
  type InspectField,
  openReplay,
  type ReadbackSubresource,
  type ReplayBackend,
  type ReplayReadbackResult,
  type ReplaySession,
  type TextureSubresource,
  type WorkInspection,
} from './replay/session';
export { decodeTexelRaw, decodeToRgba8, halfToFloat } from './texel-decode';
export {
  bytesPerTexel,
  type ChannelType,
  type FormatInfo,
  formatInfo,
} from './texel-layout';
