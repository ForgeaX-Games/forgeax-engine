import type { Plugin } from '@forgeax/engine-plugin';
import type { RenderFeature } from '@forgeax/engine-render';
import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import type { ExecutionBootstrapValue } from './types';

/** Realm-local engine assembly returned by an execution bootstrap module. */
export interface PreparedExecutionBootstrap {
  /** Render features constructed in the realm that will own the Renderer. */
  readonly features?: readonly RenderFeature<unknown>[];
  /** Plugins constructed in the realm that will own the World. */
  readonly plugins?: readonly Plugin[];
}

/** Realm-local Host bridge available to execution bootstrap plugins. */
export interface ExecutionBootstrapHost {
  readonly port?: MessagePort;
  setPointerLockAllowed(allowed: boolean): void;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    executionBootstrapHost: ExecutionBootstrapHost;
  }
}

/** Bind the optional Host transport to the same Fiber that owns bootstrap plugins. */
export function executionBootstrapHostPlugin(host: ExecutionBootstrapHost): Plugin {
  return {
    name: 'execution-bootstrap-host',
    provide: 'executionBootstrapHost',
    apply(ctx) {
      ctx.provide('executionBootstrapHost', host);
      if (host.port !== undefined) {
        ctx.effect(() => () => host.port?.close(), 'execution/bootstrap-port');
      }
    },
  };
}

/** Default export contract for `ExecutionOptions.bootstrap`. */
export type ExecutionBootstrapEntry = (
  data: ExecutionBootstrapValue | undefined,
) => PreparedExecutionBootstrap | Promise<PreparedExecutionBootstrap>;

function bootstrapError(
  phase: 'import' | 'export' | 'prepare' | 'bootstrap' | 'data',
  moduleUrl: string,
  cause: unknown,
): AppErrorType {
  return new AppError({
    code: 'app-execution-bootstrap-failed',
    expected: APP_EXPECTED['app-execution-bootstrap-failed'],
    hint: APP_ERROR_HINTS['app-execution-bootstrap-failed'],
    detail: { phase, moduleUrl, cause },
  });
}

export function validateExecutionBootstrapData(
  data: ExecutionBootstrapValue | undefined,
  moduleUrl: string,
): Result<void, AppErrorType> {
  if (data === undefined) return ok(undefined);
  try {
    structuredClone(data);
    return ok(undefined);
  } catch (cause) {
    return err(bootstrapError('data', moduleUrl, cause));
  }
}

export async function loadBootstrapEntry(
  moduleUrl: string,
): Promise<Result<ExecutionBootstrapEntry, AppErrorType>> {
  let loaded: unknown;
  try {
    loaded = await import(/* @vite-ignore */ moduleUrl);
  } catch (cause) {
    return err(bootstrapError('import', moduleUrl, cause));
  }
  const entry = (loaded as { default?: unknown }).default;
  if (typeof entry !== 'function') {
    return err(
      bootstrapError(
        'export',
        moduleUrl,
        new TypeError('default export is not an ExecutionBootstrapEntry function'),
      ),
    );
  }
  return ok(entry as ExecutionBootstrapEntry);
}

export async function prepareBootstrapEntry(
  moduleUrl: string,
  data: ExecutionBootstrapValue | undefined,
): Promise<Result<PreparedExecutionBootstrap, AppErrorType>> {
  const valid = validateExecutionBootstrapData(data, moduleUrl);
  if (!valid.ok) return valid;
  const loaded = await loadBootstrapEntry(moduleUrl);
  if (!loaded.ok) return loaded;
  try {
    const prepared = await loaded.value(data);
    if (
      typeof prepared !== 'object' ||
      prepared === null ||
      (prepared.features !== undefined && !Array.isArray(prepared.features)) ||
      (prepared.plugins !== undefined && !Array.isArray(prepared.plugins))
    ) {
      return err(
        bootstrapError(
          'prepare',
          moduleUrl,
          new TypeError('execution bootstrap must return an object with feature and plugin arrays'),
        ),
      );
    }
    return ok(prepared);
  } catch (cause) {
    return err(bootstrapError('prepare', moduleUrl, cause));
  }
}
