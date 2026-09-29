// @perf-budget-skip: real Vite build/dev graphs and Chromium Worker module identity.
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { build, createServer } from 'vite';
import { expect, it } from 'vitest';
import { executionWorkerEntries } from '../build/execution-workers.js';

it('shares installed Engine component identity across dev Worker and bootstrap imports', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-worker-dev-identity-'));
  const packages = resolve(import.meta.dirname, '../../..');
  const scope = resolve(root, 'node_modules/@forgeax');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(resolve(scope, 'engine'), { recursive: true });
    await mkdir(resolve(scope, 'worker-host'));
    await cp(resolve(packages, 'skinning/dist'), resolve(scope, 'engine-skinning'), {
      recursive: true,
    });
    await writeFile(
      resolve(scope, 'engine-skinning/package.json'),
      JSON.stringify({ name: '@forgeax/engine-skinning', type: 'module', exports: './index.mjs' }),
    );
    for (const name of ['ecs', 'types']) {
      await symlink(resolve(packages, name), resolve(scope, `engine-${name}`));
    }
    await writeFile(
      resolve(scope, 'engine/package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        type: 'module',
        exports: { './skinning': './skinning.js', './package.json': './package.json' },
        dependencies: { '@forgeax/engine-skinning': '0.0.0' },
      }),
    );
    await writeFile(
      resolve(scope, 'engine/skinning.js'),
      "export { Skin } from '@forgeax/engine-skinning';",
    );
    await writeFile(resolve(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    await writeFile(
      resolve(root, 'main.js'),
      `import { Skin } from '@forgeax/engine/skinning';
       globalThis.__skinLoaded = !!Skin;
       const worker = new Worker(new URL('./node_modules/@forgeax/worker-host/engine-worker-runtime.mjs', import.meta.url), { type: 'module' });
       worker.onmessage = event => { globalThis.__identity = event.data; };
       worker.postMessage('/bootstrap.js');`,
    );
    await writeFile(
      resolve(root, 'bootstrap.js'),
      "export { Skin } from '@forgeax/engine/skinning';",
    );
    await writeFile(
      resolve(scope, 'worker-host/engine-worker-runtime.mjs'),
      `import { Skin } from '@forgeax/engine-skinning';
       self.onmessage = async event => self.postMessage(Skin === (await import(/* @vite-ignore */ event.data)).Skin);`,
    );
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [executionWorkerEntries()],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, packages] } },
    });
    await server.listen();
    const executablePath = ['/opt/google/chrome-beta/chrome', chromium.executablePath()].find(
      existsSync,
    );
    browser = await chromium.launch({
      headless: true,
      ...(executablePath === undefined ? {} : { executablePath }),
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls?.local[0] ?? '');
    await page.waitForFunction(() => '__identity' in globalThis, undefined, { timeout: 30_000 });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(globalThis, '__identity'))).toBe(true);
  } finally {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it('serves snapshotted App Worker entries without exposing sibling inputs', async () => {
  const snapshot = await mkdtemp(resolve(tmpdir(), 'forgeax-worker-snapshot-'));
  const root = resolve(snapshot, 'project');
  const facade = resolve(root, 'node_modules/@forgeax/engine');
  const app = resolve(snapshot, 'dependencies/app');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await mkdir(resolve(facade, 'node_modules/@forgeax'), { recursive: true });
    await mkdir(resolve(app, 'dist'), { recursive: true });
    await writeFile(
      resolve(facade, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        exports: { './package.json': './package.json' },
        dependencies: { '@forgeax/engine-app': '0.0.0' },
      }),
    );
    await writeFile(
      resolve(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-app',
        main: './dist/index.mjs',
        exports: { './package.json': './package.json' },
      }),
    );
    await writeFile(resolve(app, 'dist/index.mjs'), 'export const ready = true;');
    await symlink(app, resolve(facade, 'node_modules/@forgeax/engine-app'));
    await writeFile(resolve(snapshot, 'private.txt'), 'unrelated snapshot input');
    for (const worker of ['engine', 'render', 'kernel']) {
      await writeFile(
        resolve(app, `dist/${worker}-worker-runtime.mjs`),
        'self.postMessage("ready");',
      );
    }
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [executionWorkerEntries()],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0] ?? '';
    const privateResponse = await fetch(new URL(`/@fs/${snapshot}/private.txt`, origin));
    expect(privateResponse.status).toBe(403);
    for (const worker of ['engine', 'render', 'kernel']) {
      const response = await fetch(
        new URL(`/@fs/${app}/dist/${worker}-worker-runtime.mjs`, origin),
      );
      expect(response.status, worker).toBe(200);
      expect(await response.text()).toContain('self.postMessage("ready")');
    }
  } finally {
    await server?.close();
    await rm(snapshot, { recursive: true, force: true });
  }
});

it('shares component identity between emitted Worker runtimes and dynamically loaded plugins', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-worker-identity-'));
  const skinning = resolve(import.meta.dirname, '../../../skinning/dist/index.mjs');
  try {
    await symlink(
      resolve(import.meta.dirname, '../../../../node_modules'),
      resolve(root, 'node_modules'),
    );
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      resolve(root, 'main.js'),
      `
      export const worker = new Worker(new URL('./engine-worker-runtime.mjs', import.meta.url), { type: 'module' });
    `,
    );
    await writeFile(resolve(root, 'bootstrap.js'), `export { Skin } from '${skinning}';`);
    await writeFile(
      resolve(root, 'engine-worker-runtime.mjs'),
      `
      import { Skin } from '${skinning}';
      globalThis.__forgeaxIdentityProbe = async url => Skin === (await import(/* @vite-ignore */ url)).Skin;
    `,
    );
    const outDir = resolve(root, 'dist');
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [executionWorkerEntries()],
      build: {
        target: 'esnext',
        modulePreload: false,
        outDir,
        rollupOptions: {
          preserveEntrySignatures: 'strict',
          input: { main: resolve(root, 'main.js'), bootstrap: resolve(root, 'bootstrap.js') },
          output: { entryFileNames: 'assets/[name].js' },
        },
      },
    });
    const assets = resolve(outDir, 'assets');
    const files = await readdir(assets);
    const workerFile = files.find((name) => name.startsWith('engine-worker-runtime'));
    expect(workerFile).toBeDefined();
    if (workerFile === undefined) return;
    await import(pathToFileURL(resolve(assets, workerFile)).href);
    const globals = globalThis as typeof globalThis & {
      __forgeaxIdentityProbe?: (url: string) => Promise<boolean>;
    };
    try {
      expect(
        await globals.__forgeaxIdentityProbe?.(pathToFileURL(resolve(assets, 'bootstrap.js')).href),
      ).toBe(true);
      expect(await readFile(resolve(assets, 'main.js'), 'utf8')).toContain('engine-worker-runtime');
    } finally {
      delete globals.__forgeaxIdentityProbe;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('discovers nested native Engine dependencies before a cold browser target activates', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-engine-cold-deps-'));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (const [name, dependencies, source] of [
      [
        '@forgeax/engine',
        { '@forgeax/engine-app': '0.0.0', '@forgeax/engine-plugin': '0.0.0' },
        "export { value } from '@forgeax/engine-app';",
      ],
      [
        '@forgeax/engine-app',
        { '@forgeax/engine-plugin': '0.0.0' },
        "export { value } from '@forgeax/engine-plugin';",
      ],
      [
        '@forgeax/engine-plugin',
        { 'nested-cjs': '0.0.0' },
        "import dependency from 'nested-cjs'; export const value = dependency.value;",
      ],
    ] as const) {
      const directory = resolve(root, 'node_modules', name);
      await mkdir(resolve(directory, 'dist'), { recursive: true });
      await writeFile(
        resolve(directory, 'package.json'),
        JSON.stringify({
          name,
          type: 'module',
          main: './dist/index.mjs',
          exports: { '.': './dist/index.mjs', './package.json': './package.json' },
          dependencies,
        }),
      );
      await writeFile(resolve(directory, 'dist/index.mjs'), source);
    }
    await mkdir(resolve(root, 'node_modules/nested-cjs'));
    await writeFile(
      resolve(root, 'node_modules/nested-cjs/package.json'),
      JSON.stringify({ name: 'nested-cjs', main: './index.cjs' }),
    );
    await writeFile(
      resolve(root, 'node_modules/nested-cjs/index.cjs'),
      'module.exports = { value: 42 };',
    );
    await writeFile(resolve(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    await writeFile(
      resolve(root, 'main.js'),
      "import { value } from '@forgeax/engine'; globalThis.__value = value;",
    );
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [executionWorkerEntries()],
      build: { outDir: 'output' },
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const optimizer = server.environments.client?.depsOptimizer;
    await optimizer?.init();
    await optimizer?.scanProcessing;
    expect(
      Object.keys({ ...optimizer?.metadata.optimized, ...optimizer?.metadata.discovered }),
    ).toContain('nested-cjs');
    const messages: unknown[] = [];
    const send = server.ws.send.bind(server.ws);
    server.ws.send = ((...args: Parameters<typeof send>) => {
      messages.push(args[0]);
      return send(...args);
    }) as typeof send;
    const executablePath = ['/opt/google/chrome-beta/chrome', chromium.executablePath()].find(
      existsSync,
    );
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls?.local[0] ?? '');
    await page.waitForFunction(() => Reflect.get(globalThis, '__value') === 42);
    expect(errors).toEqual([]);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'full-reload' }));
  } finally {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
