// @forgeax/engine-app -- public surface (M5: errors.ts complete).
//
// AI users:
//   - One-screen takeoff: `await createApp(canvas)`. Lands in M4 (M1 stub
//     returns a structured error pointing at the assemble entry).
//   - Assemble form: `await createApp({ renderer, world, input?, schedule? })`.
//     M3 ships rAF + frame-loop wired; M4 wires error fan-out + console.error
//     fallback + canvas-detach guard; M5 ships the AppError class + 5-member
//     closed AppErrorCode union + APP_ERROR_HINTS / APP_EXPECTED tables.
//   - M2 (feat-20260526-preview-runtime-host): loadGame / LoadGameError /
//     GameContext / GameEntry exported from the same barrel.
//
// Single import path:
//   import {
//     createApp,
//     loadGame,
//     AppError, LoadGameError,
//     APP_ERROR_HINTS, LOAD_GAME_ERROR_HINTS,
//     APP_EXPECTED, LOAD_GAME_EXPECTED,
//     isAppError, isLoadGameError,
//     type App, type GameContext, type GameEntry,
//     type AppAssembleArgs, type CreateAppOptions,
//     type AppErrorCode, type LoadGameErrorCode,
//     type AppErrorDetail, type LoadGameErrorDetail,
//     type AppErrorDetailFor, type LoadGameErrorDetailFor,
//     type AppDetailCanvasDetached, type AppDetailSystemUpdateFailed,
//     type LoadGameDetailImportFailed, type LoadGameDetailInvalidFormat,
//     type LoadGameDetailModuleNotFound, type GameEntryResolver,
//   } from '@forgeax/engine-app';

export { createApp } from './create-app';
export type {
  AppDetailCanvasDetached,
  AppDetailEmpty,
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
export type { BootstrapContext, BootstrapEntry, GameContext, GameEntry } from './game-context';

import {
  isLoadGameError,
  LOAD_GAME_ERROR_HINTS,
  LOAD_GAME_EXPECTED,
  LoadGameError,
} from './load-game-errors';

export type { GameEntryResolver } from './load-game';
export { loadGame } from './load-game';
export type {
  LoadGameDetailImportFailed,
  LoadGameDetailInvalidFormat,
  LoadGameDetailModuleNotFound,
  LoadGameErrorCode,
  LoadGameErrorDetail,
  LoadGameErrorDetailFor,
} from './load-game-errors';
export type {
  App,
  AppAssembleArgs,
  AssembleAppError,
  BundlerOptions,
  CanvasAppError,
  CreateAppOptions,
} from './types';
export { isLoadGameError, LOAD_GAME_ERROR_HINTS, LOAD_GAME_EXPECTED, LoadGameError };
