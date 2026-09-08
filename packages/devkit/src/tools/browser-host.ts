import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer as createTcpServer } from 'node:net';
import { join, relative, sep } from 'node:path';
import type {
  ToolPreviewCaptureResult,
  ToolPreviewRecipe,
  ToolPreviewResourceRequest,
} from '@forgeax/engine-app';
import { createResourcePreviewReport, type ResourcePreviewReport } from '@forgeax/engine-preview';
import {
  createPreviewArtifactManifest,
  type JsonValue,
  type PreviewArtifactManifestEntry,
  type SnapshotRef,
  type ToolDomainFailure,
  validatePreviewArtifactManifest,
} from '@forgeax/engine-tool-runtime';
import { type Browser, chromium, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import type { BootstrapRoot } from '../host/base-host.js';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import type { PreviewHostResult } from './preview-host.js';

export type BrowserHostResult =
  | { readonly ok: true; readonly value: PreviewHostResult }
  | { readonly ok: false; readonly error: ToolDomainFailure };

function transportCause(cause: unknown): JsonValue {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack === undefined ? {} : { stack: cause.stack }),
    };
  }
  if (cause === undefined) return 'undefined';
  try {
    return JSON.parse(JSON.stringify(cause)) as JsonValue;
  } catch {
    return String(cause);
  }
}

function dataUriBytes(uri: string): Uint8Array {
  const separator = uri.indexOf(',');
  if (separator < 0) throw new TypeError('preview artifact must be a data URI before publication');
  return Buffer.from(uri.slice(separator + 1), 'base64');
}

function projectUri(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join('/');
}

export interface ResourcePreviewReportInput {
  readonly snapshot: SnapshotRef;
  readonly subject: ResourcePreviewReport['subject'];
  readonly presentation: ResourcePreviewReport['presentation'];
  readonly oracle: ResourcePreviewReport['oracle'];
}

export interface BrowserHostOptions {
  readonly publish?: boolean;
}

/** @internal Vite treats port 0 as its default 5173, not as an OS-assigned port. */
export async function allocateLoopbackPort(): Promise<number> {
  const probe = createTcpServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        probe.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        probe.off('error', onError);
        resolve();
      };
      probe.once('error', onError);
      probe.once('listening', onListening);
      probe.listen(0, '127.0.0.1');
    });
    const address = probe.address();
    if (address === null || typeof address === 'string') {
      throw new Error('loopback port probe did not expose a TCP address');
    }
    return address.port;
  } finally {
    if (probe.listening) {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function artifactRef(artifact: PreviewArtifactManifestEntry) {
  const kind =
    artifact.kind === 'report' || artifact.kind === 'contact-sheet'
      ? ('tool-result' as const)
      : artifact.kind;
  return {
    kind,
    digest: artifact.digest,
    uri: artifact.uri,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.byteLength,
  };
}

export async function publishPreviewArtifacts(
  projectRoot: string,
  runId: string,
  result: PreviewHostResult,
  reportInput?: ResourcePreviewReportInput,
): Promise<PreviewHostResult> {
  if (result.manifest.identity.runId !== runId) {
    throw new Error(
      `preview artifact run identity mismatch: manifest=${result.manifest.identity.runId} requested=${runId}`,
    );
  }
  const runsRoot = join(projectRoot, '.forgeax', 'tool-runs');
  await mkdir(runsRoot, { recursive: true });
  const directoryName = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const published = join(runsRoot, directoryName);
  const finalPaths = {
    tapeJson: join(published, 'rhi-tape.json'),
    tapeBlob: join(published, 'rhi-tape.bin'),
    capturePng: join(published, 'capture.png'),
    freshReplayPng: join(published, 'fresh-replay.png'),
    profile: join(published, 'profile.json'),
    manifest: join(published, 'manifest.json'),
    report: join(published, 'report.json'),
  };
  const tapeJson = dataUriBytes(result.tape.jsonUri);
  const tapeBlob = dataUriBytes(result.tape.blobUri);
  const capturePng = dataUriBytes(result.capturePng.uri);
  const freshReplayPng = dataUriBytes(result.png.uri);
  const profile = dataUriBytes(result.profile.uri);
  const bytesByRole = {
    'rhi-tape': tapeJson,
    capture: capturePng,
    'fresh-replay': freshReplayPng,
    'profile-capture': profile,
  } as const;
  const uriByRole = {
    'rhi-tape': projectUri(projectRoot, finalPaths.tapeJson),
    capture: projectUri(projectRoot, finalPaths.capturePng),
    'fresh-replay': projectUri(projectRoot, finalPaths.freshReplayPng),
    'profile-capture': projectUri(projectRoot, finalPaths.profile),
  } as const;
  const mediaTypeByRole = {
    'rhi-tape': 'application/vnd.forgeax.rhi-tape+json',
    capture: 'image/png',
    'fresh-replay': 'image/png',
    'profile-capture': 'application/vnd.forgeax.profile+json',
  } as const;
  const requiredRoles = ['rhi-tape', 'capture', 'fresh-replay', 'profile-capture'] as const;
  const nonReportArtifacts = result.manifest.artifacts
    .filter((artifact) => artifact.role !== 'report')
    .map((artifact) => {
      if (!(artifact.role in bytesByRole)) {
        return artifact;
      }
      const role = artifact.role as keyof typeof bytesByRole;
      const bytes = bytesByRole[role];
      const digest = sha256(bytes);
      if (artifact.digest !== digest) {
        throw new Error(`preview artifact digest mismatch for ${artifact.role}`);
      }
      return {
        ...artifact,
        uri: uriByRole[role],
        digest,
        byteLength: bytes.byteLength,
        mediaType: mediaTypeByRole[role],
      };
    });
  if (
    requiredRoles.some((role) => !nonReportArtifacts.some((artifact) => artifact.role === role))
  ) {
    throw new Error(
      'preview publication is missing capture, fresh-replay, tape, or profile artifact',
    );
  }
  let report: ResourcePreviewReport | undefined;
  let reportBytes: Uint8Array | undefined;
  if (reportInput !== undefined) {
    if (reportInput.snapshot.digest !== result.manifest.identity.snapshotDigest) {
      throw new Error('preview report snapshot identity does not match the artifact manifest');
    }
    report = createResourcePreviewReport({
      runId,
      snapshot: reportInput.snapshot,
      subject: reportInput.subject,
      presentation: reportInput.presentation,
      oracle: reportInput.oracle,
      artifacts: nonReportArtifacts,
    });
    reportBytes = new TextEncoder().encode(JSON.stringify(report));
  }
  const reportArtifact: PreviewArtifactManifestEntry | undefined =
    reportBytes === undefined
      ? undefined
      : {
          owner: 'resource-preview',
          kind: 'report',
          role: 'report',
          uri: projectUri(projectRoot, finalPaths.report),
          digest: sha256(reportBytes),
          byteLength: reportBytes.byteLength,
          mediaType: 'application/vnd.forgeax.resource-preview+json',
          derivedFrom: nonReportArtifacts.map((artifact) => artifact.digest),
        };
  const manifest = createPreviewArtifactManifest({
    ...result.manifest,
    artifacts:
      reportArtifact === undefined ? nonReportArtifacts : [reportArtifact, ...nonReportArtifacts],
  });
  const validated = validatePreviewArtifactManifest(
    manifest,
    reportArtifact === undefined ? requiredRoles : ['report', ...requiredRoles],
  );
  if (!validated.ok) throw new Error(JSON.stringify(validated.error.detail));
  const staging = await mkdtemp(join(runsRoot, '.staging-'));
  const paths = {
    tapeJson: join(staging, 'rhi-tape.json'),
    tapeBlob: join(staging, 'rhi-tape.bin'),
    capturePng: join(staging, 'capture.png'),
    freshReplayPng: join(staging, 'fresh-replay.png'),
    profile: join(staging, 'profile.json'),
    manifest: join(staging, 'manifest.json'),
    report: join(staging, 'report.json'),
  };
  try {
    await Promise.all([
      writeFile(paths.tapeJson, tapeJson),
      writeFile(paths.tapeBlob, tapeBlob),
      writeFile(paths.capturePng, capturePng),
      writeFile(paths.freshReplayPng, freshReplayPng),
      writeFile(paths.profile, profile),
      ...(reportBytes === undefined ? [] : [writeFile(paths.report, reportBytes)]),
    ]);
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(staging, published);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
  return {
    ...result,
    tape: {
      ...result.tape,
      jsonUri: projectUri(projectRoot, finalPaths.tapeJson),
      blobUri: projectUri(projectRoot, finalPaths.tapeBlob),
    },
    profile: { ...result.profile, uri: projectUri(projectRoot, finalPaths.profile) },
    capturePng: { ...result.capturePng, uri: projectUri(projectRoot, finalPaths.capturePng) },
    png: { ...result.png, uri: projectUri(projectRoot, finalPaths.freshReplayPng) },
    manifest,
    artifacts: manifest.artifacts.map(artifactRef),
  };
}

function browserFailure(
  phase: string,
  cause: unknown,
  pageErrors: readonly string[] = [],
): BrowserHostResult {
  return {
    ok: false,
    error: {
      code: 'tool-preview-browser-host-failed',
      expected: 'a real Chromium page, project bootstrap, WebGPU device, and bounded preview run',
      hint: 'Inspect the Browser Host phase and repair the project or local WebGPU capability.',
      detail: {
        phase,
        cause: transportCause(cause),
        pageErrors,
      },
    },
  };
}

export async function runBrowserPreviewHost(
  projectRoot: string,
  recipe: ToolPreviewRecipe,
  snapshot: SnapshotRef,
  runId: string,
  signal: AbortSignal,
  bootstrapRoot: BootstrapRoot = 'project-bootstrap',
  resource?: ToolPreviewResourceRequest,
  options: BrowserHostOptions = {},
): Promise<BrowserHostResult> {
  const facts = await readProjectFacts(projectRoot);
  if (!facts.ok)
    return { ok: false, error: { ...facts.error, detail: facts.error.detail as never } };
  const config = await createViteConfig(facts.value, 'serve', '/', { bootstrapRoot });
  // A Browser Host is a disposable Vite realm. A shared cache lets adjacent
  // coverage groups observe a partially-written optimized dependency graph.
  // Keep the cache inside the project lifecycle and remove it with the Host.
  const cacheDir = await mkdtemp(join(facts.value.root, '.forgeax', '.browser-host-vite-'));
  let server: ViteDevServer;
  try {
    const port = await allocateLoopbackPort();
    server = await createServer({
      ...config,
      cacheDir,
      logLevel: 'silent',
      optimizeDeps: {
        ...config.optimizeDeps,
        // Tool runs must observe the current workspace build, even when a
        // persistent runner retains Vite's optimized-dependency cache.
        force: true,
      },
      server: {
        ...config.server,
        host: '127.0.0.1',
        port,
        // Vite's port 0 means its default 5173. Bind the probed port exactly so
        // another project or runner cannot be mistaken for this Browser Host.
        strictPort: true,
      },
    });
  } catch (cause) {
    await rm(cacheDir, { recursive: true, force: true });
    throw cause;
  }
  const hostStartedAtMs = performance.now();
  let phase = 'server-listen';
  let browser: Browser | undefined;
  let page: Page | undefined;
  let pageErrors: string[] = [];
  let responseDiagnostics: Promise<void>[] = [];
  const launchBrowser = (headless: boolean): Promise<Browser> =>
    chromium.launch({
      channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
      headless,
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--use-vulkan=swiftshader',
        '--use-angle=swiftshader',
        '--disable-vulkan-surface',
        '--ignore-gpu-blocklist',
        '--disable-gpu-driver-bug-workarounds',
        '--disable-dawn-features=disallow_unsafe_apis',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  const observePage = (target: Page): void => {
    target.on('pageerror', (error) => pageErrors.push(error.message));
    target.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        pageErrors.push(`${message.type()}: ${message.text()}`);
      }
    });
    target.on('response', (response) => {
      if (response.status() >= 400) {
        responseDiagnostics.push(
          response
            .text()
            .then((body) => {
              pageErrors.push(`HTTP ${response.status()}: ${response.url()} ${body}`);
            })
            .catch(() => {
              pageErrors.push(`HTTP ${response.status()}: ${response.url()}`);
            }),
        );
      }
    });
  };
  const closeBrowserProcess = async (): Promise<void> => {
    await page?.close().catch(() => undefined);
    page = undefined;
    await browser?.close().catch(() => undefined);
    browser = undefined;
  };
  const abort = (): void => {
    void closeBrowserProcess();
    void server.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('Browser Host aborted before launch');
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo | null | undefined;
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('Vite Browser Host did not expose a loopback TCP address');
    }

    phase = 'server-transform';
    const entryTransform = await server.transformRequest('/main.ts');
    if (entryTransform === null) {
      throw new Error('Vite Browser Host entry transform returned no module');
    }

    phase = 'capture-browser-launch';
    browser = await launchBrowser(recipe.presentation === 'hidden');
    phase = 'capture-page-bootstrap';
    page = await browser.newPage({
      viewport: recipe.viewport,
      deviceScaleFactor: 1,
    });
    observePage(page);
    const captureUrl = new URL(`http://127.0.0.1:${address.port}/`);
    captureUrl.searchParams.set('forgeax-tool-recipe', JSON.stringify(recipe));
    captureUrl.searchParams.set('forgeax-tool-snapshot', JSON.stringify(snapshot));
    captureUrl.searchParams.set('forgeax-tool-run-id', runId);
    if (resource !== undefined)
      captureUrl.searchParams.set('forgeax-resource-preview', JSON.stringify(resource));
    await page.goto(captureUrl.href, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.waitForFunction(
      () =>
        (
          globalThis as unknown as {
            __forgeaxToolHost?: { readonly ready?: boolean };
          }
        ).__forgeaxToolHost?.ready === true,
      undefined,
      { timeout: 45_000 },
    );
    phase = 'capture-run';
    const captured = await page.evaluate(async () => {
      const host = (
        globalThis as unknown as {
          __forgeaxToolHost: {
            capture(): Promise<
              | { readonly ok: true; readonly result: ToolPreviewCaptureResult }
              | { readonly ok: false; readonly error: ToolDomainFailure }
            >;
          };
        }
      ).__forgeaxToolHost;
      const value = await host.capture();
      return JSON.parse(
        JSON.stringify(value, (_key, nested) =>
          nested instanceof Error
            ? {
                ...nested,
                name: nested.name,
                message: nested.message,
                stack: nested.stack,
              }
            : nested,
        ),
      ) as Awaited<ReturnType<typeof host.capture>>;
    });
    await Promise.all(responseDiagnostics);
    if (!captured.ok) return browserFailure('capture-run', captured.error, pageErrors);
    if (pageErrors.length > 0)
      return browserFailure('capture-page-runtime', pageErrors[0], pageErrors);
    const capturePng = await page.screenshot({ type: 'png' });
    const capturedResult: ToolPreviewCaptureResult = {
      ...captured.result,
      capturePng: {
        uri: `data:image/png;base64,${capturePng.toString('base64')}`,
        width: recipe.viewport.width,
        height: recipe.viewport.height,
      },
    };

    await closeBrowserProcess();
    pageErrors = [];
    responseDiagnostics = [];

    phase = 'replay-browser-launch';
    browser = await launchBrowser(true);
    phase = 'replay-page-bootstrap';
    page = await browser.newPage({
      viewport: recipe.viewport,
      deviceScaleFactor: 1,
    });
    observePage(page);
    const replayUrl = new URL(`http://127.0.0.1:${address.port}/`);
    replayUrl.searchParams.set('forgeax-tool-replay', '1');
    await page.goto(replayUrl.href, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.waitForFunction(
      () =>
        (
          globalThis as unknown as {
            __forgeaxToolReplayHost?: { readonly ready?: boolean };
          }
        ).__forgeaxToolReplayHost?.ready === true,
      undefined,
      { timeout: 45_000 },
    );
    phase = 'replay-run';
    const result = (await page.evaluate(async (serializedCapture: string): Promise<unknown> => {
      const host = (
        globalThis as unknown as {
          __forgeaxToolReplayHost: {
            run(value: ToolPreviewCaptureResult): Promise<unknown>;
          };
        }
      ).__forgeaxToolReplayHost;
      const value = await host.run(JSON.parse(serializedCapture) as ToolPreviewCaptureResult);
      return JSON.parse(
        JSON.stringify(value, (_key, nested) =>
          nested instanceof Error
            ? {
                ...nested,
                name: nested.name,
                message: nested.message,
                stack: nested.stack,
              }
            : nested,
        ),
      ) as unknown;
    }, JSON.stringify(capturedResult))) as
      | { readonly ok: true; readonly result: PreviewHostResult }
      | { readonly ok: false; readonly error: ToolDomainFailure };
    await Promise.all(responseDiagnostics);
    if (!result.ok) return browserFailure('replay-run', result.error, pageErrors);
    if (pageErrors.length > 0)
      return browserFailure('replay-page-runtime', pageErrors[0], pageErrors);

    const endedAtMs = performance.now();
    const phases = result.result.operationTiming.phases;
    const observedDurationMs =
      phases === undefined
        ? 0
        : Object.values(phases).reduce(
            (total, observation) =>
              total + (observation.status === 'observed' ? observation.durationMs : 0),
            0,
          );
    const durationMs = endedAtMs - hostStartedAtMs;
    const value: PreviewHostResult = {
      ...result.result,
      operationTiming: {
        ...result.result.operationTiming,
        startedAtMs: hostStartedAtMs,
        endedAtMs,
        durationMs,
        ...(phases === undefined
          ? { unattributedMs: durationMs }
          : {
              phases: {
                ...phases,
                transport: {
                  status: 'observed',
                  durationMs: Math.max(0, durationMs - observedDurationMs),
                },
              },
              unattributedMs: 0,
            }),
      },
      actualCarrier: recipe.presentation === 'hidden' ? 'headless-private' : 'headed-private',
    };
    phase = 'artifact-publish';
    return {
      ok: true,
      value:
        options.publish === false
          ? value
          : await publishPreviewArtifacts(projectRoot, runId, value),
    };
  } catch (cause) {
    await Promise.all(responseDiagnostics);
    return browserFailure(phase, cause, pageErrors);
  } finally {
    signal.removeEventListener('abort', abort);
    await closeBrowserProcess();
    await server.close().catch(() => undefined);
    await rm(cacheDir, { recursive: true, force: true });
  }
}

export function runBrowserResourcePreviewHost(
  projectRoot: string,
  recipe: ToolPreviewRecipe,
  snapshot: SnapshotRef,
  runId: string,
  signal: AbortSignal,
  resource: ToolPreviewResourceRequest,
  options: BrowserHostOptions = {},
): Promise<BrowserHostResult> {
  return runBrowserPreviewHost(
    projectRoot,
    recipe,
    snapshot,
    runId,
    signal,
    'resource-bootstrap',
    resource,
    options,
  );
}
