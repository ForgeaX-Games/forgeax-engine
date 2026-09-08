export function agentOnboardingLines(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const onboarding = (value as { readonly onboarding?: unknown }).onboarding;
  if (onboarding === null || typeof onboarding !== 'object' || Array.isArray(onboarding)) return [];
  const candidate = onboarding as {
    readonly read?: unknown;
    readonly next?: { readonly cwd?: unknown; readonly argv?: unknown };
  };
  const lines = Array.isArray(candidate.read)
    ? candidate.read
        .filter((path): path is string => typeof path === 'string')
        .map((path) => `[forgeax] read: ${path}`)
    : [];
  if (
    typeof candidate.next?.cwd === 'string' &&
    Array.isArray(candidate.next.argv) &&
    candidate.next.argv.every((part) => typeof part === 'string')
  ) {
    lines.push(`[forgeax] next cwd: ${candidate.next.cwd}`);
    lines.push(`[forgeax] next: ${candidate.next.argv.join(' ')}`);
  }
  return lines;
}

export function sdkUpdateLines(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const update = (value as { readonly sdkUpdate?: unknown }).sdkUpdate;
  if (update === null || typeof update !== 'object' || Array.isArray(update)) return [];
  const candidate = update as {
    readonly status?: unknown;
    readonly currentVersion?: unknown;
    readonly latestVersion?: unknown;
    readonly migrationRisk?: unknown;
  };
  if (
    candidate.status !== 'available' ||
    typeof candidate.currentVersion !== 'string' ||
    typeof candidate.latestVersion !== 'string' ||
    typeof candidate.migrationRisk !== 'string'
  ) {
    return [];
  }
  return [
    `[forgeax] update available: @forgeax/engine-sdk ${candidate.currentVersion} -> ${candidate.latestVersion}`,
    `[forgeax] update note: ${candidate.migrationRisk}`,
  ];
}

export function renderForgeaxUsage(): string {
  return (
    'Usage: forgeax new [directory] [--template empty|game-3d]\n' +
    '       forgeax <init|doctor|test|dev|build|package|serve|preview> [directory]\n' +
    '       forgeax capture [directory] [--backend auto|software|hardware] [--require-ui] [--deterministic] [--headless] [--output PATH]\n' +
    '       forgeax engine <status|doctor|unlink> [--root directory]\n' +
    '       forgeax engine use-local <engine-directory> [--root directory]\n' +
    '       forgeax package [directory] [--output release/game-web.zip]\n' +
    '       forgeax run <rhi.capture|rhi.summary|rhi.inspect> [options]\n' +
    '       forgeax run <operation-id> --input <request.json>\n' +
    '       forgeax exec <program.mjs> [--json]\n' +
    '       forgeax asset <add|verify|inspect|list> [subject]\n' +
    '       forgeax shader check [path]\n' +
    '       forgeax plugin <install|uninstall> <module-or-id> [options]\n' +
    '       forgeax skill <install|verify> [--root directory]\n' +
    '       forgeax sdk install <directory> [--version VERSION]\n'
  );
}
