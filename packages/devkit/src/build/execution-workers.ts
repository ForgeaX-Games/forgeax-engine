import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, posix, resolve } from 'node:path';
import { PACK_PROGRAM_WORKER_SOURCE } from '@forgeax/engine-pack/runtime-browser';
import ts from 'typescript';
import { normalizePath, type Plugin, searchForWorkspaceRoot } from 'vite';
import { rewriteModuleSpecifiers } from './module-specifiers.js';
import { PACK_PROGRAM_ENGINE_IMPORTS, runtimeProgramIdentity } from './pack-program-imports.js';

const require = createRequire(import.meta.url);
export const engineCapabilityMeta = 'forgeax.engineCapability';
export interface EngineCapabilityMeta {
  readonly specifier: string;
  readonly reference?: string;
}

async function runtimeDependencyEntries(
  manifest: string,
  entries = new Set<string>(),
): Promise<string[]> {
  const entry = require.resolve(dirname(manifest));
  if (entries.has(entry)) return [...entries];
  entries.add(entry);
  const { dependencies = {} } = JSON.parse(await readFile(manifest, 'utf8')) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  for (const name of Object.keys(dependencies)) {
    if (!name.startsWith('@forgeax/engine-')) continue;
    await runtimeDependencyEntries(
      require.resolve(`${name}/package.json`, { paths: [dirname(manifest)] }),
      entries,
    );
  }
  return [...entries];
}

/** Keep runtime entries and URL-loaded project plugins in one module graph. */
export function executionWorkerEntries(
  runtimeImports: readonly string[] = PACK_PROGRAM_ENGINE_IMPORTS,
): Plugin {
  let building = false;
  let base = '/';
  let allowedFiles: string[] | undefined;
  const virtual = 'virtual:forgeax/pack-program-imports';
  const importTableMarker = '__forgeax_delivered_program_imports__';
  let runtimeIdentity = '';
  const externalPrefix = 'forgeax-host-import:';
  const facades = new Map<string, string>();
  const imports = new Map<string, string>();
  const admitDevelopmentModule = (id: string): void => {
    const file = id.split('?')[0];
    // URL-only runtime imports do not pass through Vite's static import
    // analysis. Admit only their resolved entry files, including installed
    // package realpaths outside the project; Vite owns subsequent imports.
    if (allowedFiles && file && isAbsolute(file) && !allowedFiles.includes(normalizePath(file))) {
      allowedFiles.push(normalizePath(file));
    }
  };
  const linkedEdges = new Map<string, { imports: string[]; dynamicImports: string[] }>();
  const owners = new Map<string, Promise<boolean>>();
  const engineOwner = (directory: string): Promise<boolean> => {
    const known = owners.get(directory);
    if (known) return known;
    const pending = (async () => {
      try {
        const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
        if (typeof manifest.name === 'string')
          return (
            manifest.name === '@forgeax/engine' || manifest.name.startsWith('@forgeax/engine-')
          );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      return dirname(directory) !== directory && engineOwner(dirname(directory));
    })();
    owners.set(directory, pending);
    return pending;
  };
  return {
    name: 'forgeax:execution-worker-entries',
    enforce: 'pre',
    configResolved(config) {
      base = config.base;
      allowedFiles = config.command === 'serve' ? config.server.fs.allow : undefined;
    },
    async resolveId(id, importer, options) {
      if (id === virtual) return `\0${virtual}`;
      if (id.startsWith(externalPrefix)) return { id, external: true };
      if (!importer || !/^@forgeax\/engine(?:$|[/-])/.test(id)) return null;
      const filename = importer.split('?')[0] ?? importer;
      if (isAbsolute(filename) && (await engineOwner(dirname(filename)))) return null;
      const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) this.error(`Engine capability unavailable: ${id}`);
      if (!building) {
        const key = externalPrefix + encodeURIComponent(id);
        const previous = imports.get(key);
        if (previous && previous !== resolved.id)
          this.error(`Engine capability resolves to multiple modules in one player: ${id}`);
        imports.set(key, resolved.id);
        admitDevelopmentModule(resolved.id);
        return {
          ...resolved,
          meta: {
            ...resolved.meta,
            [engineCapabilityMeta]: { specifier: id } satisfies EngineCapabilityMeta,
          },
        };
      }
      let reference = facades.get(resolved.id);
      if (!reference) {
        reference = this.emitFile({ type: 'chunk', id: resolved.id, preserveSignature: 'strict' });
        facades.set(resolved.id, reference);
      }
      const external = externalPrefix + encodeURIComponent(id);
      const previous = imports.get(external);
      if (previous && previous !== reference)
        this.error(`Engine capability resolves to multiple modules in one player: ${id}`);
      imports.set(external, reference);
      return {
        id: external,
        external: true,
        meta: {
          [engineCapabilityMeta]: { specifier: id, reference } satisfies EngineCapabilityMeta,
        },
      };
    },
    async load(id) {
      if (id !== `\0${virtual}`) return null;
      const engineManifest = await this.resolve('@forgeax/engine/package.json', undefined, {
        skipSelf: true,
      });
      if (!engineManifest || engineManifest.external)
        this.error('Engine manifest unavailable from the Vite host');
      const identity = await runtimeProgramIdentity(engineManifest.id);
      runtimeIdentity = identity;
      for (const specifier of runtimeImports) {
        const resolved = await this.resolve(specifier, undefined, { skipSelf: true });
        if (!resolved || resolved.external)
          this.error(`Runtime program import unavailable: ${specifier}`);
        let reference = facades.get(resolved.id);
        if (building && !reference) {
          reference = this.emitFile({
            type: 'chunk',
            id: resolved.id,
            preserveSignature: 'strict',
          });
          facades.set(resolved.id, reference);
        }
        if (building && reference) {
          const external = externalPrefix + encodeURIComponent(specifier);
          const previous = imports.get(external);
          if (previous && previous !== reference)
            this.error(
              `Engine capability resolves to multiple modules in one player: ${specifier}`,
            );
          imports.set(external, reference);
        }
        if (!building) {
          const key = externalPrefix + encodeURIComponent(specifier);
          const previous = imports.get(key);
          if (previous && previous !== resolved.id)
            this.error(
              `Engine capability resolves to multiple modules in one player: ${specifier}`,
            );
          imports.set(key, resolved.id);
          admitDevelopmentModule(resolved.id);
        }
      }
      return building
        ? `export default Object.freeze(${JSON.stringify(importTableMarker)});`
        : `export default { ${[...imports]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(
              ([key, id]) =>
                `${JSON.stringify(decodeURIComponent(key.slice(externalPrefix.length)))}: { identity: ${JSON.stringify(identity)}, url: new URL(${JSON.stringify(`${base}@fs${id}`)}, globalThis.location.origin).href }`,
            )
            .join(',')} };`;
    },
    renderChunk(code, chunk) {
      if (code.includes(importTableMarker)) {
        // At render time every project capability has resolved. The ordinary
        // runtime table can now include the exact delivered public facades.
        const fields = [...imports]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([external, reference]) => {
            const specifier = decodeURIComponent(external.slice(externalPrefix.length));
            const path = posix.relative(posix.dirname(chunk.fileName), this.getFileName(reference));
            return `${JSON.stringify(specifier)}: { identity: ${JSON.stringify(runtimeIdentity)}, url: new URL(${JSON.stringify(path.startsWith('./') || path.startsWith('../') ? path : `./${path}`)}, import.meta.url).href }`;
          });
        const file = ts.createSourceFile(
          chunk.fileName,
          code,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        const edits: { start: number; end: number }[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isStringLiteralLike(node) && node.text === importTableMarker)
            edits.push({ start: node.getStart(file), end: node.end });
          ts.forEachChild(node, visit);
        };
        visit(file);
        for (const edit of edits.reverse())
          code = `${code.slice(0, edit.start)}{ ${fields.join(',')} }${code.slice(edit.end)}`;
      }
      const edges = { imports: [] as string[], dynamicImports: [] as string[] };
      code = rewriteModuleSpecifiers(code, chunk.fileName, (specifier, kind) => {
        const reference = imports.get(specifier);
        if (!reference) return undefined;
        edges[kind === 'static' ? 'imports' : 'dynamicImports'].push(specifier);
        const relative = posix.relative(posix.dirname(chunk.fileName), this.getFileName(reference));
        return relative.startsWith('./') || relative.startsWith('../') ? relative : `./${relative}`;
      });
      linkedEdges.set(chunk.fileName, edges);
      return { code, map: null };
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== `${base}forgeax-pack-program-worker.js`) return next();
        response.setHeader('content-type', 'text/javascript');
        response.end(PACK_PROGRAM_WORKER_SOURCE);
      });
    },
    generateBundle(_options, bundle) {
      // Rolldown's renderChunk view has getter-only metadata. Update that
      // projection here; JS locators were already linked before hash finalization.
      const target = (id: string) => {
        const reference = imports.get(id);
        return reference ? this.getFileName(reference) : id;
      };
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const edges = linkedEdges.get(chunk.preliminaryFileName);
        chunk.imports = [...new Set([...chunk.imports, ...(edges?.imports ?? [])].map(target))];
        chunk.dynamicImports = [
          ...new Set([...chunk.dynamicImports, ...(edges?.dynamicImports ?? [])].map(target)),
        ];
      }
      this.emitFile({
        type: 'asset',
        fileName: 'forgeax-pack-program-worker.js',
        source: PACK_PROGRAM_WORKER_SOURCE,
      });
    },
    async config(config, environment) {
      building = environment.command === 'build';
      // The shared graph also runs in Workers. Vite's dynamic-import preload
      // helper accesses document, so emitted Worker imports must stay native.
      if (building) return { build: { modulePreload: false } };
      const root = config.root ?? process.cwd();
      const exclude = ['@forgeax/engine'];
      let manifest: string;
      try {
        manifest = require.resolve('@forgeax/engine/package.json', {
          paths: [root],
        });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw cause;
        // Source-only configuration probes need not install the public facade.
        return { optimizeDeps: { exclude } };
      }
      const { dependencies } = JSON.parse(await readFile(manifest, 'utf8')) as {
        readonly dependencies?: Readonly<Record<string, string>>;
      };
      // Worker runtime entries are served as native modules. Prebundling the
      // same Engine dependencies behind public plugin imports would create a
      // second set of component tokens and Scene module state in that Worker.
      // The umbrella manifest owns this package roster for pnpm and npm alike.
      exclude.push(
        ...Object.keys(dependencies ?? {}).filter((name) => name.startsWith('@forgeax/engine-')),
      );
      if (!exclude.includes('@forgeax/engine-app')) return { optimizeDeps: { exclude } };
      const appManifest = require.resolve('@forgeax/engine-app/package.json', {
        paths: [dirname(manifest)],
      });
      // Independent runs snapshot dependencies outside the project. Worker
      // constructor URLs do not receive Vite's imported-module file admission.
      // Admit their App-owned output directory, not the surrounding snapshot.
      return {
        optimizeDeps: {
          exclude,
          // Excluded Engine modules keep their identity, but their dependencies
          // still need discovery before the first page starts using them.
          entries: [
            '**/*.html',
            'execution-bootstrap.ts',
            ...(await runtimeDependencyEntries(appManifest)),
          ],
        },
        server: {
          fs: {
            allow: [
              ...(config.server?.fs?.allow === undefined ? [searchForWorkspaceRoot(root)] : []),
              resolve(dirname(appManifest), 'dist'),
            ],
          },
        },
      };
    },
    async transform(code, id) {
      if (!building) return null;
      // These are the three App-owned literal constructor sites. Let Rollup
      // emit ordinary entries before Vite creates isolated Worker bundles;
      // otherwise a later bootstrap import evaluates Engine singletons twice
      // in the same realm (components, schedules and scene instance state).
      const pattern =
        /new Worker\(\s*new URL\(\s*(['"])(\.\/(?:engine|render|kernel)-worker-runtime\.mjs)\1,\s*import\.meta\.url\s*\)/g;
      const matches = [...code.matchAll(pattern)];
      if (matches.length === 0) return null;
      let output = code;
      for (const match of matches.reverse()) {
        const source = match[2];
        if (source === undefined || match.index === undefined) continue;
        const resolved = await this.resolve(source, id, { skipSelf: true });
        if (resolved === null) this.error(`Cannot resolve execution Worker ${source} from ${id}`);
        const reference = this.emitFile({
          type: 'chunk',
          id: resolved.id,
          name: basename(source, '.mjs'),
          preserveSignature: 'strict',
        });
        output =
          output.slice(0, match.index) +
          `new Worker(import.meta.ROLLUP_FILE_URL_${reference}` +
          output.slice(match.index + match[0].length);
      }
      return { code: output, map: null };
    },
  };
}
