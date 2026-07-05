import { describe, expect, it } from 'vitest';

describe('@forgeax/engine-fbx', () => {
  it('exports initFbxWasm', async () => {
    const mod = await import('./index.js');
    expect(typeof mod.initFbxWasm).toBe('function');
  });

  it('exports parseFbx', async () => {
    const mod = await import('./index.js');
    expect(typeof mod.parseFbx).toBe('function');
  });

  it('exports parseFbxToObject', async () => {
    const mod = await import('./index.js');
    expect(typeof mod.parseFbxToObject).toBe('function');
  });

  it('exports isFbxWasmReady', async () => {
    const mod = await import('./index.js');
    expect(typeof mod.isFbxWasmReady).toBe('function');
  });

  it('isFbxWasmReady returns false before init', async () => {
    const mod = await import('./index.js');
    expect(mod.isFbxWasmReady()).toBe(false);
  });

  it('parseFbx throws before init', async () => {
    const mod = await import('./index.js');
    expect(() => mod.parseFbx(new Uint8Array(0))).toThrow('WASM not initialized');
  });
});

describe('@forgeax/engine-fbx barrel', () => {
  it('exports fbxImporter with key "fbx"', async () => {
    const mod = await import('./index.js');
    expect(mod.fbxImporter.key).toBe('fbx');
    expect(typeof mod.fbxImporter.import).toBe('function');
  });

  it('exports the parse-*.ts bridge layer + toAssetPack', async () => {
    const mod = await import('./index.js');
    expect(typeof mod.parseMesh).toBe('function');
    expect(typeof mod.parseScene).toBe('function');
    expect(typeof mod.parseMaterial).toBe('function');
    expect(typeof mod.parseSkeleton).toBe('function');
    expect(typeof mod.parseSkin).toBe('function');
    expect(typeof mod.parseAnimationClips).toBe('function');
    expect(typeof mod.parseTextures).toBe('function');
    expect(typeof mod.toAssetPack).toBe('function');
    expect(typeof mod.fbxErr).toBe('function');
  });
});
