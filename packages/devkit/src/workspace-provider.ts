import { randomUUID } from 'node:crypto';
import {
  createEngineWorkspaceProvider,
  ENGINE_WORKSPACE_COMMAND_TOPIC,
  type EngineWorkspaceAsset,
  type EngineWorkspaceCameraInput,
  type EngineWorkspacePlay,
  type EngineWorkspacePreview,
  type EngineWorkspaceProject,
  type EngineWorkspaceProjectSession,
  type EngineWorkspaceProvider,
  type EngineWorkspaceTarget,
  engineWorkspaceResultService,
} from '@forgeax/engine-app';
import { type BackendHost, createBackendHost } from '@forgeax/engine-host/backend';
import type { HostCallerIdentity } from '@forgeax/engine-host/transport';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import { assetInspectCommand } from './assets.js';
import { prepareRuntimePackProgram } from './build/pack-program.js';
import { createViteConfig, materializeViteDevPort } from './host.js';
import type { DevKitHostBinding } from './host-binding.js';
import { readProjectFacts } from './project.js';
import type { ProjectFacts } from './types.js';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
// Cold shader initialization shares the GPU with already running targets.
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export interface DevKitWorkspaceProviderOptions {
  readonly width?: number;
  readonly height?: number;
  /** Select the presentation target. The provider never infers this from the browser. */
  readonly headed?: boolean;
  /** `0` asks Vite for an OS-assigned loopback port. */
  readonly port?: number;
  /** Bound the browser-page readiness handshake and every command result. */
  readonly readyTimeoutMs?: number;
  /** Notify the workspace owner when browser readiness or loss changes a target. */
  readonly onTargetChanged?: () => void;
  /**
   * Test/host injection points. Production defaults use the real Vite server
   * and backend Host; the provider never launches a browser of its own. The
   * target document is the only browser App/World/AssetRegistry/renderer realm.
   */
  readonly backendFactory?: () => Promise<BackendHost>;
  /**
   * Borrow an already assembled Engine BackendHost for this workspace. The
   * provider owns only the project server, bridge, and command resources when
   * this binding is supplied.
   */
  readonly hostBinding?: DevKitHostBinding;
  readonly viteServerFactory?: (config: InlineConfig) => Promise<ViteDevServer>;
}

export interface DevKitWorkspaceTargetOptions {
  readonly sessionId: string;
  readonly targetId: string;
  readonly width: number;
  readonly height: number;
  readonly headed: boolean;
}

interface WorkspaceCommand {
  readonly kind: 'command' | 'cancel';
  readonly id: string;
  readonly sessionId: string;
  readonly operation?: string;
  readonly input?: unknown;
}

interface WorkspaceReadyResult {
  readonly kind: 'ready';
  readonly id: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly project: EngineWorkspaceProject;
  readonly target: EngineWorkspaceTarget;
}

interface WorkspaceOperationResult {
  readonly kind: 'result';
  readonly id: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: {
    readonly code?: string;
    readonly expected?: string;
    readonly hint?: string;
    readonly detail?: unknown;
  };
}

interface WorkspacePageLostResult {
  readonly kind: 'lost' | 'failed';
  readonly error?: WorkspaceOperationResult['error'];
  readonly id: string;
  readonly sessionId: string;
  readonly targetId: string;
}

type WorkspaceResult = WorkspaceReadyResult | WorkspaceOperationResult | WorkspacePageLostResult;

interface PendingResult {
  readonly targetId: string;
  readonly previewOwner?: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly onAbort: () => void;
  readonly operation: string;
}

/** A structured failure from the one browser-page workspace transport. */
export class DevKitWorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly expected: string,
    readonly hint: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${hint}`);
    this.name = 'DevKitWorkspaceError';
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal === undefined) return undefined;
  if (signal.reason !== undefined) return signal.reason;
  return Object.assign(new Error('engine workspace operation was cancelled'), {
    name: 'AbortError',
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function inspectAuthoredPack(
  root: string,
  sourcePath: string,
  sourceKey: string,
  guid: string,
  signal?: AbortSignal,
): Promise<{ meta: Record<string, unknown>; revision?: string }> {
  const result = await assetInspectCommand({ root, subject: sourcePath, sourceKey });
  throwIfAborted(signal);
  if (!result.ok)
    throw new DevKitWorkspaceError(
      result.error.code,
      result.error.expected,
      result.error.hint,
      result.error.detail,
    );
  if (
    !isRecord(result.value) ||
    typeof result.value.guid !== 'string' ||
    result.value.guid.toLowerCase() !== guid.toLowerCase()
  )
    throw new DevKitWorkspaceError(
      'asset-inspect-identity-mismatch',
      'the authored Pack output GUID to match the inspected Catalog GUID',
      'Refresh the Catalog or repair the source locator before inspecting this asset.',
      {
        guid,
        sourcePath,
        sourceKey,
        sourceGuid: isRecord(result.value) ? result.value.guid : null,
      },
    );
  const source = result.value;
  const properties = isRecord(source.payload)
    ? source.payload
    : isRecord(source.effectiveValues)
      ? source.effectiveValues
      : undefined;
  return {
    meta: {
      ...(typeof source.packageId === 'string' ? { packageId: source.packageId } : {}),
      ...(typeof source.format === 'string' ? { format: source.format } : {}),
      ...(typeof source.parentPackageId === 'string'
        ? { parentPackageId: source.parentPackageId }
        : {}),
      ...(Array.isArray(source.parameters) ? { parameters: source.parameters } : {}),
      ...(properties === undefined ? {} : { properties }),
    },
    ...(typeof source.revision === 'string' ? { revision: source.revision } : {}),
  };
}

function workspaceCallerSource(sessionId: string, targetId: string): string {
  return `forgeax-workspace:${sessionId}:${targetId}`;
}

function assertWorkspaceCaller(
  caller: HostCallerIdentity,
  sessionId: string,
  targetId: string,
  acceptedCaller: HostCallerIdentity | undefined,
): void {
  const expected = workspaceCallerSource(sessionId, targetId);
  if (
    caller.kind === 'frontend' &&
    caller.sourceId === expected &&
    acceptedCaller !== undefined &&
    caller.connectionId === acceptedCaller.connectionId &&
    caller.capability === acceptedCaller.capability
  )
    return;
  throw new DevKitWorkspaceError(
    'engine-workspace-caller-mismatch',
    'the Engine workspace result caller to match the active session and target',
    'Discard results from an old, shell, or unassociated host connection and use the active display host page.',
    {
      expectedSource: expected,
      receivedKind: caller.kind,
      receivedSource: caller.sourceId ?? null,
      receivedConnectionId: caller.connectionId,
      sessionId,
      targetId,
    },
  );
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new DevKitWorkspaceError(
      'engine-workspace-invalid-extent',
      `${name} to be a positive safe integer`,
      `Pass a positive ${name} when opening the Engine workspace.`,
      { [name]: value ?? null },
    );
  }
  return result;
}

function wireError(
  error: WorkspaceOperationResult['error'],
  operation: string,
): DevKitWorkspaceError {
  return new DevKitWorkspaceError(
    typeof error?.code === 'string' ? error.code : 'engine-workspace-browser-failure',
    typeof error?.expected === 'string'
      ? error.expected
      : `the browser workspace operation ${operation} to complete`,
    typeof error?.hint === 'string' ? error.hint : 'Inspect the browser page failure details.',
    error?.detail !== null && typeof error?.detail === 'object'
      ? (error.detail as Readonly<Record<string, unknown>>)
      : {},
  );
}

function assertProject(value: unknown, facts: ProjectFacts): EngineWorkspaceProject {
  if (value === null || typeof value !== 'object') {
    throw new DevKitWorkspaceError(
      'engine-workspace-project-invalid',
      'the browser page to return a project identity',
      'Inspect the generated Engine workspace page and reopen the project.',
      {},
    );
  }
  const project = value as Partial<EngineWorkspaceProject>;
  if (project.id !== facts.id || project.root !== facts.root) {
    throw new DevKitWorkspaceError(
      'engine-workspace-project-mismatch',
      'the browser project identity to match the opened project',
      'Treat the headed target as stale and reopen the project.',
      {
        expectedId: facts.id,
        receivedId: project.id ?? null,
        expectedRoot: facts.root,
        receivedRoot: project.root ?? null,
      },
    );
  }
  return {
    id: facts.id,
    root: facts.root,
    ...(typeof project.name === 'string' ? { name: project.name } : { name: facts.name }),
    ...(typeof project.revision === 'string' ? { revision: project.revision } : {}),
  };
}

function assertTarget(
  value: unknown,
  expected: DevKitWorkspaceTargetOptions,
): EngineWorkspaceTarget {
  if (value === null || typeof value !== 'object') {
    throw new DevKitWorkspaceError(
      'engine-workspace-target-invalid',
      'the browser page to return a stable workspace target',
      'Reopen the project and wait for the Engine browser realm to become ready.',
      {},
    );
  }
  const target = value as Partial<EngineWorkspaceTarget>;
  const targetWidth = target.width;
  const targetHeight = target.height;
  if (
    target.targetId !== expected.targetId ||
    target.sessionId !== expected.sessionId ||
    typeof target.worldId !== 'string' ||
    target.worldId.length === 0 ||
    target.headed !== expected.headed ||
    typeof targetWidth !== 'number' ||
    !Number.isSafeInteger(targetWidth) ||
    targetWidth < 1 ||
    typeof targetHeight !== 'number' ||
    !Number.isSafeInteger(targetHeight) ||
    targetHeight < 1
  ) {
    throw new DevKitWorkspaceError(
      'engine-workspace-target-mismatch',
      'the browser target identity and dimensions to match the opened session',
      'Treat the workspace target as stale and reopen the project.',
      {
        expectedSessionId: expected.sessionId,
        receivedSessionId: target.sessionId ?? null,
        expectedTargetId: expected.targetId,
        receivedTargetId: target.targetId ?? null,
      },
    );
  }
  return {
    targetId: expected.targetId,
    sessionId: expected.sessionId,
    worldId: target.worldId,
    headed: expected.headed,
    width: targetWidth,
    height: targetHeight,
    ...(typeof target.frameId === 'number' ? { frameId: target.frameId } : {}),
    ...(typeof target.url === 'string' ? { url: target.url } : {}),
  };
}

function localServerUrl(server: ViteDevServer): string {
  const local = server.resolvedUrls?.local?.[0];
  if (typeof local === 'string' && local.length !== 0) return local;
  const address = server.httpServer?.address();
  if (address !== null && typeof address === 'object' && address.port > 0) {
    return `http://127.0.0.1:${address.port}/`;
  }
  throw new DevKitWorkspaceError(
    'engine-workspace-server-url-missing',
    'the Engine Vite server to publish a loopback URL',
    'Inspect the DevKit server startup diagnostics and reopen the project.',
    {},
  );
}

/**
 * Pack startup is asynchronous: a first catalog request can legitimately
 * return 503 while the producer scans and publishes generation 1. A
 * workspace page cannot recover from that one-shot bootstrap failure, so the
 * provider waits for the existing scoped catalog route before handing its URL
 * to a browser. This is a bounded readiness wait, not a second watcher.
 */
export async function waitForRuntimeCatalog(
  serverUrl: string,
  scopeId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const catalogUrl = new URL(
    `/__pack/scopes/${encodeURIComponent(scopeId)}/1/catalog.json`,
    serverUrl,
  );
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  let lastFailure: string | undefined;
  let lastResponseBody: string | undefined;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const remaining = deadline - Date.now();
    const requestController = new AbortController();
    const requestTimeout = setTimeout(
      () => requestController.abort(),
      Math.min(5_000, Math.max(1, remaining)),
    );
    const onAbort = (): void => requestController.abort(abortReason(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(catalogUrl, {
        signal: requestController.signal,
      });
      throwIfAborted(signal);
      lastStatus = response.status;
      if (response.ok) {
        if (response.body !== null) await response.body.cancel().catch(() => {});
        return;
      }
      // Preserve the producer's bounded structured diagnostic. A 503 can be
      // either a transient generation or a terminal producer failure; the
      // caller needs the code/cause to distinguish those cases after the
      // bounded wait expires.
      try {
        const body = await response.text();
        if (body.length > 0) lastResponseBody = body.slice(0, 8_192);
      } catch (cause) {
        lastFailure = cause instanceof Error ? cause.message : String(cause);
      }
      if (response.status !== 503) break;
    } catch (cause) {
      if (signal?.aborted) throw abortReason(signal);
      lastFailure = cause instanceof Error ? cause.message : String(cause);
    } finally {
      clearTimeout(requestTimeout);
      signal?.removeEventListener('abort', onAbort);
    }
    const delay = Math.min(100, Math.max(1, remaining));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, delay);
      const onDelayAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onDelayAbort);
        reject(abortReason(signal));
      };
      function done(): void {
        signal?.removeEventListener('abort', onDelayAbort);
        resolve();
      }
      signal?.addEventListener('abort', onDelayAbort, { once: true });
      if (signal?.aborted) onDelayAbort();
    });
  }
  throw new DevKitWorkspaceError(
    'engine-workspace-catalog-not-ready',
    'the project Pack catalog to become ready before the workspace page loads',
    'Wait for the project producer to finish, repair its diagnostics if it failed, and reopen the workspace.',
    {
      catalogUrl: catalogUrl.href,
      timeoutMs,
      ...(lastStatus === undefined ? {} : { lastStatus }),
      ...(lastFailure === undefined ? {} : { lastFailure }),
      ...(lastResponseBody === undefined ? {} : { lastResponseBody }),
    },
  );
}

function commandInput(value: EngineWorkspaceCameraInput): Record<string, unknown> {
  const { signal: _signal, ...rest } = value;
  return rest as Record<string, unknown>;
}

function operationResultTarget(
  value: unknown,
  expected: DevKitWorkspaceTargetOptions,
): EngineWorkspaceTarget {
  if (value === null || typeof value !== 'object') {
    throw new DevKitWorkspaceError(
      'engine-workspace-preview-invalid',
      'the browser page to return preview metadata',
      'Retry only after the Engine workspace target is ready.',
      {},
    );
  }
  return assertTarget((value as { readonly target?: unknown }).target, expected);
}

function operationResultAsset(value: unknown): EngineWorkspaceAsset | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const asset = (value as { readonly asset?: unknown }).asset;
  if (asset === null || typeof asset !== 'object') return undefined;
  const candidate = asset as Partial<EngineWorkspaceAsset>;
  if (typeof candidate.guid !== 'string' || typeof candidate.kind !== 'string') return undefined;
  return {
    guid: candidate.guid,
    kind: candidate.kind,
    ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
    ...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
    ...(typeof candidate.revision === 'string' ? { revision: candidate.revision } : {}),
    ...(typeof candidate.previewable === 'boolean' ? { previewable: candidate.previewable } : {}),
  };
}

/**
 * Create the DevKit workspace provider used by a real project server.
 *
 * The provider starts one Vite + Host service and returns its URL before the
 * browser is ready. A host navigates its target document to that URL; the generated
 * page creates the sole App/World/AssetRegistry/renderer realm and sends a
 * readiness result over the existing Host transport. Node retains only
 * serializable project/target data and pending command results.
 */
export function createDevKitWorkspaceProvider(
  options: DevKitWorkspaceProviderOptions = {},
): EngineWorkspaceProvider {
  const width = positiveInteger(options.width, DEFAULT_WIDTH, 'width');
  const height = positiveInteger(options.height, DEFAULT_HEIGHT, 'height');
  const headed = options.headed ?? true;
  const readyTimeoutMs = positiveInteger(
    options.readyTimeoutMs,
    DEFAULT_READY_TIMEOUT_MS,
    'readyTimeoutMs',
  );
  const backendFactory = options.backendFactory ?? (() => createBackendHost());
  if (options.hostBinding !== undefined && options.backendFactory !== undefined) {
    throw new TypeError('DevKit workspace provider cannot combine hostBinding and backendFactory');
  }
  const serverFactory =
    options.viteServerFactory ?? ((config: InlineConfig) => createViteServer(config));
  let currentClose: (() => Promise<void>) | undefined;
  let disposed = false;
  const openings = new Set<Promise<unknown>>();
  const trackOpening = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = operation();
    openings.add(pending);
    void pending.then(
      () => openings.delete(pending),
      () => openings.delete(pending),
    );
    return pending;
  };

  type BrowserSession = EngineWorkspaceProjectSession & {
    readonly phase: EngineWorkspacePlay['phase'];
    borrowTarget(): EngineWorkspacePreview;
    ready(signal?: AbortSignal): Promise<void>;
  };
  const openSession = async (
    input: { root: string; signal?: AbortSignal },
    parent?: BackendHost,
  ): Promise<BrowserSession> => {
    const startupAt = performance.now();
    let lastStageAt = startupAt;
    const facts = await readProjectFacts(input.root);
    if (!facts.ok) {
      const error = facts.error;
      throw new DevKitWorkspaceError(error.code, error.expected, error.hint, error.detail);
    }
    if (disposed) {
      throw new DevKitWorkspaceError(
        'engine-workspace-provider-disposed',
        'the Engine workspace provider to remain active',
        'Create a new workspace provider before opening another project.',
        {},
      );
    }
    const sessionId = `workspace-${randomUUID()}`;
    const targetId = `target-${randomUUID()}`;
    const timing = (stage: string): void => {
      if (process.env.FORGEAX_WORKSPACE_TIMING !== '1') return;
      const now = performance.now();
      console.error(
        '[forgeax.workspace.timing]',
        JSON.stringify({
          root: facts.value.root,
          sessionId,
          targetId,
          stage,
          totalMs: Math.round(now - startupAt),
          stageMs: Math.round(now - lastStageAt),
        }),
      );
      lastStageAt = now;
    };
    timing('project-facts');
    const admissionToken = randomUUID();
    const dimensions = {
      sessionId,
      targetId,
      width,
      height,
      headed,
    } satisfies DevKitWorkspaceTargetOptions;
    const ownsBackend = parent === undefined && options.hostBinding === undefined;
    const backend = parent ?? options.hostBinding?.backend ?? (await backendFactory());
    if (disposed) {
      if (ownsBackend) await backend.dispose().catch(() => {});
      throw new DevKitWorkspaceError(
        'engine-workspace-provider-disposed',
        'the Engine workspace provider to remain active',
        'Create a new workspace provider before opening another project.',
        { sessionId, targetId },
      );
    }
    timing('backend-bound');
    const binding = {
      ...(parent ? { backend } : (options.hostBinding ?? { backend })),
      workspace: { sessionId, targetId, admissionToken, execution: parent ? 'game' : 'preview' },
    } satisfies DevKitHostBinding;
    const pending = new Map<string, PendingResult>();
    let ready: WorkspaceReadyResult | undefined;
    let readyFailure: unknown;
    let pageLost = false;
    let resultRegistration: (() => void) | undefined;
    let acceptedCaller: HostCallerIdentity | undefined;
    const expectedCallerSource = workspaceCallerSource(sessionId, targetId);
    const removeClientConnect = backend.transport.onClientConnect((caller) => {
      if (caller.kind === 'frontend' && caller.sourceId === expectedCallerSource) {
        acceptedCaller = caller;
      }
    });
    const removeClientDisconnect = backend.transport.onClientDisconnect((caller) => {
      if (acceptedCaller?.connectionId === caller.connectionId) {
        acceptedCaller = undefined;
        settleResult({
          kind: 'lost',
          id: `disconnect:${caller.connectionId}`,
          sessionId,
          targetId,
        });
      }
    });
    let removeBackendDispose: (() => void) | undefined;
    let server: ViteDevServer | undefined;
    let serverClosed = false;
    let sessionClosed = false;
    let sessionClosePromise: Promise<void> | undefined;
    const previews = new Map<string, EngineWorkspacePreview & { failure?: DevKitWorkspaceError }>();
    let play: EngineWorkspacePlay | undefined;
    let currentTarget: EngineWorkspaceTarget = {
      targetId,
      sessionId,
      worldId: `pending:${sessionId}`,
      headed,
      width,
      height,
    };

    const inactiveError = (): DevKitWorkspaceError =>
      disposed
        ? new DevKitWorkspaceError(
            'engine-workspace-provider-disposed',
            'the Engine workspace provider to remain active',
            'Create a new workspace provider before opening another project.',
            { sessionId, targetId },
          )
        : new DevKitWorkspaceError(
            'engine-workspace-session-closed',
            'the Engine workspace session to remain open',
            'Reopen the project before issuing another workspace operation.',
            { sessionId, targetId },
          );
    const assertSessionActive = (): void => {
      if (disposed || sessionClosed) throw inactiveError();
    };
    const closeIfInactive = async (): Promise<void> => {
      if (!disposed && !sessionClosed) return;
      if (server !== undefined && !serverClosed) {
        serverClosed = true;
        await server.close().catch(() => {});
      }
      await closeResources();
      throw inactiveError();
    };

    const settleResult = (payload: WorkspaceResult): void => {
      if (
        payload.sessionId !== sessionId ||
        (payload.kind !== 'result' &&
          payload.targetId !== targetId &&
          !previews.has(payload.targetId))
      )
        return;
      if (payload.kind === 'failed' && payload.targetId !== targetId) {
        const preview = previews.get(payload.targetId);
        if (!preview || preview.failure) return;
        preview.failure = wireError(payload.error, 'target execution');
        for (const [id, waiter] of pending) {
          if (waiter.targetId !== payload.targetId) continue;
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.signal?.removeEventListener('abort', waiter.onAbort);
          waiter.reject(preview.failure);
        }
        options.onTargetChanged?.();
        return;
      }
      if (payload.kind === 'lost' || payload.kind === 'failed') {
        if (payload.targetId !== targetId || (pageLost && payload.kind !== 'lost')) return;
        const cleanup = (readyFailure as { detail?: { cleanup?: string } } | undefined)?.detail
          ?.cleanup;
        if (cleanup === 'failed' || cleanup === 'timeout') return;
        pageLost = true;
        timing(payload.kind === 'lost' ? 'browser-lost' : 'browser-failed');
        readyFailure =
          payload.kind === 'failed'
            ? wireError(payload.error, 'target execution')
            : new DevKitWorkspaceError(
                'engine-workspace-page-lost',
                'the Engine workspace browser page to remain connected',
                'The headed page was destroyed or navigated away; reopen the project instead of replaying commands.',
                { sessionId, targetId },
              );
        for (const [id, waiter] of pending) {
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.signal?.removeEventListener('abort', waiter.onAbort);
          waiter.reject(readyFailure);
        }
        options.onTargetChanged?.();
        return;
      }
      if (
        pageLost &&
        !(payload.kind === 'result' && pending.get(payload.id)?.operation === 'closeWorkspace')
      )
        return;
      if (payload.kind === 'ready') {
        if (payload.targetId !== targetId) return;
        try {
          const project = assertProject(payload.project, facts.value);
          const target = assertTarget(payload.target, dimensions);
          ready = { ...payload, project, target };
          timing('browser-ready');
          currentTarget = {
            ...target,
            ...(target.url === undefined && currentTarget.url === undefined
              ? {}
              : { url: target.url ?? currentTarget.url }),
          };
        } catch (error) {
          readyFailure = error;
        }
        // Readiness is a session-level event, not a request result. Every
        // caller that was waiting for this one browser page must settle from
        // the same event; using sessionId as a pending-map key would let
        // concurrent callers overwrite one another.
        for (const [id, waiter] of pending) {
          if (waiter.operation !== 'workspace readiness') continue;
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.signal?.removeEventListener('abort', waiter.onAbort);
          if (readyFailure !== undefined) waiter.reject(readyFailure);
          else waiter.resolve(ready);
        }
        options.onTargetChanged?.();
        return;
      }
      if (payload.kind !== 'result') return;
      const waiter = pending.get(payload.id);
      if (
        waiter === undefined ||
        (payload.targetId !== targetId && payload.targetId !== waiter.targetId)
      )
        return;
      pending.delete(payload.id);
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (payload.ok) waiter.resolve(payload.value);
      else {
        const error = wireError(payload.error, waiter.operation);
        if (error.detail.cleanup === 'failed' || error.detail.cleanup === 'timeout')
          readyFailure = error;
        waiter.reject(error);
      }
    };

    resultRegistration = backend.transport.register(
      engineWorkspaceResultService(targetId),
      ({ payload, caller }) => {
        assertWorkspaceCaller(caller, sessionId, targetId, acceptedCaller);
        if (payload !== null && typeof payload === 'object')
          settleResult(payload as WorkspaceResult);
        return { accepted: true };
      },
    );

    const cancel = (id: string): void => {
      backend.transport.publish(ENGINE_WORKSPACE_COMMAND_TOPIC, {
        kind: 'cancel',
        id,
        sessionId,
      } satisfies WorkspaceCommand);
    };

    const waitFor = <T>(
      id: string,
      operation: string,
      signal: AbortSignal | undefined,
      timeoutMs = options.readyTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      operationTargetId = targetId,
      previewOwner?: string,
    ): Promise<T> => {
      throwIfAborted(signal);
      return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = (): void => {
          pending.delete(id);
          clearTimeout(timer);
          cancel(id);
          reject(abortReason(signal));
        };
        timer = setTimeout(() => {
          pending.delete(id);
          signal?.removeEventListener('abort', onAbort);
          cancel(id);
          reject(
            new DevKitWorkspaceError(
              'engine-workspace-result-timeout',
              `the browser workspace operation ${operation} to return a result`,
              'The headed Engine page did not answer before the workspace timeout.',
              { operation, sessionId, targetId: operationTargetId, timeoutMs },
            ),
          );
        }, timeoutMs);
        pending.set(id, {
          targetId: operationTargetId,
          ...(previewOwner === undefined ? {} : { previewOwner }),
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
          ...(signal === undefined ? {} : { signal }),
          onAbort,
          operation,
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    };

    const waitReady = async (signal?: AbortSignal): Promise<WorkspaceReadyResult> => {
      throwIfAborted(signal);
      if (pageLost) throw readyFailure;
      if (readyFailure !== undefined) throw readyFailure;
      if (ready !== undefined) return ready;
      return waitFor<WorkspaceReadyResult>(
        `workspace-ready-${randomUUID()}`,
        'workspace readiness',
        signal,
        readyTimeoutMs,
      );
    };

    const command = async <T>(
      operation: string,
      commandPayload: unknown,
      signal?: AbortSignal,
    ): Promise<T> => {
      const handshake =
        operation === 'closeWorkspace' ? { target: currentTarget } : await waitReady(signal);
      if (handshake.target.targetId !== targetId) {
        throw new DevKitWorkspaceError(
          'engine-workspace-target-mismatch',
          'the browser page target identity to remain current',
          'Treat the iframe as stale and reopen the project.',
          { expectedTargetId: targetId, receivedTargetId: handshake.target.targetId },
        );
      }
      throwIfAborted(signal);
      const destination = commandPayload as { targetId?: string; previewOwner?: string };
      if (
        operation !== 'closePreview' &&
        destination.previewOwner !== undefined &&
        previews.get(destination.targetId ?? targetId)?.handle !== destination.previewOwner
      )
        throw new DevKitWorkspaceError(
          'engine-workspace-preview-closed',
          'this preview owner to remain active when its command is published',
          'Open the asset again before issuing preview operations.',
          { sessionId, targetId: destination.targetId ?? targetId },
        );
      const id = randomUUID();
      const result = waitFor<T>(
        id,
        operation,
        signal,
        operation === 'openPreview' ? readyTimeoutMs : undefined,
        destination.targetId ?? targetId,
        destination.previewOwner,
      );
      try {
        backend.transport.publish(ENGINE_WORKSPACE_COMMAND_TOPIC, {
          kind: 'command',
          id,
          sessionId,
          operation,
          input: commandPayload,
        } satisfies WorkspaceCommand);
      } catch (cause) {
        const waiter = pending.get(id);
        if (waiter !== undefined) {
          pending.delete(id);
          clearTimeout(waiter.timer);
          signal?.removeEventListener('abort', waiter.onAbort);
          waiter.reject(cause);
        }
      }
      return result;
    };

    const closePreview = async (preview: EngineWorkspacePreview): Promise<void> => {
      if (previews.get(preview.target.targetId) !== preview) return;
      await Promise.resolve(preview.close?.({ targetId: preview.target.targetId }));
      if (previews.get(preview.target.targetId) === preview)
        previews.delete(preview.target.targetId);
    };

    const retireLost = () => {
      // Retiring a lost transport is not proof of native cleanup. Keep the
      // existing lost-target recovery category on the old session handle.
      readyFailure = new DevKitWorkspaceError(
        'engine-workspace-page-lost',
        'The old Workspace connection was lost',
        'The session is retired; native cleanup is unconfirmed. Do not replay its commands.',
        { targetId, sessionId, cleanup: 'unconfirmed', reason: 'transport-lost' },
      );
    };
    const closeResources = async (): Promise<void> => {
      if (sessionClosePromise !== undefined) {
        return sessionClosePromise.catch((error) => {
          if (
            acceptedCaller !== undefined ||
            !(readyFailure instanceof DevKitWorkspaceError) ||
            readyFailure.code !== 'engine-workspace-page-lost'
          )
            throw error;
          retireLost();
          removeClientDisconnect();
          if (currentClose === closeResources) currentClose = undefined;
          sessionClosePromise = Promise.resolve();
        });
      }
      sessionClosed = true;
      removeClientConnect();
      sessionClosePromise = (async () => {
        await play?.close?.();
        play = undefined;
        removeBackendDispose?.();
        removeBackendDispose = undefined;
        for (const [id, waiter] of pending) {
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.signal?.removeEventListener('abort', waiter.onAbort);
          cancel(id);
          waiter.reject(
            new DevKitWorkspaceError(
              'engine-workspace-session-closed',
              'the Engine workspace session to remain open',
              'Reopen the project before issuing another workspace operation.',
              { sessionId, targetId },
            ),
          );
        }
        for (const preview of [...previews.values()]) await closePreview(preview).catch(() => {});
        let cleanupFailure: unknown;
        const priorCleanup = (readyFailure as { detail?: { cleanup?: string } } | undefined)?.detail
          ?.cleanup;
        if (priorCleanup === 'failed' || priorCleanup === 'timeout') {
          cleanupFailure = readyFailure;
        } else if (ready !== undefined && acceptedCaller === undefined) {
          retireLost();
        } else if (ready !== undefined) {
          try {
            const cleanup = await command<{ cleanup?: string }>('closeWorkspace', { targetId });
            if (cleanup?.cleanup !== 'completed')
              throw new DevKitWorkspaceError(
                'engine-workspace-cleanup-incomplete',
                'The old Workspace plugin scopes to report completed cleanup',
                'Inspect the old browser session before considering project closure complete.',
                { targetId, cleanup },
              );
          } catch (cause) {
            const reportedCleanup = (cause as { detail?: { cleanup?: string } } | undefined)?.detail
              ?.cleanup;
            if (!acceptedCaller && reportedCleanup !== 'failed' && reportedCleanup !== 'timeout')
              retireLost();
            else {
              cleanupFailure = cause;
              readyFailure = cause;
            }
          }
        }
        if (server !== undefined && !serverClosed) {
          serverClosed = true;
          await server.close().catch(() => {});
        }
        resultRegistration?.();
        resultRegistration = undefined;
        const failedCleanup = (cleanupFailure as { detail?: { cleanup?: string } } | undefined)
          ?.detail?.cleanup;
        // A missing acknowledgment may still become a lost connection. Keep
        // observing that connection, without admitting a replacement caller.
        if (!cleanupFailure || failedCleanup === 'failed' || failedCleanup === 'timeout')
          removeClientDisconnect();
        if (ownsBackend) await backend.dispose().catch(() => {});
        if (cleanupFailure) throw cleanupFailure;
        if (currentClose === closeResources) currentClose = undefined;
      })();
      return sessionClosePromise;
    };
    if (!parent) currentClose = closeResources;
    if (!ownsBackend) {
      removeBackendDispose = backend.subscribeDispose(() => closeResources());
    }

    try {
      assertSessionActive();
      const config = await createViteConfig(facts.value, 'serve', '/', {
        server: {
          port: await materializeViteDevPort(options.port ?? 0),
          strictPort: true,
        },
        host: binding,
      });
      timing('vite-config');
      await closeIfInactive();
      server = await serverFactory(config);
      timing('vite-server-created');
      await closeIfInactive();
      assertSessionActive();
      await server.listen();
      timing('vite-listening');
      await closeIfInactive();
      const serverUrl = localServerUrl(server);
      // Unit providers may intentionally supply a transport-only fake
      // server. A real Vite server exposes httpServer; only that production
      // path needs the scoped catalog readiness probe.
      if (server.httpServer !== undefined) {
        await waitForRuntimeCatalog(serverUrl, facts.value.id, readyTimeoutMs, input.signal);
      }
      timing('catalog-ready');
      const workspaceUrl = new URL(serverUrl);
      workspaceUrl.searchParams.set('forgeaxWorkspace', parent ? 'game' : '1');
      workspaceUrl.searchParams.set('forgeaxWorkspaceSession', sessionId);
      workspaceUrl.searchParams.set('forgeaxWorkspaceTarget', targetId);
      workspaceUrl.searchParams.set('forgeaxWorkspaceToken', admissionToken);
      workspaceUrl.searchParams.set('forgeaxWorkspaceWidth', String(width));
      workspaceUrl.searchParams.set('forgeaxWorkspaceHeight', String(height));
      workspaceUrl.searchParams.set('forgeaxWorkspaceHeaded', headed ? '1' : '0');
      currentTarget = { ...currentTarget, url: workspaceUrl.href };
      timing('target-url-published');

      const assertSessionOpen = (): void => {
        if (sessionClosed) {
          throw new DevKitWorkspaceError(
            'engine-workspace-session-closed',
            'the Engine workspace session to remain open',
            'Reopen the project before issuing another workspace operation.',
            { sessionId, targetId },
          );
        }
      };
      const proxyTarget = (value: {
        previewOwner: string;
        target?: EngineWorkspaceTarget;
        asset?: EngineWorkspaceAsset;
        assetBinding?: EngineWorkspacePreview['assetBinding'];
      }): EngineWorkspacePreview => {
        const previewOwner = value.previewOwner;
        const previewInput = (input: EngineWorkspaceCameraInput) => ({
          ...commandInput(input),
          previewOwner,
        });
        let previewTarget = operationResultTarget(value, {
          ...dimensions,
          targetId: value.target?.targetId ?? targetId,
        });
        const previewTargetId = previewTarget.targetId;
        const previewAsset = operationResultAsset(value);
        let previewClosed = false;
        let previewClosePromise: Promise<void> | undefined;
        const previewClose = async (): Promise<void> => {
          if (previewClosePromise !== undefined) return previewClosePromise;
          previewClosed = true;
          // Preview replacement keeps targetId stable. An older returned
          // wrapper must not close the newer browser preview occupying the
          // same target; only the currently adopted wrapper owns the
          // close command.
          if (previews.get(preview.target.targetId) !== preview) return;
          previews.delete(previewTargetId);
          const closed = new DevKitWorkspaceError(
            'engine-workspace-preview-closed',
            'the Engine workspace preview to remain open',
            'Open the asset again before issuing preview operations.',
            { sessionId, targetId: previewTargetId },
          );
          for (const [id, waiter] of pending) {
            if (waiter.previewOwner !== previewOwner) continue;
            pending.delete(id);
            clearTimeout(waiter.timer);
            waiter.signal?.removeEventListener('abort', waiter.onAbort);
            cancel(id);
            waiter.reject(closed);
          }
          previewClosePromise = (
            ready && !pageLost
              ? command('closePreview', { targetId: previewTargetId, previewOwner }, undefined)
              : Promise.resolve()
          ).then(() => undefined);
          return previewClosePromise;
        };
        const assertPreviewOpen = (): void => {
          assertSessionOpen();
          if (preview.failure) throw preview.failure;
          if (previewClosed) {
            throw new DevKitWorkspaceError(
              'engine-workspace-preview-closed',
              'the Engine workspace preview to remain open',
              'Open the asset again before issuing camera or capture operations.',
              { targetId },
            );
          }
          if (previews.get(previewTargetId) !== preview) {
            throw new DevKitWorkspaceError(
              'engine-workspace-preview-closed',
              'this Engine workspace preview to remain the active preview',
              'The preview was replaced; reopen the asset before issuing camera or capture operations.',
              { targetId, reason: 'replaced' },
            );
          }
        };
        const preview: EngineWorkspacePreview & { failure?: DevKitWorkspaceError } = {
          handle: previewOwner,
          get target() {
            return parent ? currentTarget : previewTarget;
          },
          ...(previewAsset ? { asset: previewAsset } : {}),
          ...(value.assetBinding === undefined ? {} : { assetBinding: value.assetBinding }),
          setControl: (input) => {
            assertPreviewOpen();
            return command('target.control', previewInput(input), input.signal);
          },
          tools: {
            pick(input) {
              assertPreviewOpen();
              return command('target.pick', { ...input, targetId: previewTargetId, previewOwner });
            },
            highlight(input) {
              assertPreviewOpen();
              return command('entity.highlight', {
                ...input,
                targetId: previewTargetId,
                previewOwner,
              });
            },
            tree(input = {}) {
              assertPreviewOpen();
              return command('scene-tree.get', {
                ...input,
                targetId: previewTargetId,
                previewOwner,
              });
            },
            inspect(input) {
              assertPreviewOpen();
              return command('entity.inspect', {
                ...input,
                targetId: previewTargetId,
                previewOwner,
              });
            },
            focus(input) {
              assertPreviewOpen();
              return command('entity.focus', { ...input, targetId: previewTargetId, previewOwner });
            },
          },
          getCamera: (cameraInput) => {
            assertPreviewOpen();
            return command('camera.get', previewInput(cameraInput), cameraInput.signal);
          },
          beginCameraInteraction: (cameraInput) => {
            assertPreviewOpen();
            return command('camera.begin', previewInput(cameraInput), cameraInput.signal);
          },
          updateCameraDraft: (cameraInput) => {
            assertPreviewOpen();
            return command('camera.update', previewInput(cameraInput), cameraInput.signal);
          },
          commitCamera: (cameraInput) => {
            assertPreviewOpen();
            return command('camera.commit', previewInput(cameraInput), cameraInput.signal);
          },
          abortCameraInteraction: (cameraInput) => {
            assertPreviewOpen();
            return command('camera.abort', previewInput(cameraInput), cameraInput.signal);
          },
          revokeConnection: (input) => {
            // A browser disconnect can arrive while the owning workspace is
            // already closing. Revocation only releases live camera input;
            // closing the preview/session has already released its target.
            if (sessionClosed || previewClosed || previews.get(previewTargetId) !== preview)
              return Promise.resolve();
            assertPreviewOpen();
            return command('camera.revoke', previewInput(input));
          },
          async resize(input: Parameters<NonNullable<EngineWorkspacePreview['resize']>>[0]) {
            assertPreviewOpen();
            const result = await command('resize', { ...input, previewOwner }, input.signal);
            assertPreviewOpen();
            previewTarget = operationResultTarget(result, {
              ...dimensions,
              targetId: previewTargetId,
            });
            if (parent) currentTarget = previewTarget;
            return previewTarget;
          },
          capture: (captureInput) => {
            assertPreviewOpen();
            // The browser realm owns the real canvas/renderer. The result
            // is a serializable PNG produced by that canvas, never a Node
            // screenshot or a second browser capture surface.
            return command(
              'capture',
              {
                targetId: previewTargetId,
                previewOwner,
                width: captureInput.width,
                height: captureInput.height,
              },
              captureInput.signal,
            );
          },
          close: previewClose,
        };
        previews.set(previewTargetId, preview);
        return preview;
      };
      const session: BrowserSession = {
        get failure() {
          return readyFailure;
        },
        get phase() {
          return pageLost || readyFailure ? 'failed' : ready ? 'running' : 'starting';
        },
        borrowTarget: () => proxyTarget({ previewOwner: sessionId, target: currentTarget }),
        ready: async (signal) => {
          await waitReady(signal);
        },
        ...(!parent
          ? {
              async startPlay({ signal }: { signal?: AbortSignal }) {
                assertSessionOpen();
                if (play)
                  throw new DevKitWorkspaceError(
                    'engine-workspace-target-busy',
                    'One Play per project',
                    'Stop the current Play first.',
                  );
                let game: BrowserSession | undefined;
                try {
                  throwIfAborted(signal);
                  game = await openSession(
                    { root: facts.value.root, ...(signal ? { signal } : {}) },
                    backend,
                  );
                  throwIfAborted(signal);
                  assertSessionOpen();
                  const target = game.borrowTarget();
                  const owned = game;
                  let closing: Promise<void> | undefined;
                  const next: EngineWorkspacePlay = {
                    ...target,
                    get target() {
                      return target.target;
                    },
                    get phase() {
                      return owned.phase;
                    },
                    ready: owned.ready,
                    close() {
                      if (closing) return closing;
                      if (play === next) play = undefined;
                      closing = Promise.resolve(owned.close?.());
                      return closing;
                    },
                  };
                  play = next;
                  return next;
                } catch (error) {
                  await game?.close?.();
                  throw error;
                }
              },
            }
          : {}),
        project: { id: facts.value.id, root: facts.value.root, name: facts.value.name },
        get target() {
          return currentTarget;
        },
        runtimePack: async (input) => {
          assertSessionOpen();
          await waitReady(input.signal);
          assertSessionOpen();
          if (input.targetId !== targetId || input.worldId !== currentTarget.worldId)
            throw new DevKitWorkspaceError(
              'engine-workspace-target-stale',
              'The current project App and World',
              'Refresh engine.workspace.get before submitting runtime content.',
              { target: currentTarget },
            );
          return command(
            'runtimePack',
            {
              targetId,
              worldId: input.worldId,
              request: input.request,
              ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            },
            input.signal,
          );
        },
        inspectAsset: async ({ guid, signal }) => {
          assertSessionOpen();
          return command('inspectAsset', { targetId, guid }, signal);
        },
        listAssets: async ({ signal } = {}) => {
          assertSessionOpen();
          const result = await command<readonly EngineWorkspaceAsset[]>(
            'listAssets',
            { targetId },
            signal,
          );
          if (!Array.isArray(result)) {
            throw new DevKitWorkspaceError(
              'engine-workspace-assets-invalid',
              'the browser page to return an asset array',
              'Inspect the generated Engine workspace page and retry.',
              {},
            );
          }
          return result;
        },
        openPreview: async ({ asset, width: previewWidth, height: previewHeight, signal }) => {
          assertSessionOpen();
          // Scene editing owns the project surface. Type previews always get
          // their own surface, including the first asset opened in a project.
          const previewTargetId =
            asset.kind === 'scene' ? targetId : `${targetId}:preview:${randomUUID()}`;
          const value = await command<unknown>(
            'openPreview',
            { targetId, previewTargetId, asset, width: previewWidth, height: previewHeight },
            signal,
          );
          if (
            !value ||
            typeof value !== 'object' ||
            !('previewOwner' in value) ||
            typeof value.previewOwner !== 'string'
          ) {
            throw new DevKitWorkspaceError(
              'engine-workspace-preview-invalid',
              'the Engine browser preview allocation identity',
              'Use the matching generated Engine workspace document.',
              {},
            );
          }
          return proxyTarget({
            previewOwner: value.previewOwner as string,
            target: operationResultTarget(value, { ...dimensions, targetId: previewTargetId }),
            asset: operationResultAsset(value) ?? asset,
            ...('assetBinding' in value
              ? { assetBinding: value.assetBinding as EngineWorkspacePreview['assetBinding'] }
              : {}),
          });
        },
        close: closeResources,
      };
      return session;
    } catch (cause) {
      await closeResources();
      throw cause;
    }
  };
  const provider = createEngineWorkspaceProvider({
    openProjectSession: (input) =>
      trackOpening(async () => {
        if (disposed) throw new Error('Engine workspace provider is disposed');
        throwIfAborted(input.signal);
        await currentClose?.();
        if (disposed) throw new Error('Engine workspace provider is disposed');
        return openSession(input);
      }),
  });
  return Object.freeze({
    ...provider,
    async prepareRuntimePackProgram(
      input: Parameters<NonNullable<EngineWorkspaceProvider['prepareRuntimePackProgram']>>[0],
    ) {
      throwIfAborted(input.signal);
      const prepared = prepareRuntimePackProgram(input.source).unwrap();
      throwIfAborted(input.signal);
      return prepared;
    },
    async inspectAsset(input: Parameters<NonNullable<EngineWorkspaceProvider['inspectAsset']>>[0]) {
      throwIfAborted(input.signal);
      // The live Registry owns runtime-only payloads and their current facts.
      if (input.handle !== undefined) {
        const inspection = await provider.inspectAsset?.(input);
        throwIfAborted(input.signal);
        if (!isRecord(inspection) || !isRecord(inspection.asset)) return inspection;
        const asset = inspection.asset;
        const sourcePath = typeof asset.path === 'string' ? asset.path : undefined;
        if (!sourcePath?.endsWith('.pack.json')) return inspection;
        if (typeof asset.sourceKey !== 'string')
          throw new DevKitWorkspaceError(
            'asset-inspect-source-key-missing',
            'the Catalog row for a direct Pack asset to carry its sourceKey',
            'Rebuild the Catalog from the authored Pack and retry inspection.',
            { guid: input.guid, sourcePath },
          );
        const authored = await inspectAuthoredPack(
          input.project.root,
          sourcePath,
          asset.sourceKey,
          input.guid,
          input.signal,
        );
        return {
          ...inspection,
          source: {
            ...(isRecord(inspection.source) ? inspection.source : {}),
            path: sourcePath,
            ...(authored.revision === undefined ? {} : { revision: authored.revision }),
          },
          meta: { ...(isRecord(inspection.meta) ? inspection.meta : {}), ...authored.meta },
          ...(authored.revision === undefined ? {} : { revision: authored.revision }),
        };
      }
      const result = await assetInspectCommand({ root: input.project.root, subject: input.guid });
      throwIfAborted(input.signal);
      if (!result.ok)
        throw new DevKitWorkspaceError(
          result.error.code,
          result.error.expected,
          result.error.hint,
          result.error.detail,
        );
      const asset = result.value as Record<string, unknown>;
      const sourcePath = typeof asset.sourcePath === 'string' ? asset.sourcePath : undefined;
      const authored =
        sourcePath?.endsWith('.pack.json') && typeof asset.sourceKey === 'string'
          ? await inspectAuthoredPack(
              input.project.root,
              sourcePath,
              asset.sourceKey,
              input.guid,
              input.signal,
            )
          : undefined;
      const revision = authored?.revision ?? asset.revision;
      return {
        guid: input.guid,
        asset,
        ...(sourcePath === undefined
          ? {}
          : {
              source: {
                path: sourcePath,
                ...(sourcePath.endsWith('.pack.ts') ? { kind: 'pack.ts' } : {}),
                ...(revision === undefined ? {} : { revision }),
              },
            }),
        ...(authored === undefined ? {} : { meta: authored.meta }),
        ...(revision === undefined ? {} : { revision }),
        ...(asset.cookReceiptUrl === undefined
          ? {}
          : { ddc: { receiptUrl: asset.cookReceiptUrl } }),
      };
    },
    async dispose() {
      if (disposed) {
        await currentClose?.();
        return;
      }
      disposed = true;
      const opening = [...openings];
      try {
        await currentClose?.();
      } finally {
        await Promise.allSettled(opening);
      }
    },
  });
}
