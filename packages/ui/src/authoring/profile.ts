export type UiAuthoringCategory = 'native' | 'normalizable' | 'runtime-bound';

export interface UiAuthoringProfile {
  readonly version: '1';
  readonly html: {
    readonly nativeElements: readonly string[];
    readonly hooks: readonly string[];
    readonly globalAttributes: readonly string[];
    readonly urlAttributes: readonly string[];
  };
  readonly css: {
    readonly nativeAtRules: readonly string[];
    readonly normalizableSelectors: readonly string[];
    readonly packageVariablePrefix: string;
    readonly engineVariablePrefix: string;
  };
  readonly precedence: readonly ['runtime-bound', 'normalizable', 'native'];
}

export const UI_AUTHORING_PROFILE: UiAuthoringProfile = {
  version: '1',
  html: {
    nativeElements: [
      'a',
      'abbr',
      'article',
      'aside',
      'b',
      'button',
      'code',
      'div',
      'em',
      'fieldset',
      'figcaption',
      'figure',
      'footer',
      'form',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'header',
      'hr',
      'img',
      'input',
      'label',
      'li',
      'main',
      'nav',
      'ol',
      'option',
      'p',
      'pre',
      'progress',
      'section',
      'select',
      'small',
      'span',
      'strong',
      'table',
      'tbody',
      'td',
      'template',
      'textarea',
      'tfoot',
      'th',
      'thead',
      'tr',
      'ul',
    ],
    hooks: [
      'data-ui-part',
      'data-ui-action',
      'data-ui-template',
      'data-ui-slot',
      'data-ui-setting',
      'data-framework-island',
    ],
    globalAttributes: [
      'class',
      'id',
      'role',
      'title',
      'hidden',
      'tabindex',
      'aria-label',
      'aria-labelledby',
      'aria-live',
      'aria-hidden',
    ],
    urlAttributes: ['href', 'src'],
  },
  css: {
    nativeAtRules: ['font-face', 'keyframes', 'media', 'supports'],
    normalizableSelectors: ['html', 'body', ':root'],
    packageVariablePrefix: '--fx-',
    engineVariablePrefix: '--forgeax-',
  },
  precedence: ['runtime-bound', 'normalizable', 'native'],
};

export interface UiClassification {
  readonly category: UiAuthoringCategory;
  readonly blocking: boolean;
}

export function pickClassification(
  ...classifications: readonly UiClassification[]
): UiClassification {
  for (const category of UI_AUTHORING_PROFILE.precedence) {
    const match = classifications.find((entry) => entry.category === category);
    if (match !== undefined) return match;
  }
  return { category: 'native', blocking: false };
}
