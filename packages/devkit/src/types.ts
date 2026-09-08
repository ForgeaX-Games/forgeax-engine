import type { GameProjectPluginEntry } from '@forgeax/engine-project';

export type ForgeaXCommand =
  | 'new'
  | 'init'
  | 'doctor'
  | 'test'
  | 'dev'
  | 'build'
  | 'package'
  | 'capture'
  | 'engine.status'
  | 'engine.use-local'
  | 'engine.unlink'
  | 'engine.doctor'
  | 'serve'
  | 'preview'
  | 'plugin.install'
  | 'plugin.uninstall'
  | 'skill.install'
  | 'skill.verify'
  | 'sdk.install'
  | 'asset.add'
  | 'asset.verify'
  | 'asset.inspect'
  | 'asset.list'
  | 'shader.check'
  | 'list'
  | 'describe'
  | 'run'
  | 'exec';

export interface CommandError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type CommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CommandError };

export interface CommandEnvelope<T = unknown> {
  readonly schemaVersion: '1.0.0';
  readonly command: ForgeaXCommand;
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: CommandError;
}

export interface ProjectFacts {
  readonly root: string;
  readonly id: string;
  readonly name: string;
  readonly entry: string;
  readonly bootstrapEntry?: string;
  readonly plugins: readonly GameProjectPluginEntry[];
  readonly physics?: '2d' | '3d';
  readonly defaultScene?: string;
  readonly assetRoots: readonly string[];
  readonly assetImporters?: readonly string[];
  readonly assetPublicDir?: string;
  readonly packageJson: Readonly<Record<string, unknown>>;
}

export interface ProjectCommandOptions {
  readonly root?: string;
  readonly json?: boolean;
  readonly port?: number;
}

export interface ProjectPortOptions {
  readonly port: number;
  readonly strictPort: boolean;
}

export function parseProjectPortOption(
  value: string | undefined,
  provided: boolean,
): CommandResult<number | undefined> {
  if (!provided) return { ok: true, value: undefined };
  if (value !== undefined && /^(0|[1-9]\d*)$/.test(value)) {
    const port = Number(value);
    if (Number.isSafeInteger(port) && port <= 65_535) return { ok: true, value: port };
  }
  return {
    ok: false,
    error: {
      code: 'cli-parse-error',
      expected: '--port to be 0 or an integer from 1 to 65535',
      hint: 'Omit --port for strict 5173, pass a positive port for a strict binding, or pass 0 for an OS-assigned port.',
      detail: { option: '--port', received: value ?? null },
    },
  };
}

export function resolveProjectPort(port: number | undefined): ProjectPortOptions {
  return { port: port ?? 5173, strictPort: port !== 0 };
}

export interface InitOptions extends ProjectCommandOptions {
  readonly dryRun?: boolean;
  readonly install?: boolean;
}

export interface NewOptions extends ProjectCommandOptions {
  readonly dryRun?: boolean;
  readonly template?: string;
}

export interface BuildOptions extends ProjectCommandOptions {
  readonly base?: string;
  readonly outDir?: string;
}

export interface PackageOptions extends ProjectCommandOptions {
  readonly output?: string;
}

export type CaptureBackend = 'auto' | 'software' | 'hardware';

export interface BrowserCaptureOptions extends ProjectCommandOptions {
  /** Prefer a rendering lane, or let the browser choose and report it. */
  readonly backend?: CaptureBackend;
  /** Backwards-compatible alias for `backend: 'software'`. */
  readonly software?: boolean;
  readonly output?: string;
  readonly browser?: string;
  readonly width?: number;
  readonly height?: number;
  readonly waitMs?: number;
  readonly requireUi?: boolean;
  readonly deterministic?: boolean;
  readonly headless?: boolean;
}

/** @deprecated Use BrowserCaptureOptions with `backend: 'software'`. */
export interface SoftwareCaptureOptions extends BrowserCaptureOptions {
  readonly software: true;
  readonly backend?: 'software';
}

export interface AssetAddOptions extends ProjectCommandOptions {
  readonly path: string;
  readonly dryRun?: boolean;
}

export interface AssetInspectOptions extends ProjectCommandOptions {
  readonly subject: string;
}

export interface ShaderCheckOptions extends ProjectCommandOptions {
  readonly path?: string;
}

export interface OperationCommandOptions extends ProjectCommandOptions {
  readonly id?: string;
  readonly args?: string;
  readonly input?: string;
  readonly program?: string;
}

export interface PluginInstallOptions extends ProjectCommandOptions {
  readonly id: string;
  readonly module: string;
  readonly realm?: 'host' | 'engine' | 'build';
  readonly dependency?: string;
  readonly dryRun?: boolean;
}

export interface PluginUninstallOptions extends ProjectCommandOptions {
  readonly id: string;
  readonly dependency?: string;
  readonly dryRun?: boolean;
}
