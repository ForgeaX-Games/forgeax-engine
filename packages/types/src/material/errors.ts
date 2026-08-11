export const MATERIAL_ERROR_CODES = [
  'material-parent-not-found',
  'material-circular-inheritance',
  'material-no-effective-pass',
  'material-value-unknown',
  'material-value-type-mismatch',
  'material-contract-program-mismatch',
  'shader-module-id-missing',
  'shader-module-id-duplicate',
  'shader-module-not-found',
  'shader-module-namespace-reserved',
  'material-reflection-binding-mismatch',
  'material-specialization-not-cooked',
  'material-specialization-stale-generation',
  'gltf-material-uv-set-missing',
] as const;

export type MaterialErrorCode = (typeof MATERIAL_ERROR_CODES)[number];

export interface MaterialParentNotFoundDetail {
  readonly code: 'material-parent-not-found';
  readonly leaf: string;
  readonly missingParent: string;
  readonly chain: readonly string[];
}

export interface MaterialCircularInheritanceDetail {
  readonly code: 'material-circular-inheritance';
  readonly leaf: string;
  readonly chain: readonly string[];
}

export interface MaterialNoEffectivePassDetail {
  readonly code: 'material-no-effective-pass';
  readonly material: string;
}

export interface MaterialValueUnknownDetail {
  readonly code: 'material-value-unknown';
  readonly material: string;
  readonly parameter: string;
}

export interface MaterialValueTypeMismatchDetail {
  readonly code: 'material-value-type-mismatch';
  readonly material: string;
  readonly parameter: string;
  readonly expectedType: string;
  readonly actualType: string;
}

export interface MaterialContractProgramMismatchDetail {
  readonly code: 'material-contract-program-mismatch';
  readonly material: string;
  readonly pass: string;
  readonly program: string;
  readonly expectedProgram: string;
}

export interface ShaderModuleIdMissingDetail {
  readonly code: 'shader-module-id-missing';
  readonly source: string;
}

export interface ShaderModuleIdDuplicateDetail {
  readonly code: 'shader-module-id-duplicate';
  readonly module: string;
  readonly sources: readonly string[];
}

export interface ShaderModuleNotFoundDetail {
  readonly code: 'shader-module-not-found';
  readonly module: string;
  readonly source: string;
}

export interface ShaderModuleNamespaceReservedDetail {
  readonly code: 'shader-module-namespace-reserved';
  readonly module: string;
  readonly namespace: string;
}

export interface MaterialReflectionBindingMismatchDetail {
  readonly code: 'material-reflection-binding-mismatch';
  readonly material: string;
  readonly pass: string;
  readonly parameter: string;
  readonly expected: string;
  readonly actual: string;
}

export interface MaterialSpecializationNotCookedDetail {
  readonly code: 'material-specialization-not-cooked';
  readonly material: string;
  readonly staticSelection: readonly string[];
}

export interface MaterialSpecializationStaleGenerationDetail {
  readonly code: 'material-specialization-stale-generation';
  readonly material: string;
  readonly dependencies: readonly string[];
}

export interface GltfMaterialUvSetMissingDetail {
  readonly material: string;
  readonly primitive: string;
  readonly slot: string;
  readonly requestedSet: number;
  readonly availableSets: readonly number[];
}

interface MaterialErrorDetailByCode {
  readonly 'material-parent-not-found': MaterialParentNotFoundDetail;
  readonly 'material-circular-inheritance': MaterialCircularInheritanceDetail;
  readonly 'material-no-effective-pass': MaterialNoEffectivePassDetail;
  readonly 'material-value-unknown': MaterialValueUnknownDetail;
  readonly 'material-value-type-mismatch': MaterialValueTypeMismatchDetail;
  readonly 'material-contract-program-mismatch': MaterialContractProgramMismatchDetail;
  readonly 'shader-module-id-missing': ShaderModuleIdMissingDetail;
  readonly 'shader-module-id-duplicate': ShaderModuleIdDuplicateDetail;
  readonly 'shader-module-not-found': ShaderModuleNotFoundDetail;
  readonly 'shader-module-namespace-reserved': ShaderModuleNamespaceReservedDetail;
  readonly 'material-reflection-binding-mismatch': MaterialReflectionBindingMismatchDetail;
  readonly 'material-specialization-not-cooked': MaterialSpecializationNotCookedDetail;
  readonly 'material-specialization-stale-generation': MaterialSpecializationStaleGenerationDetail;
  readonly 'gltf-material-uv-set-missing': GltfMaterialUvSetMissingDetail;
}

export type MaterialErrorDetail = MaterialErrorDetailByCode[MaterialErrorCode];

export type MaterialErrorFor<C extends MaterialErrorCode> = {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MaterialErrorDetailByCode[C];
  readonly message: string;
};

export type MaterialError = {
  [C in MaterialErrorCode]: MaterialErrorFor<C>;
}[MaterialErrorCode];

const MATERIAL_ERROR_POLICY = {
  'material-parent-not-found': {
    expected: 'every parent GUID resolves to a MaterialAsset',
    hint: 'fix the parent GUID and resolve the material again',
  },
  'material-circular-inheritance': {
    expected: 'the parent chain is acyclic',
    hint: 'remove the repeated GUID from the parent chain',
  },
  'material-no-effective-pass': {
    expected: 'the resolved material has at least one pass',
    hint: 'add a pass to the root material or an inherited parent',
  },
  'material-value-unknown': {
    expected: 'every value name is declared by the effective contract',
    hint: 'remove the value or declare the parameter in the root contract',
  },
  'material-value-type-mismatch': {
    expected: 'each value matches its declared parameter type',
    hint: 'change the value to the declared parameter type',
  },
  'material-contract-program-mismatch': {
    expected: 'the program satisfies the material contract',
    hint: 'align the program entries with the root contract',
  },
  'shader-module-id-missing': {
    expected: 'each WGSL source declares a module ID',
    hint: 'add a compiler-native module ID declaration to the WGSL source',
  },
  'shader-module-id-duplicate': {
    expected: 'each module ID has one source provenance',
    hint: 'rename one module or remove the duplicate source',
  },
  'shader-module-not-found': {
    expected: 'every referenced module exists in the source catalog',
    hint: 'add the module to the source catalog or fix the reference',
  },
  'shader-module-namespace-reserved': {
    expected: 'user modules use a non-reserved namespace',
    hint: 'choose a module ID outside the reserved namespace',
  },
  'material-reflection-binding-mismatch': {
    expected: 'reflection matches the material contract bindings',
    hint: 'update the contract or WGSL binding and cook again',
  },
  'material-specialization-not-cooked': {
    expected: 'the requested specialization has a cooked artifact',
    hint: 'run the build or development cook path for this selection',
  },
  'material-specialization-stale-generation': {
    expected: 'all specialization dependencies share one generation',
    hint: 'retry after dependent assets and sources settle',
  },
  'gltf-material-uv-set-missing': {
    expected: 'each texture slot references an available primitive UV set',
    hint: 'add the requested UV set to the primitive and re-import it',
  },
} satisfies {
  readonly [C in MaterialErrorCode]: {
    readonly expected: string;
    readonly hint: string;
  };
};

export const MATERIAL_ERROR_EXPECTED: Readonly<Record<MaterialErrorCode, string>> =
  Object.fromEntries(
    MATERIAL_ERROR_CODES.map((code) => [code, MATERIAL_ERROR_POLICY[code].expected]),
  ) as Readonly<Record<MaterialErrorCode, string>>;

export const MATERIAL_ERROR_HINTS: Readonly<Record<MaterialErrorCode, string>> = Object.fromEntries(
  MATERIAL_ERROR_CODES.map((code) => [code, MATERIAL_ERROR_POLICY[code].hint]),
) as Readonly<Record<MaterialErrorCode, string>>;

export function createMaterialError<C extends MaterialErrorCode>(
  code: C,
  detail: MaterialErrorDetailByCode[C],
  message = `${code}: ${MATERIAL_ERROR_EXPECTED[code]}`,
): MaterialErrorFor<C> {
  return {
    code,
    expected: MATERIAL_ERROR_EXPECTED[code],
    hint: MATERIAL_ERROR_HINTS[code],
    detail,
    message,
  };
}
