#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
// bevy-demo.mjs — create Bevy demo app shells and derive their CI smoke membership.
//
// An app's package.json#forgeax.bevyExample + smokeInvocation is the one per-example
// spec. It already drives coverage; this command writes that existing contract rather
// than introducing a second ledger that every demo would need to synchronize.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VALID_STATUS = new Set(['partial', 'implemented', 'shelved']);

function fail(code, expected, hint) {
  throw new Error(`[reason] ${code}: ${expected}\n[rerun]  pnpm bevy:validate\n[hint]   ${hint}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail('bevy-demo-json-invalid', `${label} is valid JSON`, `${path}: ${String(error)}`);
  }
}

function validateSpec(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('bevy-demo-spec-invalid', `${label} is a JSON object`, `got ${JSON.stringify(value)}`);
  }
  const spec = value;
  if (typeof spec.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(spec.id)) {
    fail(
      'bevy-demo-id-invalid',
      `${label}.id is lowercase kebab-case`,
      `got ${JSON.stringify(spec.id)}`,
    );
  }
  if (typeof spec.name !== 'string' || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(spec.name)) {
    fail(
      'bevy-demo-name-invalid',
      `${label}.name is a Bevy example snake_case name`,
      `got ${JSON.stringify(spec.name)}`,
    );
  }
  if (typeof spec.category !== 'string' || spec.category.trim() === '') {
    fail(
      'bevy-demo-category-invalid',
      `${label}.category is a non-empty Bevy category`,
      `got ${JSON.stringify(spec.category)}`,
    );
  }
  if (typeof spec.title !== 'string' || spec.title.trim() === '') {
    fail(
      'bevy-demo-title-invalid',
      `${label}.title is non-empty`,
      `got ${JSON.stringify(spec.title)}`,
    );
  }
  const status = spec.status ?? 'partial';
  if (!VALID_STATUS.has(status)) {
    fail(
      'bevy-demo-status-invalid',
      `${label}.status in {partial, implemented, shelved}`,
      `got ${JSON.stringify(status)}`,
    );
  }
  return { id: spec.id, name: spec.name, category: spec.category, title: spec.title, status };
}

function appDir(root, id) {
  return resolve(root, 'apps', 'bevy', id);
}

function packageName(spec) {
  return `@forgeax/bevy-${spec.id}`;
}

function smokeInvocation(packageNameValue) {
  return `pnpm --filter ${packageNameValue} smoke`;
}

function packageJson(spec) {
  const name = packageName(spec);
  const smoke = smokeInvocation(name);
  return {
    name,
    version: '0.0.0',
    private: true,
    type: 'module',
    license: 'Apache-2.0',
    description: `Scaffold for Bevy's \`${spec.name}\` example. Replace the placeholder scene and smoke before promoting this scaffold to forgeax.bevyExample.`,
    scripts: {
      dev: 'vite',
      typecheck: 'tsc --noEmit',
      build: 'vite build',
      preview: 'vite preview',
      smoke: 'node scripts/smoke-dawn.mjs',
    },
    forgeax: {
      bevyExample: { name: spec.name, category: spec.category, status: spec.status },
      ...(spec.status === 'implemented' ? { smokeInvocation: smoke } : {}),
      metrics: {
        'bundle-size': {
          enabled: false,
          reason:
            'vite app bundle downstream of engine-runtime sizes already tracked at the package level',
        },
        fps: {
          enabled: false,
          reason: 'demo-specific fps evidence belongs to its completed reproduction',
        },
        bench: {
          enabled: false,
          reason: 'demo-specific benchmarks belong to its completed reproduction',
        },
        gate:
          spec.status === 'implemented'
            ? { enabled: true, command: smoke }
            : {
                enabled: false,
                reason: 'scaffold is not a front-door-verified Bevy reproduction yet',
              },
        'spike-report': { enabled: false, reason: 'not a spike app; Bevy example reproduction' },
      },
    },
    dependencies: {
      '@forgeax/engine-app': 'workspace:*',
      '@forgeax/engine-assets-runtime': 'workspace:*',
      '@forgeax/engine-ecs': 'workspace:*',
      '@forgeax/engine-math': 'workspace:*',
      '@forgeax/engine-runtime': 'workspace:*',
    },
    devDependencies: {
      '@forgeax/engine-vite-plugin-shader': 'workspace:*',
      '@webgpu/types': '^0.1.71',
      vite: '8.0.10',
      webgpu: '^0.4.0',
    },
  };
}

function files(spec) {
  return {
    'index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>forgeax-engine - ${spec.title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: #000; }
      canvas { display: block; width: 100vw; height: 100vh; }
    </style>
  </head>
  <body>
    <canvas id="app"></canvas>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
    'tsconfig.json': `{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "../..",
    "noEmit": true,
    "emitDeclarationOnly": false,
    "types": ["@webgpu/types"]
  },
  "include": ["src/**/*"]
}
`,
    'vite.config.ts': `import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
`,
    'src/vite-env.d.ts': `// apps/bevy/${spec.id} -- ambient declarations.
// virtual:forgeax/bundler is injected by the shader plugin for browser builds.

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
`,
    'src/main.ts': `const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-${spec.id}: missing <canvas id="app"> in index.html');

// This shell is deliberately not a reproduction yet. Build the shared scene,
// real Dawn smoke, and front-door evidence before promoting this app to
// forgeax.bevyExample.status = 'implemented'.
console.warn('[bevy-${spec.id}] scaffold ready; implement Bevy ${spec.name}');
`,
    'scripts/smoke-dawn.mjs': `#!/usr/bin/env node
console.error('[reason] bevy-demo-scaffold-unimplemented: ${spec.id} needs a real Dawn smoke before it can run in CI');
console.error('[rerun]  pnpm --filter ${packageName(spec)} smoke');
console.error('[hint]   implement the Bevy ${spec.name} scene and replace this placeholder before setting status to implemented');
process.exitCode = 1;
`,
  };
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function validateDemoApps(root) {
  const bevyRoot = resolve(root, 'apps', 'bevy');
  if (!existsSync(bevyRoot)) return [];
  const apps = [];
  for (const entry of readdirSync(bevyRoot, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(bevyRoot, entry.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath, 'package.json');
    const be = pkg?.forgeax?.bevyExample;
    if (!be || typeof be !== 'object' || Array.isArray(be)) {
      fail(
        'bevy-demo-spec-missing',
        `${relative(root, pkgPath)} has forgeax.bevyExample`,
        'new Bevy apps must use pnpm bevy:new-demo',
      );
    }
    const spec = validateSpec(
      { id: entry.name, title: entry.name, ...be },
      `${relative(root, pkgPath)}#forgeax.bevyExample`,
    );
    const expectedName = packageName(spec);
    if (pkg.name !== expectedName) {
      fail(
        'bevy-demo-projection-stale',
        `${relative(root, pkgPath)} has package name '${expectedName}'`,
        `got ${JSON.stringify(pkg.name)}`,
      );
    }
    const expectedSmoke = smokeInvocation(expectedName);
    const smoke = pkg?.forgeax?.smokeInvocation;
    const gate = pkg?.forgeax?.metrics?.gate?.command;
    if (spec.status === 'implemented') {
      if (smoke !== expectedSmoke || gate !== expectedSmoke) {
        fail(
          'bevy-demo-projection-stale',
          `${relative(root, pkgPath)} derives smoke metadata from package identity`,
          `smoke=${JSON.stringify(smoke)} gate=${JSON.stringify(gate)} expected=${JSON.stringify(expectedSmoke)}`,
        );
      }
    } else if (smoke !== undefined || gate !== undefined) {
      fail(
        'bevy-demo-partial-has-smoke',
        `${relative(root, pkgPath)} partial/shelved app has no smoke membership`,
        'only a front-door-verified implemented demo may declare smokeInvocation and a smoke gate',
      );
    }
    apps.push({ dir: dirname(pkgPath), pkg, spec });
  }
  return apps;
}

function commandNew(root, specPath) {
  if (!specPath)
    fail(
      'bevy-demo-spec-required',
      'new receives a JSON spec path',
      'pnpm bevy:new-demo -- ./my-demo.json',
    );
  const spec = validateSpec(readJson(resolve(specPath), 'input spec'), specPath);
  if (spec.status !== 'partial') {
    fail(
      'bevy-demo-scaffold-status-invalid',
      'a newly scaffolded demo has status "partial"',
      'a scaffold has no real scene or smoke yet; promote it only after a future demo round provides both',
    );
  }
  const dir = appDir(root, spec.id);
  if (existsSync(dir)) {
    fail(
      'bevy-demo-target-exists',
      `${relative(root, dir)} does not already exist`,
      'choose a new id; this command never overwrites an app',
    );
  }
  write(join(dir, 'package.json'), `${JSON.stringify(packageJson(spec), null, 2)}\n`);
  for (const [path, content] of Object.entries(files(spec))) write(join(dir, path), content);
  process.stdout.write(`[ok] created ${relative(root, dir)}\n`);
}

function commandValidate(root) {
  const apps = validateDemoApps(root);
  process.stdout.write(`[ok] ${apps.length} Bevy demo package specs are valid\n`);
}

function commandSmokes(root, dryRun) {
  const apps = validateDemoApps(root).filter((app) => app.spec.status === 'implemented');
  for (const { pkg } of apps) {
    for (const args of [
      ['--filter', pkg.name, 'build'],
      ['--filter', pkg.name, 'smoke'],
    ]) {
      process.stdout.write(`[bevy-smoke] pnpm ${args.join(' ')}\n`);
      if (dryRun) continue;
      const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
  process.stdout.write(
    `[ok] ${apps.length} implemented Bevy demo smoke entries completed${dryRun ? ' (dry run)' : ''}\n`,
  );
}

function main() {
  const argv = process.argv.slice(2).filter((argument) => argument !== '--');
  let root = process.cwd();
  let dryRun = false;
  for (let i = 0; i < argv.length; ) {
    if (argv[i] === '--root') {
      const value = argv[i + 1];
      if (!value)
        fail('bevy-demo-root-required', '--root has a directory', 'pass --root <repo-root>');
      root = resolve(value);
      argv.splice(i, 2);
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
      argv.splice(i, 1);
    } else {
      i++;
    }
  }
  const [command, argument] = argv;
  if (command === 'new') commandNew(root, argument);
  else if (command === 'validate') commandValidate(root);
  else if (command === 'smokes') commandSmokes(root, dryRun);
  else
    fail(
      'bevy-demo-command-unknown',
      'command in {new, validate, smokes}',
      `got ${JSON.stringify(command)}`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
