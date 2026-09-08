import {
  createToolPreviewHost,
  createToolPreviewRecipe,
  type ToolPreviewRecipeOptions,
  type ToolPreviewRunResult,
  type ToolPreviewTrace,
} from '@forgeax/engine-app';
import type {
  CarrierLeaseRequest,
  CarrierOffer,
  CarrierResult,
  CarrierState,
  ToolDomainFailure,
  ToolExecutionContext,
} from '@forgeax/engine-tool-runtime';
import { runBrowserPreviewHost } from './browser-host.js';

export interface PreviewHostRequest {
  readonly recipe: ToolPreviewRecipeOptions;
  readonly projectRoot?: string;
  readonly carrier?: PreviewCarrierRoute;
}

export interface PreviewHostMechanisms {
  readonly runId: string;
  readonly projectRoot: string;
  readonly backend: 'webgpu';
  readonly signal: AbortSignal;
}

export interface PreviewHostSession {
  readonly withSession: <T>(
    execute: (mechanisms: PreviewHostMechanisms) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Creates the physical host lease. Domain identity stays in the executor;
 * this seam carries only browser, backend, and lexical run ownership.
 */
export function createPreviewHostSession(input: {
  readonly runId: string;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
}): PreviewHostSession {
  let active = true;
  return {
    async withSession(execute) {
      if (!active || input.signal.aborted) throw new Error('preview-host-session-terminal');
      try {
        return await execute({
          runId: input.runId,
          projectRoot: input.projectRoot,
          backend: 'webgpu',
          signal: input.signal,
        });
      } finally {
        active = false;
      }
    },
  };
}

export interface PreviewCarrierRoute {
  readonly lookup: () => CarrierOffer | undefined;
  readonly lease: (request: CarrierLeaseRequest) => CarrierResult<{ readonly leaseId: string }>;
  readonly started: (leaseId: string) => CarrierResult<CarrierState>;
  readonly execute: (
    leaseId: string,
    request: Omit<PreviewHostRequest, 'carrier'>,
    context: Pick<ToolExecutionContext, 'runId' | 'signal'>,
  ) => Promise<PreviewRouteResult<PreviewHostResult>>;
  readonly exit: (leaseId: string) => CarrierResult<CarrierState>;
  readonly now?: () => number;
}

export interface PreviewHostResult {
  readonly actualCarrier: 'headless-private' | 'headed-private' | 'visible-consumer';
  readonly trace: ToolPreviewTrace;
  readonly captureId: string;
  readonly drawCalls: number;
  readonly committedDrawIndex: number;
  readonly nonBlackPixels: number;
  readonly actionTrace: ToolPreviewRunResult['actionTrace'];
  readonly tape: ToolPreviewRunResult['tape'];
  readonly profile: ToolPreviewRunResult['profile'];
  readonly capturePng: ToolPreviewRunResult['capturePng'];
  readonly png: ToolPreviewRunResult['png'];
  readonly manifest: ToolPreviewRunResult['manifest'];
  readonly artifacts: ToolPreviewRunResult['artifacts'];
  readonly operationTiming: ToolPreviewRunResult['operationTiming'];
  readonly resource?: import('@forgeax/engine-app').ToolPreviewResourceFacts;
}

export type PreviewHostRunner = (
  request: PreviewHostRequest,
  context: ToolExecutionContext,
) => Promise<
  | { readonly ok: true; readonly value: PreviewHostResult }
  | { readonly ok: false; readonly error: ToolDomainFailure }
>;

type PreviewRouteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ToolDomainFailure };

export interface CarrierCleanupTrace {
  readonly actualCarrier: 'headless-private' | 'headed-private' | 'visible-consumer';
  readonly backend: 'webgpu';
  readonly cleanup: readonly ['gpu', 'canvas', 'page', 'carrier'];
  readonly failure: {
    readonly code: 'tool-preview-carrier-exit';
    readonly detail: { readonly carrier: CarrierCleanupTrace['actualCarrier'] };
  };
}

export function createCarrierCleanupTrace(input: {
  readonly actualCarrier: CarrierCleanupTrace['actualCarrier'];
  readonly backend: 'webgpu';
}): CarrierCleanupTrace {
  return {
    actualCarrier: input.actualCarrier,
    backend: input.backend,
    cleanup: ['gpu', 'canvas', 'page', 'carrier'],
    failure: {
      code: 'tool-preview-carrier-exit',
      detail: { carrier: input.actualCarrier },
    },
  };
}

function carrierRouteFailure(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>>,
): PreviewRouteResult<never> {
  return { ok: false, error: { code, expected, hint, detail: detail as never } };
}

export async function runCarrierPreviewRoute<T>(
  presentation: ToolPreviewRecipeOptions['presentation'],
  carrier: PreviewCarrierRoute | undefined,
  executePrivate: () => Promise<PreviewRouteResult<T>>,
  executeConsumer: (leaseId: string) => Promise<PreviewRouteResult<T>> = executePrivate,
): Promise<PreviewRouteResult<T>> {
  if (presentation === 'hidden' || carrier === undefined) return executePrivate();
  const offer = carrier.lookup();
  if (offer === undefined) return executePrivate();
  const leased = carrier.lease({
    consumerId: offer.consumerId,
    bearerToken: offer.bearerToken,
    now: carrier.now?.() ?? Date.now(),
  });
  if (!leased.ok) return executePrivate();
  const started = carrier.started(leased.value.leaseId);
  if (!started.ok) return executePrivate();
  const result = await executeConsumer(leased.value.leaseId);
  const exited = carrier.exit(leased.value.leaseId);
  if (!exited.ok)
    return carrierRouteFailure(
      exited.error.code,
      exited.error.expected,
      exited.error.hint,
      exited.error.detail,
    );
  return result;
}

export const runPreviewHost: PreviewHostRunner = async (request, context) => {
  if (context.snapshot === undefined) {
    return carrierRouteFailure(
      'tool-snapshot-missing',
      'ToolExecutionContext.snapshot before Browser or Renderer creation',
      'Start the operation with an authority snapshot and retry the lexical ToolRun.',
      { phase: 'snapshot' },
    );
  }
  const snapshot = context.snapshot;
  const recipe = createToolPreviewRecipe(request.recipe);
  return runCarrierPreviewRoute(
    recipe.presentation,
    request.carrier,
    async () => {
      if (typeof document === 'undefined') {
        if (request.projectRoot === undefined) {
          return carrierRouteFailure(
            'tool-preview-project-root-missing',
            'the Browser Host to receive a real ForgeaX project root',
            'Create the ToolClient with projectRoot or pass projectRoot in the preview request.',
            { phase: 'project-authority' },
          );
        }
        return runBrowserPreviewHost(
          request.projectRoot,
          recipe,
          snapshot,
          context.runId,
          context.signal,
        );
      }
      const host = await createToolPreviewHost({ recipe, snapshot });
      if (!host.ok) {
        return {
          ok: false,
          error: {
            code: host.error.code,
            expected: host.error.expected,
            hint: host.error.hint,
            detail: host.error.detail as never,
          },
        };
      }
      try {
        const result = await host.value.run();
        if (!result.ok) {
          return {
            ok: false,
            error: {
              code: result.error.code,
              expected: result.error.expected,
              hint: result.error.hint,
              detail: result.error.detail as never,
            },
          };
        }
        return {
          ok: true,
          value: {
            ...result.value,
            actualCarrier: recipe.presentation === 'hidden' ? 'headless-private' : 'headed-private',
          },
        };
      } finally {
        await host.value.dispose();
      }
    },
    async (leaseId) => {
      const carrier = request.carrier;
      if (carrier === undefined) {
        return carrierRouteFailure(
          'tool-preview-carrier-unavailable',
          'a leased Consumer provider',
          'Retry the ordinary private visible carrier.',
          { phase: 'consumer-execute' },
        );
      }
      const { carrier: _carrier, ...consumerRequest } = request;
      return carrier.execute(leaseId, consumerRequest, context);
    },
  );
};
