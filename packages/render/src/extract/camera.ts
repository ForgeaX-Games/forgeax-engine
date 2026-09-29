import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { readRenderArrayView } from '@forgeax/engine-ecs/projection';
import { mat4, vec3 } from '@forgeax/engine-math';
import { GlobalTransform } from '@forgeax/engine-scene';
import {
  BarrelDistortion,
  validateBarrelDistortionParameters,
} from '../components/barrel-distortion';
import {
  antialiasFromF32,
  Camera,
  cameraExposureFromColumns,
  cameraProjectionFromF32,
  tonemapFromF32,
  transparencyFromF32,
  validateCameraBloom,
  validateCameraColorGrading,
} from '../components/camera';
import { ClippingPlanes, extractClippingPlanes } from '../components/clipping-planes';
import { DepthOfField } from '../components/depth-of-field';
import {
  DynamicResolution,
  validateDynamicResolutionCamera,
} from '../components/dynamic-resolution';
import { LensEffects, resolveLensEffects } from '../components/lens-effects';
import { MotionBlur } from '../components/motion-blur';
import { Outline, resolveOutline } from '../components/outline';
import { ScreenSpaceReflection } from '../components/screen-space-reflection';
import {
  depthOfFieldRequestFailure,
  resolveDepthOfFieldParams,
} from '../features/depth-of-field/depth-of-field-params';
import { resolveMotionBlurParams } from '../features/motion-blur/motion-blur-params';
import type { CameraSnapshot } from '../render-contract';
import { getActiveCamera, selectActiveCameraIndex } from '../systems/active-camera';

function readWorldMatrix(world: World, entity: EntityHandle): Float32Array | undefined {
  const view = readRenderArrayView(world, entity, GlobalTransform, 'world');
  return view === undefined ? undefined : new Float32Array(view);
}

/** Extract the selected camera once at the frame boundary. */
export function extractCameraSnapshots(world: World): CameraSnapshot[] {
  const cameras: CameraSnapshot[] = [];
  const cameraEntities: number[] = [];
  const cameraQuery = world
    .query({
      read: [Camera],
      optional: [
        MotionBlur,
        DynamicResolution,
        ScreenSpaceReflection,
        DepthOfField,
        BarrelDistortion,
        LensEffects,
        ClippingPlanes,
        Outline,
      ],
      with: [GlobalTransform],
    })
    .unwrap();
  for (const row of cameraQuery) {
    const cam = row.get(Camera);
    const clipping = extractClippingPlanes(row.get(ClippingPlanes));
    const motionBlur = row.get(MotionBlur);
    const barrelDistortion = row.get(BarrelDistortion);
    const lensEffects = resolveLensEffects(row.get(LensEffects));
    if (!lensEffects.ok) throw lensEffects.error;
    const outline = resolveOutline(row.get(Outline));
    if (!outline.ok) throw outline.error;
    const motionBlurResult = resolveMotionBlurParams(motionBlur);
    if (!motionBlurResult.ok) throw motionBlurResult.error;
    const motionBlurParams = motionBlurResult.value;
    const depthOfField = row.get(DepthOfField);
    validateCameraColorGrading(cam.temperature, cam.tint, cam.colorLutStrength);
    const dynamicResolution = row.get(DynamicResolution);
    const projection = cameraProjectionFromF32(cam.projection);
    const depthOfFieldResult = resolveDepthOfFieldParams(depthOfField, {
      projection,
      fov: cam.fov,
      near: cam.near,
      far: cam.far,
    });
    const depthOfFieldError = depthOfFieldResult.ok
      ? undefined
      : depthOfFieldRequestFailure(depthOfFieldResult.error);
    const screenSpaceReflection = row.get(ScreenSpaceReflection);
    const bloom = validateCameraBloom(
      cam.bloom,
      cam.bloomThreshold,
      cam.bloomIntensity,
      cam.bloomSoftKnee,
      cam.bloomScatter,
    );
    const entity = row.entity as EntityHandle;
    const worldMat = readWorldMatrix(world, entity);
    if (worldMat === undefined) continue;
    const antialias = antialiasFromF32(cam.antialias);
    const dynamicResolutionResult = validateDynamicResolutionCamera(dynamicResolution, antialias);
    if (!dynamicResolutionResult.ok) throw dynamicResolutionResult.error;
    const barrelDistortionResult = validateBarrelDistortionParameters(barrelDistortion);
    if (!barrelDistortionResult.ok) throw barrelDistortionResult.error;
    cameras.push({
      entityKey: entity as number,
      historyVersion: cam.historyVersion,
      position: mat4.getTranslation(vec3.create(), worldMat),
      world: worldMat,
      fov: cam.fov,
      aspect: cam.aspect,
      near: cam.near,
      far: cam.far,
      projection,
      orthoLeft: cam.left,
      orthoRight: cam.right,
      orthoBottom: cam.bottom,
      orthoTop: cam.top,
      tonemap: tonemapFromF32(cam.tonemap),
      exposure: cam.exposure,
      whitePoint: cam.whitePoint,
      output: {
        exposure: cameraExposureFromColumns(cam),
        temperature: cam.temperature,
        tint: cam.tint,
        colorLut: cam.colorLut,
        colorLutStrength: cam.colorLutStrength,
      },
      antialias: antialiasFromF32(cam.antialias),
      transparency: transparencyFromF32(cam.transparency),
      ...(dynamicResolutionResult.value === undefined
        ? {}
        : { dynamicResolution: dynamicResolutionResult.value }),
      bloom,
      bloomThreshold: cam.bloomThreshold,
      bloomIntensity: cam.bloomIntensity,
      bloomSoftKnee: cam.bloomSoftKnee,
      bloomScatter: cam.bloomScatter,
      clearColor: [
        cam.clearColor[0] ?? 0,
        cam.clearColor[1] ?? 0,
        cam.clearColor[2] ?? 0,
        cam.clearColor[3] ?? 1,
      ],
      ...(depthOfFieldResult.ok && depthOfFieldResult.value !== undefined
        ? { depthOfField: depthOfFieldResult.value }
        : {}),
      ...(depthOfFieldError === undefined ? {} : { depthOfFieldError }),
      ...(motionBlurParams === undefined
        ? {}
        : {
            motionBlur: {
              shutterAngle: motionBlurParams.shutterAngle,
              maxRadiusPixels: motionBlurParams.maxRadiusPixels,
              sampleCount: motionBlurParams.sampleCount,
              targetFps: motionBlurParams.targetFps,
            },
          }),
      ...(clipping === undefined ? {} : { clipping }),
      ...(outline.value === undefined ? {} : { outline: outline.value }),
      ...(lensEffects.value === undefined ? {} : { lensEffects: lensEffects.value }),
      ...(barrelDistortion === undefined ? {} : { barrelDistortion: barrelDistortionResult.value }),
      ...(screenSpaceReflection === undefined
        ? {}
        : {
            screenSpaceReflection: {
              maxDistance: screenSpaceReflection.maxDistance,
              thickness: screenSpaceReflection.thickness,
              maxRoughness: screenSpaceReflection.maxRoughness,
            },
          }),
    });
    cameraEntities.push(entity as number);
  }
  const selected = selectActiveCameraIndex(cameraEntities, getActiveCamera(world)?.entity);
  if (selected < 0) return cameras;
  const camera = cameras[selected];
  return camera === undefined ? cameras : [camera];
}
