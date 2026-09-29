import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export interface Lm63TypeC {
  readonly tilt: 'NONE';
  readonly verticalAnglesDeg: readonly number[];
  readonly horizontalAnglesDeg: readonly number[];
  readonly candela: readonly number[];
}

export interface Lm63ParseError {
  readonly code: 'invalid-ies' | 'unsupported-tilt' | 'unsupported-photometric-type';
  readonly reason: string;
}

function numericTokens(source: string, startLine: number): number[] {
  return source
    .split(/\r?\n/)
    .slice(startLine)
    .join(' ')
    .replaceAll(',', ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map(Number);
}

function allFinite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

export function parseLm63TypeC(source: string): Result<Lm63TypeC, Lm63ParseError> {
  const lines = source.split(/\r?\n/);
  const tiltLine = lines.findIndex((line) => /^\s*TILT\s*=/i.test(line));
  if (tiltLine < 0) return err({ code: 'invalid-ies', reason: 'missing TILT declaration' });
  const tiltSource = lines[tiltLine];
  if (tiltSource === undefined)
    return err({ code: 'invalid-ies', reason: 'missing TILT declaration' });
  const tilt = tiltSource
    .slice(tiltSource.indexOf('=') + 1)
    .trim()
    .toUpperCase();
  if (tilt !== 'NONE') return err({ code: 'unsupported-tilt', reason: `TILT=${tilt}` });

  const values = numericTokens(source, tiltLine + 1);
  if (values.length < 12 || !allFinite(values.slice(0, 12))) {
    return err({ code: 'invalid-ies', reason: 'numeric header is incomplete or non-finite' });
  }
  const verticalCount = values[3];
  const horizontalCount = values[4];
  const photometricType = values[5];
  if (
    verticalCount === undefined ||
    horizontalCount === undefined ||
    photometricType === undefined
  ) {
    return err({ code: 'invalid-ies', reason: 'numeric header is incomplete or non-finite' });
  }
  if (photometricType !== 1) {
    return err({
      code: 'unsupported-photometric-type',
      reason: `photometric type ${photometricType} is not Type C`,
    });
  }
  if (
    !Number.isInteger(verticalCount) ||
    !Number.isInteger(horizontalCount) ||
    verticalCount < 2 ||
    horizontalCount < 1
  ) {
    return err({ code: 'invalid-ies', reason: 'angle counts are invalid' });
  }

  const angleOffset = 12;
  const verticalEnd = angleOffset + verticalCount;
  const horizontalEnd = verticalEnd + horizontalCount;
  const candelaEnd = horizontalEnd + verticalCount * horizontalCount;
  if (values.length < candelaEnd) {
    return err({ code: 'invalid-ies', reason: 'angle or candela table is incomplete' });
  }
  const verticalAnglesDeg = values.slice(angleOffset, verticalEnd);
  const horizontalAnglesDeg = values.slice(verticalEnd, horizontalEnd);
  const candelaMultiplier = values[2];
  if (candelaMultiplier === undefined) {
    return err({ code: 'invalid-ies', reason: 'numeric header is incomplete or non-finite' });
  }
  const candela = values.slice(horizontalEnd, candelaEnd).map((value) => value * candelaMultiplier);
  if (
    !allFinite(verticalAnglesDeg) ||
    !allFinite(horizontalAnglesDeg) ||
    !allFinite(candela) ||
    verticalAnglesDeg[0] !== 0 ||
    verticalAnglesDeg[verticalAnglesDeg.length - 1] !== 180 ||
    horizontalAnglesDeg[0] !== 0
  ) {
    return err({ code: 'invalid-ies', reason: 'Type C angles or candela values are invalid' });
  }
  return ok({ tilt: 'NONE', verticalAnglesDeg, horizontalAnglesDeg, candela });
}
