/**
 * Realm-neutral material case facts shared by Dawn and Browser carriers.
 * This module only projects frozen POD input; it does not allocate resources.
 */
export function describeMaterialCase(item, input) {
  const textureField =
    item.semantic === 'factor-r'
      ? 'clearcoatTexture'
      : item.semantic === 'roughness-g'
        ? 'clearcoatRoughnessTexture'
        : 'clearcoatNormalTexture';
  return {
    caseId: item.caseId,
    lighting: item.lighting,
    geometry: item.geometry,
    semantic: item.semantic,
    authoredSlot: item.authoredSlot,
    channel: item.channel,
    textureField,
    baseColor: input.material.baseColor,
    metallic: input.material.metallic,
    roughness: input.material.roughness,
    clearcoat: input.material.clearcoat,
    clearcoatRoughness: input.material.clearcoatRoughness,
    clearcoatNormalScale: item.semantic === 'coat-normal-isolation'
      ? input.material.clearcoatNormalScale * 0.5
      : input.material.clearcoatNormalScale,
    position: input.geometry.casePositions[item.caseId],
  };
}

export function isTextureCase(item) {
  return item.semantic === 'factor-r' || item.semantic === 'roughness-g' || item.semantic === 'normal-rg' || item.semantic === 'coat-normal-isolation';
}
