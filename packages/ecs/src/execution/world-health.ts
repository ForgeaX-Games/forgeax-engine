export type WorldExecutionHealth = 'healthy' | 'poisoned';

export interface WorldExecutionFault {
  readonly code: 'shared-kernel-failed';
  readonly kernelName: string;
  readonly cause: unknown;
  readonly partialWrite: boolean;
  readonly retryable: false;
}

export interface WorldExecutionState {
  readonly identity: string;
  readonly health: WorldExecutionHealth;
  readonly fault: WorldExecutionFault | null;
}

let nextWorldIdentity = 1;

export function createWorldIdentity(): string {
  const identity = `world-${nextWorldIdentity}`;
  nextWorldIdentity += 1;
  return identity;
}

export function healthyWorldExecutionState(identity: string): WorldExecutionState {
  return Object.freeze({ identity, health: 'healthy', fault: null });
}

export function poisonedWorldExecutionState(
  identity: string,
  fault: WorldExecutionFault,
): WorldExecutionState {
  return Object.freeze({ identity, health: 'poisoned', fault: Object.freeze(fault) });
}
