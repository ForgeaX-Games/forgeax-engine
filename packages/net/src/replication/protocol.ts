import type { SessionId } from '../session/recovery';

/** Replicated ECS entity operations owned by the protocol manifest. */
export type ReplicationEntityKind = 'upsert' | 'despawn';

export interface ReplicationComponentRecord {
  readonly name: string;
  readonly operation?: 'replace' | 'remove';
  readonly data: Record<string, unknown>;
}

export interface ReplicationEntityRecord {
  readonly id: number;
  readonly kind: ReplicationEntityKind;
  readonly components: readonly ReplicationComponentRecord[];
}

export type ReplicationPacketKind =
  | 'session-open'
  | 'session-resume'
  | 'baseline'
  | 'delta'
  | 'ack'
  | 'rejection';

/** Control packet that opens or resumes one application session. */
export interface ReplicationSessionPacket {
  readonly version: 2;
  readonly kind: 'session-open' | 'session-resume';
  readonly sessionId: SessionId;
  readonly epoch: number;
  readonly sequence: 0;
}

/** Shared fields for baseline and delta data packets. */
export interface ReplicationDataPacketBase {
  readonly version: 2;
  readonly kind: 'baseline' | 'delta';
  readonly sessionId: SessionId;
  readonly epoch: number;
  readonly sequence: number;
  readonly tick: number;
  readonly fingerprint: string;
  readonly entities: readonly ReplicationEntityRecord[];
}

/** Complete authoritative baseline; sequence one is required for every epoch. */
export interface ReplicationBaselinePacket extends ReplicationDataPacketBase {
  readonly kind: 'baseline';
  readonly sequence: 1;
}

/** Ordered authoritative delta after the accepted baseline. */
export interface ReplicationDeltaPacket extends ReplicationDataPacketBase {
  readonly kind: 'delta';
  readonly sequence: number;
}

export type ReplicationDataPacket = ReplicationBaselinePacket | ReplicationDeltaPacket;

export interface ReplicationAckPacket {
  readonly version: 2;
  readonly kind: 'ack';
  readonly sessionId: SessionId;
  readonly epoch: number;
  readonly acknowledgedSequence: number;
}

export interface ReplicationRejectionPacket {
  readonly version: 2;
  readonly kind: 'rejection';
  readonly sessionId: SessionId;
  readonly epoch: number;
  readonly sequence: number;
  readonly rejectedKind: ReplicationPacketKind;
  readonly reason: string;
}

export type ReplicationPacket =
  | ReplicationSessionPacket
  | ReplicationBaselinePacket
  | ReplicationDeltaPacket
  | ReplicationAckPacket
  | ReplicationRejectionPacket;

export type ReplicationDataPacketKind = ReplicationDataPacket['kind'];
