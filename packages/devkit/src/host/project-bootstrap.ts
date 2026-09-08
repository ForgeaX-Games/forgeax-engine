import type { ProjectFacts } from '../types.js';
import { type BaseHost, type BootstrapRoot, createBaseHostForProject } from './base-host.js';

type ProjectBootstrapRoot = Extract<BootstrapRoot, 'project-bootstrap'>;

export interface ProjectBootstrapPlan {
  readonly root: ProjectBootstrapRoot;
  readonly projectRoot: string;
  readonly defaultScene?: string;
  readonly plugins: readonly string[];
  readonly host: BaseHost;
}

function leafPlugins(facts: ProjectFacts): readonly string[] {
  const names: string[] = [];
  const visit = (entries: ProjectFacts['plugins']): void => {
    for (const entry of entries) {
      if (entry.group === true) visit(entry.config as ProjectFacts['plugins']);
      else if (!entry.name.startsWith('cordis:') && entry.realm !== 'build') names.push(entry.id);
    }
  };
  visit(facts.plugins);
  return names;
}

export function createProjectBootstrapPlan(facts: ProjectFacts): ProjectBootstrapPlan {
  return {
    root: 'project-bootstrap',
    projectRoot: facts.root,
    ...(facts.defaultScene === undefined ? {} : { defaultScene: facts.defaultScene }),
    plugins: leafPlugins(facts),
    host: createBaseHostForProject(facts),
  };
}
