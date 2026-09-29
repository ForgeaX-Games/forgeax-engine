import { writeFileSync } from 'node:fs';
import { env, stderr } from 'node:process';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { beforeAll, it, onTestFinished } from 'vitest';
import { verifyVfxMeshLighting } from './vfx-mesh-lighting.fixture';

let manifest: Awaited<ReturnType<typeof buildEngineShaderManifest>>;
// Reuse the admitted point profile when prepared; source fallback remains
// available for standalone runs. Keep preparation outside the GPU test window.
beforeAll(async () => {
  const started = performance.now();
  stderr.write('[vfx-mesh] start shader preparation\n');
  manifest = await buildEngineShaderManifest({ pointShadows: true });
  stderr.write(
    `[vfx-mesh] shader preparation elapsedMs=${Math.round(performance.now() - started)}\n`,
  );
}, 300_000);

it.each([
  false,
  true,
])('verifies Mesh Point/IBL parity and depth-dependent shadow latency on Dawn (publication=%s)', async (publication) => {
  const shaderManifestUrl = URL.createObjectURL(
    new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
  );
  onTestFinished(() => URL.revokeObjectURL(shaderManifestUrl));
  const started = performance.now();
  let cookMs = 0;
  let cookCalls = 0;
  await verifyVfxMeshLighting({
    shaderManifestUrl,
    publication,
    cook: async (...args) => {
      const cookStarted = performance.now();
      try {
        return await cookParticleCodeEffect(...args);
      } finally {
        cookCalls += 1;
        cookMs += performance.now() - cookStarted;
      }
    },
    tapePaths: env,
    saveTape: writeFileSync,
  });
  stderr.write(
    `[vfx-mesh] verification elapsedMs=${Math.round(performance.now() - started)} cookMs=${Math.round(cookMs)} cookCalls=${cookCalls}\n`,
  );
}, 120_000);
