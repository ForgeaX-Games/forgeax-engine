import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  admittedSsrSpatial,
  runSsrGpuDispatch,
  runSsrViewDistanceProbe,
  sourcesFromManifest,
  ssrCoordinateErrors,
} from './ssr-gpu-dispatch';
import { runSsrReprojectionProbe } from './ssr-reprojection-probe';

describe('SSR GPU dispatch Dawn probe', () => {
  it('executes the admitted Hi-Z and trace shaders and reads a finite result', async () => {
    expect(admittedSsrSpatial().status).toBe('admitted');
    // CI hydrates the shared-app projection; local builds publish the same
    // shader producer under shared-build-inputs. Never depend on a demo dist.
    const manifestPath = ['shared-app-inputs', 'shared-build-inputs']
      .map((directory) => resolve(process.cwd(), directory, 'shaders/manifest.json'))
      .find(existsSync);
    if (manifestPath === undefined)
      throw new Error('SSR Dawn requires the built shared shader manifest');
    const manifest = (await readShaderManifestPublication(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
    )) as {
      readonly entries: readonly { readonly wgsl: string }[];
    };
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
    ).unwrap();
    expect(await runSsrReprojectionProbe(device, sourcesFromManifest(manifest).temporal)).toEqual([
      [0.5, 0.5, 0.375, 0.5625],
      [0.5, 0.5, 0.375, 0.5625],
      [0.5, 0.5, 0.375, 0.5625],
    ]);
    for (const distances of await runSsrViewDistanceProbe(
      device,
      sourcesFromManifest(manifest).trace,
    )) {
      expect(distances[0]).toBeCloseTo(6.58, 4);
      expect(distances[1]).toBeCloseTo(12, 4);
    }
    const hit = await runSsrGpuDispatch(device, sourcesFromManifest(manifest), 60);
    // Mip count must not grow CPU pass recording: ordered dispatches share
    // one compute pass per pyramid, with every level still produced below.
    expect(hit.passNames.filter((name) => name.startsWith('depth-pyramid-reduce'))).toHaveLength(1);
    expect(hit.passNames.filter((name) => name.startsWith('ssr-reflection-mip'))).toHaveLength(1);
    expect(hit.passNames).toContain('depth-pyramid-seed');
    expect(hit.passNames).toContain('ssr-trace');
    expect(hit.passNames).toContain('ssr-temporal');
    expect(hit.passNames.filter((name) => name === 'ssr-compose')).toHaveLength(1);
    expect(hit.passNames).toContain('ssr-trace');
    expect(hit.resourceNames).toContain('ssr-resolved');
    expect(hit.pixels).toHaveLength(60);
    expect(new Set(hit.pixels.map((pixel) => pixel.join(','))).size).toBe(1);
    expect(hit.pixel.some((value) => value !== 0)).toBe(true);
    // The history must store the actually shaded receiver/wall normal, not a
    // normal reconstructed across their depth discontinuity. Alpha is the
    // independent reflection confidence in the same four-byte texel.
    const surfaceNormals = new Set(
      Array.from({ length: hit.surfacePixels.length / 4 }, (_, p) =>
        hit.surfacePixels.slice(p * 4, p * 4 + 3).join(','),
      ),
    );
    // Oct12 quantization places zero Z just below the UNORM8 midpoint.
    expect(surfaceNormals).toEqual(new Set(['218,128,218', '0,128,127']));
    expect(hit.surfacePixels.filter((_, i) => i % 4 === 3).some((value) => value > 0)).toBe(true);
    const pyramid = hit.pyramidPixels[0] ?? [];
    // Independently derive the view distance at the leftmost pixel of the
    // inclined receiver from its plane equation and real perspective ray.
    const dx = (((0.5 / 64) * 2 - 1) * 2) / Math.sqrt(3);
    expect(pyramid[0]).toBeCloseTo(6 / (1 - dx), 2);
    const trace = hit.tracePixels[0] ?? [];
    const confidence = (values: readonly number[]) => values.filter((_, i) => i % 4 === 3);
    expect(confidence(trace).some((value) => value > 0)).toBe(true);
    // The analytical mirror faces a real wall across a broad interior region.
    // A positive-but-nearly-zero boundary hit is not a useful reflection.
    expect(confidence(trace).filter((value) => value >= 0x3400).length).toBeGreaterThan(40);
    expect(confidence(trace).every((value) => value <= 0x3c00)).toBe(true);
    const backFace = await runSsrGpuDispatch(device, sourcesFromManifest(manifest), 1, {
      sourceBackFacing: true,
    });
    expect(confidence(backFace.tracePixels[0] ?? []).every((value) => value === 0)).toBe(true);

    const coordinates = await runSsrGpuDispatch(device, sourcesFromManifest(manifest), 1, {
      coordinateSource: true,
    });
    const errors = ssrCoordinateErrors(coordinates.tracePixels[0] ?? []);
    expect(errors.length).toBeGreaterThan(10);
    expect(errors.filter((error) => error > 0.002).length / errors.length).toBeLessThan(0.05);

    const grout = await runSsrGpuDispatch(device, sourcesFromManifest(manifest), 1, {
      coordinateSource: true,
      recessedSource: true,
    });
    const groutErrors = ssrCoordinateErrors(grout.tracePixels[0] ?? [], true);
    expect(groutErrors.length).toBeGreaterThan(10);
    expect(groutErrors.filter((error) => error > 0.002).length / groutErrors.length).toBeLessThan(
      0.05,
    );

    for (const options of [{ excludedSource: true }, { excludedReceiver: true }]) {
      const excluded = await runSsrGpuDispatch(device, sourcesFromManifest(manifest), 1, options);
      expect(confidence(excluded.tracePixels[0] ?? []).every((value) => value === 0)).toBe(true);
    }

    const miss = await runSsrGpuDispatch(device, sourcesFromManifest(manifest), 1, {
      maxDistance: 0.01,
    });
    expect(miss.tracePixels[0]?.[3]).toBe(0);
    expect(miss.tracePixels[0]).not.toEqual(hit.tracePixels[0]);

    const disabled = await runSsrGpuDispatch(device, sourcesFromManifest(manifest), 1, {
      enabled: false,
    });
    expect(disabled.tracePixels[0]?.[3]).toBe(0);
    expect(disabled.tracePixels[0]).not.toEqual(hit.tracePixels[0]);
  });
});
