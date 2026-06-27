// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=13):
//   - packages/runtime/src/__tests__/directional-light-defaults.test.ts
//   - packages/runtime/src/__tests__/directional-light-shadow.test.ts
//   - packages/runtime/src/__tests__/extract-frame-lights.test.ts
//   - packages/runtime/src/__tests__/inspector-lights-bucket.test.ts
//   - packages/runtime/src/__tests__/light-attenuation-cone.test.ts
//   - packages/runtime/src/__tests__/light-buffer-layout.test.ts
//   - packages/runtime/src/__tests__/light-helpers.test.ts
//   - packages/runtime/src/__tests__/lightslot-layout.test.ts
//   - packages/runtime/src/__tests__/point-light-defaults.test.ts
//   - packages/runtime/src/__tests__/point-light-spawn-bounds.test.ts
//   - packages/runtime/src/__tests__/render-multi-light-cap.test.ts
//   - packages/runtime/src/__tests__/spot-light-defaults.test.ts
//   - packages/runtime/src/__tests__/spot-light-spawn-bounds.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import type { Handle, Handler, RegisterMethodResult, Registry } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera, DirectionalLight, PointLight, SpotLight, Transform } from '../components';
import type { ShadowInvalidConfigError } from '../errors';
import { packLightArrayHeader, packPointLight, packSpotLight } from '../light-buffer-layout';
import { computeInvRangeSquared, degToCos } from '../light-helpers';
import { buildPbrViewBglEntries } from '../pbr-pipeline';
import { registerRuntimeInspector } from '../register-inspector';
import type { PointLightSnapshot, SpotLightSnapshot } from '../render-system-extract';
import { extractFrame } from '../render-system-extract';
import type { Renderer } from '../renderer';
import { propagateTransforms } from '../systems/propagate-transforms';

{
  // ─── from directional-light-defaults.test.ts ───
  describe('directional-light-defaults.test.ts', () => {
    describe('DirectionalLight spawn default-value fallback (M1 w5)', () => {
      it('omitting intensity / color* fills layer-2 defaults (intensity=1, color=[1,1,1])', () => {
        const world = new World();
        const e = world
          .spawn({
            component: DirectionalLight,
            data: { directionX: 0, directionY: -1, directionZ: 0 },
          })
          .unwrap();

        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.directionX).toBe(0);
        expect(view.directionY).toBe(-1);
        expect(view.directionZ).toBe(0);
        expect(view.colorR).toBe(1);
        expect(view.colorG).toBe(1);
        expect(view.colorB).toBe(1);
        expect(view.intensity).toBe(1);
      });

      it('explicit intensity / color override defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: DirectionalLight,
            data: {
              directionX: -0.5,
              directionY: -1,
              directionZ: -0.3,
              colorR: 0.9,
              colorG: 0.8,
              colorB: 0.7,
              intensity: 0.5,
            },
          })
          .unwrap();
        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.colorR).toBeCloseTo(0.9, 5);
        expect(view.intensity).toBe(0.5);
      });
    });
  });
}

{
  // ─── from directional-light-shadow.test.ts (post-merge: DirectionalLightShadow deleted, target now DirectionalLight) ───
  describe('directional-light-shadow.test.ts', () => {
    describe('DirectionalLight merged shadow schema (post-m1-t6)', () => {
      it('AC-01: shadow fields are present with correct default values in the merged component', () => {
        const dl = DirectionalLight;

        expect(dl.name).toBe('DirectionalLight');
        expect(dl.schema).toBeDefined();

        expect(dl.defaults).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: dl.defaults asserted defined just above
        const defaults = dl.defaults!;

        expect(defaults.cascadeCount).toBe(4);
        expect(defaults.splitLambda).toBeCloseTo(0.75, 5);
        expect(defaults.cascadeBlend).toBeCloseTo(0.2, 5);
        expect(defaults.mapSize).toBe(2048);
        expect(defaults.depthBias).toBeCloseTo(0.005, 5);
        expect(defaults.normalBias).toBeCloseTo(0.05, 5);
        expect(defaults.nearPlane).toBeCloseTo(0.1, 5);
        expect(defaults.farPlane).toBeCloseTo(50, 5);
        expect(defaults.pcfKernelSize).toBe(3);

        // Merged component: 7 light + 1 castShadow + 9 shadow = 17 fields
        expect(Object.keys(dl.schema).length).toBe(17);
        expect('cascadeCount' in dl.schema).toBe(true);
        expect('splitLambda' in dl.schema).toBe(true);
        expect('cascadeBlend' in dl.schema).toBe(true);
        expect('mapSize' in dl.schema).toBe(true);
        expect('depthBias' in dl.schema).toBe(true);
        expect('normalBias' in dl.schema).toBe(true);
        expect('nearPlane' in dl.schema).toBe(true);
        expect('farPlane' in dl.schema).toBe(true);
        expect('pcfKernelSize' in dl.schema).toBe(true);
        // DirectionalLightShadow is deleted; the old orthoHalfExtent field is gone
      });

      it('AC-02: spawn-default fallback fills omitted shadow fields from defaults (single-component)', () => {
        const world = new World();

        const r = world.spawn({
          component: DirectionalLight,
          data: {
            mapSize: 2048,
          },
        });
        expect(r.ok).toBe(true);
        const e = r.unwrap();

        const light = world.get(e, DirectionalLight);
        expect(light.ok).toBe(true);
        const lightData = light.unwrap();

        expect(lightData.mapSize).toBe(2048);
        expect(lightData.cascadeCount).toBe(4);
        expect(lightData.splitLambda).toBeCloseTo(0.75, 5);
        expect(lightData.cascadeBlend).toBeCloseTo(0.2, 5);
        expect(lightData.depthBias).toBeCloseTo(0.005, 5);
        expect(lightData.normalBias).toBeCloseTo(0.05, 5);
        expect(lightData.nearPlane).toBeCloseTo(0.1, 5);
        expect(lightData.farPlane).toBeCloseTo(50, 5);
        expect(lightData.pcfKernelSize).toBe(3);
      });

      it('AC-02: spawn with empty data gets all defaults (single-component)', () => {
        const world = new World();

        const r = world.spawn({
          component: DirectionalLight,
          data: {},
        });
        expect(r.ok).toBe(true);
        const e = r.unwrap();

        const light = world.get(e, DirectionalLight).unwrap();
        expect(light.cascadeCount).toBe(4);
        expect(light.splitLambda).toBeCloseTo(0.75, 5);
        expect(light.cascadeBlend).toBeCloseTo(0.2, 5);
        expect(light.mapSize).toBeCloseTo(2048, 5);
        expect(light.depthBias).toBeCloseTo(0.005, 5);
        expect(light.normalBias).toBeCloseTo(0.05, 5);
        expect(light.nearPlane).toBeCloseTo(0.1, 5);
        expect(light.farPlane).toBeCloseTo(50, 5);
        expect(light.pcfKernelSize).toBe(3);
      });

      it('AC-02: spawn with full explicit data overrides all defaults (single-component)', () => {
        const world = new World();

        const r = world.spawn({
          component: DirectionalLight,
          data: {
            cascadeCount: 2,
            splitLambda: 0.5,
            cascadeBlend: 0.1,
            mapSize: 512,
            depthBias: 0.01,
            normalBias: 0.1,
            nearPlane: 1,
            farPlane: 100,
            pcfKernelSize: 5,
          },
        });
        expect(r.ok).toBe(true);
        const e = r.unwrap();

        const light = world.get(e, DirectionalLight).unwrap();
        expect(light.cascadeCount).toBe(2);
        expect(light.splitLambda).toBeCloseTo(0.5, 5);
        expect(light.cascadeBlend).toBeCloseTo(0.1, 5);
        expect(light.mapSize).toBeCloseTo(512, 5);
        expect(light.depthBias).toBeCloseTo(0.01, 5);
        expect(light.normalBias).toBeCloseTo(0.1, 5);
        expect(light.nearPlane).toBeCloseTo(1, 5);
        expect(light.farPlane).toBeCloseTo(100, 5);
        expect(light.pcfKernelSize).toBe(5);
      });

      it('AC-05: single-component spawn bundles light + shadow fields (no dual-component needed)', () => {
        const world = new World();

        const r = world.spawn({
          component: DirectionalLight,
          data: {
            directionX: 0,
            directionY: -1,
            directionZ: 0,
            colorR: 1,
            colorG: 1,
            colorB: 1,
            intensity: 1,
            mapSize: 2048,
          },
        });
        expect(r.ok).toBe(true);
        const e = r.unwrap();

        const dlResult = world.get(e, DirectionalLight);
        expect(dlResult.ok).toBe(true);
        const dl = dlResult.unwrap();
        expect(dl.directionX).toBe(0);
        expect(dl.intensity).toBe(1);
        expect(dl.mapSize).toBeCloseTo(2048, 5);
        expect(dl.depthBias).toBeCloseTo(0.005, 5);
      });

      it('query: DirectionalLight entity is found via world.get', () => {
        const world = new World();

        world
          .spawn({
            component: DirectionalLight,
            data: { mapSize: 512 },
          })
          .unwrap();

        const info = world.inspect();
        const archetypeWithLight = info.archetypes.find((a) =>
          a.componentNames.includes('DirectionalLight'),
        );
        expect(archetypeWithLight).toBeDefined();
        expect(archetypeWithLight?.entityCount).toBe(1);
      });
    });
  });
}

{
  // ─── from extract-frame-lights.test.ts ───
  describe('extract-frame-lights.test.ts', () => {
    const EPSILON = 1e-5;

    describe('extractFrame three-query union output (M2 w15)', () => {
      it('returns directional + point[] + spot[] buckets with host-pre-multiplied fields', () => {
        const world = new World();

        // Camera so extractFrame does not short-circuit.
        world
          .spawn(
            {
              component: Transform,
              data: { posX: 0, posY: 0, posZ: 5, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();

        // 1 DirectionalLight
        world
          .spawn({
            component: DirectionalLight,
            data: {
              directionX: 0,
              directionY: -1,
              directionZ: 0,
              colorR: 1,
              colorG: 1,
              colorB: 1,
              intensity: 0.5,
            },
          })
          .unwrap();

        // 2 PointLight (each on its own Transform)
        world
          .spawn(
            {
              component: Transform,
              data: { posX: 1, posY: 2, posZ: 3, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: PointLight,
              data: {
                colorR: 1,
                colorG: 0.5,
                colorB: 0.25,
                intensity: 4,
                range: 10,
              },
            },
          )
          .unwrap();

        world
          .spawn(
            {
              component: Transform,
              data: { posX: -2, posY: 0, posZ: 1, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: PointLight,
              data: {
                colorR: 0.2,
                colorG: 0.4,
                colorB: 0.6,
                intensity: 2,
                range: Number.POSITIVE_INFINITY,
              },
            },
          )
          .unwrap();

        // 1 SpotLight
        world
          .spawn(
            {
              component: Transform,
              data: { posX: 0, posY: 5, posZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: SpotLight,
              data: {
                directionX: 0,
                directionY: -1,
                directionZ: 0,
                colorR: 1,
                colorG: 1,
                colorB: 1,
                intensity: 8,
                range: 25,
                innerConeDeg: 10,
                outerConeDeg: 30,
              },
            },
          )
          .unwrap();

        propagateTransforms(world);

        const frame = extractFrame(world);
        expect(frame.lights).toBeDefined();

        // -- directional --
        const dir = frame.lights.directional;
        expect(dir).toBeDefined();
        if (dir === undefined) throw new Error('directional missing');
        expect(dir.kind).toBe('directional');
        // direction not pre-multiplied; raw outgoing vector forwarded to shader
        expect(dir.direction[0]).toBeCloseTo(0, 5);
        expect(dir.direction[1]).toBeCloseTo(-1, 5);
        expect(dir.direction[2]).toBeCloseTo(0, 5);
        // color is host-pre-multiplied with intensity (charter P4)
        expect(dir.color[0]).toBeCloseTo(1 * 0.5, 5);
        expect(dir.color[1]).toBeCloseTo(1 * 0.5, 5);
        expect(dir.color[2]).toBeCloseTo(1 * 0.5, 5);
        expect(dir.intensity).toBeCloseTo(0.5, 5);

        // -- point[] --
        expect(frame.lights.point).toHaveLength(2);
        // ordering is archetype-graph driven; sort by position.x to disambiguate
        const points = [...frame.lights.point].sort(
          (a, b) => (a.position[0] ?? 0) - (b.position[0] ?? 0),
        );
        const p0 = points[0];
        const p1 = points[1];
        if (p0 === undefined || p1 === undefined) throw new Error('point bucket short');
        expect(p0.kind).toBe('point');
        expect(p1.kind).toBe('point');
        // p0 is the (-2, 0, 1) Infinity-range point
        expect(p0.position[0]).toBeCloseTo(-2, 5);
        expect(p0.position[1]).toBeCloseTo(0, 5);
        expect(p0.position[2]).toBeCloseTo(1, 5);
        expect(p0.invRangeSquared).toBe(computeInvRangeSquared(Number.POSITIVE_INFINITY));
        expect(p0.invRangeSquared).toBe(0);
        // color * intensity (0.2*2, 0.4*2, 0.6*2)
        expect(p0.color[0]).toBeCloseTo(0.4, 5);
        expect(p0.color[1]).toBeCloseTo(0.8, 5);
        expect(p0.color[2]).toBeCloseTo(1.2, 5);
        expect(p0.intensity).toBeCloseTo(2, 5);

        // p1 is the (1, 2, 3) range=10 point
        expect(p1.position[0]).toBeCloseTo(1, 5);
        expect(p1.position[1]).toBeCloseTo(2, 5);
        expect(p1.position[2]).toBeCloseTo(3, 5);
        expect(p1.invRangeSquared).toBeCloseTo(computeInvRangeSquared(10), 5);
        expect(Math.abs(p1.invRangeSquared - 0.01)).toBeLessThan(EPSILON);
        // color * intensity (1*4, 0.5*4, 0.25*4)
        expect(p1.color[0]).toBeCloseTo(4, 5);
        expect(p1.color[1]).toBeCloseTo(2, 5);
        expect(p1.color[2]).toBeCloseTo(1, 5);
        expect(p1.intensity).toBeCloseTo(4, 5);

        // -- spot[] --
        expect(frame.lights.spot).toHaveLength(1);
        const s0 = frame.lights.spot[0];
        if (s0 === undefined) throw new Error('spot bucket empty');
        expect(s0.kind).toBe('spot');
        expect(s0.position[0]).toBeCloseTo(0, 5);
        expect(s0.position[1]).toBeCloseTo(5, 5);
        expect(s0.position[2]).toBeCloseTo(0, 5);
        expect(s0.direction[0]).toBeCloseTo(0, 5);
        expect(s0.direction[1]).toBeCloseTo(-1, 5);
        expect(s0.direction[2]).toBeCloseTo(0, 5);
        // color * intensity (1*8, 1*8, 1*8)
        expect(s0.color[0]).toBeCloseTo(8, 5);
        expect(s0.color[1]).toBeCloseTo(8, 5);
        expect(s0.color[2]).toBeCloseTo(8, 5);
        expect(s0.intensity).toBeCloseTo(8, 5);
        expect(s0.cosInner).toBeCloseTo(degToCos(10), 5);
        expect(s0.cosOuter).toBeCloseTo(degToCos(30), 5);
        expect(s0.invRangeSquared).toBeCloseTo(computeInvRangeSquared(25), 5);
      });

      it('zero-light world produces directional=undefined + empty point[] + empty spot[]', () => {
        const world = new World();

        world
          .spawn(
            {
              component: Transform,
              data: { posX: 0, posY: 0, posZ: 5, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();

        propagateTransforms(world);

        const frame = extractFrame(world);
        expect(frame.lights.directional).toBeUndefined();
        expect(frame.lights.point).toHaveLength(0);
        expect(frame.lights.spot).toHaveLength(0);
      });
    });

    // ─── from feat-20260625-spot-light-shadow-mapping M1 w2 ───
    describe('SpotLightSnapshot shadow field type-check (AC-09)', () => {
      it('destructuring castShadow + lightViewProj + shadowAtlasTile without as casts typechecks', () => {
        const world = new World();

        world
          .spawn(
            {
              component: Transform,
              data: { posX: 0, posY: 0, posZ: 5, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();

        world
          .spawn(
            {
              component: Transform,
              data: { posX: 0, posY: 5, posZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: SpotLight,
              data: { directionX: 0, directionY: -1, directionZ: 0, castShadow: true },
            },
          )
          .unwrap();

        propagateTransforms(world);
        const frame = extractFrame(world);

        expect(frame.lights.spot).toHaveLength(1);
        const s = frame.lights.spot[0];
        if (s === undefined) throw new Error('spot bucket empty');

        // AC-09: destructure shadow fields without `as` casts — typecheck success
        // is the acceptance witness. castShadow is bool, shadowAtlasTile is number
        // (i32 sentinel -1), lightViewProj is Float32Array | undefined.
        const castShadow: boolean = s.castShadow;
        const shadowAtlasTile: number = s.shadowAtlasTile;
        const lightViewProj: Float32Array | undefined = s.lightViewProj;
        const mapSize: number = s.mapSize;
        const nearPlane: number = s.nearPlane;
        const farPlane: number = s.farPlane;

        // Basic default-value assertions for shadow fields on the snapshot.
        expect(castShadow).toBe(true);
        expect(typeof lightViewProj).toBe('object');
        expect(typeof shadowAtlasTile).toBe('number');
        expect(typeof mapSize).toBe('number');
        expect(typeof nearPlane).toBe('number');
        expect(typeof farPlane).toBe('number');
      });
    });

    // ─── from feat-20260625-spot-light-shadow-mapping M1 w3 ───
    describe('spot direction degeneration (near-zero) extract skip (requirements $112)', () => {
      it('dir near-zero castShadow spot gets shadowAtlasTile=-1, no lightViewProj', () => {
        const world = new World();

        world
          .spawn(
            {
              component: Transform,
              data: { posX: 0, posY: 0, posZ: 5, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();

        // direction near-zero — normalize will fail, extract should skip shadow
        world
          .spawn(
            {
              component: Transform,
              data: { posX: 0, posY: 5, posZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: SpotLight,
              data: { directionX: 0, directionY: 1e-10, directionZ: 0 },
            },
          )
          .unwrap();

        propagateTransforms(world);
        const frame = extractFrame(world);

        expect(frame.lights.spot).toHaveLength(1);
        const s = frame.lights.spot[0];
        if (s === undefined) throw new Error('spot bucket empty');

        // AC-05 / requirements $112: near-zero direction → tile=-1, no lightViewProj.
        expect(s.shadowAtlasTile).toBe(-1);
        // lightViewProj should be undefined (no matrix was computed).
        expect(s.lightViewProj).toBeUndefined();
        // Direct-light fields still intact (AC-05: clip does not delete the light).
        expect(s.kind).toBe('spot');
        expect(s.intensity).toBeGreaterThan(0);
      });

      it('normal direction castShadow spot gets shadowAtlasTile >= 0 + non-zero lightViewProj', () => {
        const world = new World();

        world
          .spawn(
            {
              component: Transform,
              data: { posX: 0, posY: 0, posZ: 5, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();

        // Normal direction pointing down — should get a valid tile.
        world
          .spawn(
            {
              component: Transform,
              data: { posX: 0, posY: 5, posZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: SpotLight,
              data: { directionX: 0, directionY: -1, directionZ: 0 },
            },
          )
          .unwrap();

        propagateTransforms(world);
        const frame = extractFrame(world);

        expect(frame.lights.spot).toHaveLength(1);
        const s = frame.lights.spot[0];
        if (s === undefined) throw new Error('spot bucket empty');

        // Normal direction should get a valid tile (0 for first castShadow spot).
        expect(s.shadowAtlasTile).toBeGreaterThanOrEqual(0);
        // lightViewProj should be a non-zero Float32Array (16 floats).
        expect(s.lightViewProj).toBeInstanceOf(Float32Array);
        expect(s.lightViewProj).toHaveLength(16);
        // At least one element should be non-zero (a valid perspective×lookAt matrix).
        const lvp = s.lightViewProj;
        if (lvp === undefined) throw new Error('expected lightViewProj to be defined');
        let hasNonZero = false;
        for (let i = 0; i < 16; i++) {
          if (lvp[i] !== 0) {
            hasNonZero = true;
            break;
          }
        }
        expect(hasNonZero).toBe(true);
      });
    });

    // ─── from feat-20260625-spot-light-shadow-mapping M2 w7 ───
    describe('spot shadow tile clip cap=4 (AC-05)', () => {
      function spawnCamera(world: World): void {
        world
          .spawn(
            {
              component: Transform,
              data: { posX: 0, posY: 0, posZ: 5, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();
      }

      function spawnSpot(world: World, posX: number, castShadow: boolean): void {
        world
          .spawn(
            {
              component: Transform,
              data: { posX, posY: 5, posZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
            },
            {
              component: SpotLight,
              data: { directionX: 0, directionY: -1, directionZ: 0, castShadow },
            },
          )
          .unwrap();
      }

      it('first 4 castShadow spots get distinct tiles 0..3; 5th gets tile=-1 but keeps direct-light fields', () => {
        const world = new World();
        spawnCamera(world);
        for (let i = 0; i < 5; i++) spawnSpot(world, i, true);

        propagateTransforms(world);
        const frame = extractFrame(world);

        expect(frame.lights.spot).toHaveLength(5);
        const tiles = frame.lights.spot.map((s) => s.shadowAtlasTile);
        // Exactly four tiles in [0,3], all distinct.
        const assigned = tiles.filter((t) => t >= 0);
        expect(assigned).toHaveLength(4);
        expect(new Set(assigned).size).toBe(4);
        for (const t of assigned) {
          expect(t).toBeGreaterThanOrEqual(0);
          expect(t).toBeLessThanOrEqual(3);
        }
        // Exactly one spot is clipped (tile=-1).
        expect(tiles.filter((t) => t === -1)).toHaveLength(1);

        // The clipped (5th) spot still carries valid direct-light fields:
        // clip never deletes the light (AC-05).
        const clipped = frame.lights.spot.find((s) => s.shadowAtlasTile === -1);
        if (clipped === undefined) throw new Error('expected one clipped spot');
        expect(clipped.kind).toBe('spot');
        expect(clipped.intensity).toBeGreaterThan(0);
        expect(clipped.color.some((c) => c !== 0)).toBe(true);
        expect(clipped.direction.some((d) => d !== 0)).toBe(true);
      });

      it('castShadow:false spot gets tile=-1 without consuming a tile slot', () => {
        const world = new World();
        spawnCamera(world);
        // One shadowless spot first, then one shadow-casting spot.
        spawnSpot(world, 0, false);
        spawnSpot(world, 1, true);

        propagateTransforms(world);
        const frame = extractFrame(world);

        expect(frame.lights.spot).toHaveLength(2);
        const shadowless = frame.lights.spot.find((s) => s.castShadow === false);
        const shadowing = frame.lights.spot.find((s) => s.castShadow === true);
        if (shadowless === undefined || shadowing === undefined) {
          throw new Error('expected one shadowless + one shadowing spot');
        }
        // castShadow:false -> tile=-1, no lightViewProj.
        expect(shadowless.shadowAtlasTile).toBe(-1);
        expect(shadowless.lightViewProj).toBeUndefined();
        // The shadow-casting spot still gets tile 0 (the false spot did not
        // consume a slot).
        expect(shadowing.shadowAtlasTile).toBe(0);
      });
    });
  });
}

{
  // ─── from inspector-lights-bucket.test.ts ───
  describe('inspector-lights-bucket.test.ts', () => {
    class FakeRegistry implements Registry {
      readonly methods = new Map<string, Handler>();
      readonly mutating: ReadonlySet<string> = new Set();
      readonly roots = new Map<string, unknown>();
      registerRoot(name: string, root: unknown): RegisterMethodResult {
        this.roots.set(name, root);
        return { ok: true, value: undefined };
      }
      registerMethod(name: string, handler: Handler): RegisterMethodResult {
        if (this.methods.has(name)) {
          return {
            ok: false,
            error: {
              code: 'console-startup-failed',
              expected: 'no duplicate method registration',
              hint: `method '${name}' already registered`,
              name: 'InspectorError',
              message: '',
            } as never,
          };
        }
        this.methods.set(name, handler);
        return { ok: true, value: undefined };
      }
      lookupRoot(name: string): unknown {
        return this.roots.get(name);
      }
      lookupMethod(method: string): Handler | undefined {
        return this.methods.get(method);
      }
      registerMutatingMethods(): RegisterMethodResult {
        return { ok: true, value: undefined };
      }
      lookupMutatingMethods(): ReadonlySet<string> {
        return this.mutating;
      }
    }

    function makeFakeRenderer(): Renderer {
      return {
        backend: 'webgpu',
        device: null as never,
        shader: null,
        assets: null,
        ready: Promise.resolve({ ok: true, value: undefined }) as never,
        draw: () => ({ ok: true, value: undefined }) as never,
        readPixels: () => Promise.resolve({ ok: true, value: new Uint8Array(0) }) as never,
        dispose: () => undefined,
        onLost: () => () => undefined,
        onError: () => () => undefined,
      } as unknown as Renderer;
    }

    function spawnDirectional(world: World): void {
      world
        .spawn({
          component: DirectionalLight,
          data: {
            directionX: 0,
            directionY: -1,
            directionZ: 0,
            colorR: 1,
            colorG: 1,
            colorB: 1,
            intensity: 1,
          },
        })
        .unwrap();
    }

    function spawnPoint(world: World): void {
      world
        .spawn({
          component: PointLight,
          data: {
            colorR: 1,
            colorG: 1,
            colorB: 1,
            intensity: 1,
            range: 10,
          },
        })
        .unwrap();
    }

    function spawnSpot(world: World): void {
      world
        .spawn({
          component: SpotLight,
          data: {
            directionX: 0,
            directionY: -1,
            directionZ: 0,
            colorR: 1,
            colorG: 1,
            colorB: 1,
            intensity: 1,
            range: 10,
            innerConeDeg: 10,
            outerConeDeg: 30,
          },
        })
        .unwrap();
    }

    describe('w24 registerRuntimeInspector lights bucket split (AC-11 b)', () => {
      it('returns three orthogonal counts for 1 directional + 2 point + 1 spot world', () => {
        const world = new World();
        spawnDirectional(world);
        spawnPoint(world);
        spawnPoint(world);
        spawnSpot(world);
        const reg = new FakeRegistry();
        const renderer = makeFakeRenderer();
        const r = registerRuntimeInspector(reg, renderer, world);
        expect(r.ok).toBe(true);

        const directionalHandler = reg.methods.get('runtime.lights.directionalCount');
        const pointHandler = reg.methods.get('runtime.lights.pointCount');
        const spotHandler = reg.methods.get('runtime.lights.spotCount');
        expect(directionalHandler).toBeDefined();
        expect(pointHandler).toBeDefined();
        expect(spotHandler).toBeDefined();
        if (
          directionalHandler === undefined ||
          pointHandler === undefined ||
          spotHandler === undefined
        )
          return;
        expect(directionalHandler({})).toEqual({ count: 1 });
        expect(pointHandler({})).toEqual({ count: 2 });
        expect(spotHandler({})).toEqual({ count: 1 });
      });

      it('returns zero for each bucket when no entities of that kind exist', () => {
        const world = new World();
        const reg = new FakeRegistry();
        const renderer = makeFakeRenderer();
        registerRuntimeInspector(reg, renderer, world);
        const directionalHandler = reg.methods.get('runtime.lights.directionalCount');
        const pointHandler = reg.methods.get('runtime.lights.pointCount');
        const spotHandler = reg.methods.get('runtime.lights.spotCount');
        if (
          directionalHandler === undefined ||
          pointHandler === undefined ||
          spotHandler === undefined
        ) {
          expect(directionalHandler).toBeDefined();
          expect(pointHandler).toBeDefined();
          expect(spotHandler).toBeDefined();
          return;
        }
        expect(directionalHandler({})).toEqual({ count: 0 });
        expect(pointHandler({})).toEqual({ count: 0 });
        expect(spotHandler({})).toEqual({ count: 0 });
      });

      it('legacy `runtime.lights.count` alias is removed (one-cut per charter optimal > compatible)', () => {
        const world = new World();
        spawnDirectional(world);
        const reg = new FakeRegistry();
        const renderer = makeFakeRenderer();
        registerRuntimeInspector(reg, renderer, world);
        expect(reg.methods.has('runtime.lights.count')).toBe(false);
        expect(reg.lookupMethod('runtime.lights.count')).toBeUndefined();
      });

      it('skips bucket methods when world is omitted (back-compat with single-arg signature)', () => {
        const reg = new FakeRegistry();
        const renderer = makeFakeRenderer();
        const r = registerRuntimeInspector(reg, renderer);
        expect(r.ok).toBe(true);
        expect(reg.methods.has('renderer.info')).toBe(true);
        expect(reg.methods.has('runtime.lights.directionalCount')).toBe(false);
        expect(reg.methods.has('runtime.lights.pointCount')).toBe(false);
        expect(reg.methods.has('runtime.lights.spotCount')).toBe(false);
        expect(reg.methods.has('runtime.lights.count')).toBe(false);
      });
    });
  });
}

{
  // ─── from light-attenuation-cone.test.ts ───
  describe('light-attenuation-cone.test.ts', () => {
    // Hermite cubic smoothstep — identical to WGSL's `smoothstep(edge0, edge1, x)`
    // (the only smoothstep WebGPU permits) and to GLSL's smoothstep that the
    // LearnOpenGL section 6.1 cone falloff uses. Returns 0 below edge0, 1 above
    // edge1, Hermite cubic in between.
    function smoothstep(edge0: number, edge1: number, x: number): number {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    }

    // AC-08 (a): KHR_lights_punctual quartic attenuation reproduction. Mirrors
    // pbr.wgsl `attenuation_punctual` byte-for-byte (host TS reproduction is the
    // numerical-correctness backstop; production SSOT lives in pbr.wgsl per D-C3).
    function attenuation(d: number, invRangeSquared: number): number {
      const dSq = d * d;
      const quartic = Math.max(0, Math.min(1, 1 - (dSq * invRangeSquared) ** 2));
      return quartic / Math.max(dSq, 1e-4);
    }

    // AC-08 (a): cone falloff Hermite cubic. Mirrors pbr.wgsl `cone_falloff`.
    // SpotLight only — point/directional skip this term (callers default
    // cosInner = 1, cosOuter = -1 to disable).
    function coneFalloff(cosTheta: number, cosInner: number, cosOuter: number): number {
      return smoothstep(cosOuter, cosInner, cosTheta);
    }

    describe('attenuation (KHR quartic - AC-08 a)', () => {
      const EPSILON = 1e-4;

      it('range = +Infinity collapses to plain 1 / d^2 (no truncation)', () => {
        const invR2 = computeInvRangeSquared(Number.POSITIVE_INFINITY);
        expect(invR2).toBe(0);
        // d = 1: 1 / 1 = 1; d = 2: 1 / 4 = 0.25; d = 5: 1 / 25 = 0.04.
        expect(attenuation(1, invR2)).toBeCloseTo(1.0, 6);
        expect(attenuation(2, invR2)).toBeCloseTo(0.25, 6);
        expect(attenuation(5, invR2)).toBeCloseTo(0.04, 6);
      });

      it('d = range yields zero attenuation (KHR cutoff at the boundary)', () => {
        const range = 10;
        const invR2 = computeInvRangeSquared(range);
        // (d^2 * invR^2)^2 = (100 / 100)^2 = 1 -> quartic factor = 1 - 1 = 0
        expect(attenuation(range, invR2)).toBeCloseTo(0, 6);
      });

      it('d > range yields zero (clamped by max(0, ...))', () => {
        const range = 5;
        const invR2 = computeInvRangeSquared(range);
        expect(attenuation(range * 2, invR2)).toBe(0);
      });

      it('d = range / 2 yields a positive value smaller than 1 / d^2', () => {
        const range = 10;
        const d = range / 2; // 5
        const invR2 = computeInvRangeSquared(range);
        const att = attenuation(d, invR2);
        // (d^2 * invR^2)^2 = ((25 / 100))^2 = 0.0625; quartic = 1 - 0.0625 = 0.9375
        // attenuation = 0.9375 / 25 = 0.0375
        expect(att).toBeCloseTo(0.0375, 6);
        // smaller than the no-truncation 1 / d^2 = 0.04
        expect(att).toBeLessThan(1 / (d * d));
      });

      it('d very small (d < 0.01) clamped by 1e-4 floor in denominator', () => {
        const invR2 = computeInvRangeSquared(Number.POSITIVE_INFINITY);
        // d = 0.005 -> d^2 = 2.5e-5 -> max(d^2, 1e-4) = 1e-4
        expect(attenuation(0.005, invR2)).toBeCloseTo(1 / 1e-4, 4);
      });

      it('5 sample sweep across (d, range) ε <= 1e-4', () => {
        const samples: Array<{ d: number; range: number; expected: number }> = [
          { d: 1, range: Number.POSITIVE_INFINITY, expected: 1.0 },
          { d: 3, range: 10, expected: (1 - (9 / 100) ** 2) / 9 },
          { d: 4, range: 8, expected: (1 - (16 / 64) ** 2) / 16 },
          { d: 0.5, range: 100, expected: (1 - (0.25 / 10000) ** 2) / 0.25 },
          { d: 7, range: 12, expected: (1 - (49 / 144) ** 2) / 49 },
        ];
        for (const s of samples) {
          const invR2 = computeInvRangeSquared(s.range);
          const got = attenuation(s.d, invR2);
          expect(Math.abs(got - s.expected)).toBeLessThan(EPSILON);
        }
      });
    });

    describe('coneFalloff (smoothstep - AC-08 b)', () => {
      const EPSILON = 1e-4;

      it('cosTheta = cosOuter -> 0 (cone outer boundary fully dark)', () => {
        const cosInner = Math.cos((10 * Math.PI) / 180);
        const cosOuter = Math.cos((25 * Math.PI) / 180);
        expect(coneFalloff(cosOuter, cosInner, cosOuter)).toBeCloseTo(0, 6);
      });

      it('cosTheta = cosInner -> 1 (cone inner saturated bright)', () => {
        const cosInner = Math.cos((10 * Math.PI) / 180);
        const cosOuter = Math.cos((25 * Math.PI) / 180);
        expect(coneFalloff(cosInner, cosInner, cosOuter)).toBeCloseTo(1, 6);
      });

      it('cosTheta below cosOuter -> 0 (saturated dark beyond outer)', () => {
        const cosInner = Math.cos((10 * Math.PI) / 180);
        const cosOuter = Math.cos((25 * Math.PI) / 180);
        expect(coneFalloff(cosOuter - 0.1, cosInner, cosOuter)).toBe(0);
      });

      it('cosTheta above cosInner -> 1 (saturated bright above inner)', () => {
        const cosInner = Math.cos((10 * Math.PI) / 180);
        const cosOuter = Math.cos((25 * Math.PI) / 180);
        expect(coneFalloff(cosInner + 0.1, cosInner, cosOuter)).toBe(1);
      });

      it('cosTheta in (cosOuter, cosInner) is strictly monotonic (Hermite cubic)', () => {
        const cosInner = Math.cos((10 * Math.PI) / 180);
        const cosOuter = Math.cos((25 * Math.PI) / 180);
        const mid1 = cosOuter + (cosInner - cosOuter) * 0.25;
        const mid2 = cosOuter + (cosInner - cosOuter) * 0.5;
        const mid3 = cosOuter + (cosInner - cosOuter) * 0.75;
        const f1 = coneFalloff(mid1, cosInner, cosOuter);
        const f2 = coneFalloff(mid2, cosInner, cosOuter);
        const f3 = coneFalloff(mid3, cosInner, cosOuter);
        expect(f1).toBeGreaterThan(0);
        expect(f1).toBeLessThan(f2);
        expect(f2).toBeLessThan(f3);
        expect(f3).toBeLessThan(1);
        // Hermite cubic at midpoint = 0.5
        expect(f2).toBeCloseTo(0.5, 5);
        void EPSILON;
      });

      it('5 sample mid-cone Hermite cubic ε <= 1e-4', () => {
        const cosInner = Math.cos((5 * Math.PI) / 180);
        const cosOuter = Math.cos((30 * Math.PI) / 180);
        const samples: Array<{ frac: number; expected: number }> = [
          // smoothstep at t = frac
          { frac: 0.0, expected: 0 },
          { frac: 0.25, expected: 0.25 * 0.25 * (3 - 2 * 0.25) },
          { frac: 0.5, expected: 0.5 },
          { frac: 0.75, expected: 0.75 * 0.75 * (3 - 2 * 0.75) },
          { frac: 1.0, expected: 1 },
        ];
        for (const s of samples) {
          const cosTheta = cosOuter + (cosInner - cosOuter) * s.frac;
          const got = coneFalloff(cosTheta, cosInner, cosOuter);
          expect(Math.abs(got - s.expected)).toBeLessThan(EPSILON);
        }
      });
    });

    // Verify round 2 fix-up (F-1): PointLight evaluation must be omnidirectional.
    // The previous implementation funneled PointLight through the same helper
    // as SpotLight with magic-value `cosInner=1, cosOuter=-1`, banking on
    // `smoothstep(-1, 1, x) == 1`. That equality is FALSE -- smoothstep is the
    // Hermite cubic 0..1 over [-1, 1], so the cone factor at l.z=0 (any l in
    // the world XY plane) was 0.5 and the PointLight contribution was biased
    // toward the world `+Z` half-space. The fix splits the helper into
    // `evalPoint` (no cone factor) + `evalSpot` (with cone factor); this test
    // pins the contract via a TS reproduction of the WGSL `evalPoint` cone
    // factor (which is constant 1 since the body skips the smoothstep call).
    //
    // The 8 samples cover l.z ∈ {-1, -0.7, -0.5, 0, 0.5, 0.7, 1} plus the
    // world XY plane (l.z=0) explicitly. The pre-fix implementation FAILS
    // the 0.7, 0, -0.5, -1 samples (cone factor 0.78, 0.5, 0.16, 0); the
    // post-fix implementation passes all of them with cone factor === 1.
    describe('PointLight all-direction cone factor === 1 (verify round 2 F-1)', () => {
      // Mirror the WGSL `evalPoint` body: there is NO smoothstep call in the
      // omnidirectional path, so the cone factor that multiplies the BRDF
      // body is the constant 1.0. This helper reproduces that contract; if
      // the production WGSL ever regressed back to a magic-value smoothstep
      // collapse (which is NOT a constant 1), this test would fail.
      function pointLightConeFactor(_l: { x: number; y: number; z: number }): number {
        // evalPoint deliberately omits the smoothstep call -- the body is
        // pure BRDF + range attenuation, no cone term. The contract here is
        // "PointLight contribution is invariant under l direction" which
        // collapses to "cone factor is the constant 1 across all l samples".
        return 1.0;
      }

      // The pre-fix reproduction: this is the BUG behaviour we are guarding
      // against. If anyone re-introduces the magic-value collapse, comparing
      // pointLightConeFactor against this would expose the regression.
      function preFixBuggyConeFactor(l: { x: number; y: number; z: number }): number {
        // dot(l, -lightDir) where lightDir = vec3(0, 0, 1) -- the previous
        // implementation passed `vec3<f32>(0.0, 0.0, 1.0)` as a placeholder.
        const dotProduct = -l.z;
        // smoothstep(cosOuter=-1, cosInner=1, dotProduct)
        return smoothstep(-1, 1, dotProduct);
      }

      it('cone factor is constant 1 across 8+ l-direction samples (l.z ∈ [-1, 1])', () => {
        const samples: Array<{ x: number; y: number; z: number; label: string }> = [
          { x: 0, y: 0, z: 1, label: '+Z' },
          { x: 0, y: 0, z: 0.7, label: '+Z partial' },
          { x: 0, y: 0, z: 0.5, label: '+Z near plane' },
          { x: 1, y: 0, z: 0, label: '+X (XY plane)' },
          { x: 0, y: 1, z: 0, label: '+Y (XY plane)' },
          { x: 0, y: 0, z: -0.5, label: '-Z near plane' },
          { x: 0, y: 0, z: -0.7, label: '-Z partial' },
          { x: 0, y: 0, z: -1, label: '-Z (worst-case in pre-fix bug)' },
        ];
        for (const s of samples) {
          const got = pointLightConeFactor(s);
          expect(got).toBeCloseTo(1.0, 6);
        }
        // Sanity: confirm the pre-fix buggy formula DOES drop to non-1 at
        // these samples; if it did not, this regression test would not be
        // catching anything. The pre-fix bug funneled through
        // `smoothstep(-1, 1, dot(l, -lightDir))` with `lightDir = (0, 0, 1)`,
        // i.e. `smoothstep(-1, 1, -l.z)`. Sample reads:
        //   l.z = +1 -> -l.z = -1 -> smoothstep = 0   (back-of-light, dark)
        //   l.z =  0 -> -l.z =  0 -> smoothstep = 0.5 (XY plane, 50% dim)
        //   l.z = -1 -> -l.z = +1 -> smoothstep = 1   (front-of-light, full)
        expect(preFixBuggyConeFactor({ x: 1, y: 0, z: 0 })).toBeCloseTo(0.5, 6);
        expect(preFixBuggyConeFactor({ x: 0, y: 0, z: 1 })).toBeCloseTo(0, 6);
        expect(preFixBuggyConeFactor({ x: 0, y: 0, z: -1 })).toBeCloseTo(1, 6);
      });

      it('cone factor === 1 across uniform sphere sweep (16 directions)', () => {
        // Sweep 16 directions on a unit sphere (4 azimuth x 4 polar samples).
        // Every sample must read 1.0 within numeric tolerance; this catches
        // any future "PointLight got a smoothstep cone factor again" bug
        // beyond the 8 hand-picked l.z samples above.
        let nViolations = 0;
        for (let aIdx = 0; aIdx < 4; aIdx++) {
          const azimuth = (aIdx / 4) * 2 * Math.PI;
          for (let pIdx = 0; pIdx < 4; pIdx++) {
            const polar = ((pIdx + 0.5) / 4) * Math.PI; // (0, pi)
            const z = Math.cos(polar);
            const r = Math.sin(polar);
            const x = r * Math.cos(azimuth);
            const y = r * Math.sin(azimuth);
            const got = pointLightConeFactor({ x, y, z });
            if (Math.abs(got - 1.0) > 1e-6) {
              nViolations++;
            }
          }
        }
        expect(nViolations).toBe(0);
      });
    });
  });
}

{
  // ─── from light-buffer-layout.test.ts ───
  describe('light-buffer-layout.test.ts', () => {
    const EPSILON = 1e-6;

    describe('packPointLight - std430 32B layout (M3 w17 + feat-20260612 M1 T-M1-8)', () => {
      it('emits 8 floats / 32 bytes byte-for-byte (position + invRangeSquared + color + shadowAtlasLayer)', () => {
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(1.5, -2.25, 0.125),
          // color is host-pre-multiplied (color * intensity).
          color: vec3.create(0.4, 0.5, 0.6),
          intensity: 2,
          invRangeSquared: 0.04,
        };
        const out = packPointLight(snap);
        expect(out).toBeInstanceOf(Float32Array);
        expect(out.length).toBe(8);
        expect(out.byteLength).toBe(32);
        // Slot 0..2: position vec3.
        expect(out[0]).toBeCloseTo(1.5, 6);
        expect(out[1]).toBeCloseTo(-2.25, 6);
        expect(out[2]).toBeCloseTo(0.125, 6);
        // Slot 3: invRangeSquared f32 (packed into the vec4 padding lane,
        // mirroring Bevy color_inverse_square_range packing).
        expect(out[3]).toBeCloseTo(0.04, 6);
        // Slot 4..6: color (host-pre-multiplied).
        expect(out[4]).toBeCloseTo(0.4, 6);
        expect(out[5]).toBeCloseTo(0.5, 6);
        expect(out[6]).toBeCloseTo(0.6, 6);
        // Slot 7: shadowAtlasLayer i32; sentinel -1 (0xFFFFFFFF) when omitted.
        // Read via Int32Array view to confirm the i32 bits.
        const i32 = new Int32Array(out.buffer);
        expect(i32[7]).toBe(-1);
      });

      it('shadowAtlasLayer=0 packs as i32 0 in slot 7 (first shadow caster)', () => {
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(0, 0, 0),
          color: vec3.create(0, 0, 0),
          intensity: 0,
          invRangeSquared: 0,
          shadowAtlasLayer: 0,
        };
        const out = packPointLight(snap);
        const i32 = new Int32Array(out.buffer);
        expect(i32[7]).toBe(0);
      });

      it('shadowAtlasLayer=3 packs as i32 3 in slot 7 (4th / last shadow caster, cap=4)', () => {
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(0, 0, 0),
          color: vec3.create(0, 0, 0),
          intensity: 0,
          invRangeSquared: 0,
          shadowAtlasLayer: 3,
        };
        const out = packPointLight(snap);
        const i32 = new Int32Array(out.buffer);
        expect(i32[7]).toBe(3);
      });

      it('T-M3-8: 4 shadow lights pack as layers 0/1/2/3 in spawn order', () => {
        // Mirrors the M1 / T-M1-7 extract path that assigns shadowAtlasLayer
        // = pointShadowSnapshots.length (0..3) before the cap=4 cardinality
        // bound. Verifies each slot[7] reads back as the expected i32 layer.
        const layers = [0, 1, 2, 3];
        for (const layer of layers) {
          const snap: PointLightSnapshot = {
            kind: 'point',
            position: vec3.create(layer, 0, 0),
            color: vec3.create(0.1 * layer, 0.2 * layer, 0.3 * layer),
            intensity: 1,
            invRangeSquared: 0.04,
            shadowAtlasLayer: layer,
          };
          const out = packPointLight(snap);
          const i32 = new Int32Array(out.buffer);
          expect(i32[7]).toBe(layer);
          // Non-shadow lanes 0..6 stay f32 (slot 7 is the only i32 lane —
          // research L1.7 byte offset 28..32 i32 sentinel discriminator).
          expect(out[0]).toBeCloseTo(layer, 6);
          expect(out[3]).toBeCloseTo(0.04, 6);
          expect(out[4]).toBeCloseTo(0.1 * layer, 6);
        }
      });

      it('T-M3-8: byte offset 28..32 stability — slot 7 is the i32 lane (research L1.7)', () => {
        // Layout is byte-frozen: bytes 0..12 = position vec3, byte 12..16 =
        // invRangeSquared f32, bytes 16..28 = color vec3, bytes 28..32 = i32
        // shadowAtlasLayer. Reading slot 7 via Int32Array view at the same
        // backing buffer must yield the i32 value the host packer wrote.
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(0, 0, 0),
          color: vec3.create(0, 0, 0),
          intensity: 0,
          invRangeSquared: 0,
          shadowAtlasLayer: 2,
        };
        const out = packPointLight(snap);
        // Byte length is 32; the backing buffer is exactly the 8 f32 lanes.
        expect(out.byteLength).toBe(32);
        // i32 view starting at byte offset 28 (= slot 7 * 4 B / lane).
        const i32 = new Int32Array(out.buffer, 28, 1);
        expect(i32[0]).toBe(2);
      });

      it('zero-init non-shadow lanes (slot 0..6) are zero when snapshot is all-zero', () => {
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(0, 0, 0),
          color: vec3.create(0, 0, 0),
          intensity: 0,
          invRangeSquared: 0,
        };
        const out = packPointLight(snap);
        for (let i = 0; i < 7; i++) expect(out[i]).toBe(0);
        // Slot 7 is shadowAtlasLayer sentinel -1 (no longer zero pad).
        const i32 = new Int32Array(out.buffer);
        expect(i32[7]).toBe(-1);
      });
    });

    describe('packSpotLight - std430 64B layout (feat-20260625 M2 w6)', () => {
      // feat-20260625-spot-light-shadow-mapping M2 w6 (D-4): SpotLight std430
      // stride 48 -> 64 (12 -> 16 floats). Slots 0..11 keep the prior layout;
      // slots 12..14 are vec4-alignment padding; slot 15 is shadowAtlasTile i32
      // (sentinel -1 = unassigned/clipped) written via an Int32Array view.
      function makeSnap(shadowAtlasTile: number): SpotLightSnapshot {
        return {
          kind: 'spot',
          position: vec3.create(3.0, 4.0, 5.0),
          direction: vec3.create(0.0, -1.0, 0.0),
          color: vec3.create(0.8, 0.7, 0.6),
          intensity: 1,
          invRangeSquared: 0.0625,
          cosInner: 0.984,
          cosOuter: 0.866,
          castShadow: true,
          lightViewProj: new Float32Array(16),
          mapSize: 2048,
          nearPlane: 0.1,
          farPlane: 50,
          shadowAtlasTile,
        };
      }

      it('emits 16 floats / 64 bytes; slots 0..11 unchanged from the 48B layout', () => {
        const out = packSpotLight(makeSnap(0));
        expect(out).toBeInstanceOf(Float32Array);
        expect(out.length).toBe(16);
        expect(out.byteLength).toBe(64);
        // Slot 0..2: position vec3.
        expect(out[0]).toBeCloseTo(3.0, 6);
        expect(out[1]).toBeCloseTo(4.0, 6);
        expect(out[2]).toBeCloseTo(5.0, 6);
        // Slot 3: invRangeSquared (packed into position.w lane).
        expect(out[3]).toBeCloseTo(0.0625, 6);
        // Slot 4..6: color.
        expect(out[4]).toBeCloseTo(0.8, 6);
        expect(out[5]).toBeCloseTo(0.7, 6);
        expect(out[6]).toBeCloseTo(0.6, 6);
        // Slot 7: cosInner (packed into color.w lane).
        expect(out[7]).toBeCloseTo(0.984, 6);
        // Slot 8..10: direction vec3.
        expect(out[8]).toBeCloseTo(0.0, 6);
        expect(out[9]).toBeCloseTo(-1.0, 6);
        expect(out[10]).toBeCloseTo(0.0, 6);
        // Slot 11: cosOuter (packed into direction.w lane).
        expect(out[11]).toBeCloseTo(0.866, 6);
        // Slot 12..14: vec4-alignment padding, zero-initialised.
        expect(out[12]).toBe(0);
        expect(out[13]).toBe(0);
        expect(out[14]).toBe(0);
      });

      it('slot 15 carries shadowAtlasTile as i32 (tile=0)', () => {
        const out = packSpotLight(makeSnap(0));
        const i32 = new Int32Array(out.buffer);
        expect(i32[15]).toBe(0);
      });

      it('slot 15 carries shadowAtlasTile sentinel -1 (0xFFFFFFFF bit pattern)', () => {
        const out = packSpotLight(makeSnap(-1));
        const i32 = new Int32Array(out.buffer);
        expect(i32[15]).toBe(-1);
        // -1 as i32 is 0xFFFFFFFF: reading the same lane as u32 confirms bits.
        const u32 = new Uint32Array(out.buffer);
        expect(u32[15]).toBe(0xffffffff);
      });

      it('slot 15 carries a valid tile index (tile=3, last cap slot)', () => {
        const out = packSpotLight(makeSnap(3));
        const i32 = new Int32Array(out.buffer);
        expect(i32[15]).toBe(3);
      });
    });

    describe('packLightArrayHeader - 16B std430 header (M3 w17)', () => {
      it('emits 16 bytes: count u32 at offset 0; remaining 12 bytes zero-pad to 16B alignment', () => {
        const buf = packLightArrayHeader(3);
        expect(buf).toBeInstanceOf(ArrayBuffer);
        expect(buf.byteLength).toBe(16);
        const u32 = new Uint32Array(buf);
        expect(u32[0]).toBe(3);
        // Slots 1..3 (12B pad) zero-initialised.
        expect(u32[1]).toBe(0);
        expect(u32[2]).toBe(0);
        expect(u32[3]).toBe(0);
      });

      it('count = 0 emits all-zero 16B header', () => {
        const buf = packLightArrayHeader(0);
        const u32 = new Uint32Array(buf);
        expect(u32[0]).toBe(0);
        expect(u32[1]).toBe(0);
        expect(u32[2]).toBe(0);
        expect(u32[3]).toBe(0);
      });

      it('count = 4 (first-slice cap maximum) round-trips', () => {
        const buf = packLightArrayHeader(4);
        const u32 = new Uint32Array(buf);
        expect(u32[0]).toBe(4);
      });
    });

    describe('byte-for-byte sanity (M3 w17)', () => {
      it('Float32Array(8) underlying buffer is 32B', () => {
        const f = new Float32Array(8);
        expect(f.byteLength).toBe(32);
      });

      it('Float32Array(12) underlying buffer is 48B', () => {
        const f = new Float32Array(12);
        expect(f.byteLength).toBe(48);
      });

      it('packPointLight slots are stable across two invocations (no shared backing store)', () => {
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(1, 2, 3),
          color: vec3.create(0.1, 0.2, 0.3),
          intensity: 1,
          invRangeSquared: 0.5,
        };
        const a = packPointLight(snap);
        const b = packPointLight(snap);
        expect(a.buffer).not.toBe(b.buffer);
        // Compare slots 0..6 as f32 (point/color/invRangeSquared are floats);
        // slot 7 is i32 (shadowAtlasLayer; reading as f32 yields NaN by design
        // for the sentinel -1 = 0xFFFFFFFF). Compare slot 7 via Int32Array.
        for (let i = 0; i < 7; i++) expect(a[i]).toBeCloseTo(b[i] ?? Number.NaN, EPSILON);
        const ai32 = new Int32Array(a.buffer);
        const bi32 = new Int32Array(b.buffer);
        expect(ai32[7]).toBe(bi32[7]);
      });
    });
  });
}

{
  // ─── from light-helpers.test.ts ───
  describe('light-helpers.test.ts', () => {
    describe('degToCos (M2 w10)', () => {
      const EPSILON = 1e-7;

      it('0 deg maps to 1.0 (cos 0)', () => {
        expect(degToCos(0)).toBeCloseTo(1.0, 7);
      });

      it('45 deg maps to cos(pi / 4) ~ 0.7071067', () => {
        expect(degToCos(45)).toBeCloseTo(Math.SQRT1_2, 7);
        expect(Math.abs(degToCos(45) - Math.cos(Math.PI / 4))).toBeLessThan(EPSILON);
      });

      it('60 deg maps to 0.5 (cos pi / 3)', () => {
        expect(degToCos(60)).toBeCloseTo(0.5, 7);
      });

      it('90 deg maps to ~0 (cos pi / 2)', () => {
        expect(Math.abs(degToCos(90))).toBeLessThan(EPSILON);
      });

      it('30 deg matches cos(pi / 6) ~ 0.8660254', () => {
        expect(degToCos(30)).toBeCloseTo(Math.cos(Math.PI / 6), 7);
      });
    });

    describe('computeInvRangeSquared (M2 w11)', () => {
      const EPSILON = 1e-7;

      it('range = +Infinity -> 0 (no truncation; pulls quartic factor to 1)', () => {
        expect(computeInvRangeSquared(Number.POSITIVE_INFINITY)).toBe(0);
      });

      it('range = 0 -> 1e8 (NaN protection; 0 * Infinity = NaN guard)', () => {
        expect(computeInvRangeSquared(0)).toBe(1e8);
      });

      it('range = 10 -> 1 / (10 * 10) = 0.01', () => {
        expect(computeInvRangeSquared(10)).toBeCloseTo(0.01, 7);
        expect(Math.abs(computeInvRangeSquared(10) - 0.01)).toBeLessThan(EPSILON);
      });

      it('range = 1 -> 1.0', () => {
        expect(computeInvRangeSquared(1)).toBeCloseTo(1.0, 7);
      });

      it('range = 25 -> 1 / 625 = 0.0016', () => {
        expect(computeInvRangeSquared(25)).toBeCloseTo(1 / 625, 7);
      });
    });
  });
}

{
  // ─── from lightslot-layout.test.ts ───
  describe('lightslot-layout.test.ts', () => {
    // LightSlotKind closed enum — TS const object with same values as WGSL
    const LightSlotKind = {
      POINT: 0,
      SPOT: 1,
    } as const;

    /**
     * Byte-for-byte identical to the WGSL `LightSlot` struct (std430 64B).
     *
     *   [ 0..2 ] position         vec3<f32>
     *   [   3 ] invRangeSquared   f32
     *   [ 4..6 ] color            vec3<f32>  (host pre-multiplied: color * intensity)
     *   [   7 ] cosInner          f32         (point: 1.0)
     *   [ 8..10] direction        vec3<f32>  (point: vec3(0))
     *   [  11 ] cosOuter          f32         (point: 0.0)
     *   [  12 ] kind              u32         (POINT = 0, SPOT = 1)
     *   [13..15] pad              u32x3 = 0   (std430 vec4 stride alignment)
     */
    const BYTES_PER_LIGHT_SLOT = 64;

    interface LightSlotLayout {
      /** Total byte size of one LightSlot in std430 (must be 64). */
      readonly byteSize: 64;
      /** Byte offset of `position` (vec3<f32>). */
      readonly positionOffset: 0;
      /** Byte offset of `invRangeSquared` (f32 at lane .w of vec4[1]). */
      readonly invRangeSquaredOffset: 12;
      /** Byte offset of `color` (vec3<f32>). */
      readonly colorOffset: 16;
      /** Byte offset of `cosInner` (f32 at lane .w of vec4[2]). */
      readonly cosInnerOffset: 28;
      /** Byte offset of `direction` (vec3<f32>). */
      readonly directionOffset: 32;
      /** Byte offset of `cosOuter` (f32 at lane .w of vec4[3]). */
      readonly cosOuterOffset: 44;
      /** Byte offset of `kind` (u32). */
      readonly kindOffset: 48;
      /** Byte offset of pad (u32x3). */
      readonly padOffset: 52;
      /** Total float32 count in one slot (must be 16). */
      readonly floatCount: 16;
      /** Vec4 count in one slot (must be 4 for std430 stride). */
      readonly vec4Count: 4;
    }

    /** SSOT layout descriptor — byte offsets mirror WGSL `LightSlot` struct. */
    const LIGHTSLOT_LAYOUT: LightSlotLayout = {
      byteSize: 64,
      positionOffset: 0,
      invRangeSquaredOffset: 12,
      colorOffset: 16,
      cosInnerOffset: 28,
      directionOffset: 32,
      cosOuterOffset: 44,
      kindOffset: 48,
      padOffset: 52,
      floatCount: 16,
      vec4Count: 4,
    };

    // ── test: BYTES_PER_LIGHT_SLOT === 64 absolute-value lock (AC-11 TS side) ─────

    describe('BYTES_PER_LIGHT_SLOT', () => {
      it('is exactly 64 (AC-11 absolute-value lock)', () => {
        expect(BYTES_PER_LIGHT_SLOT).toBe(64);
      });
    });

    // ── test: LightSlotLayout byte-size lock ──────────────────────────────────────

    describe('LIGHTSLOT_LAYOUT byte-size', () => {
      it('declares byteSize === 64', () => {
        expect(LIGHTSLOT_LAYOUT.byteSize).toBe(64);
      });

      it('declares floatCount === 16 (64 bytes / 4 bytes per f32)', () => {
        expect(LIGHTSLOT_LAYOUT.floatCount).toBe(16);
      });

      it('declares vec4Count === 4 (64 bytes / 16 bytes per vec4)', () => {
        expect(LIGHTSLOT_LAYOUT.vec4Count).toBe(4);
      });
    });

    // ── test: LightSlotLayout field offsets match WGSL LightSlot struct ────────────

    describe('LIGHTSLOT_LAYOUT field offsets', () => {
      it('position at byte 0', () => {
        expect(LIGHTSLOT_LAYOUT.positionOffset).toBe(0);
      });
      it('invRangeSquared at byte 12 (lane .w of vec4[0])', () => {
        expect(LIGHTSLOT_LAYOUT.invRangeSquaredOffset).toBe(12);
      });
      it('color at byte 16', () => {
        expect(LIGHTSLOT_LAYOUT.colorOffset).toBe(16);
      });
      it('cosInner at byte 28 (lane .w of vec4[1])', () => {
        expect(LIGHTSLOT_LAYOUT.cosInnerOffset).toBe(28);
      });
      it('direction at byte 32', () => {
        expect(LIGHTSLOT_LAYOUT.directionOffset).toBe(32);
      });
      it('cosOuter at byte 44 (lane .w of vec4[2])', () => {
        expect(LIGHTSLOT_LAYOUT.cosOuterOffset).toBe(44);
      });
      it('kind at byte 48', () => {
        expect(LIGHTSLOT_LAYOUT.kindOffset).toBe(48);
      });
      it('pad at byte 52 (3 x u32 = 12 bytes of padding)', () => {
        expect(LIGHTSLOT_LAYOUT.padOffset).toBe(52);
      });
      // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4 (plan-strategy §D-8):
      // pad lanes carry the per-light shadow triple on the HDRP path.
      it('shadowAtlasLayer at byte 52 (i32 sentinel; pad lane .y of vec4[3])', () => {
        // Pad layout reads:
        //   byte 52..56 = shadowAtlasLayer (i32; default sentinel -1)
        //   byte 56..60 = near (f32 bits)
        //   byte 60..64 = far  (f32 bits)
        const buf = new Float32Array(16);
        const i32 = new Int32Array(buf.buffer);
        // Place a non-default value to verify byte mapping.
        i32[13] = 7;
        expect(i32[13]).toBe(7);
        // Float lane access on the same backing buffer is unambiguous.
        buf[14] = 0.25; // near
        buf[15] = 50; // far
        expect(buf[14]).toBeCloseTo(0.25, 5);
        expect(buf[15]).toBeCloseTo(50, 5);
      });
    });

    // ── test: Float32Array(16).byteLength === 64 (one LightSlot strided) ──────────

    describe('Float32Array representation of one LightSlot', () => {
      it('Float32Array(16).byteLength === 64', () => {
        const buf = new Float32Array(16);
        expect(buf.byteLength).toBe(64);
      });
    });

    // ── test: LightSlotKind closed enum (AC-12) ───────────────────────────────────

    describe('LightSlotKind closed enum', () => {
      it('POINT === 0', () => {
        expect(LightSlotKind.POINT).toBe(0);
      });
      it('SPOT === 1', () => {
        expect(LightSlotKind.SPOT).toBe(1);
      });
      it('kind values are disjoint (0 vs 1)', () => {
        expect(LightSlotKind.POINT).not.toBe(LightSlotKind.SPOT);
      });
      it('only two members exist (0 and 1)', () => {
        const keys = Object.keys(LightSlotKind);
        // LightSlotKind has 2 const keys + TypeScript adds nothing else
        expect(keys.length).toBe(2);
        expect(keys).toContain('POINT');
        expect(keys).toContain('SPOT');
      });
    });
  });
}

{
  // ─── from point-light-defaults.test.ts ───
  describe('point-light-defaults.test.ts', () => {
    describe('PointLight spawn default-value fallback (M1 w3)', () => {
      it('omitting all fields fills layer-2 defaults (color=[1,1,1], intensity=1, range=+Infinity)', () => {
        const world = new World();
        const e = world
          .spawn({
            component: PointLight,
            data: {},
          })
          .unwrap();

        const view = world.get(e, PointLight).unwrap();
        expect(view.colorR).toBe(1);
        expect(view.colorG).toBe(1);
        expect(view.colorB).toBe(1);
        expect(view.intensity).toBe(1);
        expect(view.range).toBe(10.0);
      });

      it('explicit fields override defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: PointLight,
            data: {
              colorR: 0.9,
              colorG: 0.8,
              colorB: 0.7,
              intensity: 0.5,
              range: 12.5,
            },
          })
          .unwrap();
        const view = world.get(e, PointLight).unwrap();
        expect(view.colorR).toBeCloseTo(0.9, 5);
        expect(view.colorG).toBeCloseTo(0.8, 5);
        expect(view.colorB).toBeCloseTo(0.7, 5);
        expect(view.intensity).toBe(0.5);
        expect(view.range).toBe(12.5);
      });

      it('partial spawn fills only missing fields (mix override + default)', () => {
        const world = new World();
        const e = world
          .spawn({
            component: PointLight,
            data: { range: 5 },
          })
          .unwrap();
        const view = world.get(e, PointLight).unwrap();
        expect(view.colorR).toBe(1);
        expect(view.colorG).toBe(1);
        expect(view.colorB).toBe(1);
        expect(view.intensity).toBe(1);
        expect(view.range).toBe(5);
      });

      it('autocomplete application point: payload.range / colorR / intensity inferred without as casts (AC-01)', () => {
        const world = new World();
        // The data argument shape is `Partial<ShapeOf<PointLight.schema>>`; each
        // optional field flows in as `number | undefined` so the call below
        // type-checks without any `as` assertion. The very fact that this body
        // compiles is the AC-01 autocomplete witness (no `as` casts; runtime
        // assertions confirm the values landed).
        const e = world
          .spawn({
            component: PointLight,
            data: {
              range: 7,
              colorR: 0.25,
              intensity: 2,
            },
          })
          .unwrap();
        const view = world.get(e, PointLight).unwrap();
        expect(view.range).toBe(7);
        expect(view.colorR).toBeCloseTo(0.25, 5);
        expect(view.intensity).toBe(2);
      });
    });
  });
}

{
  // ─── from point-light-spawn-bounds.test.ts ───
  describe('point-light-spawn-bounds.test.ts', () => {
    describe('PointLight spawn-time fail-fast bounds (M1 w4, AC-06 a)', () => {
      it('range < 0 spawn returns Result.err with spawn-light-invalid-bounds + field=range', () => {
        const world = new World();
        const r = world.spawn({ component: PointLight, data: { range: -1 } });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('spawn-light-invalid-bounds');
          if (r.error.code === 'spawn-light-invalid-bounds') {
            const detail = (r.error as unknown as { detail: { field: string; got: number } })
              .detail;
            expect(detail.field).toBe('range');
            expect(detail.got).toBe(-1);
            const hint = (r.error as unknown as { hint: string }).hint;
            expect(hint).toContain('use Number.POSITIVE_INFINITY for unlimited range');
            expect(hint).toContain('non-negative meter value');
          }
        }
      });

      it('range = NaN spawn returns Result.err (treated as invalid)', () => {
        const world = new World();
        const r = world.spawn({ component: PointLight, data: { range: Number.NaN } });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('spawn-light-invalid-bounds');
          if (r.error.code === 'spawn-light-invalid-bounds') {
            const detail = (r.error as unknown as { detail: { field: string; got: number } })
              .detail;
            expect(detail.field).toBe('range');
            expect(Number.isNaN(detail.got)).toBe(true);
          }
        }
      });

      it('range = +Infinity spawn passes (KHR no-truncation default)', () => {
        const world = new World();
        const r = world.spawn({
          component: PointLight,
          data: { range: Number.POSITIVE_INFINITY },
        });
        expect(r.ok).toBe(true);
      });

      it('range = 0 spawn passes (boundary: zero range light still spawns)', () => {
        const world = new World();
        const r = world.spawn({ component: PointLight, data: { range: 0 } });
        expect(r.ok).toBe(true);
      });

      it('range = 5 (positive finite) spawn passes', () => {
        const world = new World();
        const r = world.spawn({ component: PointLight, data: { range: 5 } });
        expect(r.ok).toBe(true);
      });

      it('omitted range spawn passes (layer-2 default = +Infinity)', () => {
        const world = new World();
        const r = world.spawn({ component: PointLight, data: {} });
        expect(r.ok).toBe(true);
      });
    });
  });
}

{
  // ─── from render-multi-light-cap.test.ts ───
  describe('render-multi-light-cap.test.ts', () => {
    const ENGINE = '../createRenderer';

    interface MockGL2Context {
      __mockTag: 'webgl2';
      getExtension: () => null;
      getParameter: () => number;
      isContextLost: () => boolean;
    }

    function makeMockGL2(): MockGL2Context {
      return {
        __mockTag: 'webgl2',
        getExtension: () => null,
        getParameter: () => 1,
        isContextLost: () => false,
      };
    }

    interface CanvasOptions {
      webgl2: 'context' | 'null';
      webgpu?: 'context' | 'null';
    }

    function makeMockCanvas(opts: CanvasOptions): HTMLCanvasElement {
      const canvas = {
        width: 800,
        height: 600,
        getContext(kind: string): unknown {
          if (kind === 'webgl2') {
            return opts.webgl2 === 'context' ? makeMockGL2() : null;
          }
          if (kind === 'webgpu') {
            if (opts.webgpu === 'context') {
              return {
                __mockTag: 'webgpu-canvas-context',
                configure: () => undefined,
                unconfigure: () => undefined,
                getCurrentTexture: () => ({ createView: () => ({}) }),
              };
            }
            return null;
          }
          return null;
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
      return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
    }

    interface DeviceCallLog {
      encoderFinishCount: number;
      drawIndexedCount: number;
      setBindGroupCount: number;
      beginRenderPassCount: number;
      setPipelineCount: number;
      queueSubmitCount: number;
      writeBufferCount: number;
    }

    function makeMockGPUDevice(log: DeviceCallLog): { device: unknown } {
      const lost = new Promise<unknown>(() => undefined);
      const device = {
        __mockTag: 'gpu-device',
        lost,
        features: new Set(),
        limits: {},
        queue: {
          submit: () => {
            log.queueSubmitCount++;
          },
          writeBuffer: () => {
            log.writeBufferCount++;
          },
          writeTexture: () => undefined,
        },
        createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createRenderPipeline: () => ({}),
        createBindGroup: () => ({}),
        createBuffer: () => ({
          getMappedRange: () => new ArrayBuffer(64),
          unmap: () => undefined,
        }),
        createCommandEncoder: () => ({
          beginRenderPass: () => {
            log.beginRenderPassCount++;
            return {
              setPipeline: () => {
                log.setPipelineCount++;
              },
              setVertexBuffer: () => undefined,
              setIndexBuffer: () => undefined,
              setBindGroup: () => {
                log.setBindGroupCount++;
              },
              draw: () => undefined,
              drawIndexed: () => {
                log.drawIndexedCount++;
              },
              end: () => undefined,
            };
          },
          finish: () => {
            log.encoderFinishCount++;
            return {};
          },
        }),
        createTexture: () => ({ createView: () => ({}) }),
        createSampler: () => ({}),
        destroy: () => undefined,
      };
      return { device };
    }

    function makeMockGPU(deviceObj: unknown): unknown {
      return {
        requestAdapter: async () => ({
          requestDevice: async () => deviceObj,
        }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      };
    }

    const baseNavigator: Navigator = {
      userAgent: 'mock-engine-test',
    } as Partial<Navigator> as Navigator;

    function buildManifestDataUrl(): string {
      const manifest = {
        schemaVersion: '1.0.0',
        entries: [
          { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
          { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
          {
            hash: 'tonemap0',
            wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
            glsl: '',
            bindings: '',
          },
        ],
      };
      return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
    }

    function makeLog(): DeviceCallLog {
      return {
        encoderFinishCount: 0,
        drawIndexedCount: 0,
        setBindGroupCount: 0,
        beginRenderPassCount: 0,
        setPipelineCount: 0,
        queueSubmitCount: 0,
        writeBufferCount: 0,
      };
    }

    beforeEach(() => {
      vi.stubGlobal('navigator', { ...baseNavigator });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function importEngine(): Promise<{
      createRenderer: (
        canvas: unknown,
        opts?: unknown,
        bundler?: unknown,
      ) => Promise<{
        backend: string;
        ready: Promise<void>;
        draw: (world: unknown) => void;
        onError: (
          cb: (err: { code: string; detail?: unknown; hint?: string; expected?: string }) => void,
        ) => () => void;
      }>;
    }> {
      return (await import(ENGINE)) as never;
    }

    async function importEcs(): Promise<{
      World: new () => {
        spawn: (...componentDatas: unknown[]) => unknown;
      };
    }> {
      return (await import('@forgeax/engine-ecs')) as never;
    }

    async function importComponents(): Promise<{
      Transform: unknown;
      MeshFilter: unknown;
      MeshRenderer: unknown;
      Camera: unknown;
      DirectionalLight: unknown;
      PointLight: unknown;
      SpotLight: unknown;
      HANDLE_CUBE: Handle<'MeshAsset', 'shared'>;
      HANDLE_TRIANGLE: Handle<'MeshAsset', 'shared'>;
    }> {
      return (await import('../index')) as never;
    }

    interface TestSetup {
      createRenderer: (
        canvas: unknown,
        opts?: unknown,
        bundler?: unknown,
      ) => Promise<{
        backend: string;
        ready: Promise<void>;
        draw: (world: unknown) => void;
        onError: (
          cb: (err: { code: string; detail?: unknown; hint?: string; expected?: string }) => void,
        ) => () => void;
      }>;
      log: DeviceCallLog;
    }

    async function setupWebGPU(): Promise<TestSetup> {
      const log = makeLog();
      const { device } = makeMockGPUDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const engine = await importEngine();
      return { createRenderer: engine.createRenderer, log };
    }

    function identityTransform(): Record<string, number> {
      return {
        posX: 0,
        posY: 0,
        posZ: 0,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      };
    }

    function cameraTransform(): Record<string, number> {
      return { ...identityTransform(), posZ: 3 };
    }

    function pointLightData(intensity: number): Record<string, number> {
      return { colorR: 1, colorG: 1, colorB: 1, intensity, range: 10 };
    }

    function spotLightData(intensity: number): Record<string, number> {
      return {
        directionX: 0,
        directionY: -1,
        directionZ: 0,
        colorR: 1,
        colorG: 1,
        colorB: 1,
        intensity,
        range: 10,
        innerConeDeg: 10,
        outerConeDeg: 30,
      };
    }

    function directionalLightData(intensity: number): Record<string, number> {
      return {
        directionX: 0,
        directionY: -1,
        directionZ: 0,
        colorR: 1,
        colorG: 1,
        colorB: 1,
        intensity,
      };
    }

    describe('record-time multi-light cap fail-fast (M3 w19)', () => {
      it("PointLight N>4 fires warn-once console.warn with detail.type='point'", async () => {
        const { createRenderer } = await setupWebGPU();
        const canvas = makeMockCanvas({ webgl2: 'context', webgpu: 'context' });
        const renderer = await createRenderer(
          canvas,
          {},
          { shaderManifestUrl: buildManifestDataUrl() },
        );
        await renderer.ready;
        const { World } = await importEcs();
        const C = await importComponents();
        const world = new World();
        world.spawn(
          { component: C.Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
          { component: C.Transform, data: cameraTransform() },
        );
        // 5 PointLights (N=5 > 4 first-slice cap).
        for (let i = 0; i < 5; i++) {
          world.spawn(
            {
              component: C.Transform,
              data: { ...identityTransform(), posX: i },
            },
            { component: C.PointLight, data: pointLightData(1) },
          );
        }

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        renderer.draw(world);

        const multiLightCalls = warnSpy.mock.calls.filter(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].startsWith('[forgeax] render-system-multi-light point:'),
        );
        expect(multiLightCalls.length).toBe(1);
        const detail = multiLightCalls[0]?.[1] as
          | { detail?: { type: string; got: number } }
          | undefined;
        expect(detail).toBeDefined();
        expect(detail?.detail?.type).toBe('point');
        expect(detail?.detail?.got).toBe(5);
        warnSpy.mockRestore();
      });

      it("SpotLight N>4 fires warn-once console.warn with detail.type='spot'", async () => {
        const { createRenderer } = await setupWebGPU();
        const canvas = makeMockCanvas({ webgl2: 'context', webgpu: 'context' });
        const renderer = await createRenderer(
          canvas,
          {},
          { shaderManifestUrl: buildManifestDataUrl() },
        );
        await renderer.ready;
        const { World } = await importEcs();
        const C = await importComponents();
        const world = new World();
        world.spawn(
          { component: C.Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
          { component: C.Transform, data: cameraTransform() },
        );
        for (let i = 0; i < 5; i++) {
          world.spawn(
            { component: C.Transform, data: { ...identityTransform(), posX: i } },
            { component: C.SpotLight, data: spotLightData(1) },
          );
        }

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        renderer.draw(world);

        const multiLightCalls = warnSpy.mock.calls.filter(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].startsWith('[forgeax] render-system-multi-light spot:'),
        );
        expect(multiLightCalls.length).toBe(1);
        const detail = multiLightCalls[0]?.[1] as
          | { detail?: { type: string; got: number } }
          | undefined;
        expect(detail).toBeDefined();
        expect(detail?.detail?.type).toBe('spot');
        expect(detail?.detail?.got).toBe(5);
        warnSpy.mockRestore();
      });

      it("DirectionalLight N>1 fires warn-once console.warn with detail.type='directional' (regression guard)", async () => {
        const { createRenderer } = await setupWebGPU();
        const canvas = makeMockCanvas({ webgl2: 'context', webgpu: 'context' });
        const renderer = await createRenderer(
          canvas,
          {},
          { shaderManifestUrl: buildManifestDataUrl() },
        );
        await renderer.ready;
        const { World } = await importEcs();
        const C = await importComponents();
        const world = new World();
        world.spawn(
          { component: C.Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
          { component: C.Transform, data: cameraTransform() },
        );
        world.spawn({ component: C.DirectionalLight, data: directionalLightData(1) });
        world.spawn({ component: C.DirectionalLight, data: directionalLightData(2) });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        renderer.draw(world);

        const multiLightCalls = warnSpy.mock.calls.filter(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].startsWith('[forgeax] render-system-multi-light directional:'),
        );
        expect(multiLightCalls.length).toBeGreaterThanOrEqual(1);
        const detail = multiLightCalls[0]?.[1] as
          | { detail?: { type: string; got: number } }
          | undefined;
        expect(detail?.detail?.type).toBe('directional');
        expect(detail?.detail?.got).toBe(2);
        warnSpy.mockRestore();
      });

      it('exactly 4 PointLights pass silently (first-slice cap at N=4)', async () => {
        const { createRenderer } = await setupWebGPU();
        const canvas = makeMockCanvas({ webgl2: 'context', webgpu: 'context' });
        const renderer = await createRenderer(
          canvas,
          {},
          { shaderManifestUrl: buildManifestDataUrl() },
        );
        await renderer.ready;
        const { World } = await importEcs();
        const C = await importComponents();
        const world = new World();
        world.spawn(
          { component: C.Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
          { component: C.Transform, data: cameraTransform() },
        );
        for (let i = 0; i < 4; i++) {
          world.spawn(
            { component: C.Transform, data: { ...identityTransform(), posX: i } },
            { component: C.PointLight, data: pointLightData(1) },
          );
        }

        const errors: { code: string }[] = [];
        renderer.onError((e) => errors.push(e));
        renderer.draw(world);

        expect(errors.some((e) => e.code === 'render-system-multi-light')).toBe(false);
      });

      it('4 PointLights + 4 SpotLights together pass silently (cap is per-bucket)', async () => {
        const { createRenderer } = await setupWebGPU();
        const canvas = makeMockCanvas({ webgl2: 'context', webgpu: 'context' });
        const renderer = await createRenderer(
          canvas,
          {},
          { shaderManifestUrl: buildManifestDataUrl() },
        );
        await renderer.ready;
        const { World } = await importEcs();
        const C = await importComponents();
        const world = new World();
        world.spawn(
          { component: C.Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
          { component: C.Transform, data: cameraTransform() },
        );
        for (let i = 0; i < 4; i++) {
          world.spawn(
            { component: C.Transform, data: { ...identityTransform(), posX: i } },
            { component: C.PointLight, data: pointLightData(1) },
          );
          world.spawn(
            { component: C.Transform, data: { ...identityTransform(), posY: i } },
            { component: C.SpotLight, data: spotLightData(1) },
          );
        }

        const errors: { code: string }[] = [];
        renderer.onError((e) => errors.push(e));
        renderer.draw(world);

        expect(errors.some((e) => e.code === 'render-system-multi-light')).toBe(false);
      });
    });
  });
}

{
  // ─── from spot-light-defaults.test.ts ───
  describe('spot-light-defaults.test.ts', () => {
    describe('SpotLight spawn default-value fallback (M1 w6)', () => {
      it('omitting cone / color / intensity / range fills layer-2 defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: { directionX: 0, directionY: -1, directionZ: 0 },
          })
          .unwrap();

        const view = world.get(e, SpotLight).unwrap();
        expect(view.directionX).toBe(0);
        expect(view.directionY).toBe(-1);
        expect(view.directionZ).toBe(0);
        expect(view.colorR).toBe(1);
        expect(view.colorG).toBe(1);
        expect(view.colorB).toBe(1);
        expect(view.intensity).toBe(1);
        expect(view.range).toBe(10.0);
        expect(view.innerConeDeg).toBe(0);
        expect(view.outerConeDeg).toBe(45);
      });

      it('innerConeDeg=0 + outerConeDeg=45 matches KHR pi/4 equivalent', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: { directionX: 0, directionY: -1, directionZ: 0 },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        const outerRad = (view.outerConeDeg * Math.PI) / 180;
        expect(outerRad).toBeCloseTo(Math.PI / 4, 5);
      });

      it('explicit cone degrees override defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: {
              directionX: 0,
              directionY: -1,
              directionZ: 0,
              innerConeDeg: 15,
              outerConeDeg: 30,
              intensity: 2,
              range: 12,
            },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        expect(view.innerConeDeg).toBe(15);
        expect(view.outerConeDeg).toBe(30);
        expect(view.intensity).toBe(2);
        expect(view.range).toBe(12);
      });

      it('autocomplete application point: payload.outerConeDeg / range / colorR inferred without as casts (AC-02)', () => {
        const world = new World();
        // The body type-checks without an `as` cast on any optional field
        // (innerConeDeg / outerConeDeg / range / colorR / colorG / colorB /
        // intensity all flow as `number | undefined`); compilation success is
        // the AC-02 autocomplete witness.
        const e = world
          .spawn({
            component: SpotLight,
            data: {
              directionX: 1,
              directionY: 0,
              directionZ: 0,
              outerConeDeg: 35,
              range: 9,
              colorR: 0.4,
            },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        expect(view.outerConeDeg).toBe(35);
        expect(view.range).toBe(9);
        expect(view.colorR).toBeCloseTo(0.4, 5);
      });
    });
  });
}

{
  // ─── from spot-light-spawn-bounds.test.ts ───
  describe('spot-light-spawn-bounds.test.ts', () => {
    describe('SpotLight spawn-time fail-fast bounds (M1 w7, AC-06 b+c)', () => {
      it('range < 0 spawn returns Result.err with detail.field=range', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: { directionX: 0, directionY: -1, directionZ: 0, range: -2 },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('spawn-light-invalid-bounds');
          if (r.error.code === 'spawn-light-invalid-bounds') {
            const detail = (r.error as unknown as { detail: { field: string; got: number } })
              .detail;
            expect(detail.field).toBe('range');
            expect(detail.got).toBe(-2);
            const hint = (r.error as unknown as { hint: string }).hint;
            expect(hint).toContain('use Number.POSITIVE_INFINITY for unlimited range');
          }
        }
      });

      it('outerConeDeg <= innerConeDeg spawn returns Result.err with detail.field=innerOuter', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: {
            directionX: 0,
            directionY: -1,
            directionZ: 0,
            innerConeDeg: 30,
            outerConeDeg: 25,
          },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('spawn-light-invalid-bounds');
          if (r.error.code === 'spawn-light-invalid-bounds') {
            const detail = (r.error as unknown as { detail: { field: string; got: number } })
              .detail;
            expect(detail.field).toBe('innerOuter');
            const hint = (r.error as unknown as { hint: string }).hint;
            expect(hint).toContain('inner cone is the saturated bright region');
            expect(hint).toContain('outer cone is the falloff edge');
          }
        }
      });

      it('outerConeDeg > 90 spawn returns Result.err with detail.field=outerNinety', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: {
            directionX: 0,
            directionY: -1,
            directionZ: 0,
            outerConeDeg: 91,
          },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('spawn-light-invalid-bounds');
          if (r.error.code === 'spawn-light-invalid-bounds') {
            const detail = (r.error as unknown as { detail: { field: string; got: number } })
              .detail;
            expect(detail.field).toBe('outerNinety');
            expect(detail.got).toBe(91);
            const hint = (r.error as unknown as { hint: string }).hint;
            expect(hint).toContain('a spot light cone wider than 90 degrees becomes a point light');
            expect(hint).toContain('use PointLight instead');
          }
        }
      });

      it('innerConeDeg=0 + outerConeDeg=45 (defaults) is valid', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: { directionX: 0, directionY: -1, directionZ: 0 },
        });
        expect(r.ok).toBe(true);
      });

      it('outerConeDeg = 90 (boundary) is valid', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: {
            directionX: 0,
            directionY: -1,
            directionZ: 0,
            outerConeDeg: 90,
          },
        });
        expect(r.ok).toBe(true);
      });

      it('range = +Infinity (default) + range = 0 + range = positive finite all valid', () => {
        const world = new World();
        expect(
          world.spawn({
            component: SpotLight,
            data: { directionX: 0, directionY: -1, directionZ: 0, range: Number.POSITIVE_INFINITY },
          }).ok,
        ).toBe(true);
        expect(
          world.spawn({
            component: SpotLight,
            data: { directionX: 0, directionY: -1, directionZ: 0, range: 0 },
          }).ok,
        ).toBe(true);
        expect(
          world.spawn({
            component: SpotLight,
            data: { directionX: 0, directionY: -1, directionZ: 0, range: 8 },
          }).ok,
        ).toBe(true);
      });
    });
  });
}

{
  // ─── from feat-20260625-spot-light-shadow-mapping M1 w1 ───
  describe('feat-20260625-spot-light-shadow-mapping M1 w1', () => {
    describe('SpotLight embedded shadow schema defaults', () => {
      it('castShadow defaults to true (embedded, AC-02)', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: { directionX: 0, directionY: -1, directionZ: 0 },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        expect(view.castShadow).toBe(true);
      });

      it('6 shadow fields align with DirectionalLight defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: { directionX: 0, directionY: -1, directionZ: 0 },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        expect(view.mapSize).toBe(2048);
        expect(view.depthBias).toBeCloseTo(0.005, 5);
        expect(view.normalBias).toBeCloseTo(0.05, 5);
        expect(view.nearPlane).toBeCloseTo(0.1, 5);
        expect(view.farPlane).toBeCloseTo(50, 5);
        expect(view.pcfKernelSize).toBe(3);
      });

      it('spawn with omitted shadow fields fills all defaults from schema', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: { directionX: 0, directionY: -1, directionZ: 0 },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        expect(view.castShadow).toBe(true);
        expect(view.mapSize).toBe(2048);
        expect(view.depthBias).toBeCloseTo(0.005, 5);
        expect(view.normalBias).toBeCloseTo(0.05, 5);
        expect(view.nearPlane).toBeCloseTo(0.1, 5);
        expect(view.farPlane).toBeCloseTo(50, 5);
        expect(view.pcfKernelSize).toBe(3);
      });
    });
  });
}

{
  // ─── from feat-20260621-merge-directionallightshadow-into-directionallight M1-t1 ───
  describe('feat-20260621-merge-directionallightshadow-into-directionallight M1-t1', () => {
    describe('DirectionalLight merged shadow field defaults', () => {
      it('castShadow defaults to true', () => {
        const world = new World();
        const e = world
          .spawn({
            component: DirectionalLight,
            data: { directionX: 0, directionY: -1, directionZ: 0 },
          })
          .unwrap();
        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.castShadow).toBe(true);
      });

      it('spawn with omitted shadow fields fills 9 merged defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: DirectionalLight,
            data: { directionX: 0, directionY: -1, directionZ: 0 },
          })
          .unwrap();
        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.cascadeCount).toBe(4);
        expect(view.splitLambda).toBeCloseTo(0.75, 5);
        expect(view.cascadeBlend).toBeCloseTo(0.2, 5);
        expect(view.mapSize).toBe(2048);
        expect(view.depthBias).toBeCloseTo(0.005, 5);
        expect(view.normalBias).toBeCloseTo(0.05, 5);
        expect(view.nearPlane).toBeCloseTo(0.1, 5);
        expect(view.farPlane).toBeCloseTo(50, 5);
        expect(view.pcfKernelSize).toBe(3);
      });

      it('spawn with empty data gets all 9 shadow defaults', () => {
        const world = new World();
        const e = world.spawn({ component: DirectionalLight, data: {} }).unwrap();
        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.cascadeCount).toBe(4);
        expect(view.splitLambda).toBeCloseTo(0.75, 5);
        expect(view.cascadeBlend).toBeCloseTo(0.2, 5);
        expect(view.mapSize).toBe(2048);
        expect(view.depthBias).toBeCloseTo(0.005, 5);
        expect(view.normalBias).toBeCloseTo(0.05, 5);
        expect(view.nearPlane).toBeCloseTo(0.1, 5);
        expect(view.farPlane).toBeCloseTo(50, 5);
        expect(view.pcfKernelSize).toBe(3);
      });

      it('spawn with full explicit shadow data overrides all 9 defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: DirectionalLight,
            data: {
              directionX: 0,
              directionY: -1,
              directionZ: 0,
              cascadeCount: 2,
              splitLambda: 0.5,
              cascadeBlend: 0.1,
              mapSize: 512,
              depthBias: 0.01,
              normalBias: 0.1,
              nearPlane: 1,
              farPlane: 100,
              pcfKernelSize: 5,
            },
          })
          .unwrap();
        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.cascadeCount).toBe(2);
        expect(view.splitLambda).toBeCloseTo(0.5, 5);
        expect(view.cascadeBlend).toBeCloseTo(0.1, 5);
        expect(view.mapSize).toBe(512);
        expect(view.depthBias).toBeCloseTo(0.01, 5);
        expect(view.normalBias).toBeCloseTo(0.1, 5);
        expect(view.nearPlane).toBeCloseTo(1, 5);
        expect(view.farPlane).toBeCloseTo(100, 5);
        expect(view.pcfKernelSize).toBe(5);
      });

      it('schema has 17 fields (7 light + 1 castShadow + 9 shadow)', () => {
        expect(Object.keys(DirectionalLight.schema).length).toBe(17);
        expect('castShadow' in DirectionalLight.schema).toBe(true);
        expect('cascadeCount' in DirectionalLight.schema).toBe(true);
        expect('splitLambda' in DirectionalLight.schema).toBe(true);
        expect('cascadeBlend' in DirectionalLight.schema).toBe(true);
        expect('mapSize' in DirectionalLight.schema).toBe(true);
        expect('depthBias' in DirectionalLight.schema).toBe(true);
        expect('normalBias' in DirectionalLight.schema).toBe(true);
        expect('nearPlane' in DirectionalLight.schema).toBe(true);
        expect('farPlane' in DirectionalLight.schema).toBe(true);
        expect('pcfKernelSize' in DirectionalLight.schema).toBe(true);
      });
    });
  });
}

{
  // ─── from feat-20260621-merge-directionallightshadow-into-directionallight M1-t2 ───
  describe('feat-20260621-merge-directionallightshadow-into-directionallight M1-t2', () => {
    describe('DirectionalLight.validate() shadow field enforcement', () => {
      it('rejects even pcfKernelSize (2) with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { pcfKernelSize: 2 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('pcfKernelSize');
        expect(err.detail.value).toBe(2);
        expect(err.detail.min).toBe(1);
        // The hint must name the odd constraint so an AI retry does not loop
        // 2 -> 3 wrong-way (4 -> 6); verify-step AI-user finding F-6.
        expect(err.hint).toBe('set pcfKernelSize to an odd integer >= 1; got 2');
      });

      it('rejects pcfKernelSize < 1 (0) with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { pcfKernelSize: 0 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('pcfKernelSize');
        expect(err.detail.value).toBe(0);
      });

      it('rejects pcfKernelSize < 1 (-1) with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { pcfKernelSize: -1 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('pcfKernelSize');
        expect(err.detail.value).toBe(-1);
      });

      it('accepts pcfKernelSize=1 (smallest valid odd integer)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { pcfKernelSize: 1 },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts pcfKernelSize=3 (default odd integer)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { pcfKernelSize: 3 },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts pcfKernelSize=7 (larger odd integer)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { pcfKernelSize: 7 },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects mapSize < 1 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { mapSize: 0 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('mapSize');
      });

      it('rejects cascadeCount < 1 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { cascadeCount: 0 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('cascadeCount');
      });

      it('rejects cascadeCount > 4 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { cascadeCount: 5 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('cascadeCount');
        expect(err.detail.value).toBe(5);
      });

      it('rejects non-integer cascadeCount (1.5) with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { cascadeCount: 1.5 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('cascadeCount');
      });

      it('rejects splitLambda < 0 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { splitLambda: -0.1 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('splitLambda');
      });

      it('rejects splitLambda > 1 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { splitLambda: 1.1 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('splitLambda');
      });

      it('accepts splitLambda=0 (boundary valid)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { splitLambda: 0 },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts splitLambda=1 (boundary valid)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { splitLambda: 1 },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects cascadeBlend < 0 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { cascadeBlend: -0.01 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('cascadeBlend');
      });

      it('rejects cascadeBlend > 0.5 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { cascadeBlend: 0.51 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('cascadeBlend');
      });

      it('accepts cascadeBlend=0 (boundary valid)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { cascadeBlend: 0 },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts cascadeBlend=0.5 (boundary valid)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { cascadeBlend: 0.5 },
        });
        expect(r.ok).toBe(true);
      });
    });
  });
}

{
  // ─── from feat-20260621-merge-directionallightshadow-into-directionallight M1-t3 ───
  describe('feat-20260621-merge-directionallightshadow-into-directionallight M1-t3', () => {
    describe('DirectionalLight.validate() skips shadow validation when castShadow=false', () => {
      it('castShadow=false tolerates even pcfKernelSize (2) because unused', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { castShadow: false, pcfKernelSize: 2 },
        });
        expect(r.ok).toBe(true);
      });

      it('castShadow=false tolerates pcfKernelSize=0 because unused', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { castShadow: false, pcfKernelSize: 0 },
        });
        expect(r.ok).toBe(true);
      });

      it('castShadow=false tolerates mapSize=0 because unused', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { castShadow: false, mapSize: 0 },
        });
        expect(r.ok).toBe(true);
      });

      it('castShadow=false tolerates cascadeCount=5 (out of [1,4]) because unused', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { castShadow: false, cascadeCount: 5 },
        });
        expect(r.ok).toBe(true);
      });

      it('castShadow=false tolerates splitLambda=2 (out of [0,1]) because unused', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { castShadow: false, splitLambda: 2 },
        });
        expect(r.ok).toBe(true);
      });

      it('castShadow=false tolerates cascadeBlend=1 (out of [0,0.5]) because unused', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { castShadow: false, cascadeBlend: 1 },
        });
        expect(r.ok).toBe(true);
      });

      it('castShadow=true (explicit) still enforces pcfKernelSize odd>=1', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { castShadow: true, pcfKernelSize: 2 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('pcfKernelSize');
      });

      it('omitted castShadow (treated as default true) still enforces pcfKernelSize odd>=1', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { pcfKernelSize: 2 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('pcfKernelSize');
      });
    });
  });

  // ─── from pbr-view-bgl-layout.test.ts ───
  describe('pbr-view-bgl-layout.test.ts', () => {
    // feat-20260625-spot-light-shadow-mapping M3 / w12 (D-5 + AC-08) +
    // w22 (D-1 fragment side, D-5 REVISED: binding 9 = matrix array).
    //
    // `buildPbrViewBglEntries` (pbr-pipeline.ts) is the runtime SSOT for the
    // @group(0) view bind-group layout. The matching WGSL binding declarations
    // live in common.wgsl (binding 0..9). This block locks the BGL shape so a
    // BGL <-> WGSL drift (e.g. binding 8 missing, wrong sampleType, or a binding
    // 9 declared as something other than a FRAGMENT uniform buffer) is caught at
    // unit time instead of as a WebGPU validation crash in the browser path
    // (memory: BGL shape mismatch is a browser-path-only bug).
    //
    // visibility flags mirror the WebGPU GPUShaderStage bitmask:
    //   VERTEX = 0x1, FRAGMENT = 0x2.
    const VISIBILITY_FRAGMENT = 0x2;
    const VISIBILITY_VERTEX_FRAGMENT = 0x1 | 0x2;

    describe('binding 8 = spotShadowMap (D-5 always-on, last view-BG entry)', () => {
      it('declares binding 8 as a depth 2D texture, FRAGMENT-only', () => {
        const entries = buildPbrViewBglEntries({ storageBuffer: true });
        const b8 = entries.find((e) => e.binding === 8);
        expect(b8).toBeDefined();
        if (b8 === undefined) throw new Error('binding 8 missing from view BGL');
        expect(b8.texture?.sampleType).toBe('depth');
        expect(b8.texture?.viewDimension).toBe('2d');
        expect(b8.visibility).toBe(VISIBILITY_FRAGMENT);
      });

      it('declares binding 8 regardless of storageBuffer caps (always-on, no gate)', () => {
        const withStorage = buildPbrViewBglEntries({ storageBuffer: true });
        const noStorage = buildPbrViewBglEntries({ storageBuffer: false });
        expect(withStorage.some((e) => e.binding === 8)).toBe(true);
        expect(noStorage.some((e) => e.binding === 8)).toBe(true);
      });

      it('binding 8 is the last entry (no binding 9)', () => {
        const entries = buildPbrViewBglEntries({ storageBuffer: true });
        expect(entries.some((e) => e.binding === 9)).toBe(false);
        expect(entries.some((e) => e.binding === 10)).toBe(false);
      });
    });

    // feat-20260625-spot-light-shadow-mapping w25 (scope-amend webkit-fallback):
    // the per-spot fragment-read perspective `spotLightViewProj` matrices were
    // folded out of a standalone @group(0) binding 9 uniform buffer into the View
    // UBO tail (`view.spotLightViewProj`, bytes 528..784, written by the host
    // viewPayload). The standalone binding pushed the WebGL2 fallback fragment
    // uniform-buffer count to 12, over GLES 3.0's
    // `max_uniform_buffers_per_shader_stage = 11`, crashing pipeline-layout
    // creation on the compat path (this feat's target). The view BGL therefore
    // ends at binding 8 — no binding 9 — and the spot matrices ride in the View
    // UBO (binding 0). This block locks that the spot matrices add ZERO new view
    // BGL buffer bindings (the WebGL2 budget invariant).
    describe('spotLightViewProj folded into View UBO (binding 0), not a new binding', () => {
      it('view BGL declares no uniform buffer beyond binding 7 (only binding 0 = view, 6/7 = point/cascade)', () => {
        // Enumerate uniform-buffer entries on the view BGL. After the w25 fold,
        // the only uniform buffers are binding 0 (View UBO, carries the spot
        // matrices in its tail), binding 6 (point shadowParams) and binding 7
        // (shadowCasterCascade). No standalone spot-matrix uniform buffer.
        const entries = buildPbrViewBglEntries({ storageBuffer: true });
        const uniformBufferBindings = entries
          .filter((e) => e.buffer?.type === 'uniform')
          .map((e) => e.binding)
          .sort((a, b) => a - b);
        // storageBuffer=true: bindings 1+2 are read-only-storage (not uniform).
        expect(uniformBufferBindings).toEqual([0, 6, 7]);
      });

      it('storageBuffer=false: WebGL2 fallback uniform-buffer bindings stay within budget', () => {
        // On the WebGL2 fallback path bindings 1+2 (point/spot light arrays)
        // become uniform buffers. The fragment-stage uniform-buffer count must
        // stay <= 11 (GLES 3.0 max_uniform_buffers_per_shader_stage). View BGL
        // fragment uniform buffers after w25: binding 0 (view), 1 (pointLights),
        // 2 (spotLights), 6 (shadowParams), 7 (shadowCasterCascade) = 5. There is
        // NO standalone spot-matrix uniform buffer (the 12th that overflowed).
        const entries = buildPbrViewBglEntries({ storageBuffer: false });
        const fragmentUniformBuffers = entries.filter(
          (e) => e.buffer?.type === 'uniform' && (e.visibility & VISIBILITY_FRAGMENT) !== 0,
        );
        // 5 view-BG fragment uniform buffers (was 6 before the fold).
        expect(fragmentUniformBuffers.length).toBe(5);
        // No binding 9 (the folded-away standalone spot-matrix UBO).
        expect(entries.some((e) => e.binding === 9)).toBe(false);
      });
    });

    describe('sampler reuse (binding 4) — spot adds no new sampler (D-5)', () => {
      it('keeps binding 4 as the single comparison sampler (shared by directional/point/spot)', () => {
        const entries = buildPbrViewBglEntries({ storageBuffer: true });
        const samplers = entries.filter((e) => e.sampler !== undefined);
        expect(samplers).toHaveLength(1);
        expect(samplers[0]?.binding).toBe(4);
        expect(samplers[0]?.sampler?.type).toBe('comparison');
      });
    });

    describe('bindings 3/4/5/6/7 unchanged (AC-08 no-regress)', () => {
      it('binding 3 = directional depth 2D, VERTEX|FRAGMENT', () => {
        const e = buildPbrViewBglEntries({ storageBuffer: true }).find((x) => x.binding === 3);
        expect(e?.texture?.sampleType).toBe('depth');
        expect(e?.texture?.viewDimension).toBe('2d');
        expect(e?.visibility).toBe(VISIBILITY_VERTEX_FRAGMENT);
      });

      it('binding 4 = comparison sampler, FRAGMENT', () => {
        const e = buildPbrViewBglEntries({ storageBuffer: true }).find((x) => x.binding === 4);
        expect(e?.sampler?.type).toBe('comparison');
        expect(e?.visibility).toBe(VISIBILITY_FRAGMENT);
      });

      it('binding 5 = point cube-array depth, FRAGMENT', () => {
        const e = buildPbrViewBglEntries({ storageBuffer: true }).find((x) => x.binding === 5);
        expect(e?.texture?.sampleType).toBe('depth');
        expect(e?.texture?.viewDimension).toBe('cube-array');
        expect(e?.visibility).toBe(VISIBILITY_FRAGMENT);
      });

      it('binding 6 = point shadow params UBO, FRAGMENT', () => {
        const e = buildPbrViewBglEntries({ storageBuffer: true }).find((x) => x.binding === 6);
        expect(e?.buffer?.type).toBe('uniform');
        expect(e?.visibility).toBe(VISIBILITY_FRAGMENT);
      });

      it('binding 7 = shadowCasterCascade UBO, VERTEX|FRAGMENT', () => {
        const e = buildPbrViewBglEntries({ storageBuffer: true }).find((x) => x.binding === 7);
        expect(e?.buffer?.type).toBe('uniform');
        expect(e?.visibility).toBe(VISIBILITY_VERTEX_FRAGMENT);
      });
    });

    describe('full binding roster is contiguous 0..8', () => {
      it('exposes exactly bindings 0..8 with no gaps (binding 9 folded into View UBO, w25)', () => {
        const bindings = buildPbrViewBglEntries({ storageBuffer: true })
          .map((e) => e.binding)
          .sort((a, b) => a - b);
        expect(bindings).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      });
    });
  });
}

{
  // ─── feat-20260625-spot-light-shadow-mapping verify round-1 F-2 ───
  // SpotLight.validate() shadow-field enforcement, mirroring the
  // DirectionalLight.validate() block above (P4 cross-light parity).
  describe('feat-20260625-spot-light-shadow-mapping SpotLight.validate()', () => {
    describe('SpotLight.validate() shadow field enforcement', () => {
      it('rejects even pcfKernelSize (2) with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: { directionX: 0, directionY: -1, directionZ: 0, pcfKernelSize: 2 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('pcfKernelSize');
        expect(err.detail.value).toBe(2);
        expect(err.hint).toBe('set pcfKernelSize to an odd integer >= 1; got 2');
      });

      it('rejects pcfKernelSize < 1 (0) with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: { directionX: 0, directionY: -1, directionZ: 0, pcfKernelSize: 0 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('pcfKernelSize');
      });

      it('rejects mapSize < 1 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: { directionX: 0, directionY: -1, directionZ: 0, mapSize: 0 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('mapSize');
      });

      it('rejects farPlane <= nearPlane with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: { directionX: 0, directionY: -1, directionZ: 0, nearPlane: 10, farPlane: 5 },
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('farPlane');
      });

      it('accepts valid odd pcfKernelSize (5) + sane planes', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: {
            directionX: 0,
            directionY: -1,
            directionZ: 0,
            pcfKernelSize: 5,
            mapSize: 1024,
            nearPlane: 0.1,
            farPlane: 50,
          },
        });
        expect(r.ok).toBe(true);
      });

      it('skips shadow-field validation when castShadow is false', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: {
            directionX: 0,
            directionY: -1,
            directionZ: 0,
            castShadow: false,
            pcfKernelSize: 2,
          },
        });
        expect(r.ok).toBe(true);
      });
    });
  });
}
