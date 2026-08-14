import { resolve } from 'node:path';
import { createServer, build as viteBuild, preview as vitePreview } from 'vite';
import { startVitest } from 'vitest/node';
import { verifyDist, writeDistManifest } from './dist.js';
import { createViteConfig } from './host.js';
import { commandError, readProjectFacts } from './project.js';

export {
  assetAddCommand,
  assetInspectCommand,
  assetListCommand,
  assetVerifyCommand,
} from './assets.js';
export type { DoctorReport } from './bootstrap-commands.js';
export { doctorCommand, initCommand, newCommand } from './bootstrap-commands.js';
export { shaderCheckCommand } from './shader-check.js';

import type { BuildOptions, CommandResult, ProjectCommandOptions } from './types.js';

export async function buildCommand(options: BuildOptions = {}): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const previous = process.cwd();
  const base = options.base ?? '/';
  try {
    process.chdir(facts.value.root);
    await viteBuild(await createViteConfig(facts.value, 'build', base));
    return { ok: true, value: await writeDistManifest(facts.value, base) };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'game-build-failed') };
  } finally {
    process.chdir(previous);
  }
}

export async function devCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const previous = process.cwd();
  try {
    process.chdir(facts.value.root);
    const server = await createServer(await createViteConfig(facts.value, 'serve'));
    await server.listen();
    if (options.json !== true) server.printUrls();
    return { ok: true, value: { root: facts.value.root, urls: server.resolvedUrls } };
  } catch (cause) {
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
    const server = await vitePreview({
      root,
      configFile: false,
      base: verified.value.base,
      preview: { open: false, port: 0, strictPort: false },
      build: { outDir: resolve(root, 'dist') },
    });
    if (options.json !== true) server.printUrls();
    return { ok: true, value: { root, urls: server.resolvedUrls } };
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
