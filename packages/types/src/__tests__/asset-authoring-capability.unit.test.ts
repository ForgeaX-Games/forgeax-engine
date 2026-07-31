import { describe, expect, it } from 'vitest';
import { authoringCapabilityForAssetKind } from '../index';

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
});
