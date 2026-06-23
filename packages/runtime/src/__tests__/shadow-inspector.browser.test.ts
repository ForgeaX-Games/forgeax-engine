// shadow-inspector.browser.test.ts - feat-20260520-directional-light-shadow-mapping
// verify round 1 fix (Fix 2): real AC-04/22 once-warn assertions + AC-19
// structured error validation.
//
// AC anchor: requirements AC-04 (0 shadow + 1 light -> once-warn),
// AC-22 (>=1 shadow + 0 light -> once-warn), AC-17 (Inspector methods
// registered), AC-19 (mapSize=0 -> shadow-invalid-config).
// Plan-strategy D-8 (once-warn via errorRegistry.fire), section 8
// error strategy SSOT.

import { World } from '@forgeax/engine-ecs';
import type { Handler, RegisterMethodResult, Registry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { DirectionalLight } from '../components/directional-light';
import { ShadowInvalidConfigError } from '../errors';
import { registerRuntimeInspector } from '../register-inspector';
import { extractFrame } from '../render-system-extract';
import type { Renderer } from '../renderer';

// Reuse FakeRegistry pattern from inspector-lights-bucket.test.ts
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

describe('shadow inspector bucket', () => {
  // ── AC-17: Inspector method registration ──────────────────────────────
  describe('AC-17 Inspector bucket registration', () => {
    // FakeRenderer with a capture-capable errorRegistry
    function makeFakeRenderer() {
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

    it('registers runtime.lights.directionalShadow.mapSize when world provided', () => {
      const world = new World();

      const reg = new FakeRegistry();
      const renderer = makeFakeRenderer();
      const r = registerRuntimeInspector(reg, renderer, world);
      expect(r.ok).toBe(true);

      const handler = reg.methods.get('runtime.lights.directionalShadow.mapSize');
      expect(handler).toBeDefined();
    });

    it('registers runtime.lights.directionalShadow.lightSpaceMatrix when world provided', () => {
      const world = new World();

      const reg = new FakeRegistry();
      const renderer = makeFakeRenderer();
      registerRuntimeInspector(reg, renderer, world);

      const handler = reg.methods.get('runtime.lights.directionalShadow.lightSpaceMatrix');
      expect(handler).toBeDefined();
    });

    it('registers runtime.shadow.debugReadback when world provided', () => {
      const world = new World();

      const reg = new FakeRegistry();
      const renderer = makeFakeRenderer();
      registerRuntimeInspector(reg, renderer, world);

      const handler = reg.methods.get('runtime.shadow.debugReadback');
      expect(handler).toBeDefined();
    });

    it('does not register shadow methods when world is omitted', () => {
      const reg = new FakeRegistry();
      const renderer = makeFakeRenderer();
      const r = registerRuntimeInspector(reg, renderer);
      expect(r.ok).toBe(true);

      expect(reg.methods.has('runtime.lights.directionalShadow.mapSize')).toBe(false);
      expect(reg.methods.has('runtime.lights.directionalShadow.lightSpaceMatrix')).toBe(false);
      expect(reg.methods.has('runtime.shadow.debugReadback')).toBe(false);
    });

    // AC-11(d): when engine.directionalShadow (backed by PipelineState
    // shadowTexture === null) returns null (castShadow:false or no shadow RT
    // allocated), the mapSize inspector handler returns { mapSize: 0 }.
    it('AC-11(d): mapSize handler returns { mapSize: 0 } when engine.directionalShadow is null', () => {
      const world = new World();

      const reg = new FakeRegistry();
      const rendererWithNullShadow = {
        ...makeFakeRenderer(),
        directionalShadow: null,
      } as unknown as Renderer;
      registerRuntimeInspector(reg, rendererWithNullShadow, world);

      const handler = reg.methods.get('runtime.lights.directionalShadow.mapSize');
      expect(handler).toBeDefined();
      if (handler === undefined) throw new Error('mapSize handler not registered');
      const result = handler(undefined);
      expect(result).toEqual({ mapSize: 0 });
    });

    it('registerMethod same-name fail-fast (register twice -> error)', () => {
      const world = new World();

      const reg = new FakeRegistry();
      const renderer = makeFakeRenderer();
      registerRuntimeInspector(reg, renderer, world);

      const r2 = registerRuntimeInspector(reg, renderer, world);
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.error.code).toBe('console-startup-failed');
      }
    });
  });

  // ── AC-04: castShadow gates shadowMapSize via extractFrame ─────────────
  // feat-20260621: orphan-shadow detection is gone (no separate shadow
  // component to orphan); "shadow off" is now simply castShadow:false, which
  // the extract surfaces as shadowMapSize === undefined.
  describe('AC-04 castShadow gates extract shadowMapSize', () => {
    it('castShadow:false -> directional defined, shadowMapSize undefined', () => {
      const world = new World();

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
            castShadow: false,
          },
        })
        .unwrap();

      const extracted = extractFrame(world);
      expect(extracted.lights.directional).toBeDefined();
      expect(extracted.lights.shadowMapSize).toBeUndefined();
    });

    it('no DirectionalLight -> directional undefined, shadowMapSize undefined', () => {
      const world = new World();
      const extracted = extractFrame(world);
      expect(extracted.lights.directional).toBeUndefined();
      expect(extracted.lights.shadowMapSize).toBeUndefined();
    });

    it('castShadow default (true) with mapSize -> shadowMapSize populated', () => {
      const world = new World();

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
            mapSize: 2048,
          },
        })
        .unwrap();

      const extracted = extractFrame(world);
      expect(extracted.lights.directional).toBeDefined();
      expect(extracted.lights.shadowMapSize).toBe(2048);
    });
  });

  // ── AC-19: mapSize=0 fail-fast structured error ────────────────────────
  describe('AC-19 ShadowInvalidConfigError structured properties', () => {
    it('ShadowInvalidConfigError carries code + expected + hint + detail (charter P3)', () => {
      const err = new ShadowInvalidConfigError('mapSize', 0, 1);

      expect(err.code).toBe('shadow-invalid-config');
      expect(err.name).toBe('ShadowInvalidConfigError');
      expect(err.expected).toBe('mapSize >= 1');
      expect(err.hint).toBe('set mapSize to a value >= 1; got 0');
      expect(err.detail).toEqual({ field: 'mapSize', value: 0, min: 1 });
    });

    it('mapSize=0 spawn returns structured error via component validate', () => {
      const world = new World();

      const r = world.spawn({
        component: DirectionalLight,
        data: { mapSize: 0 },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // The error flows through ECS's error routing, so it may be wrapped.
        // Verify the error has the right shape.
        expect(r.error).toBeDefined();
        const err = r.error as {
          code?: string;
          expected?: string;
          hint?: string;
          detail?: unknown;
        };
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.expected).toBe('mapSize >= 1');
        expect(err.hint).toBe('set mapSize to a value >= 1; got 0');
      }
    });

    it('mapSize=1 spawn succeeds (no error)', () => {
      const world = new World();

      const r = world.spawn({
        component: DirectionalLight,
        data: { mapSize: 1 },
      });
      expect(r.ok).toBe(true);
    });
  });

  // ── castShadow: false shadow-off assertions ─────────────────────────
  describe('castShadow: false shadow-off', () => {
    it('light with castShadow:false — extract sees undefined shadowMapSize', () => {
      const world = new World();

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
            castShadow: false,
          },
        })
        .unwrap();

      const extracted = extractFrame(world);
      expect(extracted.lights.directional).toBeDefined();
      // castShadow:false => shadow simply off, no error
      expect(extracted.lights.shadowMapSize).toBeUndefined();
    });
  });
});
