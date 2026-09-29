export interface BuildImporterInput {
  readonly projectRoot: string;
  readonly sourceKey: string;
}

export interface BuildImporterContribution {
  readonly id: string;
  readonly kind: 'importer';
  readonly run: (input: BuildImporterInput) => unknown | Promise<unknown>;
}

export type BuildContributionErrorCode =
  | 'build-contribution-duplicate'
  | 'build-contribution-missing';

export type BuildContributionError =
  | {
      readonly code: 'build-contribution-duplicate';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly id: string };
    }
  | {
      readonly code: 'build-contribution-missing';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly id: string };
    };

export interface BuildContributionHandle {
  readonly id: string;
  readonly dispose: () => Promise<void>;
}

export interface BuildContributionService {
  readonly register: (contribution: BuildImporterContribution) => BuildContributionHandle;
  readonly run: (id: string, input: BuildImporterInput) => Promise<unknown>;
}

function contributionError(code: BuildContributionErrorCode, id: string): BuildContributionError {
  return code === 'build-contribution-duplicate'
    ? {
        code,
        expected: `build contribution ${id} to have one owner`,
        hint: 'Choose one project plugin contribution id and remove the duplicate registration.',
        detail: { id },
      }
    : {
        code,
        expected: `build contribution ${id} to be registered`,
        hint: 'Install the project build plugin and register its contribution before running it.',
        detail: { id },
      };
}

/** The one build-realm contribution boundary for project importers and producers. */
export function createBuildContributionService(_projectRoot: string): BuildContributionService {
  const contributions = new Map<string, BuildImporterContribution>();
  return {
    register(contribution) {
      if (contributions.has(contribution.id)) {
        throw contributionError('build-contribution-duplicate', contribution.id);
      }
      contributions.set(contribution.id, contribution);
      let active = true;
      return {
        id: contribution.id,
        async dispose() {
          if (!active) return;
          active = false;
          contributions.delete(contribution.id);
        },
      };
    },
    async run(id, input) {
      const contribution = contributions.get(id);
      if (contribution === undefined) throw contributionError('build-contribution-missing', id);
      return contribution.run(input);
    },
  };
}
