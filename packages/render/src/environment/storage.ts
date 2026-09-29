import type { Buffer, Texture } from '@forgeax/engine-rhi';
import type { DeviceScope } from '../device/device-scope';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import type { RenderPipelineFrame } from '../render-pipeline';

/** Device-generation resources survive unrelated probe/scene graph topology changes. */
export interface AtmosphereStorage {
  readonly sky: Texture;
  readonly irradiance: Texture;
  readonly prefilter: Texture;
  readonly params: Buffer;
  readonly vertices: Buffer;
  readonly iblParams: Buffer;
  submittedSignature?: string | undefined;
}
const generations = new WeakMap<DeviceScope, AtmosphereStorage>();

export function atmosphereStorage(frame: RenderPipelineFrame): AtmosphereStorage {
  const runtime = (frame as _InternalRenderPipelineContext).runtime;
  const owner = runtime.deviceScope;
  const existing = generations.get(owner);
  if (existing !== undefined) return existing;
  const scope = owner.createChild('atmosphere');
  const device = runtime.device;
  try {
    const texture = (name: string, size: number, mipLevelCount = 1) => {
      const value = device
        .createTexture({
          label: name,
          format: 'rgba16float',
          size: { width: size, height: size, depthOrArrayLayers: 6 },
          mipLevelCount,
          usage: 0x14,
          textureBindingViewDimension: undefined,
        })
        .unwrap();
      scope._adopt('texture', value, (value) => {
        device.destroyTexture(value).unwrap();
      });
      return value;
    };
    const buffer = (name: string, size: number, usage: number) => {
      const value = device.createBuffer({ label: name, size, usage }).unwrap();
      scope._adopt('buffer', value, (value) => {
        device.destroyBuffer(value).unwrap();
      });
      return value;
    };
    const created: AtmosphereStorage = {
      sky: texture('atmosphere-sky', 128),
      irradiance: texture('atmosphere-irradiance', 16),
      prefilter: texture('atmosphere-prefilter', 64, 5),
      params: buffer('atmosphere-params', 64, 0x48),
      vertices: buffer('atmosphere-face-vertices', 216, 0x28),
      iblParams: buffer('atmosphere-ibl-params', 1280, 0x48),
    };
    generations.set(owner, created);
    return created;
  } catch (cause) {
    scope.retire();
    throw cause;
  }
}
