// shadow-csm-extract.test.ts — feat-20260621-merge-directionallightshadow-into-directionallight M2
// TDD red test: castShadow gate + ExtractedLights bias/PCF fields.
//
// After M1 (component merge), DirectionalLight carries the 9 shadow fields
// and castShadow:bool (default true).
// This test asserts the extract stage:
//   (a) castShadow:true  → CSM path runs (lightViewProj + cascades populated)
//   (b) castShadow:false → CSM path skipped (no cascade output)
//   (c) ExtractedLights carries depthBias/normalBias/pcfKernelSize
//   (d) bias/PCF fields are undefined when castShadow:false
// RED before m2-t2/m2-t3: extract still queries the deleted
// castShadow: true; lightViewProj won't populate.

import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Camera, DirectionalLight, Transform } from '../components';
import { extractFrame } from '../render-system-extract';

function makeWorld(castShadow?: boolean): World {
  const world = new World();
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [0, -1, 0],
      castShadow: castShadow ?? true,
      depthBias: 0.01,
      normalBias: 0.08,
      pcfKernelSize: 5,
    },
  });
  world.spawn(
    { component: Transform, data: {} },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
    },
  );
  return world;
}

describe('ExtractedLights interface (M2 castShadow gate)', () => {
  describe('castShadow=true (default): CSM path runs', () => {
    it('lightViewProj is an array of 4 Float32Array mat4s', () => {
      const world = makeWorld(true);
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
      const world = makeWorld(true);
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
      const world = makeWorld(true);
      const frame = extractFrame(world);
      expect(frame.lights.cascadeCount).toBe(4);
      expect(frame.lights.cascadeBlend).toBeCloseTo(0.2, 5);
    });
  });

  describe('castShadow=false: CSM path skipped', () => {
    it('lightViewProj is undefined when castShadow=false', () => {
      const world = makeWorld(false);
      const frame = extractFrame(world);
      expect(frame.lights.lightViewProj).toBeUndefined();
    });

    it('splitPlanes, cascadeCount, cascadeBlend are undefined', () => {
      const world = makeWorld(false);
      const frame = extractFrame(world);
      expect(frame.lights.splitPlanes).toBeUndefined();
      expect(frame.lights.cascadeCount).toBeUndefined();
      expect(frame.lights.cascadeBlend).toBeUndefined();
    });
  });

  describe('ExtractedLights carries bias/PCF from merged DirectionalLight', () => {
    it('depthBias populated when castShadow=true', () => {
      const world = makeWorld(true);
      const frame = extractFrame(world);
      expect(frame.lights.depthBias).toBeCloseTo(0.01, 5);
    });

    it('normalBias populated when castShadow=true', () => {
      const world = makeWorld(true);
      const frame = extractFrame(world);
      expect(frame.lights.normalBias).toBeCloseTo(0.08, 5);
    });

    it('pcfKernelSize populated when castShadow=true', () => {
      const world = makeWorld(true);
      const frame = extractFrame(world);
      expect(frame.lights.pcfKernelSize).toBe(5);
    });

    it('depthBias, normalBias, pcfKernelSize are undefined when castShadow=false', () => {
      const world = makeWorld(false);
      const frame = extractFrame(world);
      expect(frame.lights.depthBias).toBeUndefined();
      expect(frame.lights.normalBias).toBeUndefined();
      expect(frame.lights.pcfKernelSize).toBeUndefined();
    });
  });

  describe('N=1 (single cascade degeneracy)', () => {
    it('lightViewProj[0] valid, [1..3] zero matrices', () => {
      const world = new World();
      world.spawn({
        component: DirectionalLight,
        data: {
          direction: [0, -1, 0],
          cascadeCount: 1,
          shadowDistance: 100,
        },
      });
      world.spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      );

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
      const world = makeWorld(true);
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
  describe('pcfKernelSize wiring (M0, AC-14; merged DirectionalLight)', () => {
    function setupWorldWithPcf(pcfKernelSize: number): World {
      const world = new World();
      // feat-20260621: shadow fields merged onto DirectionalLight (castShadow
      // defaults true); pcfKernelSize is read from the same component.
      world.spawn({
        component: DirectionalLight,
        data: {
          direction: [0, -1, 0],
          cascadeCount: 1,
          shadowDistance: 100,
          pcfKernelSize,
        },
      });
      world.spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      );
      return world;
    }

    it('reads pcfKernelSize=1 from the merged component', () => {
      const frame = extractFrame(setupWorldWithPcf(1));
      expect(frame.lights.pcfKernelSize).toBe(1);
    });

    it('reads pcfKernelSize=3 from the merged component', () => {
      const frame = extractFrame(setupWorldWithPcf(3));
      expect(frame.lights.pcfKernelSize).toBe(3);
    });

    it('reads pcfKernelSize=5 from the merged component', () => {
      const frame = extractFrame(setupWorldWithPcf(5));
      expect(frame.lights.pcfKernelSize).toBe(5);
    });

    it('defaults pcfKernelSize to 3 when the component omits it', () => {
      const world = new World();
      world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], cascadeCount: 1 },
      });
      world.spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      );
      const frame = extractFrame(world);
      expect(frame.lights.pcfKernelSize).toBe(3);
    });
  });
});
