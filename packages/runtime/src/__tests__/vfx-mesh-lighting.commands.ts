import { ok } from '@forgeax/engine-types';
import { cookParticleCodeEffect, type ParticleCodeModuleSet } from '@forgeax/engine-vfx-compiler';

/** Test-host cooking only; no compiler or source evaluation enters the player. */
export const vfxMeshLightingCommands = {
  async cookVfxMeshLighting(
    _context: unknown,
    source: unknown,
    modules: Readonly<Record<string, ParticleCodeModuleSet>>,
  ) {
    const cooked = await cookParticleCodeEffect(source, modules);
    return cooked.ok ? ok({ asset: cooked.value.asset }) : cooked;
  },
};
