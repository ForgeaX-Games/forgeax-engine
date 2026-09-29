import type { AutoExposureAc27Capture, AutoExposureAc27StageObservation } from './auto-exposure-ac27-join';

export type AutoExposureStageCapture = AutoExposureAc27StageObservation;
export type AutoExposureCapture = AutoExposureAc27Capture;

export function maxDecodedSrgbRoiDelta(left: readonly number[], right: readonly number[]): number {
  const size = Math.min(left.length, right.length);
  let max = left.length === right.length ? 0 : 1;
  for (let index = 0; index < size; index += 1) max = Math.max(max, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  return max;
}

export function rawDelta(left: readonly number[], right: readonly number[]): number {
  let different = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) if (left[index] !== right[index]) different += 1;
  return different;
}

export function sameFixtureIdentity(left: AutoExposureCapture, right: AutoExposureCapture): boolean {
  return (Object.keys(left.fixtureIdentity) as (keyof AutoExposureCapture['fixtureIdentity'])[]).every((key) => left.fixtureIdentity[key].id === right.fixtureIdentity[key].id && left.fixtureIdentity[key].sha256 === right.fixtureIdentity[key].sha256);
}
