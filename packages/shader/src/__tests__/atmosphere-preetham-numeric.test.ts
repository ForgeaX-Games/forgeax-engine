import { describe, expect, it } from 'vitest';

type Vec3 = readonly [number, number, number];
type PerezFits = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

const PAPER_FITS: Readonly<Record<'Y' | 'x' | 'y', PerezFits>> = {
  Y: [
    [0.1787, -1.463],
    [-0.3554, 0.4275],
    [-0.0227, 5.3251],
    [0.1206, -2.5771],
    [-0.067, 0.3703],
  ],
  x: [
    [-0.0193, -0.2592],
    [-0.0665, 0.0008],
    [-0.0004, 0.2125],
    [-0.0641, -0.8989],
    [-0.0033, 0.0452],
  ],
  y: [
    [-0.0167, -0.2608],
    [-0.095, 0.0092],
    [-0.0079, 0.2102],
    [-0.0441, -1.6537],
    [-0.0109, 0.0529],
  ],
};

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(...value);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function zenithYxy(sunTheta: number, turbidity: number): Vec3 {
  const theta2 = sunTheta * sunTheta;
  const theta3 = theta2 * sunTheta;
  const turbidity2 = turbidity * turbidity;
  const chi = (4 / 9 - turbidity / 120) * (Math.PI - 2 * sunTheta);
  return [
    (4.0453 * turbidity - 4.971) * Math.tan(chi) - 0.2155 * turbidity + 2.4192,
    (0.00165 * theta3 - 0.00374 * theta2 + 0.00208 * sunTheta) * turbidity2 +
      (-0.02902 * theta3 + 0.06377 * theta2 - 0.03202 * sunTheta + 0.00394) * turbidity +
      (0.11693 * theta3 - 0.21196 * theta2 + 0.06052 * sunTheta + 0.25885),
    (0.00275 * theta3 - 0.0061 * theta2 + 0.00316 * sunTheta) * turbidity2 +
      (-0.04214 * theta3 + 0.0897 * theta2 - 0.04153 * sunTheta + 0.00515) * turbidity +
      (0.15346 * theta3 - 0.26756 * theta2 + 0.06669 * sunTheta + 0.26688),
  ];
}

function perez(theta: number, gamma: number, fits: PerezFits, turbidity: number): number {
  const [a, b, c, d, e] = fits.map(([slope, intercept]) => slope * turbidity + intercept);
  const safeCos = Math.max(Math.cos(theta), 0.01);
  return Math.max(
    (1 + (a ?? 0) * Math.exp((b ?? 0) / safeCos)) *
      (1 + (c ?? 0) * Math.exp((d ?? 0) * gamma) + (e ?? 0) * Math.cos(gamma) ** 2),
    1e-5,
  );
}

function evaluatePaperYxy(viewInput: Vec3, sunInput: Vec3, turbidity: number): Vec3 {
  const view = normalize([viewInput[0], Math.max(viewInput[1], 0), viewInput[2]]);
  const sun = normalize(sunInput);
  const theta = Math.acos(Math.max(0, Math.min(1, view[1])));
  const sunTheta = Math.acos(Math.max(0, Math.min(1, sun[1])));
  const gamma = Math.acos(
    Math.max(-1, Math.min(1, view[0] * sun[0] + view[1] * sun[1] + view[2] * sun[2])),
  );
  const zenith = zenithYxy(sunTheta, turbidity);
  return (['Y', 'x', 'y'] as const).map((channel, index) => {
    const relative =
      perez(theta, gamma, PAPER_FITS[channel], turbidity) /
      perez(0, sunTheta, PAPER_FITS[channel], turbidity);
    return (zenith[index] ?? 0) * relative;
  }) as unknown as Vec3;
}

function yxyToLinearSrgb([Y, x, y]: Vec3): Vec3 {
  const safeY = Math.max(y, 1e-5);
  const X = (Y * x) / safeY;
  const Z = (Y * Math.max(1 - x - y, 0)) / safeY;
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ].map((channel) => Math.min(Math.max(channel, 0), 65504)) as unknown as Vec3;
}

describe('Preetham 1999 independent numeric oracle', () => {
  it.each([
    ['morning zenith', [0, 1, 0], [-0.45, 0.22, -0.865], 3.2, [3.225319, 0.260094, 0.274286]],
    [
      'morning horizon',
      [0.1, 0, -0.995],
      [-0.45, 0.22, -0.865],
      3.2,
      [11.048136, 0.378332, 0.377748],
    ],
    ['noon zenith', [0, 1, 0], [0.1, 0.97, -0.22], 2.1, [9.491382, 0.263007, 0.270884]],
    [
      'evening circumsolar',
      [0.5, 0.15, -0.85],
      [0.5, 0.15, -0.85],
      4.2,
      [19.689314, 0.412721, 0.425093],
    ],
  ] as const)('%s matches the pinned Y/x/y reference', (_name, view, sun, turbidity, expected) => {
    const actual = evaluatePaperYxy(view, sun, turbidity);
    expect(actual[0]).toBeCloseTo(expected[0], 5);
    expect(actual[1]).toBeCloseTo(expected[1], 5);
    expect(actual[2]).toBeCloseTo(expected[2], 5);
    expect(
      yxyToLinearSrgb(actual).every((channel) => Number.isFinite(channel) && channel <= 65504),
    ).toBe(true);
  });
});
