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

export const MATERIAL_ERROR_EXPECTED: Readonly<Record<MaterialErrorCode, string>> = {
  'material-parent-not-found': 'every parent GUID resolves to a MaterialAsset',
  'material-circular-inheritance': 'the parent chain is acyclic',
  'material-no-effective-pass': 'the resolved material has at least one pass',
  'material-value-unknown': 'every value name is declared by the effective contract',
  'material-value-type-mismatch': 'each value matches its declared parameter type',
  'material-contract-program-mismatch': 'the program satisfies the material contract',
  'shader-module-id-missing': 'each WGSL source declares a module ID',
  'shader-module-id-duplicate': 'each module ID has one source provenance',
  'shader-module-not-found': 'every referenced module exists in the source catalog',
  'shader-module-namespace-reserved': 'user modules use a non-reserved namespace',
  'material-reflection-binding-mismatch': 'reflection matches the material contract bindings',
  'material-specialization-not-cooked': 'the requested specialization has a cooked artifact',
  'material-specialization-stale-generation':
    'all specialization dependencies share one generation',
  'gltf-material-uv-set-missing': 'each texture slot references an available primitive UV set',
};

export const MATERIAL_ERROR_HINTS: Readonly<Record<MaterialErrorCode, string>> = {
  'material-parent-not-found': 'fix the parent GUID and resolve the material again',
  'material-circular-inheritance': 'remove the repeated GUID from the parent chain',
  'material-no-effective-pass': 'add a pass to the root material or an inherited parent',
  'material-value-unknown': 'remove the value or declare the parameter in the root contract',
  'material-value-type-mismatch': 'change the value to the declared parameter type',
  'material-contract-program-mismatch': 'align the program entries with the root contract',
  'shader-module-id-missing': 'add a compiler-native module ID declaration to the WGSL source',
  'shader-module-id-duplicate': 'rename one module or remove the duplicate source',
  'shader-module-not-found': 'add the module to the source catalog or fix the reference',
  'shader-module-namespace-reserved': 'choose a module ID outside the reserved namespace',
  'material-reflection-binding-mismatch': 'update the contract or WGSL binding and cook again',
  'material-specialization-not-cooked': 'run the build or development cook path for this selection',
  'material-specialization-stale-generation': 'retry after dependent assets and sources settle',
  'gltf-material-uv-set-missing': 'add the requested UV set to the primitive and re-import it',
};

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
