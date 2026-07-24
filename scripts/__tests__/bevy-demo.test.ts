import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const script = resolve(repoRoot, 'scripts/bevy-demo.mjs');
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-bevy-demo-'));
  mkdirSync(join(root, 'apps', 'bevy'), { recursive: true });
  roots.push(root);
  return root;
}

function run(root: string, ...args: string[]) {
  return spawnSync('node', [script, '--root', root, ...args], { encoding: 'utf8' });
}

function spec(root: string, id = 'tiny-demo') {
  const path = join(root, `${id}.json`);
  writeFileSync(
    path,
    JSON.stringify({ id, name: 'tiny_demo', category: 'Animation', title: 'Tiny Demo' }),
  );
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bevy-demo.mjs', () => {
  it('creates a partial app with the standard package, Vite, and smoke shell', () => {
    const root = tempRoot();
    const result = run(root, 'new', spec(root));
    expect(result.status, result.stderr).toBe(0);

    const dir = join(root, 'apps', 'bevy', 'tiny-demo');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@forgeax/bevy-tiny-demo');
    expect(pkg.forgeax.bevyExample).toEqual({
      name: 'tiny_demo',
      category: 'Animation',
      status: 'partial',
    });
    expect(pkg.forgeax.smokeInvocation).toBeUndefined();
    expect(pkg.forgeax.metrics.gate).toMatchObject({ enabled: false });
    expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain('forgeaxShader');
    expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain('vitePluginRhiDebug');
    expect(pkg.devDependencies['@forgeax/engine-vite-plugin-rhi-debug']).toBe('workspace:*');
    expect(readFileSync(join(dir, 'src', 'vite-env.d.ts'), 'utf8')).toContain(
      "declare module 'virtual:forgeax/bundler'",
    );
    expect(readFileSync(join(dir, 'scripts', 'smoke-dawn.mjs'), 'utf8')).toContain(
      'bevy-demo-scaffold-unimplemented',
    );
  });

  it('accepts pnpm’s forwarded -- separator before the spec path', () => {
    const root = tempRoot();
    const result = run(root, 'new', '--', spec(root));
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'apps', 'bevy', 'tiny-demo', 'package.json'), 'utf8')).toContain(
      '@forgeax/bevy-tiny-demo',
    );
  });

  it('refuses to overwrite an existing target', () => {
    const root = tempRoot();
    const input = spec(root);
    expect(run(root, 'new', input).status).toBe(0);
    const second = run(root, 'new', input);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('bevy-demo-target-exists');
  });

  it('identifies a malformed existing app by package path', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'bad-demo');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@forgeax/bevy-bad-demo' }));

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/bevy/bad-demo/package.json has forgeax.bevyExample');
  });

  it('rejects invalid ids before creating an app', () => {
    const root = tempRoot();
    const input = join(root, 'invalid.json');
    writeFileSync(
      input,
      JSON.stringify({
        id: 'Not valid',
        name: 'tiny_demo',
        category: 'Animation',
        title: 'Tiny Demo',
      }),
    );
    const result = run(root, 'new', input);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-id-invalid');
    expect(result.stderr).toContain('[reason]');
    expect(result.stderr).toContain('[rerun]');
    expect(result.stderr).toContain('[hint]');
  });

  it('detects a stale smoke projection instead of silently running it', () => {
    const root = tempRoot();
    expect(run(root, 'new', spec(root)).status).toBe(0);
    const path = join(root, 'apps', 'bevy', 'tiny-demo', 'package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    pkg.forgeax.smokeInvocation = 'pnpm definitely-not-the-demo';
    writeFileSync(path, JSON.stringify(pkg));

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-partial-has-smoke');
  });

  it('refuses to claim a blank scaffold is implemented', () => {
    const root = tempRoot();
    const input = join(root, 'implemented.json');
    writeFileSync(
      input,
      JSON.stringify({
        id: 'implemented-demo',
        name: 'implemented_demo',
        category: 'Animation',
        title: 'Implemented Demo',
        status: 'implemented',
      }),
    );
    const result = run(root, 'new', input);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-scaffold-status-invalid');
  });

  it('accepts bounded smoke concurrency in a dry run', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'tiny-demo');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/bevy-tiny-demo',
        forgeax: {
          bevyExample: { name: 'tiny_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/bevy-tiny-demo smoke',
          metrics: { gate: { command: 'pnpm --filter @forgeax/bevy-tiny-demo smoke' } },
        },
      }),
    );
    const result = run(root, 'smokes', '--concurrency', '4', '--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('completed (dry run) with concurrency=4');
  });

  it('derives smoke concurrency from runner resources', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'tiny-demo');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/bevy-tiny-demo',
        forgeax: {
          bevyExample: { name: 'tiny_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/bevy-tiny-demo smoke',
          metrics: { gate: { command: 'pnpm --filter @forgeax/bevy-tiny-demo smoke' } },
        },
      }),
    );
    const result = run(root, 'smokes', '--concurrency', 'auto', '--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/auto concurrency=\d+/);
    expect(result.stdout).toMatch(/completed \(dry run\) with concurrency=\d+/);
  });

  it('selects one deterministic group without changing package order', () => {
    const root = tempRoot();
    for (const id of ['a-demo', 'b-demo', 'c-demo', 'd-demo', 'e-demo']) {
      const app = join(root, 'apps', 'bevy', id);
      mkdirSync(app, { recursive: true });
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({
          name: `@forgeax/bevy-${id}`,
          forgeax: {
            bevyExample: {
              name: id.replace('-', '_'),
              category: 'Animation',
              status: 'implemented',
            },
            smokeInvocation: `pnpm --filter @forgeax/bevy-${id} smoke`,
            metrics: { gate: { command: `pnpm --filter @forgeax/bevy-${id} smoke` } },
          },
        }),
      );
    }
    const result = run(root, 'smokes', '--group', '1', '--groups', '2', '--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('@forgeax/bevy-b-demo');
    expect(result.stdout).toContain('@forgeax/bevy-d-demo');
    expect(result.stdout).not.toContain('@forgeax/bevy-a-demo');
    expect(result.stdout).toContain('2/5 implemented Bevy demo smoke entries');
  });

  it('rejects a group outside the configured matrix', () => {
    const root = tempRoot();
    const result = run(root, 'smokes', '--group', '3', '--groups', '3', '--dry-run');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-group-invalid');
  });
});
