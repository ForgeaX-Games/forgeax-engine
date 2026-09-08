import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SdkPackage {
  readonly name: string;
  readonly version: string;
  readonly root: string;
  readonly fileCount: number;
  readonly byteCount: number;
}

export interface SdkTemplate {
  readonly id: string;
  readonly root: string;
  readonly default: boolean;
}

export interface SdkSkill {
  readonly id: string;
  readonly root: string;
  readonly fileCount: number;
  readonly byteCount: number;
}

export interface SdkSourceWasm {
  readonly package: string;
  readonly root: string;
  readonly files: readonly string[];
}

export interface SdkResource {
  readonly id: string;
  readonly package: string;
  readonly sourceRoot: string;
  readonly packageRoot: string;
  readonly files: readonly string[];
}

export interface SdkTemplateResource {
  readonly id: string;
  readonly root: string;
  readonly files: readonly string[];
}

export interface SdkSource {
  readonly root: 'source/engine';
  readonly format: 'git-archive-public-snapshot';
  readonly excluded: readonly ['.gitmodules', 'forgeax-engine-assets'];
  readonly fileCount: number;
  readonly byteCount: number;
  readonly prebuiltWasm: readonly SdkSourceWasm[];
}

export interface SdkManifest {
  readonly schemaVersion: '1.6.0';
  readonly sdkVersion: string;
  readonly engineCommit: string;
  readonly requirements: {
    readonly node: string;
    readonly pnpm: string;
    readonly pnpmStoreFormat: string;
  };
  readonly capabilities: readonly string[];
  readonly packages: readonly SdkPackage[];
  readonly templates: readonly SdkTemplate[];
  readonly skills: readonly SdkSkill[];
  readonly resources: readonly SdkResource[];
  readonly templateResources: readonly SdkTemplateResource[];
  readonly source: SdkSource;
}

export interface SdkContext {
  readonly root: string;
  readonly manifest: SdkManifest;
  /**
   * The full ZIP carries an immutable offline store. The npm carrier is a
   * deliberately smaller online surface and omits it, so consumers fall back
   * to the registry when this path is absent.
   */
  readonly store?: string;
  readonly templates: ReadonlyMap<string, string>;
  readonly defaultTemplate: string;
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
      const templates = new Map(
        manifest.templates.map((template) => [template.id, resolve(cursor, template.root)]),
      );
      const defaultTemplate = manifest.templates.find((template) => template.default);
      if (defaultTemplate === undefined) throw new Error('sdk-default-template-missing');
      const store = resolve(cursor, 'store', 'pnpm');
      return {
        root: cursor,
        manifest,
        ...((await readable(store)) ? { store } : {}),
        templates,
        defaultTemplate: defaultTemplate.id,
      };
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}
