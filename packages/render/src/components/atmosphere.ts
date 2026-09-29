import { defineComponent } from '@forgeax/engine-ecs';

/** Analytic atmosphere authoring facts; the directional light supplies the sun. */
export const Atmosphere = defineComponent('Atmosphere', {
  turbidity: { type: 'f32', default: 2 },
  rayleigh: { type: 'f32', default: 1 },
  mieCoefficient: { type: 'f32', default: 0.005 },
  mieDirectionalG: { type: 'f32', default: 0.8 },
  sunAngularRadius: { type: 'f32', default: 0.004675 },
  /** Independent multiplier for the analytic circumsolar lobe. */
  circumsolarStrength: { type: 'f32', default: 1 },
  /** Relative angular width of the analytic circumsolar lobe. */
  circumsolarWidth: { type: 'f32', default: 1 },
});
