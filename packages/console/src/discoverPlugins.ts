// @forgeax/engine-console/src/discoverPlugins - kubectl 4th-path plugin
// discovery (feat-20260516-console-dependency-inversion §2.1 / §2.2 +
// research §Finding 1 / 2 + §Finding 4).
//
// Eager scan: invoked once on base bin startup. Walks every directory in
// `process.env.PATH`, picks files whose basename starts with the prefix
// `forgeax-engine-console-`, and reports them as `Plugin` records. The
// suffix after the prefix becomes the `subcommand` (multi-segment names are
// kept verbatim — `forgeax-engine-console-foo-bar` -> `foo-bar`; the base
// bin only matches whole tokens, so `foo bar` argv selects `foo` and
// passes `bar` as the first positional through the plugin).
//
// The scanner reports two health states:
//   - 'healthy'   : file exists + caller has +x bit (POSIX) / file has
//                   .cmd / .bat / .exe extension (Windows; per research
//                   §Finding 4 (d) + plan-strategy R-CLI-WIN-BAT)
//   - 'unhealthy' : file exists but is not executable (chmod 644 etc.) —
//                   --help still surfaces it with a `[unhealthy]` tag so
//                   AI users learn it exists; invoking it triggers
//                   InspectorError 'console-startup-failed' upstream
//                   (charter P3 explicit failure)
//
// The first occurrence on PATH wins; later duplicates of the same
// subcommand are ignored (mirror of the kubectl plugin de-dup rule). Hidden
// dotfiles, broken symlinks, and directory entries are skipped silently —
// PATH dirs may legitimately not exist (e.g. `~/bin` on a fresh runner) so
// `ENOENT` on `readdir` is not a fatal error.

import { accessSync, existsSync, constants as fsConstants, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_PREFIX = 'forgeax-engine-console-';

export type PluginHealth = 'healthy' | 'unhealthy';

export interface Plugin {
  /** subcommand the user types after the base bin (e.g. 'asset', 'gltf', 'foo-bar'). */
  readonly subcommand: string;
  /** absolute path to the plugin binary (first PATH match). */
  readonly path: string;
  /** 'unhealthy' = file present but not executable (POSIX) — surfaced as [unhealthy] in --help. */
  readonly health: PluginHealth;
}

/**
 * Test if `path` is callable as a binary. POSIX: stat says regular file +
 * `access(X_OK)` succeeds. Windows: any file extension is treated as
 * executable since `cmd.exe` resolves via `PATHEXT`; the actual spawn step
 * dispatches `.cmd`/`.bat` to `cmd.exe /c <bin>` per research §Finding 4
 * (d) — the discovery layer is permissive on Windows by design (a file
 * sitting on PATH is assumed callable; failures surface at exec time as
 * `console-startup-failed`).
 */
function isExecutable(path: string): boolean {
  try {
    const s = statSync(path);
    if (!s.isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Eager scan `process.env.PATH` for every `forgeax-engine-console-*` shim.
 * First-on-PATH wins; the resulting array is sorted alphabetically by
 * `subcommand` so --help output is stable across runs (charter P5
 * predictable surface). Pass `pathOverride` in tests to inject a
 * synthetic PATH (apps/inspector-demo/scripts/e2e-plugin-cli.mjs uses
 * this hook).
 */
export function discoverPlugins(pathOverride?: string): readonly Plugin[] {
  const raw = pathOverride ?? process.env.PATH ?? '';
  if (raw.length === 0) return [];
  const dirs = raw.split(delimiter).filter((d) => d.length > 0);
  const seen = new Map<string, Plugin>();

  for (const dir of dirs) {
    scanDir(dir, seen);
  }

  // Monorepo fallback: also scan <repo-root>/node_modules/.bin so pnpm
  // workspace plugin bins are discovered without PATH manipulation.
  const monorepoBin = findMonorepoNodeModulesBin();
  if (monorepoBin !== undefined) {
    scanDir(monorepoBin, seen);
  }

  return [...seen.values()].sort((a, b) => a.subcommand.localeCompare(b.subcommand));
}

function findMonorepoNodeModulesBin(): string | undefined {
  try {
    // Walk up from this source file to find the monorepo root (the dir
    // containing pnpm-workspace.yaml).
    const thisDir = dirname(fileURLToPath(import.meta.url));
    let cursor = resolve(thisDir);
    for (let i = 0; i < 10; i++) {
      const candidate = join(cursor, 'node_modules', '.bin');
      if (existsSync(join(cursor, 'pnpm-workspace.yaml')) && existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch {
    // Not running from a file path (e.g. bundled or eval'd) — skip.
  }
  return undefined;
}

function scanDir(dir: string, seen: Map<string, Plugin>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(PLUGIN_PREFIX)) continue;
    const subRaw = name.slice(PLUGIN_PREFIX.length);
    const sub = process.platform === 'win32' ? subRaw.replace(/\.(cmd|bat|exe)$/i, '') : subRaw;
    if (sub.length === 0) continue;
    if (seen.has(sub)) continue;
    const full = join(dir, name);
    const health: PluginHealth = isExecutable(full) ? 'healthy' : 'unhealthy';
    seen.set(sub, { subcommand: sub, path: full, health });
  }
}
