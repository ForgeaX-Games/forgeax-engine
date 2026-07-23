import type { SnakeGameState } from './rules';

export function semanticSnapshot(state: SnakeGameState) {
  return {
    tick: state.tick,
    food: { ...state.food },
    snakes: [...state.snakes.values()]
      .sort((left, right) => left.peerId - right.peerId)
      .map((snake) => ({
        peerId: snake.peerId,
        direction: snake.direction,
        score: snake.score,
        cells: snake.cells.map((cell) => ({ ...cell })),
      })),
  };
}
