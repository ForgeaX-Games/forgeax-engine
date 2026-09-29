/** Pure CPU expectations for transmission math; this module has no GPU ownership. */

export type Color3 = readonly [number, number, number];
export type Uv2 = readonly [number, number];

export const DEFAULT_IOR = 1.5;
export const DEFAULT_GUARD_BAND = 0.02;

export interface TransmissionEnergy {
  readonly reflection: number;
  readonly transmission: number;
  readonly diffuse: number;
  readonly metallicResidual: number;
}

export interface BackdropResolution {
  readonly source: 'refracted' | 'environment' | 'unrefracted';
  readonly color: Color3;
}

export interface BackdropInputs {
  readonly uv: Uv2;
  readonly refracted?: Color3;
  readonly environment?: Color3;
  readonly unrefracted: Color3;
  readonly guardBand?: number;
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

const safeIor = (ior: number): number => {
  const candidate = finiteOr(ior, DEFAULT_IOR);
  return candidate >= 1 ? candidate : DEFAULT_IOR;
};

/** Returns dielectric F0 for air to a material with the supplied IOR. */
export function fresnelF0(ior: number): number {
  const ratio = (safeIor(ior) - 1) / (safeIor(ior) + 1);
  return ratio * ratio;
}

/**
 * Returns unpolarized dielectric reflectance. `eta` is incident IOR divided
 * by transmitted IOR, so values above one can produce total internal
 * reflection. This is a CPU oracle only; it does not sample a GPU resource.
 */
export function fresnelReflectance(cosTheta: number, eta: number): number {
  if (!Number.isFinite(cosTheta) || !Number.isFinite(eta) || eta <= 0) return 1;

  const cosIncident = clamp01(cosTheta);
  const sinTransmittedSquared = eta * eta * (1 - cosIncident * cosIncident);
  if (sinTransmittedSquared >= 1) return 1;

  const cosTransmitted = Math.sqrt(Math.max(0, 1 - sinTransmittedSquared));
  const perpendicularDenominator = cosIncident + eta * cosTransmitted;
  const parallelDenominator = eta * cosIncident + cosTransmitted;
  if (perpendicularDenominator === 0 || parallelDenominator === 0) return 1;

  const perpendicular = (cosIncident - eta * cosTransmitted) / perpendicularDenominator;
  const parallel = (eta * cosIncident - cosTransmitted) / parallelDenominator;
  return clamp01((perpendicular * perpendicular + parallel * parallel) / 2);
}

export function splitTransmissionEnergy(input: {
  readonly transmission: number;
  readonly metallic: number;
  readonly cosTheta: number;
  readonly ior: number;
}): TransmissionEnergy {
  const transmission = clamp01(finiteOr(input.transmission, 0));
  const metallic = clamp01(finiteOr(input.metallic, 0));
  const reflectance = fresnelReflectance(input.cosTheta, 1 / safeIor(input.ior));
  const nonMetal = 1 - metallic;
  const refracted = (1 - reflectance) * nonMetal;

  return {
    reflection: reflectance,
    transmission: refracted * transmission,
    diffuse: refracted * (1 - transmission),
    metallicResidual: (1 - reflectance) * metallic,
  };
}

export function beerLambertAttenuation(
  color: Color3,
  thickness: number,
  distance?: number,
): Color3 {
  if (
    !Number.isFinite(thickness) ||
    thickness <= 0 ||
    distance === undefined ||
    !Number.isFinite(distance) ||
    distance <= 0
  ) {
    return [1, 1, 1];
  }

  const exponent = thickness / distance;
  const attenuate = (component: number): number => {
    const safeComponent = clamp01(finiteOr(component, 0));
    return Math.min(Math.max(safeComponent ** exponent, 0), 1);
  };
  return [attenuate(color[0]), attenuate(color[1]), attenuate(color[2])];
}

export function roughnessToLod(roughness: number, maxLod: number): number {
  const safeRoughness = clamp01(finiteOr(roughness, 0));
  const safeMaxLod = Math.max(finiteOr(maxLod, 0), 0);
  return safeRoughness * safeRoughness * safeMaxLod;
}

export function isWithinGuardBand(uv: Uv2, guardBand = DEFAULT_GUARD_BAND): boolean {
  if (!uv.every(Number.isFinite) || !Number.isFinite(guardBand)) return false;
  const band = clamp01(guardBand);
  return uv.every((coordinate) => coordinate >= band && coordinate <= 1 - band);
}

export function resolveRefractionBackdrop(input: BackdropInputs): BackdropResolution {
  if (
    isWithinGuardBand(input.uv, input.guardBand) &&
    input.refracted !== undefined &&
    isFiniteColor(input.refracted)
  ) {
    return { source: 'refracted', color: input.refracted };
  }
  if (input.environment !== undefined && isFiniteColor(input.environment)) {
    return { source: 'environment', color: input.environment };
  }
  if (isFiniteColor(input.unrefracted)) {
    return { source: 'unrefracted', color: input.unrefracted };
  }
  return { source: 'unrefracted', color: [0, 0, 0] };
}

export function isFiniteColor(color: Color3): boolean {
  return color.length === 3 && color.every(Number.isFinite);
}
