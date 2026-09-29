import {
  type MaterialCookRasterContext,
  validateMaterialCookProgramContext,
} from '@forgeax/engine-pack/material-cook';
import { err, ok, type Result } from '@forgeax/engine-types';

export type MaterialBackend = MaterialCookRasterContext['backend'];
export type MaterialCapability = MaterialCookRasterContext['capability'];
export type MaterialPipeline = MaterialCookRasterContext['pipeline'];
export type MaterialGeometry = MaterialCookRasterContext['geometry'];
export type MaterialPass = MaterialCookRasterContext['pass'];
export type MaterialInstrumentation = MaterialCookRasterContext['instrumentation'];
export type MaterialVariantContextInput = MaterialCookRasterContext;
export type MaterialVariantContext = MaterialCookRasterContext;

export const DEFAULT_MATERIAL_VARIANT_CONTEXT: MaterialVariantContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};

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
  'PROBE_BLEND_AVAILABLE',
  'PROJECTOR_AVAILABLE',
  'POINT_SHADOW_AVAILABLE',
  'PER_INSTANCE_REGION',
  'VISIBLE_SURFACE_AVAILABLE',
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
  }
  const validated = validateMaterialCookProgramContext(value);
  if (!validated.ok) {
    return invalid(
      validated.error.detail.field.replace(/^context\./, ''),
      validated.error.detail.actual,
    );
  }
  if (validated.value.pipeline === 'ray') return invalid('pipeline', 'ray');
  return ok(validated.value);
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
    // Standard local-light transport follows the device storage capability
    // in both render paths. Cooked Surface programs must retain that shared
    // lighting branch before their WGSL becomes compiler-free runtime input.
    CLUSTER_FORWARD_AVAILABLE: context.capability === 'storage-buffer',
    PROBE_BLEND_AVAILABLE: context.capability === 'storage-buffer',
    WEBGL2_COMPAT: context.backend === 'webgl2',
    PER_INSTANCE_REGION: context.geometry === 'sprite-instances',
    SKINNING_DISABLED: context.geometry !== 'skinned',
    POINT_SHADOW_AVAILABLE: false,
    MATERIAL_VALIDATION_ENABLED: context.instrumentation === 'validation',
    VISIBLE_SURFACE_AVAILABLE: context.visibleSurface === true,
  });
}
