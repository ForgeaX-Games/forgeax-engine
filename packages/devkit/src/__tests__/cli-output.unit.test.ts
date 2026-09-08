import { describe, expect, it } from 'vitest';
import { agentOnboardingLines, renderForgeaxUsage, sdkUpdateLines } from '../cli-output.js';

describe('agentOnboardingLines', () => {
  it('renders only the structured local reading and next-command contract', () => {
    expect(
      agentOnboardingLines({
        onboarding: {
          read: ['/sdk/AGENTS.md', '/sdk/skills/forgeax-engine-sdk/SKILL.md'],
          next: { cwd: '/sdk', argv: ['node', './bin/forgeax.mjs', 'new', '../game'] },
        },
      }),
    ).toEqual([
      '[forgeax] read: /sdk/AGENTS.md',
      '[forgeax] read: /sdk/skills/forgeax-engine-sdk/SKILL.md',
      '[forgeax] next cwd: /sdk',
      '[forgeax] next: node ./bin/forgeax.mjs new ../game',
    ]);
    expect(agentOnboardingLines({ onboarding: { read: [1], next: {} } })).toEqual([]);
  });

  it('renders only an actionable newer-SDK warning', () => {
    expect(
      sdkUpdateLines({
        sdkUpdate: {
          status: 'available',
          currentVersion: '0.1.5',
          latestVersion: '0.1.6',
          migrationRisk: 'Existing games require explicit migration and testing.',
        },
      }),
    ).toEqual([
      '[forgeax] update available: @forgeax/engine-sdk 0.1.5 -> 0.1.6',
      '[forgeax] update note: Existing games require explicit migration and testing.',
    ]);
    expect(sdkUpdateLines({ sdkUpdate: { status: 'current' } })).toEqual([]);
  });
});

describe('renderForgeaxUsage', () => {
  it('describes commands without executing them', () => {
    expect(renderForgeaxUsage()).toContain('forgeax <init|doctor|test|dev|build');
    expect(renderForgeaxUsage()).toContain(
      'forgeax capture [directory] [--backend auto|software|hardware]',
    );
    expect(renderForgeaxUsage()).toContain('[--deterministic]');
    expect(renderForgeaxUsage()).toContain('forgeax exec <program.mjs>');
    expect(renderForgeaxUsage()).toContain('forgeax skill <install|verify>');
  });
});
