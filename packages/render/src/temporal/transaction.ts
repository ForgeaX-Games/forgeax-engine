import {
  type RendererFrameTransaction,
  stageRendererFrame,
} from '../assembly/renderer-frame-transaction';
import type { TemporalHistory } from './history';
import type { TemporalView } from './view';

export interface TemporalFrameCandidate {
  readonly view: TemporalView;
  readonly history: TemporalHistory;
}

export interface TemporalGenerationFence {
  readonly capturedGeneration: number;
  readonly currentGeneration: () => number;
}

export function temporalGenerationIsCurrent(fence: TemporalGenerationFence): boolean {
  return fence.currentGeneration() === fence.capturedGeneration;
}

export function stageTemporalFrame(
  candidate: TemporalFrameCandidate,
): RendererFrameTransaction<TemporalFrameCandidate> {
  return stageRendererFrame(candidate, () => candidate.history.abort());
}
