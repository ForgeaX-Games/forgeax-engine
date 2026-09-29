import { describe, expect, it } from 'vitest';
import { agentOnboardingLines, renderForgeaxUsage, sdkUpdateLines } from '../cli-output.js';

describe('agentOnboardingLines', () => {
  it('renders only the structured local reading and next-command contract', () => {
    expect(
      agentOnboardingLines({
        onboarding: {
          read: ['/sdk/AGENTS.md', '/sdk/skills/forgeax-engine-sdk/SKILL.md'],
          next: { cwd: '/sdk', argv: ['node', './bin/forgeax.mjs', 'project', 'new', '../game'] },
        },
      }),
    ).toEqual([
      '[forgeax] read: /sdk/AGENTS.md',
      '[forgeax] read: /sdk/skills/forgeax-engine-sdk/SKILL.md',
      '[forgeax] next cwd: /sdk',
      '[forgeax] next: node ./bin/forgeax.mjs project new ../game',
    ]);
    expect(agentOnboardingLines({ onboarding: { read: [1], next: {} } })).toEqual([]);
  });

  it('renders the two explicit template choices without a fake next command', () => {
    expect(
      agentOnboardingLines({
        onboarding: {
          read: [],
          templateSelection: { required: true, available: ['empty', 'game-3d'] },
        },
      }),
    ).toEqual([
      '[forgeax] template required: choose one of: empty, game-3d',
      '[forgeax] create: forgeax project new <directory> --template <template-id>',
    ]);
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
    expect(renderForgeaxUsage()).toContain(
      'forgeax project <init|check|test|build|package|preview|capture>',
    );
    expect(renderForgeaxUsage()).toContain(
      'forgeax dev <start|status|reload|stop|eval|camera|focus|capture>',
    );
    expect(renderForgeaxUsage()).not.toContain('forgeax exec');
    expect(renderForgeaxUsage()).toContain('forgeax project skill <install|verify>');
    expect(renderForgeaxUsage(['empty', 'game-3d'])).toContain(
      'new [directory] --template empty|game-3d',
    );
    expect(renderForgeaxUsage()).toContain('[--root directory]');
  });
});
