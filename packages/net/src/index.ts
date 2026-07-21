// @forgeax/engine-net -- memory transport, replication session, and profile-driven ECS sync.
//
// Depends on @forgeax/engine-ecs (World, schedule), @forgeax/engine-plugin (Plugin),
// and @forgeax/engine-types (Result, errors). No WebSocket, browser, app, or runtime dependency.

// Endpoint contract (requirements AC-02, AC-13)
export type { EndpointEvent, NetEndpoint, PeerId } from './endpoint/endpoint';
export type { EndpointErrorCode, EndpointErrorDetail } from './endpoint/errors';
export {
  ENDPOINT_ERROR_HINTS,
  ENDPOINT_EXPECTED,
  EndpointError,
  isEndpointError,
} from './endpoint/errors';
export type { MemoryFaultController } from './endpoint/memory';
// Memory endpoint (requirements AC-03)
export {
  createMemoryEndpointPair,
  createMemoryEndpointPairWithController,
} from './endpoint/memory';
export { AuthorityCoordinator, createAuthorityCoordinator } from './replication/authority';
export type {
  NetEntityId,
  ReplicationBatch,
  ReplicationComponentRecord,
  ReplicationEntityRecord,
} from './replication/codec';
export { NetError, type NetErrorCode, type NetErrorDetail } from './replication/errors';
export { validateHandshake } from './replication/handshake';
export type {
  DefineReplicationOptions,
  ReplicationLimits,
  ReplicationProfile,
} from './replication/profile';
export { defineReplication } from './replication/profile';
export {
  applyReplicaBatch,
  createReplicaCoordinator,
  decodeAndApplyReplicaBatch,
  ReplicaCoordinator,
} from './replication/replica';
export type { NetSessionConfig, PeerSnapshot, RawMessage } from './session/net-session';
// Session (requirements AC-04)
export { NetSession } from './session/net-session';
export type { NetPluginConfig } from './session/session-plugin';
export { netPlugin } from './session/session-plugin';
