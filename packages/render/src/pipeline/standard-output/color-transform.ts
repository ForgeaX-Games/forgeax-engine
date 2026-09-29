import type { ColorValueDomain } from '@forgeax/engine-render-graph';
import { bradfordAdaptD65 } from './auto-exposure/oracle';
import type { StandardOutputEncoding, StandardOutputLogicalStage } from './types';

export interface StandardOutputDomainTransition {
  readonly stage: StandardOutputLogicalStage;
  readonly input: ColorValueDomain;
  readonly output: ColorValueDomain;
}

export const LINEAR_HDR_DOMAIN: ColorValueDomain = 'linear-hdr';
export const LINEAR_LDR_DOMAIN: ColorValueDomain = 'linear-ldr';
export const DISPLAY_ENCODED_DOMAIN: ColorValueDomain = 'display-encoded';

/** D65 product white point shared by the Camera output oracle. */
export const D65_TEMPERATURE_KELVIN = 6504;
export const CAMERA_COLOR_LUT_ZERO_COST_STRENGTH = 0;

export function outputEncodingOwner(encoding: StandardOutputEncoding): string {
  return encoding === 'explicit-oetf' ? 'output-encoding.wgsl' : 'srgb-attachment';
}

export function outputEncodingUsesOetf(encoding: StandardOutputEncoding): boolean {
  return encoding === 'explicit-oetf';
}

export type StandardRgb = readonly [number, number, number];
export type StandardRgba = readonly [number, number, number, number];

/** Apply the camera's Bradford white-balance adaptation in linear HDR. */
export function applyStandardWhiteBalance(
  rgb: StandardRgb,
  temperature: number,
  tint: number,
): [number, number, number] {
  const adapted = bradfordAdaptD65(rgb, temperature);
  if (tint === 0) return adapted;
  const greenScale = Math.max(0, 1 - tint);
  const magentaScale = Math.max(0, 1 + tint);
  return [adapted[0] * magentaScale, adapted[1] * greenScale, adapted[2] * magentaScale];
}

export interface StandardColorLutData {
  readonly size: number;
  /** RGBA half-float texels in z-major, y-major, x-major order. */
  readonly data: ArrayLike<number>;
}

function halfToFloat(value: number): number {
  const sign = (value & 0x8000) === 0 ? 1 : -1;
  const exponent = (value >>> 10) & 0x1f;
  const mantissa = value & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

function lutValue(data: ArrayLike<number>, index: number): number {
  const value = data[index] ?? 0;
  if (data instanceof Uint8Array) {
    const byte = index * 2;
    return halfToFloat((data[byte] ?? 0) | ((data[byte + 1] ?? 0) << 8));
  }
  return data instanceof Uint16Array ? halfToFloat(value) : value;
}

function sampleNearest(data: StandardColorLutData, x: number, y: number, z: number): StandardRgba {
  const size = data.size;
  const texel = ((z * size + y) * size + x) * 4;
  return [
    lutValue(data.data, texel),
    lutValue(data.data, texel + 1),
    lutValue(data.data, texel + 2),
    lutValue(data.data, texel + 3),
  ];
}

/** CPU reference for the fixed clamp-to-edge, texel-center trilinear LUT sample. */
export function sampleStandardColorLut(
  data: StandardColorLutData,
  rgb: StandardRgb,
  strength = 1,
  alpha = 1,
): StandardRgba {
  if (!Number.isInteger(data.size) || data.size < 2) return [rgb[0], rgb[1], rgb[2], alpha];
  const size = data.size;
  const coordinate = rgb.map((value) =>
    Math.min(size - 1, Math.max(0, Math.min(1, value) * size - 0.5)),
  ) as [number, number, number];
  const base = coordinate.map(Math.floor) as [number, number, number];
  const fraction: [number, number, number] = [
    coordinate[0] - base[0],
    coordinate[1] - base[1],
    coordinate[2] - base[2],
  ];
  const sampled: [number, number, number, number] = [0, 0, 0, 0];
  for (let dz = 0; dz <= 1; dz += 1) {
    for (let dy = 0; dy <= 1; dy += 1) {
      for (let dx = 0; dx <= 1; dx += 1) {
        const sample = sampleNearest(
          data,
          Math.min(size - 1, base[0] + dx),
          Math.min(size - 1, base[1] + dy),
          Math.min(size - 1, base[2] + dz),
        );
        const weight =
          (dx === 0 ? 1 - fraction[0] : fraction[0]) *
          (dy === 0 ? 1 - fraction[1] : fraction[1]) *
          (dz === 0 ? 1 - fraction[2] : fraction[2]);
        sampled[0] += sample[0] * weight;
        sampled[1] += sample[1] * weight;
        sampled[2] += sample[2] * weight;
        sampled[3] += sample[3] * weight;
      }
    }
  }
  const amount = Math.min(1, Math.max(0, strength));
  return [
    rgb[0] + (sampled[0] - rgb[0]) * amount,
    rgb[1] + (sampled[1] - rgb[1]) * amount,
    rgb[2] + (sampled[2] - rgb[2]) * amount,
    alpha,
  ];
}
