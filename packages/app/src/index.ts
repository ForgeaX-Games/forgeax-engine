// @forgeax/engine-app -- public surface (M5: errors.ts complete).
//
// AI users:
//   - One-screen takeoff: `await createApp(canvas)`. Lands in M4 (M1 stub
//     returns a structured error pointing at the assemble entry).
//   - Assemble form: `await createApp({ renderer, world, input?, schedule? })`.
//     M3 ships rAF + frame-loop wired; M4 wires error fan-out + console.error
//     fallback + canvas-detach guard; M5 ships the AppError class + 5-member
//     closed AppErrorCode union + APP_ERROR_HINTS / APP_EXPECTED tables.
//   - loadGame validates the native default Cordis plugin exported by a project.
//
// Single import path:
//   import {
//     createApp,
//     loadGame,
//     AppError, LoadGameError,
//     APP_ERROR_HINTS, LOAD_GAME_ERROR_HINTS,
//     APP_EXPECTED, LOAD_GAME_EXPECTED,
//     isAppError, isLoadGameError,
//     type App, type GameHost, type Plugin,
//     type AppAssembleArgs, type CreateAppOptions,
//     type AppErrorCode, type LoadGameErrorCode,
//     type AppErrorDetail, type LoadGameErrorDetail,
//     type AppErrorDetailFor, type LoadGameErrorDetailFor,
//     type AppDetailCanvasDetached, type AppDetailSystemUpdateFailed,
//     type LoadGameDetailImportFailed, type LoadGameDetailInvalidFormat,
//     type LoadGameDetailModuleNotFound, type GamePluginResolver,
//   } from '@forgeax/engine-app';

export type {
  Effect,
  EffectMeta,
  Fiber,
  Inject,
  Plugin,
} from '@forgeax/engine-plugin';
export { Context } from '@forgeax/engine-plugin';
export {
  createFullscreenRenderFeature,
  type FullscreenRenderFeatureOptions,
} from '@forgeax/engine-render/authoring';
export {
  type BrowserFrameSubmitted,
  FORGEAX_FRAME_SUBMITTED_DATASET,
  FORGEAX_FRAME_SUBMITTED_EVENT,
  publishBrowserFrameSubmitted,
  resetBrowserFrameSubmitted,
} from './browser-frame-signal';
export { createApp, measureCanvasDrawingBuffer, syncCanvasDrawingBuffer } from './create-app';
export type {
  AppDetailCanvasDetached,
  AppDetailEmpty,
  AppDetailExecutionBootstrapFailed,
  AppDetailExecutionDeadlineExceeded,
  AppDetailExecutionKernelFailed,
  AppDetailExecutionRebuildFailed,
  AppDetailExecutionStaleWorld,
  AppDetailExecutionTierUnavailable,
  AppDetailPluginActivationFailed,
  AppDetailSystemUpdateFailed,
  AppErrorCode,
  AppErrorDetail,
  AppErrorDetailFor,
} from './errors';
export {
  APP_ERROR_HINTS,
  APP_EXPECTED,
  AppError,
  isAppError,
} from './errors';
export type {
  ExecutionAssetCatalog,
  ExecutionBootstrapEntry,
  ExecutionBootstrapHost,
  ExecutionBootstrapValue,
  ExecutionCapabilities,
  ExecutionCapabilityFact,
  ExecutionCapabilityName,
  ExecutionControl,
  ExecutionEngineHealth,
  ExecutionFault,
  ExecutionMeasurement,
  ExecutionOptions,
  ExecutionReport,
  ExecutionRequestedTier,
  ExecutionSelection,
  ExecutionSelectionReason,
  ExecutionTier,
  ExecutionWorldHealth,
  KernelDispatchReason,
  PreparedExecutionBootstrap,
} from './execution';
export {
  createExecutionReport,
  EXECUTION_CAPABILITY_NAMES,
  EXECUTION_REPORT_SCHEMA_VERSION,
  EXECUTION_REQUESTED_TIERS,
  EXECUTION_TIERS,
  executionBootstrapHostPlugin,
  isExecutionReport,
  loadBootstrapEntry,
  missingExecutionCapabilities,
  prepareBootstrapEntry,
  probeExecutionCapabilities,
  selectExecutionTier,
  unavailableExecutionCapabilities,
  validateExecutionBootstrapData,
} from './execution';
export { ensureFallbackCamera } from './fallback-camera';
export type {
  GameActionArgsSchema,
  GameActionDef,
  GameHost,
  GameProjectionRegistrar,
  GameProjectionValue,
  GameReadDef,
} from './game-context';
export { gameHostPlugin } from './game-context';
export { inputPlugin } from './plugin-factories';
export type { RenderFeatureHost } from './renderer-plugin';
export {
  ownedRendererPlugin,
  rendererPlugin,
  renderFeatureHostPlugin,
  renderFeaturePlugin,
} from './renderer-plugin';

import {
  isLoadGameError,
  LOAD_GAME_ERROR_HINTS,
  LOAD_GAME_EXPECTED,
  LoadGameError,
} from './load-game-errors';

export type { GamePluginResolver } from './load-game';
export { loadGame } from './load-game';
export type {
  LoadGameDetailImportFailed,
  LoadGameDetailInvalidFormat,
  LoadGameDetailModuleNotFound,
  LoadGameErrorCode,
  LoadGameErrorDetail,
  LoadGameErrorDetailFor,
} from './load-game-errors';
export {
  createToolPreviewHost,
  replayToolPreviewCapture,
  type ToolPreviewCaptureResult,
  type ToolPreviewHost,
  type ToolPreviewHostError,
  type ToolPreviewHostOptions,
  type ToolPreviewResourceFacts,
  type ToolPreviewResourceKind,
  type ToolPreviewResourceRequest,
  type ToolPreviewRunResult,
} from './tool-preview/bootstrap';
export {
  createToolPreviewEvidence,
  joinResourcePreviewEvidence,
  joinToolPreviewEvidence,
  type ToolPreviewEvidence,
} from './tool-preview/evidence';
export {
  fitToolPreviewCameraToAabb,
  type ToolPreviewCameraFrame,
} from './tool-preview/framing';
export {
  createToolPreviewRecipe,
  type ToolPreviewAction,
  type ToolPreviewPresentation,
  type ToolPreviewRecipe,
  type ToolPreviewRecipeOptions,
  type ToolPreviewTrace,
  type ToolPreviewTraceEvent,
  validateToolPreviewTrace,
} from './tool-preview/recipe';
export type {
  App,
  AppAssembleArgs,
  AssembleAppError,
  BundlerOptions,
  CanvasAppError,
  CanvasDrawingBufferSize,
  CreateAppOptions,
  DrawSource,
  DrawSourceResult,
  ExecutionApp,
} from './types';
export { APP_PHASE_CATALOG } from './types';
export { isLoadGameError, LOAD_GAME_ERROR_HINTS, LOAD_GAME_EXPECTED, LoadGameError };
