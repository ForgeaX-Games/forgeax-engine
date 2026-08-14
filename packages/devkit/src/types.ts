export type ForgeaXCommand =
  | 'new'
  | 'init'
  | 'doctor'
  | 'test'
  | 'dev'
  | 'build'
  | 'preview'
  | 'asset.add'
  | 'asset.verify'
  | 'asset.inspect'
  | 'asset.list'
  | 'shader.check';

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
  readonly physics?: '2d' | '3d';
  readonly defaultScene?: string;
  readonly assetRoots: readonly string[];
  readonly packageJson: Readonly<Record<string, unknown>>;
}

export interface ProjectCommandOptions {
  readonly root?: string;
  readonly json?: boolean;
}

export interface InitOptions extends ProjectCommandOptions {
  readonly dryRun?: boolean;
  readonly install?: boolean;
}

export interface NewOptions extends ProjectCommandOptions {
  readonly dryRun?: boolean;
}

export interface BuildOptions extends ProjectCommandOptions {
  readonly base?: string;
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
