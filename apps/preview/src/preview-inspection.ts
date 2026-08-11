import type {
  App,
  GameActionDef,
  GameProjectionRegistrar,
  GameProjectionValue,
  GameReadDef,
} from '@forgeax/engine-app';
import type { SimulationError, SimulationErrorCode } from '@forgeax/engine-ecs';

type PreviewInspectionErrorCode =
  | 'projection-action-not-found'
  | 'projection-read-not-found'
  | 'projection-action-failed'
  | 'projection-read-failed'
  | 'projection-result-not-serializable'
  | 'rhi-debug-unavailable'
  | 'rhi-capture-failed'
  | 'recover-not-needed'
  | 'recover-not-implemented'
  | 'recover-adapter-unavailable'
  | 'recover-device-unavailable';

export type PreviewInspectionError = {
  readonly code: PreviewInspectionErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: { readonly id?: string; readonly cause?: string };
};

export type PreviewInspectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PreviewInspectionError };

export interface SimulationErrorSurface {
  readonly code: SimulationErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SimulationError['detail'];
  readonly action: string;
  readonly baselineFingerprint: string;
}

export const SIMULATION_INSPECTION_SCHEMA_URI =
  'https://forgeax.dev/schema/simulation-inspection-v1.json';

/** Project a simulation failure without turning the Preview into a restore owner. */
export function consumeSimulationError(
  simulationError: SimulationError,
  baselineFingerprint: string,
): SimulationErrorSurface {
  let action: string;
  switch (simulationError.code) {
    case 'simulation-record-invalid':
      action = 'repair the record and create a new in-process v1 record';
      break;
    case 'simulation-state-unsupported':
      action = 'mark the value transient or add an owner-level portable descriptor';
      break;
    case 'simulation-resource-invalid':
      action = 'register the recoverable resource descriptor and create a new record';
      break;
    case 'simulation-entity-unmapped':
      action = 'create a fresh target and preserve every entity mapping';
      break;
    case 'simulation-participant-duplicate':
      action = 'keep one participant registration per stable id';
      break;
    case 'simulation-participant-missing':
      action = 'register participant on a fresh target and retry';
      break;
    case 'simulation-participant-version-mismatch':
      action = 'use the declared participant version and create a new record';
      break;
    case 'simulation-participant-schema-mismatch':
      action = 'use a compatible participant schema and create a new record';
      break;
    case 'simulation-participant-not-ready':
      action = 'wait until the participant is ready, then retry on a fresh target';
      break;
    case 'simulation-participant-prepare-failed':
      action = 'discard the staging result and retry with a fresh target';
      break;
    case 'simulation-trace-invalid':
      action = 'repair the fixed-tick trace before restoring the record';
      break;
    case 'simulation-compare-invalid':
      action = 'declare a finite non-negative tolerance for every numeric field';
      break;
    case 'simulation-target-not-fresh':
      action = 'create a new target World and retry without reusing partial state';
      break;
  }
  return {
    code: simulationError.code,
    expected: simulationError.expected,
    hint: simulationError.hint,
    detail: simulationError.detail,
    action,
    baselineFingerprint,
  };
}

export type PreviewProjectionDescriptor = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly argsSchema?: GameActionDef['argsSchema'];
};

export type PreviewInspection = {
  readonly version: 1;
  readonly list: () => {
    readonly actions: readonly PreviewProjectionDescriptor[];
    readonly reads: readonly PreviewProjectionDescriptor[];
  };
  readonly read: (id: string) => Promise<PreviewInspectionResult<GameProjectionValue>>;
  readonly run: (
    id: string,
    args?: GameProjectionValue,
  ) => Promise<PreviewInspectionResult<GameProjectionValue>>;
  readonly renderer: {
    readonly health: () => GameProjectionValue;
    readonly recover: () => Promise<PreviewInspectionResult<GameProjectionValue>>;
  };
  readonly captureFrame: (frames?: number) => Promise<PreviewInspectionResult<GameProjectionValue>>;
};

type BrowserCapture = (frames?: number) => Promise<GameProjectionValue>;

const hostKey = '__forgeaxPreviewInspection';

function error(
  code: PreviewInspectionErrorCode,
  expected: string,
  hint: string,
  detail?: PreviewInspectionError['detail'],
): PreviewInspectionError {
  return detail === undefined ? { code, expected, hint } : { code, expected, hint, detail };
}

function serialise(
  value: unknown,
):
  | { readonly ok: true; readonly value: GameProjectionValue }
  | { readonly ok: false; readonly cause: string } {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return { ok: false, cause: 'JSON.stringify returned undefined' };
    return { ok: true, value: JSON.parse(json) as GameProjectionValue };
  } catch (cause) {
    return { ok: false, cause: String(cause) };
  }
}

function descriptor(def: GameActionDef | GameReadDef): PreviewProjectionDescriptor {
  return {
    id: def.id,
    title: def.title,
    ...(def.description === undefined ? {} : { description: def.description }),
    ...('argsSchema' in def && def.argsSchema !== undefined ? { argsSchema: def.argsSchema } : {}),
  };
}

/**
 * Create the Preview-only inspection boundary for one loaded game.
 *
 * The host owns transport and renderer lifecycle; game code owns the action/read
 * meanings. The returned registrar is passed through BootstrapContext and is
 * cleared by registerCleanup, so a stopped run cannot leave stale closures on
 * the browser global.
 */
export function createPreviewInspection(
  app: App,
  registerCleanup: (cleanup: () => void) => void,
): { readonly registrar: GameProjectionRegistrar; readonly inspection: PreviewInspection } {
  const actions = new Map<string, GameActionDef>();
  const reads = new Map<string, GameReadDef>();

  const simulationInspection = (
    app as App & { readonly simulationInspection?: () => GameProjectionValue }
  ).simulationInspection;
  if (simulationInspection !== undefined) {
    reads.set('simulation.inspect', {
      id: 'simulation.inspect',
      title: 'Simulation inspection',
      description: `Read the World-owned simulation record, participant, trace, and report summary (${SIMULATION_INSPECTION_SCHEMA_URI}).`,
      read: simulationInspection,
    });
  }

  const registrar: GameProjectionRegistrar = {
    registerAction(def) {
      if (actions.has(def.id) || reads.has(def.id)) {
        throw new Error(`preview: duplicate projection id '${def.id}'`);
      }
      actions.set(def.id, def);
      return () => {
        if (actions.get(def.id) === def) actions.delete(def.id);
      };
    },
    registerRead(def) {
      if (actions.has(def.id) || reads.has(def.id)) {
        throw new Error(`preview: duplicate projection id '${def.id}'`);
      }
      reads.set(def.id, def);
      return () => {
        if (reads.get(def.id) === def) reads.delete(def.id);
      };
    },
  };

  const read = async (id: string): Promise<PreviewInspectionResult<GameProjectionValue>> => {
    const def = reads.get(id);
    if (def === undefined) {
      return {
        ok: false,
        error: error(
          'projection-read-not-found',
          'a read projection registered by the loaded game',
          'call inspection.list() and use one of the returned read ids',
          { id },
        ),
      };
    }
    try {
      const result = serialise(await def.read());
      return result.ok
        ? result
        : {
            ok: false,
            error: error(
              'projection-result-not-serializable',
              'the read projection must return JSON-shaped data',
              'return only null, booleans, numbers, strings, arrays, and plain objects',
              { id, cause: result.cause },
            ),
          };
    } catch (cause) {
      return {
        ok: false,
        error: error(
          'projection-read-failed',
          'the registered read projection completed without throwing',
          'inspect the game-owned read implementation and retry',
          { id, cause: String(cause) },
        ),
      };
    }
  };

  const run = async (
    id: string,
    args: GameProjectionValue = null,
  ): Promise<PreviewInspectionResult<GameProjectionValue>> => {
    const def = actions.get(id);
    if (def === undefined) {
      return {
        ok: false,
        error: error(
          'projection-action-not-found',
          'an action projection registered by the loaded game',
          'call inspection.list() and use one of the returned action ids',
          { id },
        ),
      };
    }
    try {
      const result = serialise(await def.run(args));
      return result.ok
        ? result
        : {
            ok: false,
            error: error(
              'projection-result-not-serializable',
              'the action result must be JSON-shaped data',
              'return only null, booleans, numbers, strings, arrays, and plain objects',
              { id, cause: result.cause },
            ),
          };
    } catch (cause) {
      return {
        ok: false,
        error: error(
          'projection-action-failed',
          'the registered action completed without throwing',
          'inspect the game-owned action implementation and retry',
          { id, cause: String(cause) },
        ),
      };
    }
  };

  const inspection: PreviewInspection = {
    version: 1,
    list: () => ({
      actions: [...actions.values()].map(descriptor),
      reads: [...reads.values()].map(descriptor),
    }),
    read,
    run,
    renderer: {
      health: () => {
        const result = serialise(app.renderer.health());
        return result.ok ? result.value : { reason: 'internal-fault', recoverable: false };
      },
      recover: async () => {
        const result = await app.renderer.recover();
        const health = serialise(app.renderer.health());
        const healthValue = health.ok
          ? health.value
          : { reason: 'internal-fault', recoverable: false };
        return result.ok
          ? { ok: true, value: { recovered: true, health: healthValue } }
          : {
              ok: false,
              error: {
                code: result.error.code,
                expected: result.error.expected,
                hint: result.error.hint,
              },
            };
      },
    },
    captureFrame: async (frames = 1) => {
      const capture = (globalThis as { __forgeax?: { captureFrame?: BrowserCapture } }).__forgeax
        ?.captureFrame;
      if (capture === undefined) {
        return {
          ok: false,
          error: error(
            'rhi-debug-unavailable',
            'Preview must be started with the RHI debug dev plugin',
            'use the Preview dev host and keep the debug plugin enabled before requesting capture',
          ),
        };
      }
      try {
        return { ok: true, value: await capture(frames) };
      } catch (cause) {
        return {
          ok: false,
          error: error(
            'rhi-capture-failed',
            'the active renderer must produce an uploadable RHI tape',
            'inspect the renderer error and retry after the next healthy frame',
            { cause: String(cause) },
          ),
        };
      }
    },
  };

  const host = globalThis as Record<string, unknown>;
  host[hostKey] = inspection;
  registerCleanup(() => {
    actions.clear();
    reads.clear();
    if (host[hostKey] === inspection) delete host[hostKey];
  });
  return { registrar, inspection };
}
