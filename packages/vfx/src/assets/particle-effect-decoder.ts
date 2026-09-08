import {
  type AssetDecoderContribution,
  type AssetKind,
  err,
  ok,
  type ParticleEffectAsset,
} from '@forgeax/engine-types';

export const particleEffectContribution: AssetDecoderContribution<
  ParticleEffectAsset,
  'particle-effect'
> = {
  kind: { kind: 'particle-effect' } as AssetKind<ParticleEffectAsset, 'particle-effect'>,
  consumer: 'VfxGpuRuntime',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload;
      if (
        payload.kind === 'particle-effect' &&
        payload.schemaVersion === 2 &&
        payload.emitters.length === payload.program.emitters.length &&
        payload.programFingerprint === payload.program.fingerprint
      ) {
        return ok(payload);
      }
      return err({
        code: 'asset-package-invalid',
        expected: 'a schema v2 particle payload matching its cooked program',
        hint: 'recook the particle effect atomically with its GPU program',
        detail: { guid: envelope.guid, reason: 'particle owner validation failed' },
      });
    },
  },
};
