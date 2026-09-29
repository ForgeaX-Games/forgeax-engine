import { err, ok, type Result } from '@forgeax/engine-types';

// Public gateways drop idempotent package GETs, including HTTP/2 streams reset
// mid-body. Every catalog, Pack, artifact, and loader-binary read shares this
// bounded recovery: interrupted transfers (fetch's TypeError) and transient
// statuses retry after these delays, bypassing a possibly poisoned HTTP cache.
// Aborts, permanent statuses, and fetcher-specific failures surface at once.
const RETRY_DELAYS_MS = [250, 750] as const;
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

export type PackageFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface PackageReadFailure {
  /** Last observation, e.g. `HTTP 404` or `TypeError: network error`. */
  readonly observed: string;
  readonly attempts: number;
  /** The transfer completed but `body` rejected its content (e.g. invalid JSON). */
  readonly malformed: boolean;
}

function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** Read one package resource in full through `body`, so a body reset is retried too. */
export async function readPackage<T>(
  fetcher: PackageFetcher,
  url: string,
  body: (response: Response) => Promise<T>,
  init?: RequestInit,
): Promise<Result<T, PackageReadFailure>> {
  for (let attempt = 1; ; attempt++) {
    let observed: string;
    let retryable: boolean;
    let malformed = false;
    let response: Response | undefined;
    try {
      response = await (attempt === 1
        ? init === undefined
          ? fetcher(url)
          : fetcher(url, init)
        : fetcher(url, { cache: 'reload', ...init }));
      if (response.ok) return ok(await body(response));
      observed = `HTTP ${response.status}`;
      retryable = TRANSIENT_STATUS.has(response.status);
    } catch (cause) {
      observed = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      retryable = cause instanceof TypeError;
      malformed = response?.ok === true && !retryable;
    }
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (!retryable || delay === undefined || init?.signal?.aborted) {
      return err({ observed, attempts: attempt, malformed });
    }
    if (response !== undefined && !response.bodyUsed) {
      try {
        await response.body?.cancel();
      } catch {
        // The retry below remains authoritative.
      }
    }
    await pause(delay, init?.signal);
    if (init?.signal?.aborted) return err({ observed, attempts: attempt, malformed });
  }
}

export const bytesOf = async (response: Response): Promise<Uint8Array> =>
  new Uint8Array(await response.arrayBuffer());
export const jsonOf = (response: Response): Promise<unknown> => response.json();
