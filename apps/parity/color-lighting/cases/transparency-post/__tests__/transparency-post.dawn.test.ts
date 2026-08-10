import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { createRenderer } from '@forgeax/engine-runtime';
import { readbackTexturePixels } from '../../../../../../packages/rhi-debug/src/readback';
import { describe, expect, it } from 'vitest';
import ldrCase from '../transparent-ldr-urp.json' with { type: 'json' };
import hdrCase from '../transparent-hdr-hdrp.json' with { type: 'json' };
import type { SceneCase } from '../../../src/contracts/types';
import { createDawnSurface, makeWorld } from '../gpu-capture';

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
const requiredParityRun = process.env.FORGEAX_PARITY_REQUIRED === '1';
const cases = [ldrCase, hdrCase] as unknown as readonly SceneCase[];
const manifest = await buildEngineShaderManifest();
const manifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;

function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

describe('transparency post Dawn GPU integration', () => {
  it.skipIf(!dawnReady && !requiredParityRun)('captures both pipeline producers from live attachments', async () => {
    if (!dawnReady) throw new Error('required transparency/post Dawn evidence needs navigator.gpu');
    const observations: Array<{
      caseId: string;
      pipelineId: string;
      backendId: string;
      frameId: number;
      rawHash: string;
      bytes: number[];
    }> = [];
    for (const sceneCase of cases) {
      const surface = createDawnSurface(sceneCase.scene.width, sceneCase.scene.height);
      const renderer = await createRenderer(surface.canvas, {}, { shaderManifestUrl: manifestUrl });
      try {
        const ready = await renderer.ready;
        expect(ready.ok).toBe(true);
        if (!ready.ok) throw new Error(ready.error.hint);
        if (sceneCase.pipeline?.identity === 'hdrp') {
          const installed = renderer.installPipeline({
            kind: 'render-pipeline',
            pipelineId: 'forgeax::hdrp',
            config: { clusterGrid: { x: 16, y: 9, z: 24 } },
          });
          expect(installed.ok).toBe(true);
          if (!installed.ok) throw new Error(installed.error.hint);
        }
        const drawn = renderer.draw([makeWorld(sceneCase)], { owner: 0 });
        expect(drawn.ok).toBe(true);
        if (!drawn.ok) throw new Error(drawn.error.hint);
        await renderer.device.queue.onSubmittedWorkDone();
        const bytes = await readbackTexturePixels(
          renderer.device,
          surface.getTexture(),
          sceneCase.scene.width,
          sceneCase.scene.height,
          { bytesPerTexel: 4 },
        );
        observations.push({
          caseId: sceneCase.caseId,
          pipelineId: sceneCase.pipeline?.engineId ?? 'forgeax::urp',
          backendId: 'dawn',
          frameId: 0,
          rawHash: hashBytes(bytes),
          bytes: Array.from(bytes),
        });
      } finally {
        renderer.dispose();
      }
    }
    expect(observations).toHaveLength(2);
    expect(observations.map((entry) => entry.pipelineId)).toEqual(['forgeax::urp', 'forgeax::hdrp']);
    expect(observations.every((entry) => entry.bytes.length > 0)).toBe(true);
    expect(observations.every((entry) => /^[0-9a-f]{8}$/.test(entry.rawHash))).toBe(true);
    const artifactPath = process.env.FORGEAX_PARITY_TRANSPARENCY_ARTIFACT;
    if (artifactPath !== undefined) {
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(
        artifactPath,
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'transparency-producer',
          invocationId: process.env.FORGEAX_PARITY_INVOCATION_ID ?? 'transparency-dawn-artifact',
          cases: observations,
        }, null, 2)}\n`,
        'utf8',
      );
    }
  }, 120_000);
});
