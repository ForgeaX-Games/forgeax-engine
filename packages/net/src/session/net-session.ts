// @forgeax/engine-net -- NetSession host-neutral World integration.

import { err, ok, type Result } from '@forgeax/engine-types';
import type { NetEndpoint, NetEndpointConnector, PeerId } from '../endpoint/endpoint';
import { type EndpointError, isEndpointError } from '../endpoint/errors';
import type { AuthorityCoordinator, PublishedPacket } from '../replication/authority';
import { decodeReplicationPacket, encodeReplicationPacket } from '../replication/codec';
import { NetError, type NetError as NetErrorType } from '../replication/errors';
import { DEFAULT_REPLICATION_LIMITS, type ReplicationLimits } from '../replication/profile';
import type {
  ReplicationAckPacket,
  ReplicationDataPacket,
  ReplicationSessionPacket,
} from '../replication/protocol';
import { decodeAndApplyReplicationPacket, type ReplicaCoordinator } from '../replication/replica';
import {
  createSessionId,
  DEFAULT_NET_RECOVERY_POLICY,
  type NetRecoveryOutcome,
  type NetRecoveryPolicy,
  type NetRecoverySnapshot,
  type NetSessionFailure,
  type NetSessionState,
  resolveNetRecoveryPolicy,
  type SessionId,
  transitionNetSessionState,
} from './recovery';

export interface PeerSnapshot {
  readonly peerIds: ReadonlyArray<PeerId>;
  readonly connected: boolean;
}

export interface SessionSnapshot {
  readonly sessionIds: ReadonlyArray<SessionId>;
  readonly connected: boolean;
}

export interface NetSessionClock {
  readonly now: () => number;
  readonly schedule: (delayMs: number, callback: () => void) => { cancel(): void };
}

export interface NetSessionResourceCounts {
  readonly pendingConnects: number;
  readonly timers: number;
  readonly ledgers: number;
  readonly callbacks: number;
}

export interface NetSessionConfig {
  readonly endpoint?: NetEndpoint;
  readonly connector?: NetEndpointConnector;
  readonly sessionId?: SessionId | number;
  readonly recovery?: Partial<NetRecoveryPolicy>;
  readonly clock?: NetSessionClock;
  readonly maxRawMessages: number;
}

export interface RawMessage {
  readonly peerId: PeerId;
  readonly sessionId: SessionId;
  readonly data: Uint8Array;
}

const defaultClock: NetSessionClock = {
  now: () => Date.now(),
  schedule: (delayMs, callback) => {
    const id = globalThis.setTimeout(callback, delayMs);
    return { cancel: () => globalThis.clearTimeout(id) };
  },
};

function recoveryFailure(reason: string): NetErrorType {
  return new NetError({
    code: 'recovery-rejected',
    expected: 'a recoverable NetSession lifecycle operation',
    hint: 'inspect the current snapshot and retire the session after terminal failure',
    detail: { reason },
  });
}

function initialState(sessionId: SessionId, endpoint: NetEndpoint | undefined): NetSessionState {
  return endpoint === undefined
    ? { kind: 'connecting', sessionId }
    : { kind: 'resyncing', sessionId, epoch: 0 };
}

export class NetSession {
  #endpoint: NetEndpoint | undefined;
  readonly #connector: NetEndpointConnector | undefined;
  readonly #clock: NetSessionClock;
  readonly #policy: NetRecoveryPolicy;
  readonly #sessionId: SessionId;
  readonly #peerIds = new Set<PeerId>();
  readonly #sessionPeers = new Map<SessionId, PeerId>();
  readonly #announcedPeers = new Set<PeerId>();
  #sessionAnnounced = false;
  #rawMessages: RawMessage[] = [];
  readonly #maxRawMessages: number;
  #authority: AuthorityCoordinator | undefined;
  readonly #pendingFullPeers = new Set<PeerId>();
  #replica:
    | { readonly coordinator: ReplicaCoordinator; readonly limits: ReplicationLimits }
    | undefined;
  #state: NetSessionState;
  #lastError: NetSessionFailure | undefined;
  #epoch = 0;
  #sequence = 0;
  #acknowledgedSequence = 0;
  #reconnectAttempts = 0;
  #pendingConnect: { readonly abort: () => void } | undefined;
  #retryTimer: { cancel(): void } | undefined;
  readonly #ledger = new Map<number, Uint8Array>();
  #disposed = false;

  constructor(config: NetSessionConfig) {
    this.#endpoint = config.endpoint;
    this.#connector = config.connector;
    this.#clock = config.clock ?? defaultClock;
    this.#maxRawMessages = config.maxRawMessages;
    const resolvedSessionId = this.#resolveSessionId(config.sessionId);
    this.#sessionId = resolvedSessionId.ok ? resolvedSessionId.value : (1 as SessionId);
    const policy = resolveNetRecoveryPolicy(config.recovery);
    this.#policy = policy.ok ? policy.value : DEFAULT_NET_RECOVERY_POLICY;
    this.#state = initialState(this.#sessionId, this.#endpoint);
    if (!resolvedSessionId.ok) this.#setFailure(resolvedSessionId.error);
    else if (!policy.ok) this.#setFailure(policy.error);
  }

  #resolveSessionId(value: SessionId | number | undefined): Result<SessionId, NetErrorType> {
    return createSessionId(value ?? 1);
  }

  #setState(next: NetSessionState): void {
    const transition = transitionNetSessionState(this.#state, next);
    if (transition.ok) {
      this.#state = transition.value;
      return;
    }
    this.#setFailure(transition.error);
  }

  #setFailure(failure: NetSessionFailure): void {
    this.#lastError = failure;
    if (this.#state.kind !== 'failed' && this.#state.kind !== 'retired')
      this.#setState({ kind: 'failed', sessionId: this.#sessionId, error: failure });
    this.#authority = undefined;
    this.#peerIds.clear();
    this.#sessionPeers.clear();
    this.#announcedPeers.clear();
    this.#sessionAnnounced = false;
    this.#pendingFullPeers.clear();
    this.#rawMessages = [];
    this.#clearRecoveryWork();
    this.#endpoint?.close();
  }

  #clearRecoveryWork(): void {
    this.#retryTimer?.cancel();
    this.#retryTimer = undefined;
    this.#pendingConnect?.abort();
    this.#pendingConnect = undefined;
    this.#ledger.clear();
  }

  #beginRecovery(): void {
    const previousEndpoint = this.#endpoint;
    this.#endpoint = undefined;
    previousEndpoint?.close();
    if (
      this.#state.kind === 'connecting' ||
      this.#state.kind === 'active' ||
      this.#state.kind === 'resyncing'
    )
      this.#setState({
        kind: 'recovering',
        sessionId: this.#sessionId,
        epoch: this.#epoch,
        attempt: 0,
      });
    this.#ledger.clear();
    this.#sequence = 0;
    this.#acknowledgedSequence = 0;
    this.#peerIds.clear();
    this.#sessionPeers.clear();
    this.#announcedPeers.clear();
    this.#sessionAnnounced = false;
    this.#pendingFullPeers.clear();
    this.#rawMessages = [];
  }

  #attemptRecovery(): void {
    if (this.#disposed || this.#state.kind !== 'recovering' || this.#pendingConnect) return;
    if (this.#reconnectAttempts >= this.#policy.maxReconnectAttempts) {
      this.#setFailure(
        new NetError({
          code: 'recovery-exhausted',
          expected: 'reconnect attempts within the configured finite bound',
          hint: 'inspect the failure and create a new session after exhaustion',
          detail: {
            attempts: this.#reconnectAttempts,
            maxAttempts: this.#policy.maxReconnectAttempts,
          },
        }),
      );
      return;
    }
    this.#reconnectAttempts += 1;
    this.#setState({
      kind: 'recovering',
      sessionId: this.#sessionId,
      epoch: this.#epoch,
      attempt: this.#reconnectAttempts,
    });
    if (this.#connector === undefined) {
      if (this.#reconnectAttempts >= this.#policy.maxReconnectAttempts) this.#attemptRecovery();
      return;
    }
    const controller = new AbortController();
    this.#pendingConnect = { abort: () => controller.abort() };
    void this.#connector.connect(controller.signal).then(
      (result) => this.#connected(result),
      (cause: unknown) => this.#connectFailed(cause),
    );
  }

  #connected(result: Result<NetEndpoint, EndpointError>): void {
    this.#pendingConnect = undefined;
    if (this.#disposed || this.#state.kind !== 'recovering') {
      if (result.ok) result.value.close();
      return;
    }
    if (!result.ok) {
      this.#connectFailed(result.error);
      return;
    }
    this.#endpoint?.close();
    this.#endpoint = result.value;
    this.#lastError = undefined;
    this.#epoch += 1;
    this.#sequence = 0;
    this.#acknowledgedSequence = 0;
    this.#ledger.clear();
    this.#setState({ kind: 'resyncing', sessionId: this.#sessionId, epoch: this.#epoch });
  }

  #connectFailed(cause: unknown): void {
    this.#pendingConnect = undefined;
    if (this.#disposed || this.#state.kind !== 'recovering') return;
    const failure: NetSessionFailure =
      cause instanceof NetError
        ? (cause as unknown as NetErrorType)
        : isEndpointError(cause)
          ? cause
          : recoveryFailure('connector attempt failed');
    if (this.#reconnectAttempts >= this.#policy.maxReconnectAttempts) {
      this.#setFailure(
        new NetError({
          code: 'recovery-exhausted',
          expected: 'reconnect attempts within the configured finite bound',
          hint: 'inspect the endpoint failure and create a new session after exhaustion',
          detail: {
            attempts: this.#reconnectAttempts,
            maxAttempts: this.#policy.maxReconnectAttempts,
          },
        }),
      );
      return;
    }
    this.#lastError = failure;
    this.advanceRecovery();
  }

  #handleAck(packet: ReplicationAckPacket): Result<void, NetError> {
    if (packet.sessionId !== this.#sessionId && !this.#sessionPeers.has(packet.sessionId))
      return err(
        new NetError({
          code: 'recovery-rejected',
          expected: 'an ACK for the current SessionId',
          hint: 'discard ACKs from another logical session',
          detail: { reason: 'ACK SessionId does not match the current session' },
        }),
      );
    if (packet.epoch !== this.#epoch || packet.acknowledgedSequence > this.#sequence)
      return ok(undefined);
    if (packet.acknowledgedSequence <= this.#acknowledgedSequence) return ok(undefined);
    this.#acknowledgedSequence = packet.acknowledgedSequence;
    for (const sequence of this.#ledger.keys())
      if (sequence <= packet.acknowledgedSequence) this.#ledger.delete(sequence);
    return ok(undefined);
  }

  #receiveMessage(peerId: PeerId, data: Uint8Array, errors: NetError[]): void {
    if (
      this.#state.kind === 'recovering' ||
      this.#state.kind === 'failed' ||
      this.#state.kind === 'retired'
    )
      return;
    const limits = this.#replica?.limits ?? DEFAULT_REPLICATION_LIMITS;
    const decoded = decodeReplicationPacket(data, limits);
    if (!decoded.ok) {
      if (this.#replica === undefined) {
        this.#queueRawMessage(peerId, data);
        return;
      }
      errors.push(decoded.error);
      this.#setFailure(decoded.error as NetErrorType);
      return;
    }
    if (decoded.value.kind === 'session-open' || decoded.value.kind === 'session-resume') {
      this.#bindSession(decoded.value.sessionId, peerId);
      return;
    }
    if (decoded.value.kind === 'ack') {
      const handled = this.#handleAck(decoded.value);
      if (!handled.ok) {
        errors.push(handled.error);
        this.#setFailure(handled.error);
      }
      return;
    }
    if (decoded.value.kind !== 'baseline' && decoded.value.kind !== 'delta') {
      if (decoded.value.kind === 'rejection') {
        const failure = recoveryFailure(
          `peer rejected ${decoded.value.rejectedKind}: ${decoded.value.reason}`,
        );
        errors.push(failure);
        this.#setFailure(failure);
      }
      return;
    }
    if (this.#replica === undefined) {
      this.#queueRawMessage(peerId, data);
      return;
    }
    const applied = decodeAndApplyReplicationPacket(
      this.#replica.coordinator,
      data,
      this.#replica.limits,
    );
    if (!applied.ok) {
      errors.push(applied.error);
      this.#setFailure(applied.error);
      return;
    }
    const packetOutcome = this.#replica.coordinator.lastPacketOutcome;
    if (packetOutcome === 'accepted') {
      this.#epoch = decoded.value.epoch;
      this.#sequence = decoded.value.sequence;
      this.#acknowledgedSequence = decoded.value.sequence;
      this.#setState({
        kind: 'active',
        sessionId: this.#sessionId,
        epoch: this.#epoch,
        sequence: this.#sequence,
      });
    }
    if (packetOutcome === 'accepted' || packetOutcome === 'duplicate')
      this.#sendReplicationAck(peerId, decoded.value);
  }

  receiveEvents(): readonly NetError[] {
    const errors: NetError[] = [];
    if (this.#disposed || this.#state.kind === 'failed' || this.#state.kind === 'retired')
      return errors;
    for (const event of this.#endpoint?.poll() ?? []) {
      if (event.kind === 'peer-connected') {
        this.#peerIds.add(event.peerId);
        if (this.#replica !== undefined) this.#bindSession(this.#sessionId, event.peerId);
        else this.#bindSession(this.#sessionForPeer(event.peerId), event.peerId);
        this.#pendingFullPeers.add(event.peerId);
      } else if (event.kind === 'peer-disconnected') {
        this.#forgetPeer(event.peerId);
        if (this.#replica !== undefined) {
          this.#replica.coordinator.clear();
          this.#beginRecovery();
          this.advanceRecovery();
        }
      } else this.#receiveMessage(event.peerId, event.data, errors);
    }
    return errors;
  }

  drainRawMessages(): RawMessage[] {
    return this.#rawMessages.splice(0);
  }

  getPeerSnapshot(): PeerSnapshot {
    const peerIds = [...this.#peerIds].sort((left, right) => left - right);
    return { peerIds, connected: peerIds.length > 0 };
  }

  getSessionSnapshot(): SessionSnapshot {
    const sessionIds = [...this.#sessionPeers.keys()].sort((left, right) => left - right);
    return { sessionIds, connected: sessionIds.length > 0 };
  }

  /** Return lifecycle, epoch, sequence, ledger, and owned-resource evidence. */
  getRecoverySnapshot(): NetRecoverySnapshot {
    return {
      sessionId: this.#sessionId,
      state: this.#state,
      pendingPackets: this.#ledger.size,
      maxPendingPackets: this.#policy.maxPendingPackets,
      acknowledgedSequence: this.#acknowledgedSequence,
      reconnectAttempts: this.#reconnectAttempts,
      epoch: this.#epoch,
      sequence: this.#sequence,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      ownedResources: {
        pendingConnects: this.#pendingConnect === undefined ? 0 : 1,
        timers: this.#retryTimer === undefined ? 0 : 1,
        ledgers: this.#ledger.size === 0 ? 0 : 1,
        callbacks: 0,
      },
    };
  }

  getResourceSnapshot(): NetSessionResourceCounts {
    return this.getRecoverySnapshot().ownedResources;
  }

  recover(): NetRecoveryOutcome {
    if (this.#state.kind === 'retired' || this.#state.kind === 'failed')
      return { kind: 'retired', sessionId: this.#sessionId };
    if (this.#state.kind === 'recovering')
      return { kind: 'already-recovering', sessionId: this.#sessionId };
    this.#beginRecovery();
    return { kind: 'started', sessionId: this.#sessionId };
  }

  advanceRecovery(): void {
    if (this.#state.kind !== 'recovering') return;
    const delay =
      this.#policy.reconnectDelaysMs[
        Math.min(this.#reconnectAttempts, this.#policy.reconnectDelaysMs.length - 1)
      ];
    if (delay === undefined || delay === 0) this.#attemptRecovery();
    else {
      this.#retryTimer?.cancel();
      this.#retryTimer = this.#clock.schedule(delay, () => {
        this.#retryTimer = undefined;
        this.#attemptRecovery();
      });
    }
  }

  sendRaw(peerId: PeerId, data: Uint8Array): Result<void, EndpointError | NetError> {
    if (this.#state.kind !== 'active') return err(recoveryFailure('session is not active'));
    return this.#sendToPeer(peerId, data);
  }

  /** Send one application command through the current replica attachment. */
  sendToAuthority(sessionId: SessionId, data: Uint8Array): Result<void, EndpointError | NetError> {
    if (sessionId !== this.#sessionId)
      return err(recoveryFailure('session id does not belong to this NetSession'));
    if (
      this.#state.kind === 'recovering' ||
      this.#state.kind === 'failed' ||
      this.#state.kind === 'retired'
    )
      return err(recoveryFailure('session is not connected to the authority'));
    const peerId = this.#peerForSession(sessionId);
    if (peerId === undefined) return err(recoveryFailure('authority peer is not connected'));
    if (this.#replica !== undefined) {
      const announced = this.#announceSession(peerId);
      if (!announced.ok) return announced;
    }
    return this.#sendToPeer(peerId, data);
  }

  /** Send one application message to an authority-owned logical session. */
  sendToSession(sessionId: SessionId, data: Uint8Array): Result<void, EndpointError | NetError> {
    if (this.#state.kind === 'failed' || this.#state.kind === 'retired')
      return err(recoveryFailure('session is not connected to the authority'));
    const peerId = this.#peerForSession(sessionId);
    if (peerId === undefined) return err(recoveryFailure('logical session is not connected'));
    return this.#sendToPeer(peerId, data);
  }

  attachAuthority(authority: AuthorityCoordinator): void {
    this.#authority = authority;
  }

  requestFullBaseline(peerId: PeerId): void {
    if (this.#peerIds.has(peerId)) this.#pendingFullPeers.add(peerId);
  }

  requestFullBaselineForSession(sessionId: SessionId): void {
    const peerId = this.#sessionPeers.get(sessionId);
    if (peerId !== undefined) this.requestFullBaseline(peerId);
  }

  attachReplica(coordinator: ReplicaCoordinator, limits: ReplicationLimits): void {
    this.#replica = { coordinator, limits };
  }

  #ledgerBoundError(): NetError {
    return new NetError({
      code: 'recovery-rejected',
      expected: 'published packets within the configured finite ACK bound',
      hint: 'wait for a cumulative ACK before publishing more packets',
      detail: { reason: 'ACK ledger bound reached' },
    });
  }

  #ensurePublicationCapacity(expectedEpoch: number): Result<void, NetError> {
    if (expectedEpoch === this.#epoch && this.#ledger.size >= this.#policy.maxPendingPackets)
      return err(this.#ledgerBoundError());
    return ok(undefined);
  }

  #reservePublished(packet: PublishedPacket): Result<void, NetError> {
    if (packet.epoch !== this.#epoch) {
      this.#ledger.clear();
      this.#acknowledgedSequence = 0;
      this.#epoch = packet.epoch;
    }
    if (this.#ledger.size >= this.#policy.maxPendingPackets && !this.#ledger.has(packet.sequence))
      return err(this.#ledgerBoundError());
    this.#sequence = packet.sequence;
    this.#ledger.set(packet.sequence, packet.bytes);
    return ok(undefined);
  }

  #sendPublished(
    packet: PublishedPacket,
    peerIds: readonly PeerId[],
  ): Result<void, EndpointError | NetError> {
    const reserved = this.#reservePublished(packet);
    if (!reserved.ok) return reserved;
    if (this.#endpoint === undefined) return err(recoveryFailure('session has no endpoint'));
    let delivered = false;
    for (const peerId of peerIds) {
      const sent = this.#endpoint.send(peerId, packet.bytes);
      if (!sent.ok) {
        if (sent.error.code === 'connection-closed') {
          // A socket can close before its endpoint emits the corresponding
          // disconnect event. Treat that transport race as the lifecycle
          // event it represents so one stale peer cannot poison the World or
          // prevent the same publication reaching live peers.
          this.#forgetPeer(peerId);
          continue;
        }
        this.#ledger.delete(packet.sequence);
        return err(sent.error);
      }
      delivered = true;
    }
    if (!delivered) this.#ledger.delete(packet.sequence);
    return ok(undefined);
  }

  publish(): Result<void, NetError | EndpointError> {
    // Do not advance the authority ledger before a peer exists. A host can
    // start its fixed loop before the first socket handshake; reserving that
    // empty publication would make the first connected peer wait behind an
    // ACK for bytes it could never receive.
    if (this.#authority === undefined || this.#endpoint === undefined || this.#peerIds.size === 0)
      return ok(undefined);
    if (this.#pendingFullPeers.size > 0) {
      const capacity = this.#ensurePublicationCapacity(this.#authority.nextPublicationEpoch(true));
      if (!capacity.ok) return capacity;
      const published = this.#authority.publishFull();
      if (!published.ok) return err(published.error);
      const sent = this.#sendPublished(published.value, [...this.#peerIds]);
      if (!sent.ok) return err(sent.error);
      this.#pendingFullPeers.clear();
      // A fresh baseline is the first packet of the new epoch for every
      // replica.  Do not append the same-tick delta: a receiver must be able
      // to observe and apply sequence 1 before any incremental publication.
      return ok(undefined);
    }
    const capacity = this.#ensurePublicationCapacity(this.#authority.nextPublicationEpoch());
    if (!capacity.ok) return capacity;
    const published = this.#authority.publish();
    if (!published.ok) return err(published.error);
    const sent = this.#sendPublished(published.value, [...this.#peerIds]);
    if (!sent.ok) return err(sent.error);
    return ok(undefined);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearRecoveryWork();
    this.#endpoint?.close();
    this.#endpoint = undefined;
    this.#replica?.coordinator.clear();
    this.#replica = undefined;
    this.#authority = undefined;
    this.#peerIds.clear();
    this.#sessionPeers.clear();
    this.#announcedPeers.clear();
    this.#sessionAnnounced = false;
    this.#pendingFullPeers.clear();
    this.#rawMessages = [];
    if (this.#state.kind !== 'retired')
      this.#setState({ kind: 'retired', sessionId: this.#sessionId, reason: 'disposed' });
  }

  #queueRawMessage(peerId: PeerId, data: Uint8Array): void {
    if (this.#rawMessages.length >= this.#maxRawMessages) return;
    this.#rawMessages.push({
      peerId,
      sessionId: this.#sessionForPeer(peerId),
      data: new Uint8Array(data),
    });
  }

  #sessionForPeer(peerId: PeerId): SessionId {
    for (const [sessionId, mappedPeerId] of this.#sessionPeers)
      if (mappedPeerId === peerId) return sessionId;
    if (this.#replica !== undefined) {
      this.#bindSession(this.#sessionId, peerId);
      return this.#sessionId;
    }
    const created = createSessionId(peerId);
    const sessionId = created.ok ? created.value : this.#sessionId;
    this.#bindSession(sessionId, peerId);
    return sessionId;
  }

  #bindSession(sessionId: SessionId, peerId: PeerId): void {
    for (const [mappedSessionId, mappedPeerId] of this.#sessionPeers)
      if (mappedSessionId === sessionId || mappedPeerId === peerId)
        this.#sessionPeers.delete(mappedSessionId);
    this.#sessionPeers.set(sessionId, peerId);
  }

  #forgetPeer(peerId: PeerId): void {
    this.#peerIds.delete(peerId);
    for (const [sessionId, mappedPeerId] of this.#sessionPeers)
      if (mappedPeerId === peerId) this.#sessionPeers.delete(sessionId);
    this.#announcedPeers.delete(peerId);
    this.#pendingFullPeers.delete(peerId);
  }

  #peerForSession(sessionId: SessionId): PeerId | undefined {
    const mapped = this.#sessionPeers.get(sessionId);
    if (mapped !== undefined && this.#peerIds.has(mapped)) return mapped;
    if (this.#replica !== undefined && this.#peerIds.size === 1) {
      const peerId = [...this.#peerIds][0];
      if (peerId !== undefined) {
        this.#bindSession(sessionId, peerId);
        return peerId;
      }
    }
    return undefined;
  }

  #announceSession(peerId: PeerId): Result<void, EndpointError | NetError> {
    if (this.#announcedPeers.has(peerId)) return ok(undefined);
    const packet: ReplicationSessionPacket = {
      version: 2,
      kind: this.#sessionAnnounced ? 'session-resume' : 'session-open',
      sessionId: this.#sessionId,
      epoch: this.#epoch,
      sequence: 0,
    };
    const encoded = encodeReplicationPacket(packet, DEFAULT_REPLICATION_LIMITS);
    if (!encoded.ok) return err(encoded.error);
    const sent = this.#sendToPeer(peerId, encoded.value);
    if (!sent.ok) return sent;
    this.#announcedPeers.add(peerId);
    this.#sessionAnnounced = true;
    return ok(undefined);
  }

  #sendToPeer(peerId: PeerId, data: Uint8Array): Result<void, EndpointError | NetError> {
    const result = this.#endpoint?.send(peerId, data);
    if (result === undefined) return err(recoveryFailure('session has no endpoint'));
    return result.ok ? ok(undefined) : err(result.error);
  }

  /** ACK accepted data at the session boundary; consumers should not reimplement this wire step. */
  #sendReplicationAck(peerId: PeerId, packet: ReplicationDataPacket): void {
    const encoded = encodeReplicationPacket(
      {
        version: 2,
        kind: 'ack',
        sessionId: packet.sessionId,
        epoch: packet.epoch,
        acknowledgedSequence: packet.sequence,
      },
      DEFAULT_REPLICATION_LIMITS,
    );
    if (!encoded.ok) {
      this.#setFailure(encoded.error);
      return;
    }
    const sent = this.#sendToPeer(peerId, encoded.value);
    if (!sent.ok) this.#lastError = sent.error;
  }
}
