export declare const FALSIFICATION_VARIANTS: Readonly<{
  readonly 'missing-derived-parent': {
    readonly name: 'missing-derived-parent';
    readonly description: string;
    readonly environment: 'FORGEAX_FALSIFY_MISSING_PARENT';
  };
  readonly 'uv0-transform-loss': {
    readonly name: 'uv0-transform-loss';
    readonly description: string;
    readonly environment: 'FORGEAX_FALSIFY_UV0_TRANSFORM';
  };
}>;

export declare function falsificationEnvironment(
  variant: keyof typeof FALSIFICATION_VARIANTS,
): Record<string, '1'>;

export declare function assertFalsificationFailed(result: {
  readonly variant: keyof typeof FALSIFICATION_VARIANTS;
  readonly exitCode: number;
  readonly output: string;
}): void;
