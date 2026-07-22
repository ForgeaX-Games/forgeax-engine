import { describe, expect, it } from 'vitest';
import { applyGameSetting, createGameSettingsState } from '../settings';

describe('game-default settings state', () => {
  it('updates only the current run memory state', () => {
    const state = createGameSettingsState();
    applyGameSetting(state, 'music', 35);
    applyGameSetting(state, 'highContrast', true);
    expect(state).toEqual({ music: 35, highContrast: true });
    expect(createGameSettingsState()).toEqual({ music: 70, highContrast: false });
  });
});
