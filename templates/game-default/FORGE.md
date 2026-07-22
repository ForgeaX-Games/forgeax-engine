# _template

_(no brief yet — tell Forge what you want to make)_
# UI consumer boundary

The default template consumes HUD and settings UiAssets from the assets submodule. Keep stable markup and style in the `.ui.html`/`.ui.css` author sources and use `src/hud.ts` or `src/settings.ts` only for dynamic values, event ownership, modal focus, and cleanup. UI screenshots are auxiliary evidence; DOM assertions and lifecycle behavior remain the acceptance source of truth.
