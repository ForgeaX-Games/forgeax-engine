import { describe, expect, it } from 'vitest';
import { installHud } from '../assets/plugins/hud';
import { GAME_DEFAULT_INPUT_MAP } from '../assets/plugins/resources/input';

describe('game-default HUD consumer', () => {
  it('projects the playable mission, guided lab, mode and popup into one disposable host', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const hud = installHud({ asset: { guid: 'test', html: '<section><span data-ui-slot="score"></span><strong data-ui-slot="mission"></strong><button data-ui-action="toggle-mode"></button><details class="asset-lab"><summary>Asset Lab</summary></details><span data-ui-slot="crosshair"></span><span data-ui-slot="hint"></span><span data-ui-slot="lock-status"></span><div data-ui-slot="popups"></div></section>', css: '' }, initialMode: 'topdown', onToggle: () => undefined, host });
    hud.setScore(12);
    hud.setMode('orbit');
    hud.floatScore('+10', 20, 30);
    const assetHost = host.querySelector<HTMLElement>('[data-ui-asset="test"]');
    expect(assetHost).not.toBeNull();
    expect(assetHost?.shadowRoot?.textContent).toContain('Score  12');
    expect(assetHost?.shadowRoot?.textContent).toContain('Mission 1/2 · Score 50 · 12/50');
    expect(assetHost?.shadowRoot?.textContent).toContain('View: Orbit');
    expect(assetHost?.shadowRoot?.querySelector<HTMLDetailsElement>('.asset-lab')?.open).toBe(false);
    hud.setScore(50);
    expect(assetHost?.shadowRoot?.textContent).toContain('Mission 2/2 · Press P');
    hud.setTargetProfileActive(true);
    expect(assetHost?.shadowRoot?.textContent).toContain('Mission complete');
    expect(assetHost?.shadowRoot?.querySelector('[data-ui-slot="mission"]')?.getAttribute('data-complete')).toBe('true');
    hud.setScore(0);
    hud.setTargetProfileActive(false);
    expect(assetHost?.shadowRoot?.textContent).toContain('Mission 1/2 · Score 50 · 0/50');
    hud.dispose();
    expect(host.childElementCount).toBe(0);
    host.remove();
  });
});

describe('game-default player controls', () => {
  it('keeps mission and guided asset actions while retiring gallery hotkeys', () => {
    const actions = GAME_DEFAULT_INPUT_MAP.map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['shoot', 'reset', 'targetProfile', 'jpegTexture', 'videoTexture', 'spriteAtlas', 'fontSource']));
    expect(actions).not.toEqual(expect.arrayContaining(['projectileVisual', 'meshHandle', 'fbxMesh', 'glbMesh', 'gltfMesh', 'vfxHit', 'vfxCharge', 'visibility']));
  });
});
