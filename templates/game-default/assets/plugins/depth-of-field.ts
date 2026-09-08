import { PostProcessParams, type Renderer } from '@forgeax/engine-render';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { GameHost } from '@forgeax/engine-app';
import type { Context } from '@forgeax/engine-plugin';
import dofShader from '../shaders/depth-of-field.wgsl';
import { installGameFullscreenFeature } from './fullscreen-feature';

export const DEPTH_OF_FIELD_ID = 'game-default::depth-of-field';
export const DOF_PARAM_BYTES = 32;
const DOF_MODE_OFF = 0;
const DOF_MODE_BOKEH = 2;

export interface DepthOfFieldSnapshot {
  readonly enabled: boolean;
  readonly mode: 'off' | 'bokeh';
  readonly focalDistance: number;
  readonly aperture: number;
  readonly effect: string;
}

export interface DepthOfFieldHandle {
  readonly paramsEntity: EntityHandle;
  readonly installed: boolean;
  readonly error?: string;
  setEnabled(enabled: boolean): void;
  reset(): void;
  dispose(): void;
  snapshot(): DepthOfFieldSnapshot;
}

function packParams(enabled: boolean, focalDistance: number, aperture: number): Uint8Array {
  const bytes = new ArrayBuffer(DOF_PARAM_BYTES);
  const values = new Float32Array(bytes);
  values[0] = focalDistance;
  values[1] = 0.1;
  values[2] = 200;
  values[3] = enabled ? DOF_MODE_BOKEH : DOF_MODE_OFF;
  values[4] = aperture;
  values[5] = 10;
  return new Uint8Array(bytes);
}

export async function installDepthOfField(
  context: Context,
  world: World,
  host: GameHost | undefined,
  renderer: Renderer | undefined,
  initialEnabled: boolean,
): Promise<DepthOfFieldHandle> {
  const focalDistance = 7;
  const aperture = 0.8;
  const params = packParams(initialEnabled, focalDistance, aperture);
  const paramsEntity = world.spawn({ component: PostProcessParams, data: { shader: DEPTH_OF_FIELD_ID, data: params } }).unwrap();
  if (!renderer) {
    return {
      paramsEntity,
      installed: false,
      error: 'Renderer is unavailable; depth-of-field remains disabled.',
      setEnabled: () => {},
      reset: () => {},
      dispose: () => {},
      snapshot: () => ({ enabled: false, mode: 'off', focalDistance, aperture, effect: DEPTH_OF_FIELD_ID }),
    };
  }
  const feature = await installGameFullscreenFeature(context, host, renderer, {
    identity: DEPTH_OF_FIELD_ID,
    source: dofShader.wgsl,
    reads: [{ key: 'sceneColor' }, { key: 'depth', sampleType: 'depth' }],
    params: { byteSize: DOF_PARAM_BYTES, defaultValue: params },
  });
  let enabled = initialEnabled;
  const write = (): void => { world.set(paramsEntity, PostProcessParams, { data: packParams(enabled, focalDistance, aperture) }); };
  return {
    paramsEntity,
    installed: feature.installed,
    ...(feature.error === undefined ? {} : { error: feature.error }),
    setEnabled(next: boolean): void { enabled = next; write(); },
    reset(): void { enabled = initialEnabled; write(); },
    dispose: feature.dispose,
    snapshot(): DepthOfFieldSnapshot {
      return { enabled: feature.installed && enabled, mode: feature.installed && enabled ? 'bokeh' : 'off', focalDistance, aperture, effect: DEPTH_OF_FIELD_ID };
    },
  };
}
