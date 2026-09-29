import { describe, expect, it } from 'vitest';
import {
  beerLambertAttenuation,
  fresnelF0,
  fresnelReflectance,
  isFiniteColor,
  isWithinGuardBand,
  resolveRefractionBackdrop,
  roughnessToLod,
  splitTransmissionEnergy,
} from '../oracle.js';

const finite = (value: number): boolean => Number.isFinite(value);

describe('transmission CPU oracle', () => {
  it('uses the dielectric F0 formula and increases with IOR', () => {
    expect(fresnelF0(1.5)).toBeCloseTo(0.04, 8);
    expect(fresnelF0(1.33)).toBeLessThan(fresnelF0(1.5));
    expect(fresnelF0(2)).toBeGreaterThan(fresnelF0(1.5));
  });

  it('keeps total internal reflection as reflection', () => {
    expect(fresnelReflectance(0.5, 1.5)).toBe(1);
    expect(fresnelReflectance(1, 1 / 1.5)).toBeCloseTo(0.04, 8);
  });

  it('partitions transmission only from non-metal energy', () => {
    const dielectric = splitTransmissionEnergy({
      transmission: 1,
      metallic: 0,
      cosTheta: 1,
      ior: 1.5,
    });
    const metal = splitTransmissionEnergy({
      transmission: 1,
      metallic: 1,
      cosTheta: 1,
      ior: 1.5,
    });

    expect(dielectric.transmission).toBeGreaterThan(0);
    expect(metal.transmission).toBe(0);
    expect(
      dielectric.reflection +
        dielectric.transmission +
        dielectric.diffuse +
        dielectric.metallicResidual,
    ).toBeCloseTo(1, 8);
    expect(
      metal.reflection + metal.transmission + metal.diffuse + metal.metallicResidual,
    ).toBeCloseTo(1, 8);
  });

  it('applies Beer attenuation per component and preserves neutral boundaries', () => {
    expect(beerLambertAttenuation([0.25, 0.5, 1], 2, 4)).toEqual([0.5, Math.SQRT2 / 2, 1]);
    expect(beerLambertAttenuation([0.25, 0.5, 1], 0, 4)).toEqual([1, 1, 1]);
    expect(beerLambertAttenuation([0.25, 0.5, 1], 2)).toEqual([1, 1, 1]);
    expect(beerLambertAttenuation([0, 0.5, 1], 1, 2)[0]).toBe(0);
  });

  it('keeps zero-color absorption finite', () => {
    const attenuation = beerLambertAttenuation([0, 0, 0], 3, 2);
    expect(attenuation).toEqual([0, 0, 0]);
    expect(attenuation.every(finite)).toBe(true);
  });

  it('maps roughness squared to a bounded monotonic LOD', () => {
    expect(roughnessToLod(0, 8)).toBe(0);
    expect(roughnessToLod(0.5, 8)).toBe(2);
    expect(roughnessToLod(1, 8)).toBe(8);
    expect(roughnessToLod(0.75, 8)).toBeGreaterThan(roughnessToLod(0.5, 8));
    expect(roughnessToLod(2, 8)).toBe(8);
  });

  it('rejects the protected edge guard band', () => {
    expect(isWithinGuardBand([0.02, 0.5])).toBe(true);
    expect(isWithinGuardBand([0.01, 0.5])).toBe(false);
    expect(isWithinGuardBand([0.5, 0.98])).toBe(true);
    expect(isWithinGuardBand([0.5, 0.99])).toBe(false);
  });

  it('falls back from an invalid refraction sample to environment then baseline', () => {
    expect(
      resolveRefractionBackdrop({
        uv: [0.01, 0.5],
        refracted: [0.1, 0.2, 0.3],
        environment: [0.4, 0.5, 0.6],
        unrefracted: [0.7, 0.8, 0.9],
      }),
    ).toEqual({ source: 'environment', color: [0.4, 0.5, 0.6] });
    expect(
      resolveRefractionBackdrop({
        uv: [0.01, 0.5],
        unrefracted: [0.7, 0.8, 0.9],
      }),
    ).toEqual({ source: 'unrefracted', color: [0.7, 0.8, 0.9] });
    expect(
      resolveRefractionBackdrop({
        uv: [0.5, 0.5],
        refracted: [0.1, 0.2, 0.3],
        environment: [0.4, 0.5, 0.6],
        unrefracted: [0.7, 0.8, 0.9],
      }),
    ).toEqual({ source: 'refracted', color: [0.1, 0.2, 0.3] });
  });

  it('guards non-finite inputs without producing non-finite output', () => {
    const energy = splitTransmissionEnergy({
      transmission: Number.NaN,
      metallic: Number.POSITIVE_INFINITY,
      cosTheta: Number.NaN,
      ior: Number.NaN,
    });
    const values = [
      fresnelF0(Number.NaN),
      fresnelReflectance(Number.NaN, Number.NaN),
      energy.reflection,
      energy.transmission,
      energy.diffuse,
      energy.metallicResidual,
      beerLambertAttenuation([Number.NaN, 0, 1], Number.NaN, 1)[0],
      roughnessToLod(Number.NaN, 8),
    ];
    expect(values.every(finite)).toBe(true);
    expect(
      isFiniteColor(
        resolveRefractionBackdrop({ uv: [Number.NaN, 0], unrefracted: [1, 1, 1] }).color,
      ),
    ).toBe(true);
  });
});
