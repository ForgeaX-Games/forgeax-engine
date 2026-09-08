import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { basename, dirname, relative, resolve } from 'node:path';
import { build as viteBuild, preview as vitePreview } from 'vite';
import { startVitest } from 'vitest/node';
import { createZip } from './archive.js';
import { verifyDist, writeDistManifest } from './dist.js';
import { createViteConfig } from './host.js';
import { commandError, readProjectFacts } from './project.js';
import { resolveProjectPort } from './types.js';

export {
  assetAddCommand,
  assetInspectCommand,
  assetListCommand,
  assetVerifyCommand,
} from './assets.js';
export type { DoctorReport } from './bootstrap-commands.js';
export { doctorCommand, initCommand, newCommand } from './bootstrap-commands.js';
export {
  engineDoctorCommand,
  engineStatusCommand,
  engineUnlinkCommand,
  engineUseLocalCommand,
} from './engine-binding.js';
export { pluginInstallCommand, pluginUninstallCommand } from './plugin-authoring.js';
export { createCliRhiDebugOperationContext } from './rhi-debug/cli-context.js';
export type {
  ArtifactRef,
  CapturedRhiTape,
  RhiCaptureFrameValue,
  RhiDebugOperationContext,
  RhiDebugOperationDescriptor,
  RhiDebugOperationInput,
  RhiDebugOperationName,
  RhiDebugOperationOutput,
  RhiInspectInput,
  RhiInspectOutput,
  RhiSummaryInput,
  RhiSummaryOutput,
} from './rhi-debug/operations.js';
export {
  createRhiDebugOperationContext,
  discoverRhiDebugOperations,
  RHI_DEBUG_OPERATION_MANIFEST,
  recoverRhiDebugError,
  renderRhiDebugHelp,
  runRhiDebugOperation,
} from './rhi-debug/operations.js';
export { sdkInstallCommand } from './sdk-install.js';
export { shaderCheckCommand } from './shader-check.js';
export { skillInstallCommand, skillVerifyCommand } from './skill-install.js';
export { browserCaptureCommand, softwareCaptureCommand } from './software-capture.js';

import {
  type RhiDebugOperationContext,
  type RhiDebugOperationInput,
  type RhiDebugOperationName,
  type RhiDebugOperationOutput,
  runRhiDebugOperation,
} from './rhi-debug/operations.js';
import type {
  BuildOptions,
  CommandResult,
  PackageOptions,
  ProjectCommandOptions,
} from './types.js';

export function runRhiDebugCommand(
  name: RhiDebugOperationName,
  input: RhiDebugOperationInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiDebugOperationOutput>> {
  return runRhiDebugOperation(name, input, context);
}

async function materializeViteDevPort(port: number): Promise<number> {
  if (port !== 0) return port;
  const reservation = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    reservation.once('error', rejectListen);
    reservation.listen(0, '127.0.0.1', resolveListen);
  });
  const address = reservation.address();
  const assigned = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose, rejectClose) => {
    reservation.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  if (assigned === 0) throw new Error('OS did not assign an ephemeral preview port');
  return assigned;
}

export async function buildCommand(options: BuildOptions = {}): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const previous = process.cwd();
  const base = options.base ?? '/';
  const outDir = resolve(facts.value.root, options.outDir ?? 'dist');
  try {
    process.chdir(facts.value.root);
    await viteBuild(await createViteConfig(facts.value, 'build', base, { outDir }));
    return { ok: true, value: await writeDistManifest(facts.value, base, outDir) };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'game-build-failed') };
  } finally {
    process.chdir(previous);
  }
}

function releaseSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'forgeax-game';
}

export async function packageCommand(
  options: PackageOptions = {},
): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const built = await buildCommand({
    root: facts.value.root,
    base: './',
    ...(options.json === undefined ? {} : { json: options.json }),
  });
  if (!built.ok) return built;
  const distRoot = resolve(facts.value.root, 'dist');
  const verified = await verifyDist(distRoot);
  if (!verified.ok) return verified;
  const archive = resolve(
    facts.value.root,
    options.output ?? `release/${releaseSlug(facts.value.name)}-web.zip`,
  );
  const archiveRelativeToDist = relative(distRoot, archive);
  if (archiveRelativeToDist === '' || !archiveRelativeToDist.startsWith('..')) {
    return {
      ok: false,
      error: {
        code: 'release-output-inside-dist',
        expected: 'the release archive to live outside the derived dist directory',
        hint: 'Use --output release/<game>-web.zip or another path outside dist.',
        detail: { archive, distRoot },
      },
    };
  }
  const temporaryArchive = `${archive}.partial-${process.pid}`;
  const checksumPath = `${archive}.sha256`;
  const temporaryChecksum = `${checksumPath}.partial-${process.pid}`;
  try {
    const paths = [
      ...verified.value.artifacts.map((artifact) => artifact.path),
      'forgeax-dist.json',
    ];
    const entries = await Promise.all(
      paths.map(async (path) => ({ path, bytes: await readFile(resolve(distRoot, path)) })),
    );
    const bytes = createZip(entries);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifestBytes = await readFile(resolve(distRoot, 'forgeax-dist.json'));
    await mkdir(dirname(archive), { recursive: true });
    await writeFile(temporaryArchive, bytes);
    await writeFile(temporaryChecksum, `${sha256}  ${basename(archive)}\n`);
    await rename(temporaryChecksum, checksumPath);
    await rename(temporaryArchive, archive);
    return {
      ok: true,
      value: {
        schemaVersion: '1.0.0',
        format: 'forgeax-web-game',
        target: 'web',
        project: verified.value.project,
        base: verified.value.base,
        engine: {
          delivery: 'bundled-runtime',
          wasm: verified.value.artifacts.some((artifact) => artifact.path.endsWith('.wasm')),
        },
        archive: { path: archive, bytes: bytes.byteLength, sha256 },
        checksumPath,
        distManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        run: {
          local: 'forgeax preview',
          shared: 'upload the ZIP to an HTTPS static or HTML-game host and share its URL',
        },
      },
    };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'game-package-failed') };
  } finally {
    await Promise.all([
      rm(temporaryArchive, { force: true }),
      rm(temporaryChecksum, { force: true }),
    ]);
  }
}

export async function devCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const previous = process.cwd();
  let server: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
  try {
    const { createServer } = await import('vite');
    const { createViteConfig } = await import('./host.js');
    const port = resolveProjectPort(options.port);
    const vitePort = { ...port, port: await materializeViteDevPort(port.port) };
    process.chdir(facts.value.root);
    server = await createServer(
      await createViteConfig(facts.value, 'serve', '/', {
        server: vitePort,
      }),
    );
    await server.listen(vitePort.port);
    if (options.json !== true) server.printUrls();
    return {
      ok: true,
      value: {
        root: facts.value.root,
        urls: server.resolvedUrls,
        mode: 'dev',
        serves: 'source',
        capabilities: {
          'rhi.capture': {
            available: false,
            realm: 'host',
            reason: 'standalone-dev-server-has-no-live-app-cli-attachment',
          },
        },
      },
    };
  } catch (cause) {
    await server?.close();
    process.chdir(previous);
    return { ok: false, error: commandError(cause, 'dev-server-failed') };
  }
}

export async function previewCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root ?? process.cwd());
  const verified = await verifyDist(resolve(root, 'dist'));
  if (!verified.ok) return verified;
  try {
    const port = resolveProjectPort(options.port);
    const server = await vitePreview({
      root,
      configFile: false,
      base: verified.value.base,
      preview: { open: false, ...port },
      build: { outDir: resolve(root, 'dist') },
    });
    if (options.json !== true) server.printUrls();
    return {
      ok: true,
      value: {
        root,
        urls: server.resolvedUrls,
        mode: 'preview',
        serves: 'dist',
        capabilities: {
          'rhi.capture': {
            available: false,
            realm: 'host',
            reason: 'static-dist-host-does-not-install-dev-capture',
          },
        },
      },
    };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'preview-server-failed') };
  }
}

export async function testCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  try {
    const context = await startVitest('test', [], {
      root: facts.value.root,
      run: true,
      watch: false,
      passWithNoTests: false,
    });
    if (context === undefined) {
      return {
        ok: false,
        error: {
          code: 'test-runner-unavailable',
          expected: 'Vitest to create a project test context',
          hint: 'Inspect the project test configuration.',
          detail: { root: facts.value.root },
        },
      };
    }
    const failed = context.state.getFiles().filter((file) => file.result?.state === 'fail');
    await context.close();
    if (failed.length > 0) {
      return {
        ok: false,
        error: {
          code: 'project-tests-failed',
          expected: 'all project tests to pass',
          hint: 'Repair the failing game test before building a release.',
          detail: { files: failed.map((file) => file.filepath) },
        },
      };
    }
    return { ok: true, value: { root: facts.value.root } };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-tests-failed') };
  }
}
