import { describe, expect, it } from 'vitest';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import type { PeerId } from '../src/endpoint/endpoint';
import { NetSession } from '../src/session/net-session';

// ---------------------------------------------------------------------------
// TDD phase: raw message boundary tests.
// Memory pair: epA = peerId 1, epB = peerId 2.
// ---------------------------------------------------------------------------

describe('Session raw message bounds', () => {
  it('drainRawMessages returns empty array when no messages', () => {
    const [epA] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    const raw = session.drainRawMessages();
    expect(raw).toHaveLength(0);
  });

  it('drainRawMessages clears buffer after drain (bounded)', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const sessionA = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    sessionA.receiveEvents();

    // Send two messages from B to A
    epB.send(1 as PeerId, new Uint8Array([1]));
    epB.send(1 as PeerId, new Uint8Array([2]));

    sessionA.receiveEvents();
    const first = sessionA.drainRawMessages();
    expect(first).toHaveLength(2);

    const second = sessionA.drainRawMessages();
    expect(second).toHaveLength(0);
  });

  it('respects max raw message bound', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const sessionA = new NetSession({ endpoint: epA, maxRawMessages: 2 });

    sessionA.receiveEvents();

    for (let i = 0; i < 5; i++) {
      epB.send(1 as PeerId, new Uint8Array([i]));
    }

    sessionA.receiveEvents();
    const raw = sessionA.drainRawMessages();
    expect(raw).toHaveLength(2);
  });

  it('sender identity is endpoint-originated (not forged)', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const sessionA = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    sessionA.receiveEvents();

    epB.send(1 as PeerId, new Uint8Array([77]));

    sessionA.receiveEvents();
    const raw = sessionA.drainRawMessages();
    expect(raw).toHaveLength(1);
    // B's peerId from A's perspective is 2
    expect(raw[0]!.peerId).toBe(2 as PeerId);
  });

  it('sendRaw to wrong peer returns error', () => {
    const [epA] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    const result = epA.send(999 as PeerId, new Uint8Array([1]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('peer-not-found');
    }
  });

  it('close endpoint prevents further send', () => {
    const [epA] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    session.receiveEvents();

    const closeResult = epA.close();
    expect(closeResult.ok).toBe(true);

    const sendResult = epA.send(2 as PeerId, new Uint8Array([1]));
    expect(sendResult.ok).toBe(false);
  });

  it('session does not expose concrete endpoint to game', () => {
    const [epA] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    expect((session as Record<string, unknown>).endpoint).toBeUndefined();
    expect(typeof session.sendRaw).toBe('function');
    expect(typeof session.drainRawMessages).toBe('function');
  });
});
