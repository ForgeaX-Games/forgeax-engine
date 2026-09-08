import type {
  App,
  GameActionDef,
  GameProjectionRegistrar,
  GameProjectionValue,
  GameReadDef,
} from '@forgeax/engine-app';

type PreviewInspectionErrorCode =
  | 'projection-action-not-found'
  | 'projection-read-not-found'
  | 'projection-action-failed'
  | 'projection-read-failed'
  | 'projection-result-not-serializable'
  | 'rhi-debug-unavailable'
  | 'rhi-capture-failed'
  | 'rhi-artifact-upload-failed'
  | 'recover-not-needed'
  | 'recover-not-implemented'
  | 'recover-adapter-unavailable'
  | 'recover-device-unavailable'
  | 'recover-lifecycle-failed'
  | 'recover-disposed-during-rebuild';

export type PreviewInspectionError = {
  readonly code: PreviewInspectionErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: { readonly id?: string; readonly cause?: string };
};

export type PreviewInspectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PreviewInspectionError };

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
  /** Test-only access to the live registry used by browser transport gates. */
  readonly assets: App['assets'];
  readonly captureFrame: (frames?: number) => Promise<PreviewInspectionResult<GameProjectionValue>>;
};

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

function rendererHealth(app: App): GameProjectionValue {
  const inspection = app.renderer.inspect();
  return {
    reason: inspection.state,
    recoverable: inspection.state === 'device-lost',
    surface: inspection.surface,
    frame: {
      frameId: inspection.frame.frameId,
      deviceGeneration: inspection.frame.deviceGeneration,
    },
    features: [...inspection.features],
  };
}

/**
 * Create the Preview-only inspection boundary for one loaded game.
 *
 * The host owns transport and renderer lifecycle; game code owns the action/read
 * meanings. The returned registrar is passed through GameHost and is
 * cleared by registerCleanup, so a stopped run cannot leave stale closures on
 * the browser global.
 */
export function createPreviewInspection(
  app: App,
  registerCleanup: (cleanup: () => void) => void,
): { readonly registrar: GameProjectionRegistrar; readonly inspection: PreviewInspection } {
  const actions = new Map<string, GameActionDef>();
  const reads = new Map<string, GameReadDef>();

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
      health: () => rendererHealth(app),
      recover: async () => {
        const result = await app.renderer.recover();
        const healthValue = rendererHealth(app);
        return result.ok
          ? { ok: true, value: { recovered: true, health: healthValue } }
          : {
              ok: false,
              error: {
                code: 'recover-lifecycle-failed',
                expected: result.error.expected,
                hint: `${result.error.hint} (${result.error.code})`,
              },
            };
      },
    },
    assets: app.assets,
    captureFrame: async (frames = 1) => {
      if (frames !== 1) {
        return {
          ok: false,
          error: error(
            'rhi-capture-failed',
            'one capture request must produce one single-file rhi-tape ArtifactRef',
            'request exactly one frame and use the returned ArtifactRef for summary and inspect',
            { id: 'frames', cause: `requested ${frames}` },
          ),
        };
      }
      const capture = app.rhiCapture;
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
        const captured = await capture.captureFrame();
        if (!captured.ok) {
          return {
            ok: false,
            error: error('rhi-capture-failed', captured.error.expected, captured.error.hint, {
              cause: captured.error.code,
            }),
          };
        }
        const runId = `preview-${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
        const response = await fetch(`/__forgeax-debug/tape?runId=${encodeURIComponent(runId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-forgeax-rhitape' },
          body: captured.value.bytes as unknown as BodyInit,
        });
        const payload: unknown = await response.json();
        if (
          !response.ok ||
          payload === null ||
          typeof payload !== 'object' ||
          (payload as { kind?: unknown }).kind !== 'rhi-tape' ||
          (payload as { digest?: unknown }).digest !== captured.value.digest ||
          typeof (payload as { path?: unknown }).path !== 'string'
        ) {
          return {
            ok: false,
            error: error(
              'rhi-artifact-upload-failed',
              'the Vite RHI debug provider must accept one raw v7 .rhitape and return its ArtifactRef',
              'start the Preview dev host with the RHI debug plugin and retry the capture',
              { cause: JSON.stringify(payload) },
            ),
          };
        }
        return {
          ok: true,
          value: {
            kind: 'rhi-tape',
            digest: captured.value.digest,
            source: 'rhi.capture',
            path: (payload as { path: string }).path,
          },
        };
      } catch (cause) {
        return {
          ok: false,
          error: error(
            'rhi-artifact-upload-failed',
            'the active renderer must produce an uploadable RHI tape and the dev provider must be reachable',
            'inspect the Preview dev server and retry after the next healthy frame',
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
