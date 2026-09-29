import type { DeviceScope } from '../device/device-scope';
import type { EnvironmentFrame } from './frame';

export interface EnvironmentGeneration {
  readonly signature: string;
  readonly generation: number;
  readonly lane: 'direct' | 'clustered';
  readonly scope: DeviceScope;
  readonly liveHandle: object;
  readonly resourceCount: number;
  readonly resourceBytes: number;
  retired: boolean;
}

export interface EnvironmentGenerationFailure {
  readonly failureAt?: 'prepare' | 'build' | 'execute' | 'finish' | 'submit';
}

export interface EnvironmentGenerationState {
  readonly frame: EnvironmentFrame;
  readonly scope: DeviceScope;
  readonly generation: number;
}
