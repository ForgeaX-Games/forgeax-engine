// shadow-csm-extract.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M2 / w7: ExtractedLights interface extension test (TDD: now green after w9).
//
// Covers AC-08 (ExtractedLights carries fixed-size lightViewProj[4] +
// splitPlanes[4] + cascadeCount/cascadeBlend scalars) and verifies
// lightSpaceMatrix is deleted.

import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Camera, DirectionalLight, DirectionalLightShadow, Transform } from '../components';
import { extractFrame } from '../render-system-extract';

describe('ExtractedLights interface (w7)', () => {
  function setupWorld(): World {
    const world = new World();
    world.spawn({
      component: DirectionalLight,
      data: { directionX: 0, directionY: -1, directionZ: 0 },
    });
    world.spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
      },
    );
    world.spawn({
      component: DirectionalLightShadow,
      data: { nearPlane: 0.1, farPlane: 100 },
    });
    return world;
  }

  describe('N=4 (default cascadeCount)', () => {
    it('lightViewProj is an array of 4 Float32Array mat4s', () => {
      const world = setupWorld();
      const frame = extractFrame(world);
      const { lightViewProj } = frame.lights;
      expect(lightViewProj).toBeDefined();
      if (lightViewProj === undefined) return;
      expect(Array.isArray(lightViewProj)).toBe(true);
      expect(lightViewProj.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        const m = lightViewProj[i];
        expect(m).toBeInstanceOf(Float32Array);
        expect(m).toHaveLength(16);
      }
    });

    it('splitPlanes is a Float32Array of length 4', () => {
      const world = setupWorld();
      const frame = extractFrame(world);
      const { splitPlanes } = frame.lights;
      expect(splitPlanes).toBeDefined();
      if (splitPlanes === undefined) return;
      expect(splitPlanes).toBeInstanceOf(Float32Array);
      expect(splitPlanes.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        const v = splitPlanes[i];
        expect(typeof v).toBe('number');
        expect(Number.isFinite(v)).toBe(true);
      }
    });

    it('cascadeCount and cascadeBlend scalars match component defaults', () => {
      const world = setupWorld();
      const frame = extractFrame(world);
      expect(frame.lights.cascadeCount).toBe(4);
      expect(frame.lights.cascadeBlend).toBeCloseTo(0.2, 5);
    });
  });

  describe('N=1 (single cascade degeneracy)', () => {
    it('lightViewProj[0] valid, [1..3] zero matrices', () => {
      const world = new World();
      world.spawn({
        component: DirectionalLight,
        data: { directionX: 0, directionY: -1, directionZ: 0 },
      });
      world.spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      );
      world.spawn({
        component: DirectionalLightShadow,
        data: { cascadeCount: 1, nearPlane: 0.1, farPlane: 100 },
      });

      const frame = extractFrame(world);
      const { lightViewProj, cascadeCount } = frame.lights;
      expect(cascadeCount).toBe(1);
      expect(lightViewProj).toBeDefined();
      if (lightViewProj === undefined) return;
      expect(lightViewProj.length).toBe(4);

      const m0 = lightViewProj[0];
      expect(m0).toBeInstanceOf(Float32Array);
      expect(m0).toHaveLength(16);
      if (m0 !== undefined) {
        const m0NonZero = Array.from(m0).some((v) => v !== 0);
        expect(m0NonZero).toBe(true);
      }

      for (let i = 1; i < 4; i++) {
        const m = lightViewProj[i];
        if (m !== undefined) {
          expect(m).toBeInstanceOf(Float32Array);
          expect(m).toHaveLength(16);
          const allZero = Array.from(m).every((v) => v === 0);
          expect(allZero).toBe(true);
        }
      }
    });
  });

  describe('lightSpaceMatrix deleted', () => {
    it('ExtractedLights does not have lightSpaceMatrix property', () => {
      const world = setupWorld();
      const frame = extractFrame(world);
      expect('lightSpaceMatrix' in frame.lights).toBe(false);
    });
  });

  // feat-20260621-learn-render-5-3-production-shadow-demos M0 / AC-14:
  // extract reads DirectionalLightShadow.pcfKernelSize into the frame lights
  // struct (symmetric with cascadeCount/cascadeBlend). Before M0 this field is
  // dead (research F7): extract never read it, so frame.lights.pcfKernelSize
  // is undefined regardless of the component value -- these cases are RED
  // until M0-T-IMPL-EXTRACT lands.
  describe('pcfKernelSize wiring (M0, AC-14)', () => {
    function setupWorldWithPcf(pcfKernelSize: number): World {
      const world = new World();
      world.spawn({
        component: DirectionalLight,
        data: { directionX: 0, directionY: -1, directionZ: 0 },
      });
      world.spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      );
      world.spawn({
        component: DirectionalLightShadow,
        data: { cascadeCount: 1, nearPlane: 0.1, farPlane: 100, pcfKernelSize },
      });
      return world;
    }

    it('reads pcfKernelSize=1 from the component', () => {
      const frame = extractFrame(setupWorldWithPcf(1));
      expect(frame.lights.pcfKernelSize).toBe(1);
    });

    it('reads pcfKernelSize=3 from the component', () => {
      const frame = extractFrame(setupWorldWithPcf(3));
      expect(frame.lights.pcfKernelSize).toBe(3);
    });

    it('reads pcfKernelSize=5 from the component', () => {
      const frame = extractFrame(setupWorldWithPcf(5));
      expect(frame.lights.pcfKernelSize).toBe(5);
    });

    it('defaults pcfKernelSize to 3 when the component omits it', () => {
      const world = setupWorld();
      const frame = extractFrame(world);
      expect(frame.lights.pcfKernelSize).toBe(3);
    });
  });
});
