import type { World } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import type { BootstrapEntry } from '../game-context';

export async function loadBootstrapEntry(
  moduleUrl: string,
): Promise<Result<BootstrapEntry, AppErrorType>> {
  let loaded: unknown;
  try {
    loaded = await import(/* @vite-ignore */ moduleUrl);
  } catch (cause) {
    return err(
      new AppError({
        code: 'app-execution-bootstrap-failed',
        expected: APP_EXPECTED['app-execution-bootstrap-failed'],
        hint: APP_ERROR_HINTS['app-execution-bootstrap-failed'],
        detail: { phase: 'import', moduleUrl, cause },
      }),
    );
  }
  const entry = (loaded as { default?: unknown }).default;
  if (typeof entry !== 'function') {
    return err(
      new AppError({
        code: 'app-execution-bootstrap-failed',
        expected: APP_EXPECTED['app-execution-bootstrap-failed'],
        hint: APP_ERROR_HINTS['app-execution-bootstrap-failed'],
        detail: {
          phase: 'export',
          moduleUrl,
          cause: new TypeError('default export is not a function'),
        },
      }),
    );
  }
  return ok(entry as BootstrapEntry);
}

export async function runBootstrapEntry(
  moduleUrl: string,
  world: World,
): Promise<Result<void, AppErrorType>> {
  const loaded = await loadBootstrapEntry(moduleUrl);
  if (!loaded.ok) return loaded;
  try {
    await loaded.value(world);
    return ok(undefined);
  } catch (cause) {
    return err(
      new AppError({
        code: 'app-execution-bootstrap-failed',
        expected: APP_EXPECTED['app-execution-bootstrap-failed'],
        hint: APP_ERROR_HINTS['app-execution-bootstrap-failed'],
        detail: { phase: 'bootstrap', moduleUrl, cause },
      }),
    );
  }
}
