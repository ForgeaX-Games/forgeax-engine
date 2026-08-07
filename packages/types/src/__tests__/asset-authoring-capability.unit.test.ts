import { describe, expect, it } from 'vitest';
import {
  authoringCapabilityForAssetKind,
  catalogOperationsFor,
  isCatalogProjectionValid,
} from '../index';

describe('producer-owned asset authoring capability', () => {
  it('publishes placement and binding shape for built-in kinds', () => {
    expect(authoringCapabilityForAssetKind('mesh')).toEqual({
      placement: { operation: 'spawnEntity' },
      binding: {
        operation: 'bindAssetRef',
        target: {
          component: 'MeshFilter',
          field: 'assetHandle',
          assetType: 'MeshAsset',
          cardinality: 'single',
        },
        requiredSlots: 1,
      },
    });
    expect(authoringCapabilityForAssetKind('scene').placement).toEqual({
      operation: 'addSceneAssetToScene',
    });
  });

  it('publishes the producer-owned particle effect binding contract', () => {
    expect(authoringCapabilityForAssetKind('particle-effect')).toEqual({
      placement: { operation: 'spawnEntity' },
      binding: {
        operation: 'bindAssetRef',
        target: {
          component: 'ParticleEffectPlayer',
          field: 'effect',
          assetType: 'ParticleEffectAsset',
          cardinality: 'single',
        },
        requiredSlots: 1,
      },
    });

    expect(authoringCapabilityForAssetKind('mesh').binding).toMatchObject({
      target: { assetType: 'MeshAsset' },
    });
    expect(authoringCapabilityForAssetKind('material').binding).toMatchObject({
      target: { assetType: 'MaterialAsset' },
    });
    expect(authoringCapabilityForAssetKind('audio').binding).toEqual({
      operation: 'unavailable',
      reason: {
        code: 'unsupported-asset-kind',
        hint: expect.stringContaining('binding capability'),
      },
    });
  });

  it('fails closed with a structured reason for a new kind without a producer fact', () => {
    const capability = authoringCapabilityForAssetKind('host/new-kind');
    expect(capability.placement).toEqual({
      operation: 'unavailable',
      reason: { code: 'unsupported-asset-kind', hint: expect.any(String) },
    });
    expect(capability.binding).toEqual({
      operation: 'unavailable',
      reason: { code: 'unsupported-asset-kind', hint: expect.any(String) },
    });
  });

  it('projects capabilities without deriving them from kind or path', () => {
    const operations = catalogOperationsFor({
      subject: 'imported-output',
      execution: 'cooked',
      lifecycle: 'stale',
    });

    expect(operations.sourceOverride).toEqual({ operation: 'sourceOverride', enabled: true });
    expect(operations.save).toMatchObject({ operation: 'save', enabled: false });
    expect(
      isCatalogProjectionValid({
        subject: 'imported-output',
        execution: 'cooked',
        lifecycle: 'stale',
        operations,
      }),
    ).toBe(true);
  });
});
