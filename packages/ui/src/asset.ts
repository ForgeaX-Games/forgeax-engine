import type { UiLocalization } from './localization/resources.js';

export interface UiAsset {
  readonly guid: string;
  readonly html: string;
  readonly css: string;
  readonly localization?: UiLocalization;
  readonly actions?: Readonly<Record<string, string>>;
}

export interface UiInstance {
  readonly host: HTMLElement;
  readonly signal: AbortSignal;
  dispose(): void;
}
