import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const auditScript = join(repoRoot, 'scripts', 'rhi-debug-fleet-audit.mjs');

describe('rhi-debug fleet audit', () => {
  it('derives capture facts from authored source, not generated dist output', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-rhi-debug-fleet-'));
    try {
      const app = join(fixture, 'apps', 'fixture');
      mkdirSync(join(app, 'src'), { recursive: true });
      mkdirSync(join(app, 'dist'), { recursive: true });
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({
          name: '@forgeax/fixture',
          scripts: { dev: 'vite', smoke: 'node scripts/smoke-dawn.mjs' },
          dependencies: { '@forgeax/engine-render': 'workspace:*' },
        }),
      );
      writeFileSync(join(app, 'src', 'main.mjs'), 'console.log("authored app");');
      writeFileSync(join(app, 'dist', 'main.mjs'), 'window.__forgeax.captureFrame(1);');

      const result = spawnSync(process.execPath, [auditScript, '--root', fixture, '--json'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.summary.rhiDebugCapture).toBeUndefined();
      expect(report.candidates[0].frontDoors).toEqual(['dev', 'dawnSmoke']);
      expect(report.candidates[0].oracle).toBe('none');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
