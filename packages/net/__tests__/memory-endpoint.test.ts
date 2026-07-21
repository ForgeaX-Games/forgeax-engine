import { describe, expect, it } from 'vitest';
import type { PeerId } from '../src/endpoint/endpoint';
import type { NetEndpoint } from '../src/endpoint/endpoint';
import { createMemoryEndpointPair, createMemoryEndpointPairWithController } from '../src/endpoint/memory';

// ---------------------------------------------------------------------------
// TDD red phase: memory endpoint fault tests.
// Tests define the fault injection contract before the full implementation.
// These tests initially fail (red) and will be green after m2-memory-endpoint-impl.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Basic memory endpoint contract (reliable ordered, peer lifecycle)
// ---------------------------------------------------------------------------

describe('Memory endpoint basic contract', () => {
  it('creates a pair of endpoints', () => {
    const [epA, epB] = createMemoryEndpointPair();
    expect(epA).toBeDefined();
    expect(epB).toBeDefined();
  });

  it('emits peer-connected event after pair creation', () => {
    const [epA, epB] = createMemoryEndpointPair();

    const eventsA = epA.poll();
    const eventsB = epB.poll();

    const connectA = eventsA.find((e) => e.kind === 'peer-connected');
    const connectB = eventsB.find((e) => e.kind === 'peer-connected');

    expect(connectA).toBeDefined();
    expect(connectB).toBeDefined();
    expect(connectA!.peerId).toBeDefined();
    expect(connectB!.peerId).toBeDefined();
  });

  it('delivers messages in order (reliable ordered)', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const peerIdB = getPeerId(epA, 'peer-connected');

    const msg1 = new Uint8Array([1, 2, 3]);
    const msg2 = new Uint8Array([4, 5, 6]);
    const msg3 = new Uint8Array([7, 8, 9]);

    const r1 = epA.send(peerIdB, msg1);
    const r2 = epA.send(peerIdB, msg2);
    const r3 = epA.send(peerIdB, msg3);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);

    const events = epB.poll();
    const messages = events.filter((e) => e.kind === 'message');
    expect(messages).toHaveLength(3);
    expect(messages[0]!.data).toEqual(msg1);
    expect(messages[1]!.data).toEqual(msg2);
    expect(messages[2]!.data).toEqual(msg3);
  });

  it('preserves message boundaries (complete Uint8Array)', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const peerIdB = getPeerId(epA, 'peer-connected');

    const msg = new Uint8Array([1, 2, 3, 4, 5]);
    const r = epA.send(peerIdB, msg);
    expect(r.ok).toBe(true);

    const events = epB.poll();
    const messages = events.filter((e) => e.kind === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.data).toEqual(msg);
    expect(messages[0]!.data.length).toBe(5);
  });

  it('sends to wrong peerId returns peer-not-found error', () => {
    const [epA] = createMemoryEndpointPair();
    const fakePeerId = 999 as PeerId;

    const r = epA.send(fakePeerId, new Uint8Array([1]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('peer-not-found');
    }
  });

  it('close prevents further operations', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const peerIdB = getPeerId(epA, 'peer-connected');

    const r1 = epA.close();
    expect(r1.ok).toBe(true);

    const r2 = epA.send(peerIdB, new Uint8Array([1]));
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.code).toBe('already-closed');
    }

    const r3 = epA.close();
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error.code).toBe('already-closed');
    }
  });

  it('emits peer-disconnected event on close', () => {
    const [epA, epB] = createMemoryEndpointPair();
    epA.close();

    const events = epB.poll();
    const disconnect = events.find((e) => e.kind === 'peer-disconnected');
    expect(disconnect).toBeDefined();
  });

  it('send to disconnected peer returns connection-closed', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const peerIdB = getPeerId(epA, 'peer-connected');

    epB.close();
    epA.poll();

    const r = epA.send(peerIdB, new Uint8Array([1]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('connection-closed');
    }
  });
});

// ---------------------------------------------------------------------------
// Fault injection tests (test-only control surface)
// ---------------------------------------------------------------------------

describe('Memory fault injection', () => {
  it('delay: message arrives after configured delay', () => {
    const { endpoints: [epA, epB], controller } = createMemoryEndpointPairWithController();
    const peerIdB = getPeerId(epA, 'peer-connected');

    controller.delayNextDelivery(100);
    const r = epA.send(peerIdB, new Uint8Array([1, 2, 3]));
    expect(r.ok).toBe(true);

    const immediate = epB.poll();
    const immediateMessages = immediate.filter((e) => e.kind === 'message');
    expect(immediateMessages).toHaveLength(0);
  });

  it('duplicate: message is delivered twice', () => {
    const { endpoints: [epA, epB], controller } = createMemoryEndpointPairWithController();
    const peerIdB = getPeerId(epA, 'peer-connected');

    controller.duplicateNextDelivery();
    const r = epA.send(peerIdB, new Uint8Array([1, 2, 3]));
    expect(r.ok).toBe(true);

    const events = epB.poll();
    const messages = events.filter((e) => e.kind === 'message');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(messages[1]!.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('malformed: message bytes are corrupted', () => {
    const { endpoints: [epA, epB], controller } = createMemoryEndpointPairWithController();
    const peerIdB = getPeerId(epA, 'peer-connected');

    controller.malformNextDelivery();
    const r = epA.send(peerIdB, new Uint8Array([1, 2, 3]));
    expect(r.ok).toBe(true);

    const events = epB.poll();
    const messages = events.filter((e) => e.kind === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.data).not.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('disconnect: fault controller can force-disconnect a peer', () => {
    const { endpoints: [epA, epB], controller } = createMemoryEndpointPairWithController();
    const peerIdB = getPeerId(epA, 'peer-connected');

    controller.disconnectPeer(epA);

    const events = epB.poll();
    const disconnect = events.find((e) => e.kind === 'peer-disconnected');
    expect(disconnect).toBeDefined();
  });

  it('fault controls are not exposed on public NetEndpoint surface', () => {
    const [epA] = createMemoryEndpointPair();

    expect((epA as Record<string, unknown>).delayNextDelivery).toBeUndefined();
    expect((epA as Record<string, unknown>).duplicateNextDelivery).toBeUndefined();
    expect((epA as Record<string, unknown>).malformNextDelivery).toBeUndefined();
    expect((epA as Record<string, unknown>).disconnectPeer).toBeUndefined();
  });

  it('duplicate and disconnect are not interpreted as auto-recovery', () => {
    const { endpoints: [epA, epB], controller } = createMemoryEndpointPairWithController();
    const peerIdB = getPeerId(epA, 'peer-connected');

    controller.disconnectPeer(epA);
    epA.poll();

    const r = epA.send(peerIdB, new Uint8Array([1]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('connection-closed');
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPeerId(
  ep: NetEndpoint,
  eventKind: 'peer-connected' | 'peer-disconnected',
): PeerId {
  const events = ep.poll();
  const event = events.find((e) => e.kind === eventKind);
  if (!event) {
    throw new Error(`No ${eventKind} event found`);
  }
  return event.peerId;
}
