// @forgeax/engine-net -- NetSession host-neutral World integration.
// (requirements AC-04, plan-strategy D-1/D-3)

import { err, ok, type Result } from '@forgeax/engine-types';
import type { NetEndpoint, PeerId } from '../endpoint/endpoint';
import type { EndpointError } from '../endpoint/errors';
import type { AuthorityCoordinator } from '../replication/authority';
import type { NetError } from '../replication/errors';
import type { ReplicationLimits } from '../replication/profile';
import { decodeAndApplyReplicaBatch, type ReplicaCoordinator } from '../replication/replica';

export interface PeerSnapshot {
  readonly peerIds: ReadonlyArray<PeerId>;
  readonly connected: boolean;
}

export interface NetSessionConfig {
  readonly endpoint: NetEndpoint;
  readonly maxRawMessages: number;
}

export interface RawMessage {
  readonly peerId: PeerId;
  readonly data: Uint8Array;
}

export class NetSession {
  readonly #endpoint: NetEndpoint;
  readonly #peerIds = new Set<PeerId>();
  #rawMessages: RawMessage[] = [];
  readonly #maxRawMessages: number;
  #authority: AuthorityCoordinator | undefined;
  #pendingFull = false;
  #replica:
    | { readonly coordinator: ReplicaCoordinator; readonly limits: ReplicationLimits }
    | undefined;

  constructor(config: NetSessionConfig) {
    this.#endpoint = config.endpoint;
    this.#maxRawMessages = config.maxRawMessages;
  }

  receiveEvents(): readonly NetError[] {
    const errors: NetError[] = [];
    for (const event of this.#endpoint.poll()) {
      if (event.kind === 'peer-connected') {
        this.#peerIds.add(event.peerId);
        this.#pendingFull = true;
      } else if (event.kind === 'peer-disconnected') {
        this.#peerIds.delete(event.peerId);
      } else {
        if (this.#replica !== undefined) {
          const result = decodeAndApplyReplicaBatch(
            this.#replica.coordinator,
            event.data,
            this.#replica.limits,
          );
          if (!result.ok) errors.push(result.error);
        } else if (this.#rawMessages.length < this.#maxRawMessages) {
          this.#rawMessages.push({ peerId: event.peerId, data: event.data });
        }
      }
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

  sendRaw(peerId: PeerId, data: Uint8Array): Result<void, EndpointError> {
    const result = this.#endpoint.send(peerId, data);
    return result.ok ? ok(undefined) : err(result.error);
  }

  attachAuthority(authority: AuthorityCoordinator): void {
    this.#authority = authority;
  }

  attachReplica(coordinator: ReplicaCoordinator, limits: ReplicationLimits): void {
    this.#replica = { coordinator, limits };
  }

  publish(): Result<void, NetError | EndpointError> {
    if (this.#authority === undefined) return ok(undefined);
    const published = this.#pendingFull ? this.#authority.publishFull() : this.#authority.publish();
    if (!published.ok) return err(published.error);
    for (const peerId of this.#peerIds) {
      const sent = this.#endpoint.send(peerId, published.value.bytes);
      if (!sent.ok) return err(sent.error);
    }
    if (this.#pendingFull) this.#pendingFull = false;
    return ok(undefined);
  }
}
