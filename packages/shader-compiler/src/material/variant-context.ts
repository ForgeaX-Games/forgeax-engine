import { err, ok, type Result } from '@forgeax/engine-types';

export type MaterialBackend = 'webgpu' | 'webgl2' | 'wgpu-native';
export type MaterialCapability = 'storage-buffer' | 'uniform-fallback';
export type MaterialPipeline = 'forward' | 'deferred';
export type MaterialGeometry = 'mesh' | 'skinned' | 'sprite';
export type MaterialPass = 'forward' | 'shadow' | 'depth';
export type MaterialInstrumentation = 'none' | 'validation';

export interface MaterialVariantContextInput {
  readonly backend: MaterialBackend;
  readonly capability: MaterialCapability;
  readonly pipeline: MaterialPipeline;
  readonly geometry: MaterialGeometry;
  readonly pass: MaterialPass;
  readonly profile: 'forgeax-material-wgsl-v1';
  readonly toolchain: 'naga-oil';
  readonly instrumentation: MaterialInstrumentation;
}

export type MaterialVariantContext = MaterialVariantContextInput;

export interface MaterialVariantContextError {
  readonly code: 'material-variant-context-invalid' | 'material-variant-axis-reserved';
  readonly field: string;
  readonly expected: string;
  readonly actual: unknown;
  readonly action: 'use-domain-owner-field' | 'remove-material-override';
}

const RESERVED_AXES = new Set([
  'STORAGE_BUFFER_AVAILABLE',
  'WEBGL2_COMPAT',
  'CLUSTER_FORWARD_AVAILABLE',
  'POINT_SHADOW_AVAILABLE',
  'PER_INSTANCE_REGION',
]);

const FIELDS = new Set([
  'backend',
  'capability',
  'pipeline',
  'geometry',
  'pass',
  'profile',
  'toolchain',
  'instrumentation',
]);

function invalid(field: string, actual: unknown): Result<never, MaterialVariantContextError> {
  return err({
    code: 'material-variant-context-invalid',
    field,
    expected: 'a closed MaterialVariantContext field',
    actual,
    action: 'use-domain-owner-field',
  });
}

export function createMaterialVariantContext(
  value: unknown,
): Result<MaterialVariantContext, MaterialVariantContextError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('context', value);
  }
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (RESERVED_AXES.has(field)) {
      return err({
        code: 'material-variant-axis-reserved',
        field,
        expected: 'the corresponding domain-owned context field',
        actual: record[field],
        action: 'remove-material-override',
      });
    }
    if (!FIELDS.has(field)) return invalid(field, record[field]);
  }
  const required = [...FIELDS];
  for (const field of required) {
    if (!(field in record)) return invalid(field, undefined);
  }
  if (
    record.backend !== 'webgpu' &&
    record.backend !== 'webgl2' &&
    record.backend !== 'wgpu-native'
  ) {
    return invalid('backend', record.backend);
  }
  if (record.capability !== 'storage-buffer' && record.capability !== 'uniform-fallback') {
    return invalid('capability', record.capability);
  }
  if (record.pipeline !== 'forward' && record.pipeline !== 'deferred') {
    return invalid('pipeline', record.pipeline);
  }
  if (record.geometry !== 'mesh' && record.geometry !== 'skinned' && record.geometry !== 'sprite') {
    return invalid('geometry', record.geometry);
  }
  if (record.pass !== 'forward' && record.pass !== 'shadow' && record.pass !== 'depth') {
    return invalid('pass', record.pass);
  }
  if (record.profile !== 'forgeax-material-wgsl-v1') return invalid('profile', record.profile);
  if (record.toolchain !== 'naga-oil') return invalid('toolchain', record.toolchain);
  if (record.instrumentation !== 'none' && record.instrumentation !== 'validation') {
    return invalid('instrumentation', record.instrumentation);
  }
  return ok(value as MaterialVariantContext);
}

/**
 * Lower a validated domain snapshot to the compiler's private boolean selectors.
 * Material callers cannot provide or merge this map themselves.
 */
export function lowerMaterialVariantContext(
  context: MaterialVariantContext,
): Readonly<Record<string, boolean>> {
  return Object.freeze({
    STORAGE_BUFFER_AVAILABLE: context.capability === 'storage-buffer',
    WEBGL2_COMPAT: context.backend === 'webgl2',
    PER_INSTANCE_REGION: false,
    POINT_SHADOW_AVAILABLE: false,
  });
}
