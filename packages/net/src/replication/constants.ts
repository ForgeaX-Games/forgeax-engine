import type { ReplicationLimits } from './profile';
export const REPLICATION_PROTOCOL_VERSION = 1;
export const DEFAULT_REPLICATION_LIMITS: ReplicationLimits = {
  maxMessageBytes: 64 * 1024,
  maxEntities: 1024,
  maxComponentOperations: 4096,
  maxStringBytes: 4096,
  maxBufferBytes: 16 * 1024,
  maxArrayElements: 1024,
};
