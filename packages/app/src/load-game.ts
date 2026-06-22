// @forgeax/engine-app -- loadGame(slug, resolver) -> Result<GameEntry, LoadGameError>
//
// Pure-function load helper that validates a dynamically-imported game
// template module. The resolver is an injection point so loadGame is
// independent of Vite / bundler specifics.
//
// Shape:
//   1. Call resolver(slug). If resolver throws, distinguish module-not-found
//      (slug in detail) from import-failed (cause in detail).
//   2. If resolver returns a module, check typeof module.default === 'function'.
//   3. On success, return Result.ok(module.default).
//
// Constraints from upstream:
//   - requirements D-3: loadGame does NOT depend on Vite specifics
//   - requirements boundary-case table: module-not-found -> slug in detail;
//     invalid-format -> exportKeys; import-failed -> cause
//   - plan-strategy D-3: LoadGameError reuses codebase structured error pattern
//
// Charter awareness:
//   - P3 explicit failure: all 3 error paths return structured Result.err
//   - F1 context-limited: the function is one screen (no hidden state)

import { err, ok, type Result } from '@forgeax/engine-ecs';

import type { GameEntry } from './game-context';
import { LOAD_GAME_ERROR_HINTS, LOAD_GAME_EXPECTED, LoadGameError } from './load-game-errors';

/**
 * The shape of a module that the resolver returns. loadGame checks
 * `typeof module.default === 'function'` before treating it as a valid
 * GameEntry.
 */
interface GameEntryModule {
  readonly default?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Resolver function signature: receives a slug (the game identifier),
 * returns a Promise that resolves to a module object.
 *
 * The host (apps/preview/) injects this as a dynamic import proxy,
 * e.g. `(slug) => import(\`../../templates/\${slug}/src/main.ts\`)`.
 * loadGame does not hardcode any import path.
 */
export type GameEntryResolver = (slug: string) => Promise<GameEntryModule>;

/**
 * Load and validate a game template module.
 *
 * Returns `Result.ok<GameEntry>` when the resolver returns a module
 * whose `default` export is a function. Returns `Result.err<LoadGameError>`
 * with one of 3 error codes on failure.
 *
 * @param slug - The game identifier (e.g. 'game-default'). Passed
 *   through to the resolver and carried in the 'module-not-found' detail.
 * @param resolver - Async function that imports/fetches the game module.
 *   The host owns all path resolution logic.
 */
export async function loadGame(
  slug: string,
  resolver: GameEntryResolver,
): Promise<Result<GameEntry, LoadGameError>> {
  let module: GameEntryModule;
  try {
    module = await resolver(slug);
  } catch (thrown: unknown) {
    // Distinguish module-not-found from generic import failure.
    // The heuristic: if the thrown error contains the slug in its message,
    // treat it as module-not-found (the resolver signaled the specific
    // module was not found, e.g. Vite "Failed to load module" with the
    // slug path in the message). Otherwise treat it as import-failed
    // (generic network error, eval error, etc.).
    if (thrown instanceof Error && thrown.message.includes(slug)) {
      return err(
        new LoadGameError({
          code: 'module-not-found',
          expected: LOAD_GAME_EXPECTED['module-not-found'],
          hint: LOAD_GAME_ERROR_HINTS['module-not-found'],
          detail: { slug },
        }),
      );
    }
    return err(
      new LoadGameError({
        code: 'import-failed',
        expected: LOAD_GAME_EXPECTED['import-failed'],
        hint: LOAD_GAME_ERROR_HINTS['import-failed'],
        detail: { cause: thrown },
      }),
    );
  }

  // Validate default export: must be a function. null / undefined /
  // non-function values are all invalid-format.
  if (typeof module.default !== 'function') {
    const exportKeys = Object.keys(module);
    return err(
      new LoadGameError({
        code: 'invalid-format',
        expected: LOAD_GAME_EXPECTED['invalid-format'],
        hint: LOAD_GAME_ERROR_HINTS['invalid-format'],
        detail: { exportKeys },
      }),
    );
  }

  return ok(module.default as GameEntry);
}
