import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const canonicalBuildScript = 'vite build';

export function validateCanonicalAppBuild(app) {
  const buildScript = app.manifest.scripts?.build;
  if (buildScript !== canonicalBuildScript) {
    throw new Error(
      `[build-apps] unsupported build script for ${app.manifest.name}: ` +
        `expected ${JSON.stringify(canonicalBuildScript)}, received ${JSON.stringify(buildScript)}`,
    );
  }
}

export function validateCanonicalAppBuilds(apps) {
  for (const app of apps) validateCanonicalAppBuild(app);
}

export function resolveViteCli(repoRoot) {
  const requireFromRepo = createRequire(resolve(repoRoot, 'package.json'));
  const packageManifestPath = requireFromRepo.resolve('vite/package.json');
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'));
  const bin =
    typeof packageManifest.bin === 'string' ? packageManifest.bin : packageManifest.bin?.vite;
  if (typeof bin !== 'string')
    throw new Error(`[build-apps] installed Vite package has no vite CLI: ${packageManifestPath}`);
  const cliPath = resolve(dirname(packageManifestPath), bin);
  if (!existsSync(cliPath)) throw new Error(`[build-apps] Vite CLI not found: ${cliPath}`);
  return cliPath;
}

export function createViteBuildInvocation({
  app,
  viteCliPath,
  sharedInputManifest,
  appFactsDir,
  baseEnv = process.env,
}) {
  return {
    command: process.execPath,
    args: [viteCliPath, 'build'],
    options: {
      cwd: app.directory,
      stdio: 'inherit',
      shell: false,
      env: {
        ...baseEnv,
        FORGEAX_SHARED_APP_INPUTS_MANIFEST: sharedInputManifest,
        ...(appFactsDir === undefined ? {} : { FORGEAX_BUILD_METRICS_DIR: appFactsDir }),
      },
    },
  };
}

export function createPrebuildInvocation({ app, baseEnv = process.env }) {
  if (app.manifest.scripts?.prebuild === undefined) return null;
  return {
    command: 'pnpm',
    args: ['run', 'prebuild'],
    options: {
      cwd: app.directory,
      stdio: 'inherit',
      shell: false,
      env: baseEnv,
    },
  };
}
