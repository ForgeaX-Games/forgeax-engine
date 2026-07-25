export interface SwapChainFormatPair {
  readonly storage: GPUTextureFormat;
  readonly view: GPUTextureFormat;
  readonly fallbackReason?: 'preferred-canvas-format-missing';
}

export function selectSwapChainFormat(storageBufferCapable: boolean): SwapChainFormatPair {
  if (!storageBufferCapable) {
    return { storage: 'rgba8unorm', view: 'rgba8unorm-srgb' };
  }
  const nav = (
    globalThis as { navigator?: { gpu?: { getPreferredCanvasFormat?: () => GPUTextureFormat } } }
  ).navigator;
  const gpu = nav?.gpu;
  const getPreferred = gpu?.getPreferredCanvasFormat;
  if (gpu !== undefined && typeof getPreferred === 'function') {
    const storage = getPreferred.call(gpu);
    return { storage, view: `${storage}-srgb` as unknown as GPUTextureFormat };
  }
  return {
    storage: 'rgba8unorm',
    view: 'rgba8unorm-srgb',
    fallbackReason: 'preferred-canvas-format-missing',
  };
}
