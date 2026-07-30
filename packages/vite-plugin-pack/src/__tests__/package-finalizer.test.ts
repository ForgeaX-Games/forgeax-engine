import { describe, expect, it } from 'vitest';
import {
  canonicalizeLogicalPackage,
  finalizePackage,
  type LogicalPackage,
} from '../package-finalizer.js';

const logicalPackage: LogicalPackage = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    {
      guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
      kind: 'host-reel',
      payload: { version: 1, title: 'demo' },
      refs: ['019e3969-1d48-7c3b-ac24-6d68f457065e'],
      artifacts: {
        preview: {
          mediaType: 'application/octet-stream',
          assetCodec: { name: 'reel', profile: 'preview' },
          bytes: new Uint8Array([1, 2, 3, 4]),
        },
      },
    },
  ],
};

function sink() {
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  return {
    writes,
    write(path: string, bytes: Uint8Array) {
      writes.push({ path, bytes: new Uint8Array(bytes) });
    },
  };
}

describe('shared package finalizer', () => {
  it('keeps authored and cooked packages semantically equal across sinks', async () => {
    const dev = sink();
    const build = sink();

    const devResult = await finalizePackage(logicalPackage, dev, {
      base: '/preview/',
      packagePath: '__forgeax/dev/package.json',
      artifactPath: (guid, key) => `__forgeax/dev/${guid}/${key}.bin`,
    });
    const buildResult = await finalizePackage(logicalPackage, build, {
      base: '/release/',
      packagePath: 'assets/package-abc.json',
      artifactPath: (guid, key) => `assets/${guid}-${key}-xyz.bin`,
    });

    expect(devResult.semantic).toBe(buildResult.semantic);
    const devAsset = devResult.pack.assets[0];
    const buildAsset = buildResult.pack.assets[0];
    expect(devAsset).toBeDefined();
    expect(buildAsset).toBeDefined();
    if (devAsset === undefined || buildAsset === undefined) return;
    expect(devAsset.artifacts.preview?.mediaType).toBe('application/octet-stream');
    expect(devAsset.artifacts.preview?.path).not.toBe(buildAsset.artifacts.preview?.path);
    expect(devResult.packageUrl).toBe('/preview/__forgeax/dev/package.json');
    expect(buildResult.packageUrl).toBe('/release/assets/package-abc.json');
    expect(dev.writes.find((entry) => entry.path.endsWith('.json'))?.bytes).toBeDefined();
    expect(dev.writes.find((entry) => entry.path.endsWith('.bin'))?.bytes).toEqual(
      build.writes.find((entry) => entry.path.endsWith('.bin'))?.bytes,
    );
  });

  it('canonicalizes logical payload and artifact bytes deterministically', () => {
    expect(canonicalizeLogicalPackage(logicalPackage)).toBe(
      canonicalizeLogicalPackage({
        ...logicalPackage,
        assets: [...logicalPackage.assets].reverse(),
      }),
    );
  });
});
