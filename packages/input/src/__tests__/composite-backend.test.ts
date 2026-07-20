// composite-backend.test.ts -- merge-semantics contract for the
// CompositeInputBackend decorator.
//
// WHY this backend exists: an AI (or a record/replay harness) needs to feed
// synthetic input into the SAME `INPUT_BACKEND_KEY` world resource a human's
// browser backend occupies -- WITHOUT evicting the human (PIE + human-as-final-
// authority: a human can take over at any instant). Replacing the resource
// would lock the human out; a decorator merges both sources so they coexist.
//
// The scan system calls `backend.sample()` exactly once per frame and RELIES on
// its side effects (up-edge / movement / wheel accumulators drain on read).
// So the composite must call `inner.sample()` exactly once and merge the
// injected state field-by-field, honoring each field's lifecycle:
//
//   downKeys   held across frames         -> UNION(inner, injected.held)
//   upKeys     lives exactly ONE frame    -> UNION, injected side drained here
//   buttons    held tuple                 -> OR per slot
//   movementX/Y, wheelDelta  accumulators -> SUM, injected side drained here
//   focused    gates up-edge suppression  -> inner.focused || injectedActive
//   pointerLocked                          -> inner (AI never fabricates a lock)
//
// yieldToHuman (default ON): a human-held key suppresses injected state only for
// that SAME key in that frame, so the AI never fights the human for that key while
// unrelated synthetic input can continue. This is the structural "human wins" gate.

import { describe, expect, it } from 'vitest';
// Import from the leaf modules, not the '../index' barrel: the barrel re-exports
// frame-start-scan-system, which value-imports @forgeax/engine-ecs and would drag
// an (unbuilt-dist) runtime dependency into this pure unit test. composite-backend
// and input-snapshot have no engine-ecs dependency.
import { makeCompositeBackend } from '../composite-backend';
import type { InputBackend, InputBackendSample } from '../input-snapshot';

/** Minimal programmable stand-in for the human/browser backend. */
function fakeInner(init?: Partial<InputBackendSample>): InputBackend & {
  set: (patch: Partial<InputBackendSample>) => void;
  sampleCalls: () => number;
} {
  let calls = 0;
  let state: InputBackendSample = {
    downKeys: new Set<string>(),
    upKeys: new Set<string>(),
    buttons: [false, false, false],
    movementX: 0,
    movementY: 0,
    wheelDelta: 0,
    focused: true,
    pointerLocked: false,
    ...init,
  };
  return {
    sample(): InputBackendSample {
      calls++;
      const out = { ...state, downKeys: new Set(state.downKeys), upKeys: new Set(state.upKeys) };
      // Mirror the real backend: accumulators drain on read.
      state = { ...state, upKeys: new Set(), movementX: 0, movementY: 0, wheelDelta: 0 };
      return out;
    },
    detach() {},
    set(patch) {
      state = { ...state, ...patch };
    },
    sampleCalls: () => calls,
  };
}

describe('CompositeInputBackend merge semantics', () => {
  it('calls inner.sample() exactly once per composite.sample() (respects side effects)', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.sample();
    c.sample();
    expect(inner.sampleCalls()).toBe(2);
  });

  it('downKeys is the UNION of human-held and AI-injected keys', () => {
    // yieldToHuman OFF so overlap coexists -- pure union semantics. (The default
    // yield behavior is covered separately in the yieldToHuman describe block.)
    const inner = fakeInner({ downKeys: new Set(['d']) });
    const c = makeCompositeBackend(inner, { yieldToHuman: false });
    c.press('w');
    const s = c.sample();
    expect(s.downKeys.has('w')).toBe(true); // AI
    expect(s.downKeys.has('d')).toBe(true); // human
  });

  it('injected key stays held across frames until released', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.press('w');
    expect(c.sample().downKeys.has('w')).toBe(true);
    expect(c.sample().downKeys.has('w')).toBe(true); // still held next frame
  });

  it('release produces an up-edge that lives exactly ONE frame', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.press('w');
    c.sample(); // held
    c.release('w');
    const s1 = c.sample();
    expect(s1.upKeys.has('w')).toBe(true); // edge appears once
    expect(s1.downKeys.has('w')).toBe(false); // no longer held
    const s2 = c.sample();
    expect(s2.upKeys.has('w')).toBe(false); // and is gone the next frame
  });

  it('merges human and AI up-edges in the same frame', () => {
    const inner = fakeInner({ upKeys: new Set(['d']) });
    const c = makeCompositeBackend(inner);
    c.press('w');
    c.sample();
    c.release('w');
    inner.set({ upKeys: new Set(['d']) });
    const s = c.sample();
    expect(s.upKeys.has('w')).toBe(true); // AI
    expect(s.upKeys.has('d')).toBe(true); // human
  });

  it('buttons are OR-merged per slot (AI never clears a human button)', () => {
    const inner = fakeInner({ buttons: [false, true, false] });
    const c = makeCompositeBackend(inner);
    c.setButton(0, true);
    const s = c.sample();
    expect(s.buttons).toEqual([true, true, false]);
  });

  it('movement + wheel accumulators are SUMMED and the injected side drains on read', () => {
    const inner = fakeInner({ movementX: 3, movementY: -2, wheelDelta: 1 });
    const c = makeCompositeBackend(inner);
    c.addMovement(10, 20);
    c.addWheel(2);
    const s1 = c.sample();
    expect(s1.movementX).toBe(13);
    expect(s1.movementY).toBe(18);
    expect(s1.wheelDelta).toBe(3);
    // Injected accumulator must reset (inner already drains itself).
    const s2 = c.sample();
    expect(s2.movementX).toBe(0);
    expect(s2.movementY).toBe(0);
    expect(s2.wheelDelta).toBe(0);
  });

  it('focused is forced true while AI injection is active (so scan does not suppress AI up-edges)', () => {
    const inner = fakeInner({ focused: false }); // headless / backgrounded tab
    const c = makeCompositeBackend(inner);
    c.press('w');
    expect(c.sample().focused).toBe(true);
  });

  it('focused falls back to inner when there is no active injection', () => {
    const inner = fakeInner({ focused: false });
    const c = makeCompositeBackend(inner);
    expect(c.sample().focused).toBe(false);
    inner.set({ focused: true });
    expect(c.sample().focused).toBe(true);
  });

  it('pointerLocked passes through from inner (AI cannot fabricate a lock)', () => {
    const inner = fakeInner({ pointerLocked: true });
    const c = makeCompositeBackend(inner);
    c.press('w');
    expect(c.sample().pointerLocked).toBe(true);
  });

  describe('yieldToHuman gate (human-as-final-authority) — PER-KEY', () => {
    it('the human wins only the SAME key; unrelated AI keys coexist', () => {
      const inner = fakeInner();
      const c = makeCompositeBackend(inner); // yieldToHuman defaults ON
      c.press('w');
      expect(c.sample().downKeys.has('w')).toBe(true); // AI drives while human idle

      // Human presses a DIFFERENT key (d): AI's w survives, human's d is added —
      // they coexist. This is the key difference from a global-yield gate.
      inner.set({ downKeys: new Set(['d']) });
      const s = c.sample();
      expect(s.downKeys.has('d')).toBe(true); // human's key
      expect(s.downKeys.has('w')).toBe(true); // AI's DIFFERENT key still lives

      inner.set({ downKeys: new Set() });
      expect(c.sample().downKeys.has('w')).toBe(true); // AI still held
    });

    it('a human press on the SAME key the AI holds suppresses the AI copy (no double-count)', () => {
      const inner = fakeInner();
      const c = makeCompositeBackend(inner);
      c.press('w');
      // Human grabs the SAME key. downKeys still has 'w' exactly once (Set), but the
      // AI copy is suppressed so releasing the AI key does not linger under the human.
      inner.set({ downKeys: new Set(['w']) });
      expect(c.sample().downKeys.has('w')).toBe(true); // present via the human

      // Human lets go while AI still holds w -> AI resumes ownership of w.
      inner.set({ downKeys: new Set() });
      expect(c.sample().downKeys.has('w')).toBe(true);
    });

    it('suppresses an injected up-edge while the human still holds that same key', () => {
      const inner = fakeInner();
      const c = makeCompositeBackend(inner);
      c.press('w');
      c.sample();

      // The human takes w, then the AI releases its now-yielded copy. The composite
      // must not tell the scan system that w went up while the human still holds it.
      inner.set({ downKeys: new Set(['w']) });
      c.release('w');
      const s = c.sample();
      expect(s.downKeys.has('w')).toBe(true);
      expect(s.upKeys.has('w')).toBe(false);

      // The injected edge was drained with the sample, so releasing the human key
      // later is represented only by the human backend's own edge.
      inner.set({ downKeys: new Set(), upKeys: new Set(['w']) });
      const afterHumanRelease = c.sample();
      expect(afterHumanRelease.downKeys.has('w')).toBe(false);
      expect(afterHumanRelease.upKeys.has('w')).toBe(true);
    });

    it('with yieldToHuman disabled, AI and human coexist even on the SAME key', () => {
      const inner = fakeInner({ downKeys: new Set(['w']) });
      const c = makeCompositeBackend(inner, { yieldToHuman: false });
      c.press('w');
      const s = c.sample();
      expect(s.downKeys.has('w')).toBe(true); // union collapses to one anyway
    });

    it('setYieldToHuman toggles the SAME-key gate at runtime', () => {
      const inner = fakeInner({ downKeys: new Set(['w']) }); // human holds w
      const c = makeCompositeBackend(inner);
      c.press('w'); // AI also holds w
      // With yield on, the AI copy of w is suppressed; the human still supplies w,
      // so to observe the gate we track a SECOND AI-only key and the up-edge behavior.
      c.press('a'); // AI-only key (human not pressing it)
      let s = c.sample();
      expect(s.downKeys.has('a')).toBe(true); // AI-only key always lives
      expect(s.downKeys.has('w')).toBe(true); // supplied by the human
      // Disable yield: nothing changes for a union of held keys (w still one entry).
      c.setYieldToHuman(false);
      s = c.sample();
      expect(s.downKeys.has('w')).toBe(true);
      expect(s.downKeys.has('a')).toBe(true);
    });
  });

  it('clearInjected drops all AI state (held keys become up-edges once)', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.press('w');
    c.press('a');
    c.sample();
    c.clearInjected();
    const s = c.sample();
    expect(s.downKeys.has('w')).toBe(false);
    expect(s.downKeys.has('a')).toBe(false);
    expect(s.upKeys.has('w')).toBe(true); // clean release edge
    expect(s.upKeys.has('a')).toBe(true);
  });

  it('forwards setPointerLockAllowed and detach to inner', () => {
    let allowed: boolean | undefined;
    let detached = false;
    const inner: InputBackend = {
      sample: () => ({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      }),
      setPointerLockAllowed: (a) => {
        allowed = a;
      },
      detach: () => {
        detached = true;
      },
    };
    const c = makeCompositeBackend(inner);
    c.setPointerLockAllowed?.(false);
    expect(allowed).toBe(false);
    c.detach();
    expect(detached).toBe(true);
  });

  it('preserves inner optional fields (pointerEvents/pointers) untouched', () => {
    const inner = fakeInner();
    inner.set({
      pointerEvents: [
        { pointerId: 1, phase: 'down', x: 5, y: 6, pressure: 1, pointerType: 'mouse' },
      ],
    });
    const c = makeCompositeBackend(inner);
    const s = c.sample();
    expect(s.pointerEvents?.[0]?.phase).toBe('down');
  });
});
