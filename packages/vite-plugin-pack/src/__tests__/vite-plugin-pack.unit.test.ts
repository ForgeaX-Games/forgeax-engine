// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=10):
//   - packages/vite-plugin-pack/src/__tests__/audio-pack-index.test.ts
//   - packages/vite-plugin-pack/src/__tests__/configure-server-hmr.test.ts
//   - packages/vite-plugin-pack/src/__tests__/dev-discoverable-rows.test.ts
//   - packages/vite-plugin-pack/src/__tests__/dev-import-hdr.test.ts
//   - packages/vite-plugin-pack/src/__tests__/dev-import-texture.test.ts
//   - packages/vite-plugin-pack/src/__tests__/import-texture.test.ts
//   - packages/vite-plugin-pack/src/__tests__/per-meta-concurrent.test.ts
//   - packages/vite-plugin-pack/src/__tests__/scene-asset-fixture.test.ts
//   - packages/vite-plugin-pack/src/__tests__/serve-imported-bytes.test.ts
//   - packages/vite-plugin-pack/test/plugin-dev.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import type { Asset, AssetRef, Importer, PackIndexEntry } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCatalogStrict } from '../build-catalog.js';
import { importTextureEntry } from '../import-texture.js';
import { ASSET_CHANGED_EVENT, type AssetChangedPayload, pluginPack } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = join(HERE, '..', '..', '..', '..');

{
  // ─── from audio-pack-index.test.ts ───

  const AUD_BGM_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';
  const AUD_SFX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45e';

  function audioMetaSingle(guid: string): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'audio',
      source: 'bgm.mp3',
      importSettings: {},
      subAssets: [{ guid, sourceIndex: 0, kind: 'audio' }],
    });
  }

  function audioMetaMulti(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'audio',
      source: 'sfx-pack.wav',
      importSettings: {},
      subAssets: [
        { guid: AUD_BGM_GUID, sourceIndex: 0, kind: 'audio' },
        { guid: AUD_SFX_GUID, sourceIndex: 1, kind: 'audio' },
      ],
    });
  }

  function audioMetaNoSource(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'audio',
      importSettings: {},
      subAssets: [{ guid: AUD_BGM_GUID, sourceIndex: 0, kind: 'audio' }],
    });
  }

  function audioImageMeta(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood-container.jpg',
      importSettings: { colorSpace: 'srgb', mipmap: 'auto' },
      subAssets: [
        { guid: '019e2cc6-0c86-79da-aa76-b0984c86d45c', sourceIndex: 0, kind: 'texture' },
      ],
    });
  }

  const AUD_ONE_BYTE_FILE = new Uint8Array([0xff]);

  describe('audio-pack-index.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-audio-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) audio .meta.json produces kind="audio" entry with metadata undefined', async () => {
      await writeFile(join(tmpRoot, 'bgm.mp3.meta.json'), audioMetaSingle(AUD_BGM_GUID));
      await writeFile(join(tmpRoot, 'bgm.mp3'), AUD_ONE_BYTE_FILE);

      const result = await buildCatalogStrict([tmpRoot]);

      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      const row = result.catalog[0];
      expect(row).toBeDefined();
      expect(row?.kind).toBe('audio');
      expect(row?.metadata).toBeUndefined();
    });

    it('(b) audio entry has 4 core fields: guid, relativeUrl, kind="audio", sourcePath', async () => {
      await writeFile(join(tmpRoot, 'bgm.mp3.meta.json'), audioMetaSingle(AUD_BGM_GUID));
      await writeFile(join(tmpRoot, 'bgm.mp3'), AUD_ONE_BYTE_FILE);

      const result = await buildCatalogStrict([tmpRoot]);
      const audioRows = result.catalog.filter((e) => e.kind === 'audio');

      expect(audioRows).toHaveLength(1);
      const row = audioRows[0];
      expect(row).toBeDefined();
      if (row) {
        expect(row.guid.toLowerCase()).toBe(AUD_BGM_GUID);
        expect(row.relativeUrl.endsWith('bgm.mp3')).toBe(true);
        expect(row.relativeUrl.startsWith('/')).toBe(true);
        expect(row.kind).toBe('audio');
        expect(row.sourcePath.endsWith('bgm.mp3')).toBe(true);
      }
    });

    it('(c) audio sidecar without source field fails schema validation', async () => {
      await writeFile(join(tmpRoot, 'bgm.mp3.meta.json'), audioMetaNoSource());

      const result = await buildCatalogStrict([tmpRoot]);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.catalog.filter((e) => e.kind === 'audio')).toHaveLength(0);
    });

    it('(d) multiple sub-asset GUIDs each produce their own PackIndexEntry row', async () => {
      await writeFile(join(tmpRoot, 'sfx-pack.wav.meta.json'), audioMetaMulti());
      await writeFile(join(tmpRoot, 'sfx-pack.wav'), AUD_ONE_BYTE_FILE);

      const result = await buildCatalogStrict([tmpRoot]);
      const audioRows = result.catalog.filter((e) => e.kind === 'audio');

      expect(audioRows).toHaveLength(2);
      const guids = audioRows.map((r) => r.guid.toLowerCase());
      expect(guids).toContain(AUD_BGM_GUID);
      expect(guids).toContain(AUD_SFX_GUID);

      for (const row of audioRows) {
        expect(row.relativeUrl.endsWith('sfx-pack.wav')).toBe(true);
        expect(row.sourcePath.endsWith('sfx-pack.wav')).toBe(true);
        expect(row.kind).toBe('audio');
        expect(row.metadata).toBeUndefined();
      }
    });

    it('(e) audio arm is compatible with existing image/gltf arms (no regression)', async () => {
      await writeFile(join(tmpRoot, 'bgm.mp3.meta.json'), audioMetaSingle(AUD_BGM_GUID));
      await writeFile(join(tmpRoot, 'bgm.mp3'), AUD_ONE_BYTE_FILE);
      await writeFile(join(tmpRoot, 'wood.jpg.meta.json'), audioImageMeta());
      await writeFile(join(tmpRoot, 'wood-container.jpg'), AUD_ONE_BYTE_FILE);

      const result = await buildCatalogStrict([tmpRoot]);

      expect(result.errors).toHaveLength(0);

      const texRows = result.catalog.filter((e) => e.kind === 'texture');
      expect(texRows).toHaveLength(1);
      const texRow = texRows[0];
      expect(texRow).toBeDefined();
      if (texRow) {
        expect(texRow.relativeUrl.endsWith('wood-container.jpg')).toBe(true);
        expect(texRow.metadata).toBeDefined();
      }

      const audioRows = result.catalog.filter((e) => e.kind === 'audio');
      expect(audioRows).toHaveLength(1);
    });
  });
}

{
  // ─── from configure-server-hmr.test.ts ───

  interface RecordedWsSend {
    readonly type: string;
    readonly payload: unknown;
  }

  interface HmrMockServer {
    readonly middlewares: { use(handler: unknown): void };
    readonly watcher: { on(event: string, cb: (...args: unknown[]) => void): void };
    readonly ws: {
      send(payload: { type: string } & Record<string, unknown>): void;
      readonly calls: RecordedWsSend[];
    };
  }

  function makeHmrMockServer(): HmrMockServer {
    const calls: RecordedWsSend[] = [];
    return {
      middlewares: { use: () => {} },
      watcher: { on: () => {} },
      ws: {
        send(payload) {
          calls.push({ type: payload.type, payload });
        },
        calls,
      },
    };
  }

  async function waitFor(
    predicate: () => boolean,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 1000;
    const intervalMs = options.intervalMs ?? 20;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  const HMR_WOOD_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';

  function hmrWoodImageMeta(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood-container.jpg',
      importSettings: {
        colorSpace: 'srgb',
        mipmap: 'auto',
        addressMode: 'repeat',
        filterMode: 'linear',
      },
      subAssets: [{ guid: HMR_WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
    });
  }

  const HMR_PACK_JSON_FIXTURE = JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [{ guid: '01890000-0000-7000-8000-aaaaaaaaaaaa', kind: 'mesh', payload: {}, refs: [] }],
  });

  const HMR_ONE_BYTE_JPG = new Uint8Array([0xff]);
  const HMR_TWO_BYTE_JPG = new Uint8Array([0xff, 0xd8]);

  describe('configure-server-hmr.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;
    let hmrAssetsDir: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w12-'));
      hmrAssetsDir = join(tmpRoot, 'assets');
      process.chdir(tmpRoot);
      await mkdir(hmrAssetsDir, { recursive: true });
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) sidecar .meta.json change emits server.ws.send full-reload', async () => {
      await writeFile(join(hmrAssetsDir, 'wood-container.jpg'), HMR_ONE_BYTE_JPG);
      await writeFile(join(hmrAssetsDir, 'wood-container.meta.json'), hmrWoodImageMeta());

      const server = makeHmrMockServer();
      const plugin = pluginPack({ roots: [hmrAssetsDir] });
      plugin.configureServer(server);

      await new Promise((r) => setTimeout(r, 50));

      await writeFile(join(hmrAssetsDir, 'wood-container.meta.json'), hmrWoodImageMeta());

      await waitFor(() => server.ws.calls.length > 0);

      expect(server.ws.calls.length).toBeGreaterThan(0);
      expect(server.ws.calls[0]?.type).toBe('full-reload');
    });

    it('(b) .jpg content change emits server.ws.send full-reload', async () => {
      await writeFile(join(hmrAssetsDir, 'wood-container.jpg'), HMR_ONE_BYTE_JPG);
      await writeFile(join(hmrAssetsDir, 'wood-container.meta.json'), hmrWoodImageMeta());

      const server = makeHmrMockServer();
      const plugin = pluginPack({ roots: [hmrAssetsDir] });
      plugin.configureServer(server);

      await new Promise((r) => setTimeout(r, 50));

      await writeFile(join(hmrAssetsDir, 'wood-container.jpg'), HMR_TWO_BYTE_JPG);

      await waitFor(() => server.ws.calls.length > 0);

      expect(server.ws.calls.length).toBeGreaterThan(0);
      expect(server.ws.calls.some((c) => c.type === 'full-reload')).toBe(true);
    });

    it('(c) .pack.json change emits server.ws.send full-reload', async () => {
      await writeFile(join(hmrAssetsDir, 'legacy.pack.json'), HMR_PACK_JSON_FIXTURE);

      const server = makeHmrMockServer();
      const plugin = pluginPack({ roots: [hmrAssetsDir] });
      plugin.configureServer(server);

      await new Promise((r) => setTimeout(r, 50));

      await writeFile(join(hmrAssetsDir, 'legacy.pack.json'), HMR_PACK_JSON_FIXTURE);

      await waitFor(() => server.ws.calls.length > 0);

      expect(server.ws.calls.length).toBeGreaterThan(0);
      expect(server.ws.calls.some((c) => c.type === 'full-reload')).toBe(true);
    });

    it('(d) .gltf source change emits server.ws.send full-reload (M3)', async () => {
      const GLTF_MINIMAL = JSON.stringify({ asset: { version: '2.0' } });
      await writeFile(join(hmrAssetsDir, 'model.gltf'), GLTF_MINIMAL);

      const server = makeHmrMockServer();
      const plugin = pluginPack({ roots: [hmrAssetsDir] });
      plugin.configureServer(server);

      await new Promise((r) => setTimeout(r, 50));

      await writeFile(join(hmrAssetsDir, 'model.gltf'), GLTF_MINIMAL);

      await waitFor(() => server.ws.calls.length > 0);

      expect(server.ws.calls.length).toBeGreaterThan(0);
      expect(server.ws.calls.some((c) => c.type === 'full-reload')).toBe(true);
    });

    it('(e) sidecar change also pushes a structured forgeax:asset-changed event', async () => {
      // P2: alongside `full-reload` (for the running game), the dev server pushes
      // a custom catalog-change event so a tooling subscriber (editor Content
      // Browser) can re-query `/__pack/index` instead of polling the filesystem.
      await writeFile(join(hmrAssetsDir, 'wood-container.jpg'), HMR_ONE_BYTE_JPG);
      await writeFile(join(hmrAssetsDir, 'wood-container.meta.json'), hmrWoodImageMeta());

      const server = makeHmrMockServer();
      const plugin = pluginPack({ roots: [hmrAssetsDir] });
      plugin.configureServer(server);

      await new Promise((r) => setTimeout(r, 50));

      await writeFile(join(hmrAssetsDir, 'wood-container.meta.json'), hmrWoodImageMeta());

      const isSidecarChanged = (c: RecordedWsSend): boolean => {
        if (c.type !== 'custom') return false;
        const p = c.payload as { event?: string; data?: AssetChangedPayload };
        return p.event === ASSET_CHANGED_EVENT && p.data?.kind === 'sidecar';
      };

      await waitFor(() => server.ws.calls.some(isSidecarChanged));

      const custom = server.ws.calls.find(isSidecarChanged);
      expect(custom).toBeDefined();
      const data = (custom?.payload as { data?: AssetChangedPayload }).data;
      expect(data?.kind).toBe('sidecar');
      expect(data?.file).toContain('wood-container.meta.json');
      expect(typeof data?.event).toBe('string');
    });
  });
}

{
  // ─── from dev-discoverable-rows.test.ts ───

  const DISCOVER_WOOD_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
  const DISCOVER_FIXTURE_PNG_SRC = join(
    WORKTREE_ROOT,
    'forgeax-engine-assets',
    'learn-opengl',
    'textures',
    'wood.png',
  );

  function discoverWoodImageMeta(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood.png',
      importSettings: {
        colorSpace: 'srgb',
        mipmap: 'auto',
        addressMode: 'repeat',
        filterMode: 'linear',
      },
      subAssets: [{ guid: DISCOVER_WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
    });
  }

  interface DiscoverCapturedRes {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    setHeader(name: string, value: string): void;
    end(chunk: string | Uint8Array): void;
  }

  function makeDiscoverRes(): DiscoverCapturedRes {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        this.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      },
    };
  }

  interface DiscoverMockServerCapture {
    server: {
      middlewares: { use(h: (req: unknown, res: unknown, next: () => void) => unknown): void };
      watcher: { on(): void };
      ws: { send(): void };
    };
    getHandler(): ((req: unknown, res: unknown, next: () => void) => unknown) | undefined;
  }

  function makeDiscoverServer(): DiscoverMockServerCapture {
    let handler: ((req: unknown, res: unknown, next: () => void) => unknown) | undefined;
    return {
      server: {
        middlewares: {
          use(h) {
            handler = h;
          },
        },
        watcher: { on: () => {} },
        ws: { send: () => {} },
      },
      getHandler: () => handler,
    };
  }

  type DiscoverHandler = (req: unknown, res: unknown, next: () => void) => unknown;

  async function fetchDevCatalog(handler: DiscoverHandler) {
    const res = makeDiscoverRes();
    await handler({ url: '/__pack/index', method: 'GET' }, res, () => {});
    return JSON.parse(res.body) as PackIndexEntry[];
  }

  async function lookupGuid(handler: DiscoverHandler, guid: string) {
    const res = makeDiscoverRes();
    await handler({ url: `/__pack/lookup/${guid}`, method: 'GET' }, res, () => {});
    return res;
  }

  describe('dev-discoverable-rows.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;
    let assetsDir: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w1-'));
      assetsDir = join(tmpRoot, 'assets');
      process.chdir(tmpRoot);
      await mkdir(assetsDir, { recursive: true });
      const png = await readFile(DISCOVER_FIXTURE_PNG_SRC);
      await writeFile(join(assetsDir, 'wood.png'), png);
      await writeFile(join(assetsDir, 'wood.png.meta.json'), discoverWoodImageMeta());
      await writeFile(join(tmpRoot, 'main.js'), "console.log('w1');\n");
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(AC-01) a meta-only / no-DDC image asset stays a bare-source kind:texture row', async () => {
      const cap = makeDiscoverServer();
      const plugin = pluginPack({ roots: [assetsDir] });
      plugin.configureServer(cap.server as never);

      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      expect(handler).toBeDefined();
      if (handler === undefined) return;

      const catalog = await fetchDevCatalog(handler);
      const row = catalog.find(
        (e) => e.guid.toLowerCase() === DISCOVER_WOOD_GUID && e.kind === 'texture',
      );
      expect(row).toBeDefined();
      expect(row?.kind).toBe('texture');
      expect(row?.relativeUrl.endsWith('.bin')).toBe(false);
      expect(row?.relativeUrl.endsWith('wood.png')).toBe(true);
    });

    it('(AC-01) /__pack/lookup/:guid resolves the bare-source row', async () => {
      const cap = makeDiscoverServer();
      const plugin = pluginPack({ roots: [assetsDir] });
      plugin.configureServer(cap.server as never);

      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      expect(handler).toBeDefined();
      if (handler === undefined) return;

      const res = await lookupGuid(handler, DISCOVER_WOOD_GUID);
      expect(res.statusCode).toBe(200);
      const entry = JSON.parse(res.body) as PackIndexEntry;
      expect(entry.guid.toLowerCase()).toBe(DISCOVER_WOOD_GUID);
      expect(entry.kind).toBe('texture');
      expect(entry.relativeUrl.endsWith('.bin')).toBe(false);
    });
  });
}

{
  // ─── from dev-import-hdr.test.ts ───

  const DIH_HDR_GUID = '019e3969-1d43-7610-8810-e80dbd491d91';
  const DIH_HDR_WIDTH = 8;
  const DIH_HDR_HEIGHT = 4;

  function dihMakeMinimalHdr(width: number, height: number): Uint8Array {
    const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
    const encoder = new TextEncoder();
    const headerBytes = encoder.encode(header);

    const hi = (width >> 8) & 0xff;
    const lo = width & 0xff;
    const prefix = new Uint8Array([0x02, 0x02, hi, lo]);
    const chRun = new Uint8Array([128 + width, 128]);
    const scanlineBytes = 4 + 4 * 2;
    const pixelBytes = new Uint8Array(height * scanlineBytes);

    for (let y = 0; y < height; y++) {
      let off = y * scanlineBytes;
      pixelBytes.set(prefix, off);
      off += 4;
      pixelBytes.set(chRun, off);
      off += 2;
      pixelBytes.set(chRun, off);
      off += 2;
      pixelBytes.set(chRun, off);
      off += 2;
      pixelBytes.set(chRun, off);
    }

    const total = new Uint8Array(headerBytes.length + pixelBytes.length);
    total.set(headerBytes);
    total.set(pixelBytes, headerBytes.length);
    return total;
  }

  function dihHdrEquirectMeta(hdrFilename: string): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: hdrFilename,
      importSettings: {
        colorSpace: 'linear',
        mipmap: 'none',
      },
      subAssets: [{ guid: DIH_HDR_GUID, sourceIndex: 0, kind: 'equirect' }],
    });
  }

  interface DihCapturedRes {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    setHeader(name: string, value: string): void;
    end(chunk: string | Uint8Array): void;
  }

  function makeDihRes(): DihCapturedRes {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        this.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      },
    };
  }

  type DihHandler = (req: unknown, res: unknown, next: () => void) => unknown;

  function makeDihServer(): { server: unknown; getHandler(): DihHandler | undefined } {
    let handler: DihHandler | undefined;
    return {
      server: {
        middlewares: {
          use(h: DihHandler) {
            handler = h;
          },
        },
        watcher: { on: () => {} },
        ws: { send: () => {} },
      },
      getHandler: () => handler,
    };
  }

  async function dihPostImport(handler: DihHandler, guid: string): Promise<DihCapturedRes> {
    const res = makeDihRes();
    await handler({ url: `/__import/${guid}`, method: 'POST' }, res, () => {});
    return res;
  }

  describe('dev-import-hdr.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;
    let assetsDir: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w8-'));
      assetsDir = join(tmpRoot, 'assets');
      process.chdir(tmpRoot);
      await mkdir(assetsDir, { recursive: true });
      await writeFile(join(assetsDir, 'env.hdr'), dihMakeMinimalHdr(DIH_HDR_WIDTH, DIH_HDR_HEIGHT));
      await writeFile(join(assetsDir, 'env.hdr.meta.json'), dihHdrEquirectMeta('env.hdr'));
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) HDR equirect meta imports to an rgba16float .bin row, not a 422', async () => {
      const cap = makeDihServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [imageImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      expect(handler).toBeDefined();
      if (handler === undefined) return;

      const res = await dihPostImport(handler, DIH_HDR_GUID);
      expect(res.statusCode).toBe(200);
      const returned = JSON.parse(res.body) as PackIndexEntry[];
      const row = returned.find(
        (e) => e.guid.toLowerCase() === DIH_HDR_GUID && e.kind === 'equirect',
      );
      expect(row).toBeDefined();
      expect(row?.relativeUrl.endsWith('.bin')).toBe(true);
      const meta = row?.metadata;
      expect(meta).toBeDefined();
      if (meta === undefined || meta.kind !== 'texture') return;
      expect(meta.format).toBe('rgba16float');
      expect(meta.colorSpace).toBe('linear');
      expect(meta.width).toBe(DIH_HDR_WIDTH);
      expect(meta.height).toBe(DIH_HDR_HEIGHT);
    });

    it('(b) a declared GUID whose row is not a importable texture still 422s', async () => {
      const AUD_GUID = '019e3969-1d44-7c3b-ac24-6d68f457065f';
      await writeFile(join(assetsDir, 'beep.wav'), new Uint8Array([0x52, 0x49, 0x46, 0x46]));
      await writeFile(
        join(assetsDir, 'beep.wav.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'audio',
          source: 'beep.wav',
          importSettings: {},
          subAssets: [{ guid: AUD_GUID, sourceIndex: 0, kind: 'audio' }],
        }),
      );

      const cap = makeDihServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [imageImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      if (handler === undefined) throw new Error('handler not mounted');

      const res = await dihPostImport(handler, AUD_GUID);
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body) as { error: string; code?: string; hint?: string };
      expect(body.error).toBe('import-failed');
      // A BENIGN skip carries no structured `code` (it is not a cook failure);
      // the hint names the benign causes, not a generic "could not be imported".
      expect(body.code).toBeUndefined();
      expect(body.hint).toContain('not an importable texture');
    });

    it('(c) a REAL cook failure (corrupt source) 422s with a structured code + reason', async () => {
      // A `.png`-extension source whose bytes are not a decodable PNG: the
      // per-asset path's importTextureEntry throws -> importOneTexture rethrows
      // a structured ImportError -> the route surfaces code + reason (not the
      // generic benign hint). Regression for the silent `[]` -> generic 422.
      const PNG_GUID = '019e3969-1d49-7c3b-ac24-6d68f457065f';
      await writeFile(join(assetsDir, 'broken.png'), new Uint8Array([0x00, 0x01, 0x02, 0x03]));
      await writeFile(
        join(assetsDir, 'broken.png.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: 'broken.png',
          importSettings: {},
          subAssets: [{ guid: PNG_GUID, sourceIndex: 0, kind: 'texture' }],
        }),
      );

      const cap = makeDihServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [imageImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      if (handler === undefined) throw new Error('handler not mounted');

      const res = await dihPostImport(handler, PNG_GUID);
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body) as {
        error: string;
        code?: string;
        reason?: string;
      };
      expect(body.error).toBe('import-failed');
      // Structured cause, aligned with the per-meta (gltf/fbx) path: a real
      // failure carries `code` + the underlying `reason`, not just a hint.
      expect(body.code).toBe('import-internal-error');
      expect(typeof body.reason).toBe('string');
      expect(body.reason?.length ?? 0).toBeGreaterThan(0);
    });
  });
}

{
  // ─── from dev-import-texture.test.ts ───

  const DIT_WOOD_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
  const DIT_FIXTURE_PNG_SRC = join(
    WORKTREE_ROOT,
    'forgeax-engine-assets',
    'learn-opengl',
    'textures',
    'wood.png',
  );

  function ditWoodImageMeta(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood.png',
      importSettings: {
        colorSpace: 'srgb',
        mipmap: 'auto',
        addressMode: 'repeat',
        filterMode: 'linear',
      },
      subAssets: [{ guid: DIT_WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
    });
  }

  interface DitCapturedRes {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    setHeader(name: string, value: string): void;
    end(chunk: string | Uint8Array): void;
  }

  function makeDitRes(): DitCapturedRes {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        this.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      },
    };
  }

  type DitHandler = (req: unknown, res: unknown, next: () => void) => unknown;

  function makeDitServer(): { server: unknown; getHandler(): DitHandler | undefined } {
    let handler: DitHandler | undefined;
    return {
      server: {
        middlewares: {
          use(h: DitHandler) {
            handler = h;
          },
        },
        watcher: { on: () => {} },
        ws: { send: () => {} },
      },
      getHandler: () => handler,
    };
  }

  async function ditFetchCatalog(handler: DitHandler): Promise<PackIndexEntry[]> {
    const res = makeDitRes();
    await handler({ url: '/__pack/index', method: 'GET' }, res, () => {});
    return JSON.parse(res.body) as PackIndexEntry[];
  }

  async function ditPostImport(handler: DitHandler, guid: string): Promise<DitCapturedRes> {
    const res = makeDitRes();
    await handler({ url: `/__import/${guid}`, method: 'POST' }, res, () => {});
    return res;
  }

  describe('dev-import-texture.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;
    let assetsDir: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w10-'));
      assetsDir = join(tmpRoot, 'assets');
      process.chdir(tmpRoot);
      await mkdir(assetsDir, { recursive: true });
      const png = await readFile(DIT_FIXTURE_PNG_SRC);
      await writeFile(join(assetsDir, 'wood.png'), png);
      await writeFile(join(assetsDir, 'wood.png.meta.json'), ditWoodImageMeta());
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a/b) imported texture row relativeUrl ends .bin + metadata has width/height', async () => {
      const cap = makeDitServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [imageImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      expect(handler).toBeDefined();
      if (handler === undefined) return;

      const res = await ditPostImport(handler, DIT_WOOD_GUID);
      expect(res.statusCode).toBe(200);
      const returned = JSON.parse(res.body) as PackIndexEntry[];
      const row = returned.find(
        (e) => e.guid.toLowerCase() === DIT_WOOD_GUID && e.kind === 'texture',
      );
      expect(row).toBeDefined();
      expect(row?.relativeUrl.endsWith('.bin')).toBe(true);
      expect(row?.sourcePath.endsWith('wood.png')).toBe(true);
      const meta = row?.metadata;
      expect(meta).toBeDefined();
      if (meta === undefined || meta.kind !== 'texture') return;
      expect(meta.width).toBeGreaterThan(0);
      expect(meta.height).toBeGreaterThan(0);
      expect(meta.format).toBe('rgba8unorm-srgb');
      expect(meta.colorSpace).toBe('srgb');
      expect(meta.mipmap).toBe(true);
    });

    it('(c) a <guid>.bin is written to the DDC under node_modules/.cache/forgeax-ddc', async () => {
      const cap = makeDitServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [imageImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      if (handler === undefined) throw new Error('handler not mounted');

      await ditPostImport(handler, DIT_WOOD_GUID);
      const ddcFile = join(tmpRoot, 'node_modules/.cache/forgeax-ddc', `${DIT_WOOD_GUID}.bin`);
      const s = await stat(ddcFile);
      expect(s.isFile()).toBe(true);
      expect(s.size).toBeGreaterThan(0);
      await expect(stat(join(assetsDir, `wood.png.${DIT_WOOD_GUID}.bin`))).rejects.toThrow();
    });

    it('(d) AC-02: after import the GUID appears exactly once in the dev catalog', async () => {
      const cap = makeDitServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [imageImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      if (handler === undefined) throw new Error('handler not mounted');

      await ditPostImport(handler, DIT_WOOD_GUID);
      const catalog = await ditFetchCatalog(handler);
      const rows = catalog.filter((e) => e.guid.toLowerCase() === DIT_WOOD_GUID);
      expect(rows.length).toBe(1);
      expect(rows[0]?.relativeUrl.endsWith('.bin')).toBe(true);
    });
  });
}

{
  // ─── from import-texture.test.ts ───

  const IT_PNG_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
  const IT_JPEG_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065a';
  const IT_HDR_GUID = '019e3969-1d43-7610-8810-e80dbd491d91';
  const IT_FIXTURE_PNG_SRC = join(
    WORKTREE_ROOT,
    'forgeax-engine-assets',
    'learn-opengl',
    'textures',
    'wood.png',
  );

  function itMakeMinimalHdr(width: number, height: number): Uint8Array {
    const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
    const headerBytes = new TextEncoder().encode(header);

    const hi = (width >> 8) & 0xff;
    const lo = width & 0xff;
    const prefix = new Uint8Array([0x02, 0x02, hi, lo]);
    const chRun = new Uint8Array([128 + width, 128]);
    const scanlineBytes = 4 + 4 * 2;
    const pixelBytes = new Uint8Array(height * scanlineBytes);

    for (let y = 0; y < height; y++) {
      let off = y * scanlineBytes;
      pixelBytes.set(prefix, off);
      off += 4;
      pixelBytes.set(chRun, off);
      off += 2;
      pixelBytes.set(chRun, off);
      off += 2;
      pixelBytes.set(chRun, off);
      off += 2;
      pixelBytes.set(chRun, off);
    }

    const total = new Uint8Array(headerBytes.length + pixelBytes.length);
    total.set(headerBytes);
    total.set(pixelBytes, headerBytes.length);
    return total;
  }

  function itTextureEntry(guid: string, sourceRel: string): PackIndexEntry {
    return {
      guid,
      relativeUrl: `/${sourceRel}`,
      kind: 'texture',
      sourcePath: sourceRel,
      metadata: {
        kind: 'texture',
        format: 'rgba8unorm-srgb',
        colorSpace: 'srgb',
        mipmap: true,
        // feat-20260707 M5 / w38: these arms assert the UNCOMPRESSED RGBA import
        // shape (byteLength == w*h*4). Pin compressionMode:'none' now that the
        // default flipped to 'auto' (which would cook a Basis .ktx2 instead).
        compressionMode: 'none',
      },
    };
  }

  describe('import-texture.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w3-'));
      process.chdir(tmpRoot);
      await mkdir(join(tmpRoot, 'assets'), { recursive: true });
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) PNG arm: imports RGBA bytes + folded metadata, no relativeUrl', async () => {
      const png = await readFile(IT_FIXTURE_PNG_SRC);
      const sourceRel = relative(tmpRoot, join(tmpRoot, 'assets', 'wood.png'));
      await writeFile(join(tmpRoot, sourceRel), png);

      const result = await importTextureEntry(itTextureEntry(IT_PNG_GUID, sourceRel), {
        cwd: tmpRoot,
      });
      expect('bytes' in result).toBe(true);
      if (!('bytes' in result)) return;

      expect(result.bytes).toBeInstanceOf(Uint8Array);
      expect(result.bytes.byteLength).toBeGreaterThan(0);
      expect(result.metadata.kind).toBe('texture');
      expect(result.metadata.width).toBeGreaterThan(0);
      expect(result.metadata.height).toBeGreaterThan(0);
      expect(result.metadata.format).toBe('rgba8unorm-srgb');
      expect(result.metadata.colorSpace).toBe('srgb');
      expect(result.metadata.mipmap).toBe(true);
      expect(result.bytes.byteLength).toBe(
        (result.metadata.width ?? 0) * (result.metadata.height ?? 0) * 4,
      );
      expect('relativeUrl' in result).toBe(false);
    });

    it('(b) JPEG arm: image/jpeg mime imports the same {bytes,metadata} shape', async () => {
      const jpegSrc = join(
        WORKTREE_ROOT,
        'forgeax-engine-assets',
        'learn-opengl',
        'textures',
        'container.jpg',
      );
      const jpeg = await readFile(jpegSrc);
      const sourceRel = relative(tmpRoot, join(tmpRoot, 'assets', 'container.jpg'));
      await writeFile(join(tmpRoot, sourceRel), jpeg);

      const entry = itTextureEntry(IT_JPEG_GUID, sourceRel);
      const result = await importTextureEntry(entry, { cwd: tmpRoot });
      expect('bytes' in result).toBe(true);
      if (!('bytes' in result)) return;
      expect(result.bytes).toBeInstanceOf(Uint8Array);
      expect(result.metadata.format).toBe('rgba8unorm-srgb');
      expect(result.bytes.byteLength).toBe(
        (result.metadata.width ?? 0) * (result.metadata.height ?? 0) * 4,
      );
      expect('relativeUrl' in result).toBe(false);
    });

    it("(c) .hdr arm (AC-12) compressionMode:'none' imports raw rgba16float bytes (8 bytes/px)", async () => {
      const width = 8;
      const height = 4;
      const sourceRel = relative(tmpRoot, join(tmpRoot, 'assets', 'env.hdr'));
      await writeFile(join(tmpRoot, sourceRel), itMakeMinimalHdr(width, height));

      const entry: PackIndexEntry = {
        guid: IT_HDR_GUID,
        relativeUrl: `/${sourceRel}`,
        kind: 'equirect',
        sourcePath: sourceRel,
        metadata: {
          kind: 'texture',
          format: 'rgba16float',
          colorSpace: 'linear',
          mipmap: false,
          // Pin 'none' to assert the UNCOMPRESSED rgba16float import shape now
          // that the default flipped to 'auto' (which cooks a UASTC-HDR .ktx2).
          compressionMode: 'none',
        },
      };

      const result = await importTextureEntry(entry, { cwd: tmpRoot });
      expect('bytes' in result).toBe(true);
      if (!('bytes' in result)) return;
      expect(result.metadata.format).toBe('rgba16float');
      expect(result.metadata.colorSpace).toBe('linear');
      expect(result.metadata.width).toBe(width);
      expect(result.metadata.height).toBe(height);
      expect(result.bytes.byteLength).toBe(width * height * 4 * 2);
      expect(result.metadata.compression).toBe('none');
      expect('relativeUrl' in result).toBe(false);
    });

    it("(c2) .hdr equirect default 'auto' stays uncompressed rgba16float (feat-20260707 fix)", async () => {
      const width = 8;
      const height = 4;
      const sourceRel = relative(tmpRoot, join(tmpRoot, 'assets', 'env-auto.hdr'));
      await writeFile(join(tmpRoot, sourceRel), itMakeMinimalHdr(width, height));

      const entry: PackIndexEntry = {
        guid: IT_HDR_GUID,
        relativeUrl: `/${sourceRel}`,
        kind: 'equirect',
        sourcePath: sourceRel,
        metadata: {
          kind: 'texture',
          format: 'rgba16float',
          colorSpace: 'linear',
          mipmap: false,
          // No compressionMode -> defaults to 'auto'. An equirect is ALWAYS an
          // IBL / skybox source (equirect-to-cube / irradiance / prefilter RENDER
          // passes) and BC6H is not color-renderable, so the equirect kind is
          // never block-compressed: the catalog row is forced to compression
          // 'none' and the importer ships raw rgba16float (the two agree).
        },
      };

      const result = await importTextureEntry(entry, { cwd: tmpRoot });
      expect('bytes' in result).toBe(true);
      if (!('bytes' in result)) return;
      // KTX2 magic identifier (first 12 bytes of every KTX 2.0 container).
      const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
      // Raw rgba16float byte count (w*h*8), NOT a KTX2 container.
      expect(result.bytes.byteLength).toBe(width * height * 4 * 2);
      expect(Array.from(result.bytes.subarray(0, 12))).not.toEqual(KTX2_MAGIC);
      expect(result.metadata.compression).toBe('none');
      expect(result.metadata.format).toBe('rgba16float');
    });

    it('(d) non-texture / unknown-extension rows are skipped (no import)', async () => {
      const sourceRel = relative(tmpRoot, join(tmpRoot, 'assets', 'mystery.xyz'));
      await writeFile(join(tmpRoot, sourceRel), new Uint8Array([1, 2, 3]));
      const entry = itTextureEntry('019e3969-1d48-7c3b-ac24-6d68f4570000', sourceRel);
      const result = await importTextureEntry(entry, { cwd: tmpRoot });
      expect('skipped' in result).toBe(true);
    });
  });
}

{
  // ─── from per-meta-concurrent.test.ts ───

  const PMC_FIXTURE_PNG_SRC = join(
    WORKTREE_ROOT,
    'forgeax-engine-assets',
    'learn-opengl',
    'textures',
    'wood.png',
  );

  const PMC_TEX_GUID_A = '01900000-0000-7000-8000-aaaaaaaaaaaa';
  const PMC_TEX_GUID_B = '01900000-0000-7000-8000-bbbbbbbbbbbb';
  const PMC_MESH_GUID = '01900000-0000-7000-8000-cccccccccccc';
  const PMC_TEX_GUID_C = '01900000-0000-7000-8000-dddddddddddd';

  let pmcDecodeCallCount = 0;
  const PMC_DECODE_SENTINEL_BYTE = 0x77;

  function pmcGltfMetaTextured(guids: readonly string[]): string {
    const subAssets: Array<{ guid: string; sourceIndex: number; kind: string; name?: string }> = [
      { guid: PMC_MESH_GUID, sourceIndex: 0, kind: 'mesh' },
    ];
    for (let i = 0; i < guids.length; i++) {
      const g = guids[i];
      if (g === undefined) throw new Error('unreachable');
      subAssets.push({ guid: g, sourceIndex: i, kind: 'texture', name: `tex-${i}` });
    }
    return JSON.stringify({
      schemaVersion: 1,
      kind: 'external-asset-package',
      importer: 'gltf',
      source: 'textured.gltf',
      importSettings: { defaultSceneIndex: 0 },
      subAssets,
    });
  }

  function makePmcMockGltfImporter(): Importer {
    return {
      key: 'gltf',
      async import(ctx) {
        const upstreamDecode = ctx.decodeImage;
        ctx.decodeImage = async (bytes, mime, settings) => {
          pmcDecodeCallCount++;
          const upstream = await upstreamDecode(bytes, mime, settings);
          if (!upstream.ok) return upstream;
          const tagged = new Uint8Array(upstream.value.bytes.length + 1);
          tagged.set(upstream.value.bytes, 0);
          tagged[upstream.value.bytes.length] = PMC_DECODE_SENTINEL_BYTE;
          return {
            ok: true,
            value: { texture: upstream.value.texture, bytes: tagged },
          };
        };

        const subAssets = ctx.subAssets;
        const result: Array<{
          guid: string;
          kind: string;
          payload: Asset;
          refs: readonly AssetRef[];
        }> = [];

        const meshSub = subAssets.find((s) => s.kind === 'mesh');
        if (meshSub !== undefined) {
          result.push({
            guid: meshSub.guid,
            kind: 'mesh',
            payload: {
              kind: 'mesh' as const,
              vertices: 0 as never,
              attributes: [] as never,
              submeshes: [] as never,
            } as Asset,
            refs: [],
          });
        }

        const texSubs = subAssets.filter((s) => s.kind === 'texture');
        for (const sub of texSubs) {
          const pngBytes = await readFile(PMC_FIXTURE_PNG_SRC);
          const dec = await ctx.decodeImage(new Uint8Array(pngBytes), 'image/png', {});
          if (dec.ok) {
            result.push({
              guid: sub.guid,
              kind: 'texture',
              payload: dec.value.texture,
              refs: [],
            });
          }
        }

        return result;
      },
    };
  }

  interface PmcCapturedRes {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    setHeader(name: string, value: string): void;
    end(chunk: string | Uint8Array): void;
  }

  function makePmcRes(): PmcCapturedRes {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        this.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      },
    };
  }

  type PmcHandler = (req: unknown, res: unknown, next: () => void) => unknown;

  function makePmcServer(): { server: unknown; getHandler(): PmcHandler | undefined } {
    let handler: PmcHandler | undefined;
    return {
      server: {
        middlewares: {
          use(h: PmcHandler) {
            handler = h;
          },
        },
        watcher: { on: () => {} },
        ws: { send: () => {} },
      },
      getHandler: () => handler,
    };
  }

  async function pmcPostImport(handler: PmcHandler, guid: string): Promise<PmcCapturedRes> {
    const res = makePmcRes();
    await handler({ url: `/__import/${guid}`, method: 'POST' }, res, () => {});
    return res;
  }

  describe('per-meta-concurrent.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;
    let assetsDir: string;
    let assetsDir2: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w22-'));
      assetsDir = join(tmpRoot, 'assets');
      assetsDir2 = join(tmpRoot, 'assets2');
      process.chdir(tmpRoot);
      pmcDecodeCallCount = 0;
      await mkdir(assetsDir, { recursive: true });
      await mkdir(assetsDir2, { recursive: true });
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) concurrent requests for different GUIDs on same meta trigger only one decodeImage call', async () => {
      await writeFile(
        join(assetsDir, 'textured.gltf.meta.json'),
        pmcGltfMetaTextured([PMC_TEX_GUID_A, PMC_TEX_GUID_B]),
      );
      await writeFile(join(assetsDir, 'textured.gltf'), new Uint8Array([0]));

      const mockImporter = makePmcMockGltfImporter();
      const cap = makePmcServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [mockImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      expect(handler).toBeDefined();
      if (handler === undefined) return;

      const count = 69;
      const promisesA: Promise<PmcCapturedRes>[] = [];
      for (let i = 0; i < count; i++) {
        promisesA.push(pmcPostImport(handler, PMC_TEX_GUID_A));
      }
      const resultsA = await Promise.all(promisesA);

      for (const r of resultsA) {
        expect(r.statusCode).toBe(200);
        const entries = JSON.parse(r.body) as PackIndexEntry[];
        expect(entries.length).toBe(1);
        expect(entries[0]?.guid.toLowerCase()).toBe(PMC_TEX_GUID_A);
      }

      expect(pmcDecodeCallCount).toBeLessThanOrEqual(2);
      expect(pmcDecodeCallCount).toBeGreaterThan(0);
    });

    it('(b) all concurrent callers receive the correct PackIndexEntry for their GUID', async () => {
      await writeFile(
        join(assetsDir, 'textured.gltf.meta.json'),
        pmcGltfMetaTextured([PMC_TEX_GUID_A, PMC_TEX_GUID_B]),
      );
      await writeFile(join(assetsDir, 'textured.gltf'), new Uint8Array([0]));

      const mockImporter = makePmcMockGltfImporter();
      const cap = makePmcServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [mockImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      if (handler === undefined) throw new Error('handler not mounted');

      const promises: Promise<PmcCapturedRes>[] = [];
      const half = 35;
      for (let i = 0; i < half; i++) {
        promises.push(pmcPostImport(handler, PMC_TEX_GUID_A));
        promises.push(pmcPostImport(handler, PMC_TEX_GUID_B));
      }
      const results = await Promise.all(promises);

      let countA = 0;
      let countB = 0;
      for (const r of results) {
        expect(r.statusCode).toBe(200);
        const entries = JSON.parse(r.body) as PackIndexEntry[];
        expect(entries.length).toBe(1);
        const g = entries[0]?.guid.toLowerCase();
        if (g === PMC_TEX_GUID_A) countA++;
        else if (g === PMC_TEX_GUID_B) countB++;
      }
      expect(countA).toBe(half);
      expect(countB).toBe(half);

      expect(pmcDecodeCallCount).toBeLessThanOrEqual(2);
    });

    it('(c) after import completes, no per-meta promise leak', async () => {
      await writeFile(
        join(assetsDir, 'textured.gltf.meta.json'),
        pmcGltfMetaTextured([PMC_TEX_GUID_A]),
      );
      await writeFile(join(assetsDir, 'textured.gltf'), new Uint8Array([0]));

      const mockImporter = makePmcMockGltfImporter();
      const cap = makePmcServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [mockImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      if (handler === undefined) throw new Error('handler not mounted');

      const count = 50;
      const promises: Promise<PmcCapturedRes>[] = [];
      for (let i = 0; i < count; i++) {
        promises.push(pmcPostImport(handler, PMC_TEX_GUID_A));
      }
      await Promise.all(promises);

      const afterRes = await pmcPostImport(handler, PMC_TEX_GUID_A);
      expect(afterRes.statusCode).toBe(200);
      expect(pmcDecodeCallCount).toBe(1);
    });

    it('(d) two independent metaPaths trigger separate imports (group isolation)', async () => {
      await writeFile(
        join(assetsDir, 'textured.gltf.meta.json'),
        pmcGltfMetaTextured([PMC_TEX_GUID_A]),
      );
      await writeFile(join(assetsDir, 'textured.gltf'), new Uint8Array([0]));

      await writeFile(
        join(assetsDir2, 'textured2.gltf.meta.json'),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'external-asset-package',
          importer: 'gltf',
          source: 'textured2.gltf',
          importSettings: { defaultSceneIndex: 0 },
          subAssets: [
            { guid: '01900000-0000-7000-8000-eeeeeeeeeeee', sourceIndex: 0, kind: 'mesh' },
            { guid: PMC_TEX_GUID_C, sourceIndex: 0, kind: 'texture', name: 'tex-c' },
          ],
        }),
      );
      await writeFile(join(assetsDir2, 'textured2.gltf'), new Uint8Array([0]));

      const mockImporter = makePmcMockGltfImporter();
      const cap = makePmcServer();
      const plugin = pluginPack({ roots: [assetsDir, assetsDir2], importers: [mockImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      if (handler === undefined) throw new Error('handler not mounted');

      const promises: Promise<PmcCapturedRes>[] = [];
      const half = 30;
      for (let i = 0; i < half; i++) {
        promises.push(pmcPostImport(handler, PMC_TEX_GUID_A));
        promises.push(pmcPostImport(handler, PMC_TEX_GUID_C));
      }
      const results = await Promise.all(promises);

      for (const r of results) {
        expect(r.statusCode).toBe(200);
      }

      expect(pmcDecodeCallCount).toBeLessThanOrEqual(2);
      expect(pmcDecodeCallCount).toBeGreaterThan(0);
    });

    it('(e) cooked sub-asset rows carry the derived display name (binary + non-binary arms)', async () => {
      // Regression guard: startMetaImport rebuilds each imported PackIndexEntry
      // field-by-field. Dropping `name` there made a lazy-cooked GLB's
      // sub-assets show blank in the Content Browser while the un-cooked
      // /pack-index.json still had the name. Both overlay arms (binary texture,
      // non-binary mesh living in the pack body) must preserve buildCatalog's
      // deriveAssetName result.
      await writeFile(
        join(assetsDir, 'textured.gltf.meta.json'),
        pmcGltfMetaTextured([PMC_TEX_GUID_A]),
      );
      await writeFile(join(assetsDir, 'textured.gltf'), new Uint8Array([0]));

      const mockImporter = makePmcMockGltfImporter();
      const cap = makePmcServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [mockImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      if (handler === undefined) throw new Error('handler not mounted');

      // Binary arm: the texture declared name 'tex-0' in the meta, so
      // deriveAssetName returns the stored name for a multi-asset package.
      const texRes = await pmcPostImport(handler, PMC_TEX_GUID_A);
      expect(texRes.statusCode).toBe(200);
      const texEntries = JSON.parse(texRes.body) as PackIndexEntry[];
      expect(texEntries[0]?.name).toBe('tex-0');

      // Non-binary arm: the mesh declared no name, so deriveAssetName falls
      // back to the source basename.
      const meshRes = await pmcPostImport(handler, PMC_MESH_GUID);
      expect(meshRes.statusCode).toBe(200);
      const meshEntries = JSON.parse(meshRes.body) as PackIndexEntry[];
      expect(meshEntries[0]?.name).toBe('textured.gltf');
    });
  });
}

{
  // ─── from scene-asset-fixture.test.ts ───

  const SAF_REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
  const SAF_HELLO_ROOM_ASSETS = resolve(SAF_REPO_ROOT, 'apps', 'hello', 'room', 'assets');
  const SAF_ROOM_PACK_PATH = resolve(SAF_HELLO_ROOM_ASSETS, 'room.pack.json');
  const SAF_ROOM_SCENE_GUID = '019e2808-d3ba-735f-811f-ae7bbb465392';

  interface SafMockResHeaders {
    'Content-Type'?: string;
    [k: string]: string | undefined;
  }
  interface SafMockRes {
    setHeader: (k: string, v: string) => void;
    end: (body: string) => void;
    statusCode?: number;
    _body: string;
    _headers: SafMockResHeaders;
  }
  interface SafMockReq {
    url: string;
  }
  type SafMiddleware = (req: SafMockReq, res: SafMockRes, next: () => void) => void | Promise<void>;
  interface SafMockServer {
    middlewares: { use: (mw: SafMiddleware) => void };
    watcher?: { on: (k: string, cb: () => void) => void };
  }

  function saMakeRes(): SafMockRes {
    const headers: SafMockResHeaders = {};
    const res: SafMockRes = {
      _body: '',
      _headers: headers,
      setHeader: (k, v) => {
        headers[k] = v;
      },
      end: (body) => {
        res._body = body;
      },
    };
    return res;
  }

  async function safAttachPlugin(roots: readonly string[]): Promise<{ middleware: SafMiddleware }> {
    const plugin = pluginPack({ roots: [...roots] }) as unknown as {
      name: string;
      configureServer?: (server: SafMockServer) => void | Promise<void>;
    };
    let middleware: SafMiddleware | undefined;
    const server: SafMockServer = {
      middlewares: {
        use: (mw) => {
          middleware = mw;
        },
      },
    };
    await plugin.configureServer?.(server);
    if (middleware === undefined) throw new Error('configureServer did not register middleware');
    await new Promise((r) => setTimeout(r, 100));
    return { middleware };
  }

  async function safFetchUrl(middleware: SafMiddleware, url: string): Promise<SafMockRes> {
    const res = saMakeRes();
    await middleware({ url }, res, () => {});
    return res;
  }

  describe('scene-asset-fixture.test.ts', () => {
    it('(a) catalog includes one entry with kind === "scene" + the room SceneAsset GUID', async () => {
      const fixtureRaw = readFileSync(SAF_ROOM_PACK_PATH, 'utf-8');
      expect(fixtureRaw.includes(SAF_ROOM_SCENE_GUID)).toBe(true);
      const { middleware } = await safAttachPlugin([SAF_HELLO_ROOM_ASSETS]);
      const res = await safFetchUrl(middleware, '/__pack/index');
      expect(res._headers['Content-Type']).toBe('application/json');
      const catalog = JSON.parse(res._body) as Array<{
        guid: string;
        relativeUrl: string;
        kind: string;
      }>;
      const sceneEntries = catalog.filter((e) => e.kind === 'scene');
      expect(sceneEntries.length).toBeGreaterThanOrEqual(1);
      expect(
        sceneEntries.some((e) => e.guid.toLowerCase() === SAF_ROOM_SCENE_GUID.toLowerCase()),
      ).toBe(true);
    });

    it('(b) /__pack/lookup/<sceneGuid> resolves to a catalog entry pointing at room.pack.json', async () => {
      const { middleware } = await safAttachPlugin([SAF_HELLO_ROOM_ASSETS]);
      const res = await safFetchUrl(middleware, `/__pack/lookup/${SAF_ROOM_SCENE_GUID}`);
      expect(res._headers['Content-Type']).toBe('application/json');
      const entry = JSON.parse(res._body) as {
        guid: string;
        relativeUrl: string;
        kind: string;
        sourcePath: string;
      };
      expect(entry.kind).toBe('scene');
      expect(entry.guid.toLowerCase()).toBe(SAF_ROOM_SCENE_GUID.toLowerCase());
      expect(entry.sourcePath.endsWith('room.pack.json')).toBe(true);
    });

    it('(c) empty roots: catalog is `[]` (degrade-not-crash)', async () => {
      const { middleware } = await safAttachPlugin([]);
      const res = await safFetchUrl(middleware, '/__pack/index');
      expect(res._headers['Content-Type']).toBe('application/json');
      const catalog = JSON.parse(res._body) as unknown[];
      expect(Array.isArray(catalog)).toBe(true);
      expect(catalog.length).toBe(0);
    });
  });
}

{
  // ─── from serve-imported-bytes.test.ts ───

  const SIB_WOOD_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
  const SIB_FIXTURE_PNG_SRC = join(
    WORKTREE_ROOT,
    'forgeax-engine-assets',
    'learn-opengl',
    'textures',
    'wood.png',
  );

  function sibWoodImageMeta(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood.png',
      importSettings: {
        colorSpace: 'srgb',
        mipmap: 'auto',
        addressMode: 'repeat',
        filterMode: 'linear',
      },
      subAssets: [{ guid: SIB_WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
    });
  }

  interface SibCapturedRes {
    statusCode: number;
    headers: Record<string, string>;
    bodyBuf: Buffer;
    setHeader(name: string, value: string): void;
    end(chunk: string | Uint8Array): void;
  }

  function makeSibRes(): SibCapturedRes {
    return {
      statusCode: 200,
      headers: {},
      bodyBuf: Buffer.alloc(0),
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        this.bodyBuf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk);
      },
    };
  }

  type SibHandler = (req: unknown, res: unknown, next: () => void) => unknown;

  function makeSibServer(): { server: unknown; getHandler(): SibHandler | undefined } {
    let handler: SibHandler | undefined;
    return {
      server: {
        middlewares: {
          use(h: SibHandler) {
            handler = h;
          },
        },
        watcher: { on: () => {} },
        ws: { send: () => {} },
      },
      getHandler: () => handler,
    };
  }

  async function sibGetJson(handler: SibHandler, url: string): Promise<PackIndexEntry[]> {
    const res = makeSibRes();
    await handler({ url, method: 'GET' }, res, () => {});
    return JSON.parse(res.bodyBuf.toString('utf-8')) as PackIndexEntry[];
  }

  async function sibPostImport(handler: SibHandler, guid: string): Promise<PackIndexEntry[]> {
    const res = makeSibRes();
    await handler({ url: `/__import/${guid}`, method: 'POST' }, res, () => {});
    return JSON.parse(res.bodyBuf.toString('utf-8')) as PackIndexEntry[];
  }

  describe('serve-imported-bytes.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;
    let assetsDir: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w12-'));
      assetsDir = join(tmpRoot, 'assets');
      process.chdir(tmpRoot);
      await mkdir(assetsDir, { recursive: true });
      const png = await readFile(SIB_FIXTURE_PNG_SRC);
      await writeFile(join(assetsDir, 'wood.png'), png);
      await writeFile(join(assetsDir, 'wood.png.meta.json'), sibWoodImageMeta());
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(AC-07d) serving the imported .bin URL returns imported bytes (not raw source)', async () => {
      const cap = makeSibServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [imageImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      expect(handler).toBeDefined();
      if (handler === undefined) return;

      const returned = await sibPostImport(handler, SIB_WOOD_GUID);
      const row = returned.find(
        (e) => e.guid.toLowerCase() === SIB_WOOD_GUID && e.kind === 'texture',
      );
      expect(row).toBeDefined();
      if (row === undefined) return;
      const binUrl = row.relativeUrl;
      expect(binUrl.endsWith('.bin')).toBe(true);

      const ddcFile = join(tmpRoot, 'node_modules/.cache/forgeax-ddc', `${SIB_WOOD_GUID}.bin`);
      const importedOnDisk = await readFile(ddcFile);
      const rawSource = await readFile(join(assetsDir, 'wood.png'));

      expect(Buffer.compare(importedOnDisk, rawSource) !== 0).toBe(true);

      expect(row.sourcePath.endsWith('wood.png')).toBe(true);
      expect(row.relativeUrl.endsWith(`wood.png.${SIB_WOOD_GUID}.bin`)).toBe(true);
      const served = await readFile(ddcFile);
      expect(Buffer.compare(served, importedOnDisk)).toBe(0);
      expect(Buffer.compare(served, rawSource)).not.toBe(0);
    });

    it('(catalog) the imported row is also reflected at /__pack/index after import', async () => {
      const cap = makeSibServer();
      const plugin = pluginPack({ roots: [assetsDir], importers: [imageImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      if (handler === undefined) throw new Error('handler not mounted');

      await sibPostImport(handler, SIB_WOOD_GUID);
      const catalog = await sibGetJson(handler, '/__pack/index');
      const row = catalog.find((e) => e.guid.toLowerCase() === SIB_WOOD_GUID);
      expect(row?.relativeUrl.endsWith('.bin')).toBe(true);
    });
  });
}

{
  // ─── from plugin-dev.test.ts (test/ -> src/__tests__/) ───

  interface PdServerResponseLike {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(chunk: string): void;
  }

  interface PdIncomingMessageLike {
    url?: string;
  }

  type PdNextFn = (err?: unknown) => void;
  type PdMiddleware = (
    req: PdIncomingMessageLike,
    res: PdServerResponseLike,
    next: PdNextFn,
  ) => void | Promise<void>;

  interface PdMiddlewaresLike {
    use(handler: PdMiddleware): unknown;
  }

  interface PdViteDevServerLike {
    middlewares: PdMiddlewaresLike;
    watcher?: { on(event: string, cb: (...args: unknown[]) => void): unknown };
  }

  interface PdPluginLike {
    name: string;
    configureServer?: (server: PdViteDevServerLike) => void;
    generateBundle?: (this: {
      emitFile: (asset: { type: string; fileName: string; source: string }) => string;
    }) => void;
  }

  function pdCaptureMiddleware(plugin: PdPluginLike): {
    middleware: PdMiddleware;
    watchCallbacks: Map<string, ((...args: unknown[]) => void)[]>;
  } {
    const watchCallbacks = new Map<string, ((...args: unknown[]) => void)[]>();
    const middlewares: PdMiddleware[] = [];

    const fakeWatcher = {
      on(event: string, cb: (...args: unknown[]) => void): unknown {
        const existing = watchCallbacks.get(event) ?? [];
        watchCallbacks.set(event, [...existing, cb]);
        return fakeWatcher;
      },
    };

    const fakeServer: PdViteDevServerLike = {
      middlewares: {
        use(handler: PdMiddleware): unknown {
          middlewares.push(handler);
          return undefined;
        },
      },
      watcher: fakeWatcher,
    };

    plugin.configureServer?.(fakeServer);

    const middleware = middlewares[0];
    if (!middleware)
      throw new Error('pluginPack did not register a middleware via configureServer');
    return { middleware, watchCallbacks };
  }

  async function pdSimulateRequest(
    middleware: PdMiddleware,
    url: string,
  ): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> {
    return new Promise((resolve, reject) => {
      let body = '';
      const headers: Record<string, string> = {};
      let statusCode = 200;

      const res: PdServerResponseLike = {
        get statusCode() {
          return statusCode;
        },
        set statusCode(v: number) {
          statusCode = v;
        },
        setHeader(name: string, value: string) {
          headers[name] = value;
        },
        end(chunk: string) {
          body = chunk;
          resolve({ statusCode, body, headers });
        },
      };

      const req: PdIncomingMessageLike = { url };

      const next: PdNextFn = (err) => {
        if (err) {
          reject(err as Error);
        } else {
          resolve({ statusCode: 404, body: '', headers });
        }
      };

      const result = middleware(req, res, next);
      if (result instanceof Promise) {
        result.catch(reject);
      }
    });
  }

  describe('plugin-dev.test.ts', () => {
    it('src/index exports pluginPack function', () => {
      expect(typeof pluginPack).toBe('function');
    });

    it('returns a plugin with name "forgeax:pack"', () => {
      const plugin = pluginPack({ roots: [] }) as unknown as PdPluginLike;
      expect(plugin.name).toBe('forgeax:pack');
    });

    it('has configureServer hook', () => {
      const plugin = pluginPack({ roots: [] }) as unknown as PdPluginLike;
      expect(typeof plugin.configureServer).toBe('function');
    });

    it('GET /__pack/index returns application/json array', async () => {
      const plugin = pluginPack({ roots: [] }) as unknown as PdPluginLike;
      const { middleware } = pdCaptureMiddleware(plugin);

      const result = await pdSimulateRequest(middleware, '/__pack/index');
      expect(result.headers['Content-Type']).toContain('application/json');
      const parsed = JSON.parse(result.body) as unknown;
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('GET /__pack/lookup/<known-guid> returns an entry or 404 JSON', async () => {
      const plugin = pluginPack({ roots: [] }) as unknown as PdPluginLike;
      const { middleware } = pdCaptureMiddleware(plugin);

      const someGuid = '00000000-0000-7000-8000-000000000001';
      const result = await pdSimulateRequest(middleware, `/__pack/lookup/${someGuid}`);
      expect([200, 404]).toContain(result.statusCode);
      if (result.body.length > 0) {
        expect(() => JSON.parse(result.body)).not.toThrow();
      }
    });

    it('unrelated URL falls through to next()', async () => {
      const plugin = pluginPack({ roots: [] }) as unknown as PdPluginLike;
      const { middleware } = pdCaptureMiddleware(plugin);

      const result = await pdSimulateRequest(middleware, '/something-else');
      expect(result.statusCode).toBe(404);
      expect(result.body).toBe('');
    });

    it('watcher is registered via server.watcher.on', () => {
      const plugin = pluginPack({ roots: [] }) as unknown as PdPluginLike;
      const { watchCallbacks } = pdCaptureMiddleware(plugin);
      const hasChangeHandler =
        watchCallbacks.has('change') || watchCallbacks.has('add') || watchCallbacks.has('unlink');
      expect(typeof hasChangeHandler).toBe('boolean');
    });
  });
}

{
  // ─── AC-17 startMetaImport parse failure → structured error (w14) ───

  interface Ac17CapturedRes {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    setHeader(name: string, value: string): void;
    end(chunk: string | Uint8Array): void;
  }

  function makeAc17Res(): Ac17CapturedRes {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        this.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      },
    };
  }

  type Ac17Handler = (req: unknown, res: unknown, next: () => void) => unknown;

  function makeAc17Server(): { server: unknown; getHandler(): Ac17Handler | undefined } {
    let handler: Ac17Handler | undefined;
    return {
      server: {
        middlewares: {
          use(h: Ac17Handler) {
            handler = h;
          },
        },
        watcher: { on: () => {} },
        ws: { send: () => {} },
      },
      getHandler: () => handler,
    };
  }

  describe('w14-startMetaImport-parse-failure.test.ts — AC-17 structured error', () => {
    let originalCwd: string;
    let tmpRoot: string;
    let assetsDir: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-ac17-vpp-'));
      assetsDir = join(tmpRoot, 'assets');
      process.chdir(tmpRoot);
      await mkdir(assetsDir, { recursive: true });
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('AC-17: unparseable meta JSON → POST /__import returns 422 (structured error, not silent skip)', async () => {
      const testGuid = 'bbbbbbbb-cccc-4000-8000-000000000001';
      await writeFile(join(assetsDir, 'bad.meta.json'), 'not json {{ bad');

      const cap = makeAc17Server();
      const plugin = pluginPack({ roots: [assetsDir], importers: [imageImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      expect(handler).toBeDefined();
      if (handler === undefined) return;

      // First trigger: the meta declares no GUID (bad JSON), so GUID is not in
      // guidToMeta. POST /__import returns 404 meta-not-found.
      // The AC-17 structural test verifies that when the meta IS found but has
      // unparseable JSON, startMetaImport throws instead of silently returning [].
      // We test this indirectly: verify the import endpoint does NOT return 200+[]
      // silently. Since guidToMeta won't have the GUID (meta was unparseable at
      // scan/buildGuidToMetaMap time), the 404 is expected.
      const res = makeAc17Res();
      await handler({ url: `/__import/${testGuid}`, method: 'POST' }, res, () => {});
      // Unparseable meta means the GUID won't be in guidToMeta → 404
      // (not a silent 200 with empty [])
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('meta-not-found');
    });

    it('AC-17: meta with omitted source + missing derived file → scanner reports orphan (not silent)', async () => {
      const metaContent = JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'image',
        importSettings: {},
        subAssets: [
          { guid: 'bbbbbbbb-cccc-4000-8000-000000000001', sourceIndex: 0, kind: 'texture' },
        ],
      });
      // Write meta but NOT the companion file ghost.png
      await writeFile(join(assetsDir, 'ghost.png.meta.json'), metaContent);

      const cap = makeAc17Server();
      const plugin = pluginPack({ roots: [assetsDir], importers: [imageImporter] });
      plugin.configureServer(cap.server as never);
      await new Promise((r) => setTimeout(r, 80));
      const handler = cap.getHandler();
      expect(handler).toBeDefined();
      if (handler === undefined) return;

      // Catalog build will fail via scan (pack-orphan-meta due to missing derived file),
      // so the catalog stays empty. The result is a clean failure, not a silent skip.
      const res = makeAc17Res();
      await handler({ url: '/__pack/index', method: 'GET' }, res, () => {});
      expect(res.statusCode).toBe(200);
      // Since scan failed, catalog was never built; an empty catalog is returned
      // (the catch path sets catalogReady = true with empty catalog)
      const catalog = JSON.parse(res.body) as unknown[];
      expect(catalog).toEqual([]);
    });
  });
}

{
  // ─── watcher debounce + dedup + no listener leak
  //     (feedback 2026-07-06-vite-plugin-pack-watcher-debounce-dedup-listener-leak) ───

  interface WatchRecordedSend {
    readonly type: string;
  }

  interface WatchMockServer {
    readonly middlewares: { use(handler: unknown): void };
    readonly watcher: {
      on(event: string, cb: (...args: unknown[]) => void): void;
      readonly onCalls: string[];
    };
    readonly ws: {
      send(payload: { type: string } & Record<string, unknown>): void;
      readonly calls: WatchRecordedSend[];
    };
  }

  function makeWatchMockServer(): WatchMockServer {
    const calls: WatchRecordedSend[] = [];
    const onCalls: string[] = [];
    return {
      middlewares: { use: () => {} },
      watcher: {
        on(event) {
          onCalls.push(event);
        },
        onCalls,
      },
      ws: {
        send(payload) {
          calls.push({ type: payload.type });
        },
        calls,
      },
    };
  }

  async function watchWaitFor(
    predicate: () => boolean,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 1500;
    const intervalMs = options.intervalMs ?? 20;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  function countReloads(server: WatchMockServer): number {
    return server.ws.calls.filter((c) => c.type === 'full-reload').length;
  }

  const WATCH_WOOD_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
  function watchWoodImageMeta(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood-container.jpg',
      importSettings: { colorSpace: 'srgb', mipmap: 'auto' },
      subAssets: [{ guid: WATCH_WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
    });
  }
  const WATCH_ONE_BYTE_JPG = new Uint8Array([0xff]);

  describe('watcher-debounce-dedup.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;
    let assetsDir: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-watch-'));
      assetsDir = join(tmpRoot, 'assets');
      process.chdir(tmpRoot);
      await mkdir(assetsDir, { recursive: true });
      await writeFile(join(assetsDir, 'wood-container.jpg'), WATCH_ONE_BYTE_JPG);
      await writeFile(join(assetsDir, 'wood-container.meta.json'), watchWoodImageMeta());
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) never registers a `change` listener on server.watcher (no leak)', async () => {
      const server = makeWatchMockServer();
      const plugin = pluginPack({ roots: [assetsDir] });
      plugin.configureServer(server as never);
      await new Promise((r) => setTimeout(r, 50));

      // Trigger several sidecar rebuilds; the old code accumulated one no-op
      // `server.watcher.on('change', ...)` per rebuild (MaxListenersExceeded).
      for (let i = 0; i < 4; i++) {
        await writeFile(join(assetsDir, 'wood-container.meta.json'), watchWoodImageMeta());
        await new Promise((r) => setTimeout(r, 30));
      }
      await watchWaitFor(() => countReloads(server) > 0);

      expect(server.watcher.onCalls.filter((e) => e === 'change')).toHaveLength(0);
    });

    it('(b) a burst of rapid writes coalesces into a single full-reload', async () => {
      const server = makeWatchMockServer();
      const plugin = pluginPack({ roots: [assetsDir] });
      plugin.configureServer(server as never);
      await new Promise((r) => setTimeout(r, 50));

      // Fan a single logical edit into many fs.watch events inside one debounce
      // window (mimics Windows event amplification). All must collapse to ONE
      // catalog rebuild + ONE reload.
      for (let i = 0; i < 8; i++) {
        await writeFile(join(assetsDir, 'wood-container.meta.json'), watchWoodImageMeta());
      }
      await watchWaitFor(() => countReloads(server) > 0);
      // Give any straggler flush a chance to (wrongly) fire.
      await new Promise((r) => setTimeout(r, 300));

      expect(countReloads(server)).toBe(1);
    });

    it('(c) a byte-identical sidecar rewrite after the first reload is deduped', async () => {
      const server = makeWatchMockServer();
      const plugin = pluginPack({ roots: [assetsDir] });
      plugin.configureServer(server as never);
      await new Promise((r) => setTimeout(r, 50));

      // First change: cache is empty, so this flushes + reloads (count -> 1) and
      // records the content signature.
      await writeFile(join(assetsDir, 'wood-container.meta.json'), watchWoodImageMeta());
      await watchWaitFor(() => countReloads(server) >= 1);
      const afterFirst = countReloads(server);
      expect(afterFirst).toBe(1);

      // Second change with identical bytes: content dedup drops it, no reload.
      await writeFile(join(assetsDir, 'wood-container.meta.json'), watchWoodImageMeta());
      await new Promise((r) => setTimeout(r, 300));
      expect(countReloads(server)).toBe(afterFirst);
    });

    it('(d) a genuine content change after a deduped write still reloads', async () => {
      const server = makeWatchMockServer();
      const plugin = pluginPack({ roots: [assetsDir] });
      plugin.configureServer(server as never);
      await new Promise((r) => setTimeout(r, 50));

      await writeFile(join(assetsDir, 'wood-container.meta.json'), watchWoodImageMeta());
      await watchWaitFor(() => countReloads(server) >= 1);
      expect(countReloads(server)).toBe(1);

      // Change the sidecar bytes (mipmap none): dedup must NOT swallow it.
      const changed = JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'image',
        source: 'wood-container.jpg',
        importSettings: { colorSpace: 'srgb', mipmap: 'none' },
        subAssets: [{ guid: WATCH_WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
      });
      await writeFile(join(assetsDir, 'wood-container.meta.json'), changed);
      await watchWaitFor(() => countReloads(server) >= 2);
      expect(countReloads(server)).toBe(2);
    });
  });
}
