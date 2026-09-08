// @forgeax/engine-vite-plugin-rhi-debug -- serve-only raw tape transport.
//
// The plugin is a leaf: it validates one encoded v7 tape with the core decoder,
// persists one `.rhitape` file, and exposes no replay or report owner.

import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decodeTape } from '@forgeax/engine-rhi-debug';
import type { Plugin, ViteDevServer } from 'vite';

export const RAW_TAPE_ROUTE = '/__forgeax-debug/tape' as const;
export const RHITAPE_MIME = 'application/x-forgeax-rhitape' as const;

const DEFINE_KEY = 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG';
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CaptureProvider {
  readonly id: string;
}

export type CaptureProviderError =
  | { readonly code: 'capture-target-unavailable'; readonly providerIds: readonly string[] }
  | { readonly code: 'capture-target-ambiguous'; readonly providerIds: readonly string[] };

export type ViteProviderError =
  | CaptureProviderError
  | {
      readonly code:
        | 'capture-run-id-invalid'
        | 'capture-mime-invalid'
        | 'capture-tape-invalid'
        | 'capture-artifact-write-failed';
      readonly hint: string;
    };

export interface RawTapeUpload {
  readonly runId: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface RawTapeArtifactRef {
  readonly kind: 'rhi-tape';
  readonly digest: string;
  readonly path: string;
}

export interface RawTapeProviderOptions {
  readonly rootDir: string;
  readonly writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
}

export interface RawTapeProvider {
  accept(upload: RawTapeUpload): Promise<ProviderResult<RawTapeArtifactRef, ViteProviderError>>;
}

type ProviderResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function selectCaptureProvider(
  providers: readonly CaptureProvider[],
): ProviderResult<CaptureProvider, CaptureProviderError> {
  const providerIds = providers.map((provider) => provider.id);
  if (providers.length === 0) {
    return { ok: false, error: { code: 'capture-target-unavailable', providerIds } };
  }
  if (providers.length > 1) {
    return { ok: false, error: { code: 'capture-target-ambiguous', providerIds } };
  }
  const provider = providers[0];
  if (provider === undefined) {
    return { ok: false, error: { code: 'capture-target-unavailable', providerIds } };
  }
  return { ok: true, value: provider };
}

export function createRawTapeProvider(options: RawTapeProviderOptions): RawTapeProvider {
  const rootDir = resolve(options.rootDir);
  const write =
    options.writeFile ??
    (async (path: string, bytes: Uint8Array) => {
      await writeFile(path, bytes);
    });

  return {
    async accept(upload) {
      if (!RUN_ID_PATTERN.test(upload.runId)) {
        return {
          ok: false,
          error: {
            code: 'capture-run-id-invalid',
            hint: 'runId must contain only ASCII letters, numbers, underscore, or hyphen',
          },
        };
      }
      if (upload.contentType !== RHITAPE_MIME) {
        return {
          ok: false,
          error: {
            code: 'capture-mime-invalid',
            hint: `content-type must be exactly ${RHITAPE_MIME}`,
          },
        };
      }

      const decoded = decodeTape(upload.bytes);
      if (!decoded.ok) {
        return {
          ok: false,
          error: {
            code: 'capture-tape-invalid',
            hint: decoded.error.hint,
          },
        };
      }

      const digest = `sha256:${createHash('sha256').update(upload.bytes).digest('hex')}`;
      const debugDir = join(rootDir, '.forgeax-debug');
      const outDir = join(debugDir, upload.runId);
      const finalPath = join(outDir, 'frame.rhitape');
      const tempDir = join(debugDir, `.rhitape-${upload.runId}-${randomUUID()}`);
      const debugDirExisted = await pathExists(debugDir);
      const outDirExisted = await pathExists(outDir);

      try {
        await mkdir(tempDir, { recursive: true });
        await write(join(tempDir, 'frame.rhitape'), upload.bytes);
        await mkdir(outDir, { recursive: true });
        await rename(join(tempDir, 'frame.rhitape'), finalPath);
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        await rm(tempDir, { recursive: true, force: true });
        if (!outDirExisted) await rm(outDir, { recursive: true, force: true });
        if (!debugDirExisted) await rm(debugDir, { recursive: true, force: true });
        return {
          ok: false,
          error: {
            code: 'capture-artifact-write-failed',
            hint: 'the raw tape could not be written atomically; inspect the dev-server filesystem and retry',
          },
        };
      }

      return { ok: true, value: { kind: 'rhi-tape', digest, path: finalPath } };
    },
  };
}

export interface RhiDebugPluginOptions {
  readonly rootDir?: string;
}

interface MiddlewareRequest extends AsyncIterable<Uint8Array> {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

interface MiddlewareResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string | Uint8Array): void;
}

function sendJson(res: MiddlewareResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readRawBody(req: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    chunks.push(bytes);
    size += bytes.byteLength;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function contentType(req: MiddlewareRequest): string {
  const value = req.headers?.['content-type'];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function vitePluginRhiDebug(options: RhiDebugPluginOptions = {}): Plugin {
  return {
    name: 'forgeax:rhi-debug',

    config(_config, env) {
      return {
        define: { [DEFINE_KEY]: JSON.stringify(env.command === 'serve' ? '1' : '0') },
      };
    },

    configureServer(server: ViteDevServer) {
      const provider = createRawTapeProvider({ rootDir: options.rootDir ?? process.cwd() });
      server.middlewares.use(async (request, response, next) => {
        const req = request as MiddlewareRequest;
        const res = response as unknown as MiddlewareResponse;
        const url = new URL(req.url ?? '', 'http://localhost');
        if (url.pathname !== RAW_TAPE_ROUTE) {
          next();
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          sendJson(res, 405, {
            error: 'method-not-allowed',
            hint: `use POST ${RAW_TAPE_ROUTE}?runId=<id> with raw ${RHITAPE_MIME} bytes`,
          });
          return;
        }

        const runId = url.searchParams.get('runId') ?? '';
        const bytes = await readRawBody(req);
        const result = await provider.accept({ runId, contentType: contentType(req), bytes });
        if (!result.ok) {
          sendJson(
            res,
            result.error.code === 'capture-artifact-write-failed' ? 500 : 400,
            result.error,
          );
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result.value));
      });
    },
  };
}

export default vitePluginRhiDebug;
