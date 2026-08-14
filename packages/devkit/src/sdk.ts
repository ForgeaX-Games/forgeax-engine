import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SdkPackage {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly sha256: string;
}

export interface SdkManifest {
  readonly schemaVersion: '1.0.0';
  readonly sdkVersion: string;
  readonly engineCommit: string;
  readonly requirements: {
    readonly node: string;
    readonly pnpm: string;
    readonly pnpmStoreFormat: string;
  };
  readonly capabilities: readonly string[];
  readonly packages: readonly SdkPackage[];
}

export interface SdkContext {
  readonly root: string;
  readonly manifest: SdkManifest;
  readonly store: string;
  readonly template: string;
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findSdkContext(): Promise<SdkContext | undefined> {
  const configured = process.env.FORGEAX_SDK_ROOT;
  let cursor = resolve(configured ?? dirname(fileURLToPath(import.meta.url)));
  for (;;) {
    const manifestPath = resolve(cursor, 'sdk-manifest.json');
    if (await readable(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SdkManifest;
      return {
        root: cursor,
        manifest,
        store: resolve(cursor, 'store', 'pnpm'),
        template: resolve(cursor, 'templates', 'game-default'),
      };
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}
