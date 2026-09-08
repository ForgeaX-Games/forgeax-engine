// @forgeax/engine-app/internal/ecs-import — host-owned capability projection.
//
// The remote transport deliberately has no engine-package vocabulary. Hosts
// that expose ECS to eval inject this narrow projection at the transport seam,
// keeping the ECS wire surface and its dependency ownership in one place.

const ECS_MODULE_SPECIFIER = '@forgeax/engine-ecs';

export const ECS_PUBLIC_SYMBOLS = Object.freeze([
  'World',
  'Entity',
  'Update',
  'FixedUpdate',
  'Time',
  'FixedTime',
] as const);

export type EcsPublicSymbol = (typeof ECS_PUBLIC_SYMBOLS)[number];
export type EcsPublicModule = Readonly<Partial<Record<EcsPublicSymbol, unknown>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function projectEcsPublicModule(value: unknown): EcsPublicModule {
  if (!isRecord(value)) return {};
  const projected: Record<string, unknown> = {};
  for (const symbol of ECS_PUBLIC_SYMBOLS) {
    if (symbol in value) projected[symbol] = value[symbol];
  }
  return projected;
}

export function createEcsImportModule(
  importModule: (specifier: string) => Promise<unknown>,
): (specifier: string) => Promise<unknown> {
  return async (specifier: string): Promise<unknown> => {
    const moduleValue = await importModule(specifier);
    return specifier === ECS_MODULE_SPECIFIER ? projectEcsPublicModule(moduleValue) : moduleValue;
  };
}
