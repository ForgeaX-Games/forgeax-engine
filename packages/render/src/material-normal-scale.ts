/** Explicit material values override the legacy glTF texture-local scale. */
export function materialNormalScale(values: Readonly<Record<string, unknown>>): number {
  if (typeof values.normalScale === 'number' && Number.isFinite(values.normalScale)) {
    return values.normalScale;
  }
  const texture = values.normalTexture;
  if (typeof texture === 'object' && texture !== null && !Array.isArray(texture)) {
    const scale = (texture as { normalScale?: unknown }).normalScale;
    if (typeof scale === 'number' && Number.isFinite(scale)) return scale;
  }
  return 1;
}
