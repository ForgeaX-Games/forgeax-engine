export function agentOnboardingLines(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const onboarding = (value as { readonly onboarding?: unknown }).onboarding;
  if (onboarding === null || typeof onboarding !== 'object' || Array.isArray(onboarding)) return [];
  const candidate = onboarding as {
    readonly read?: unknown;
    readonly templateSelection?: unknown;
    readonly next?: { readonly cwd?: unknown; readonly argv?: unknown };
  };
  const lines = Array.isArray(candidate.read)
    ? candidate.read
        .filter((path): path is string => typeof path === 'string')
        .map((path) => `[forgeax] read: ${path}`)
    : [];
  const selection = candidate.templateSelection;
  if (selection !== null && typeof selection === 'object' && !Array.isArray(selection)) {
    const available = (selection as { readonly available?: unknown }).available;
    if (Array.isArray(available) && available.every((id) => typeof id === 'string')) {
      lines.push(`[forgeax] template required: choose one of: ${available.join(', ')}`);
      lines.push('[forgeax] create: forgeax project new <directory> --template <template-id>');
    }
  }
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

export function renderForgeaxUsage(templateIds: readonly string[] = []): string {
  const templateChoice = templateIds.length === 0 ? '<template-id>' : templateIds.join('|');
  return (
    `Usage: forgeax project new [directory] --template ${templateChoice} [--root directory] [--id ID] [--name NAME] [--package-name PACKAGE]\n` +
    '       forgeax project <init|check|test|build|package|preview|capture> [directory]\n' +
    '       forgeax project engine <status|check|unlink|use-local> [--root directory]\n' +
    '       forgeax project plugin <inspect|configure|disable|enable|install|uninstall> [options]\n' +
    '       forgeax project skill <install|verify> [--root directory]\n' +
    '       forgeax asset <import|verify|inspect|resolve|list> [subject]\n' +
    '       forgeax asset shader check [path]\n' +
    '       forgeax sdk install <directory> [--version VERSION]\n' +
    '       forgeax dev <start|status|reload|stop|eval|camera|focus|capture> [options]\n' +
    '       forgeax debug <preview|rhi|profile> <operation> [options]\n'
  );
}
