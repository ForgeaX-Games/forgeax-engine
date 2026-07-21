// animation-plugin-self-owns-resolver.test.ts
//
// Regression: animationPlugin() must SELF-INSERT the AnimationAssetResolver
// resource in build() (like physicsPlugin owns PhysicsWorld, statePlugin owns
// its State resources) — not rely on the app layer to pre-inject it.
//
// Why this exists: advanceAnimationPlayer declares
// `resources: [ANIMATION_ASSET_RESOLVER_KEY]` UNCONDITIONALLY. The canvas form
// of createApp used to hand-insert the resolver before running plugins; the
// assemble form (host-owned world — the editor ▶ Play world fork) did NOT, so a
// host that listed animationPlugin() but forgot the manual insert crashed on the
// first world.update(1 / 60).unwrap() with:
//   AppError[app-system-update-failed] … Required resource "AnimationAssetResolver"
//   not found for system "advanceAnimationPlayer".
// Collapsing ownership INTO the plugin makes both createApp forms correct for
// free (SSOT / Derive — a single owner, no per-call-site sync).
//
// This test drives build() over a bare World (no app layer at all — the harshest
// form of the assemble contract) and asserts a tick runs clean.

import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ANIMATION_ASSET_RESOLVER_KEY } from '../createRenderer';
import { animationPlugin } from '../plugin-factories';

describe('animationPlugin — self-owns AnimationAssetResolver (SSOT)', () => {
  it('build() inserts the resource so a bare-world tick does not fault', async () => {
    const world = new World();
    // Precondition: the resource is absent — no app layer pre-injected it.
    expect(world.hasResource(ANIMATION_ASSET_RESOLVER_KEY)).toBe(false);

    const res = await animationPlugin().build(world);
    expect(res.ok).toBe(true);

    // The plugin minted + inserted the resolver its own system requires.
    expect(world.hasResource(ANIMATION_ASSET_RESOLVER_KEY)).toBe(true);

    // Drive a tick. Without the resource, advanceAnimationPlayer's ParamValidation
    // routes 'invalid' → the error handler fires (the crash mode). With the plugin
    // self-owning it, the handler must NOT fire.
    let captured: unknown;
    world.setErrorHandler((error) => {
      captured = error;
    });
    world.update(1 / 60).unwrap();
    expect(captured).toBeUndefined();
  });

  it('build() is idempotent — does not overwrite a host-pre-injected resolver', async () => {
    const world = new World();
    const sentinel = { resolveAnimationClip: () => undefined };
    world.insertResource(ANIMATION_ASSET_RESOLVER_KEY, sentinel);

    const res = await animationPlugin().build(world);
    expect(res.ok).toBe(true);

    // A host that DID pre-inject (e.g. a custom resolver) keeps its instance —
    // the plugin only fills the gap, mirroring inputPlugin/audioPlugin's guard.
    expect(world.getResource(ANIMATION_ASSET_RESOLVER_KEY)).toBe(sentinel);
  });
});
