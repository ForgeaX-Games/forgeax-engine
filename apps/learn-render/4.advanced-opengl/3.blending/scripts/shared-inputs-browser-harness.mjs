import { readFile, writeFile } from 'node:fs/promises';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ProbeError extends Error {
  constructor(stage, url, expected, actual, hint, detail = '') {
    super(`${stage}: ${detail || `expected ${expected}, got ${actual}`} (${url})`);
    this.name = 'ProbeError';
    this.stage = stage;
    this.url = url;
    this.expected = expected;
    this.actual = actual;
    this.hint = hint;
    this.detail = detail;
  }
}

export function probeFailureRecord(error) {
  if (!(error instanceof ProbeError)) return null;
  return {
    code: `shared-input-browser-${error.stage}`,
    stage: error.stage,
    url: error.url,
    expected: error.expected,
    actual: error.actual,
    hint: error.hint,
    detail: error.detail,
  };
}

export function assertApplicationBootstrap(errors, url) {
  const failure = errors.find((error) => /createApp failed|app\.onError|no usable backend/i.test(error));
  if (failure !== undefined) {
    throw new ProbeError(
      'application-bootstrap',
      url,
      'the application to initialize without a structured runtime error',
      failure,
      'Inspect the browser error and repair the application or shader manifest before accepting preview output.',
    );
  }
}

export async function pollHttpReady(url, options = {}) {
  const {
    deadlineMs = 30_000,
    intervalMs = 100,
    fetchImpl = globalThis.fetch,
    stage = 'preview-readiness',
  } = options;
  const deadline = Date.now() + deadlineMs;
  let actual = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url);
      actual = response.status;
      if (response.ok) return response;
    } catch (error) {
      actual = error instanceof Error ? error.message : String(error);
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new ProbeError(stage, url, 'HTTP 2xx before deadline', actual, 'Check the server root/base and verify HTTP readiness rather than stdout markers.');
}

function originOf(server) {
  const address = server.httpServer?.address?.();
  if (!address || typeof address === 'string') throw new Error('Vite server did not expose an ephemeral HTTP address');
  return `http://127.0.0.1:${address.port}`;
}

export async function startViteServer({ mode, root, base = '/blending/', port = 0 }) {
  const vite = await import('vite');
  const config = { root, base, server: { host: '127.0.0.1', port, strictPort: false } };
  const server = mode === 'preview'
    ? await vite.preview({ root, preview: { host: '127.0.0.1', port, strictPort: false }, base })
    : await vite.createServer(config);
  if (mode !== 'preview') await server.listen();
  return { server, origin: originOf(server) };
}

export async function closeServer(resource, timeoutMs = 5_000) {
  if (!resource) return;
  const close = resource.close?.bind(resource);
  if (!close) return;
  // Vite's dev server retains HMR WebSockets. Stop those connections before
  // awaiting its close promise: otherwise a browser probe can leave CI waiting
  // indefinitely for the peer that the server itself is meant to terminate.
  resource.ws?.close?.();
  resource.httpServer?.closeAllConnections?.();
  resource.httpServer?.closeIdleConnections?.();
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('server close timeout')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    resource.httpServer?.close?.();
  }
}

export async function withServerLifecycle(serverPromise, callback) {
  const resource = await serverPromise;
  try {
    return await callback(resource);
  } finally {
    await closeServer(resource.server ?? resource);
  }
}

export async function withRestoredFile(path, callback) {
  const original = await readFile(path);
  try {
    return await callback(original);
  } finally {
    await writeFile(path, original);
  }
}
