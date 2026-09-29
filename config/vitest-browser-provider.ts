import {
  type PlaywrightBrowserProvider,
  type PlaywrightProviderOptions,
  playwright as playwrightProvider,
} from '@vitest/browser-playwright';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserProviderOption, TestProject } from 'vitest/node';

// Vitest's Playwright provider creates each page with context.newPage(). Chrome
// activates the app for that operation in headed runs. The CDP target option
// keeps the same visible, Playwright-controlled page while preventing that
// OS-level activation on every Chromium host; the test document remains
// visible and focused.
type OpenBrowserOptions = { parallel: boolean };

type ProviderInternals = {
  createContext: (sessionId: string, options: OpenBrowserOptions) => Promise<BrowserContext>;
};

function isFalse(value: string | undefined): boolean {
  return value === '0' || value?.toLowerCase() === 'false';
}

async function browserContextIds(provider: PlaywrightBrowserProvider): Promise<Set<string>> {
  const browser = provider.browser;
  if (!browser) return new Set();
  const cdp = await browser.newBrowserCDPSession();
  try {
    const result = await cdp.send('Target.getBrowserContexts');
    return new Set(result.browserContextIds);
  } finally {
    await cdp.detach();
  }
}

async function createBackgroundPage(
  provider: PlaywrightBrowserProvider,
  context: BrowserContext,
  contextId: string,
): Promise<Page> {
  const browser = provider.browser;
  if (!browser) throw new Error('Playwright browser is not available.');

  const cdp = await browser.newBrowserCDPSession();
  let listener: ((page: Page) => void) | undefined;
  const pagePromise = new Promise<Page>((resolve) => {
    listener = (page) => {
      if (listener) context.off('page', listener);
      resolve(page);
    };
    context.on('page', listener);
  });
  try {
    await cdp.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId: contextId,
      background: true,
    });
    return await pagePromise;
  } catch (error) {
    if (listener) context.off('page', listener);
    throw error;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

function installBackgroundPageCreation(provider: PlaywrightBrowserProvider): void {
  const internals = provider as unknown as ProviderInternals;
  const originalCreateContext = internals.createContext;
  if (typeof originalCreateContext !== 'function') return;
  const createContext = originalCreateContext.bind(provider);
  const backgroundContexts = new WeakSet<BrowserContext>();
  let createContextQueue = Promise.resolve();

  internals.createContext = (sessionId, options) => {
    const run = createContextQueue.then(async () => {
      const before = await browserContextIds(provider);
      const context = await createContext(sessionId, options);
      if (backgroundContexts.has(context)) return context;

      const after = await browserContextIds(provider);
      const contextId = [...after].find((id) => !before.has(id));
      if (!contextId) return context;

      const originalNewPage = context.newPage.bind(context);
      context.newPage = async () => {
        try {
          return await createBackgroundPage(provider, context, contextId);
        } catch {
          // Keep the provider usable with a Chromium build that does not
          // implement Target.createTarget(background). The normal Playwright
          // path preserves the test result; only the focus optimization is
          // unavailable in that fallback.
          return originalNewPage();
        }
      };
      backgroundContexts.add(context);
      return context;
    });
    createContextQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function playwrightWithBackgroundPages(
  options: PlaywrightProviderOptions = {},
): BrowserProviderOption<PlaywrightProviderOptions> {
  const base = playwrightProvider(options);
  return {
    ...base,
    providerFactory(project: TestProject) {
      const provider = base.providerFactory(project) as PlaywrightBrowserProvider;
      const backgroundPages =
        project.config.browser.name === 'chromium' &&
        project.config.browser.headless === false &&
        !isFalse(process.env.FORGEAX_BROWSER_BACKGROUND);
      if (backgroundPages) installBackgroundPageCreation(provider);
      return provider;
    },
  };
}
