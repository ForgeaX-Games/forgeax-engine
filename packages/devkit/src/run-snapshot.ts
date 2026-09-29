import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, type PlatformPath, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { packlist } from '@pnpm/fs.packlist';
import { inspectEngineWorkspace, readEngineBinding } from './engine-binding.js';

const omitted = new Set([
  '.git',
  '.agents',
  '.claude',
  '.codex',
  '.forgeax',
  '.forgeax-debug',
  '.forgeax-harness',
  '.worktrees',
  'node_modules',
  'artifacts',
  'coverage',
]);

export function runStateDirectory(projectRoot: string): string {
  const identity = createHash('sha256').update(resolve(projectRoot)).digest('hex');
  return resolve(
    process.env.FORGEAX_RUNS_DIR ?? join(homedir(), '.local/share/ForgeaX/runs'),
    identity,
  );
}

interface SnapshotFile {
  readonly source: string;
  readonly target: string;
  readonly stamp: string;
  readonly mode: number;
  readonly size: number;
}

interface SnapshotPlan {
  readonly binding: string;
  readonly files: SnapshotFile[];
  readonly links: Array<{ readonly target: string; readonly destination: string }>;
}

class SnapshotChangedError extends Error {}

const SNAPSHOT_ATTEMPTS = 3;

type SnapshotPath = Pick<PlatformPath, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>;

/**
 * A snapshot directory is inside the project when it is the project root or a
 * descendant. Another Windows volume is outside: `path.relative` returns that
 * absolute path instead of a `..` prefix.
 */
export function snapshotDirectoryInsideProject(
  projectRoot: string,
  directory: string,
  pathApi: SnapshotPath = { isAbsolute, relative, resolve, sep },
): boolean {
  const relativeDirectory = pathApi.relative(
    pathApi.resolve(projectRoot),
    pathApi.resolve(directory),
  );
  if (!relativeDirectory) return true;
  if (pathApi.isAbsolute(relativeDirectory)) return false;
  return !relativeDirectory.startsWith(`..${pathApi.sep}`) && relativeDirectory !== '..';
}

async function stamp(path: string): Promise<{ stamp: string; mode: number; size: number }> {
  const info = await stat(path, { bigint: true });
  return {
    stamp: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(':'),
    mode: Number(info.mode),
    size: Number(info.size),
  };
}

async function installedPackage(from: string, name: string): Promise<string | undefined> {
  if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name))
    throw new Error(`Invalid package name: ${name}`);
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    try {
      return await realpath(join(directory, 'node_modules', name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(directory) === directory) return undefined;
  }
}

async function planSnapshot(projectRoot: string, signal?: AbortSignal): Promise<SnapshotPlan> {
  signal?.throwIfAborted();
  const binding = await readEngineBinding(projectRoot);
  if (!binding.ok) throw new Error(`${binding.error.code}: ${binding.error.hint}`);
  const boundPackages = new Map<string, string>();
  if (binding.value) {
    const inspected = await inspectEngineWorkspace(binding.value.path);
    if (!inspected.ok) throw new Error(`${inspected.error.code}: ${inspected.error.hint}`);
    for (const entry of inspected.value.packages)
      boundPackages.set(entry.name, await realpath(entry.root));
  }
  const files: SnapshotFile[] = [];
  const links: SnapshotPlan['links'] = [];
  const packages = new Map<string, string>();
  async function tree(
    source: string,
    target: string,
    ancestors = new Set<string>(),
  ): Promise<void> {
    signal?.throwIfAborted();
    const canonical = await realpath(source);
    const info = await stat(canonical);
    if (info.isFile()) {
      files.push({ source: canonical, target, ...(await stamp(canonical)) });
      return;
    }
    if (!info.isDirectory() || ancestors.has(canonical))
      throw new Error(`Unsupported or cyclic input: ${source}`);
    const next = new Set([...ancestors, canonical]);
    for (const name of (await readdir(canonical)).sort()) {
      if (!omitted.has(name)) await tree(join(canonical, name), join(target, name), next);
    }
  }
  async function dependencies(source: string, target: string, project = false): Promise<void> {
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    const names = {
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...(project ? manifest.devDependencies : {}),
      ...manifest.optionalDependencies,
    };
    for (const name of Object.keys(names).sort()) {
      signal?.throwIfAborted();
      const installed = boundPackages.get(name) ?? (await installedPackage(source, name));
      if (!installed) {
        if (
          name in (manifest.optionalDependencies ?? {}) ||
          manifest.peerDependenciesMeta?.[name]?.optional
        )
          continue;
        throw new Error(`Snapshot dependency is not installed: ${name} (from ${source})`);
      }
      let destination = packages.get(installed);
      const existing = destination !== undefined;
      destination ??= join('dependencies', createHash('sha256').update(installed).digest('hex'));
      packages.set(installed, destination);
      links.push({ target: join(target, 'node_modules', name), destination });
      if (!existing) {
        // The package's published payload owns dependency inputs, not its checkout.
        for (const file of (await packlist(installed)).sort()) {
          if (!file.split('/').some((part) => omitted.has(part)))
            await tree(join(installed, file), join(destination, file));
        }
        await dependencies(installed, destination);
      }
    }
  }
  await tree(projectRoot, 'project');
  await dependencies(projectRoot, 'project', true);
  return { binding: JSON.stringify(binding.value), files, links };
}

/** Copy the resolved installed closure, including dirty inputs, before publishing a run. */
async function createRunSnapshotAttempt(
  projectRoot: string,
  directory: string,
  signal?: AbortSignal,
): Promise<{
  readonly root: string;
  readonly version: string;
  readonly dispose: () => Promise<void>;
}> {
  if (snapshotDirectoryInsideProject(projectRoot, directory))
    throw new Error('Run snapshots must be stored outside the project inputs.');
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const plan = await planSnapshot(resolve(projectRoot), signal);
    const digest = createHash('sha256');
    for (const file of plan.files) {
      signal?.throwIfAborted();
      const target = join(directory, file.target);
      await mkdir(dirname(target), { recursive: true });
      digest.update(JSON.stringify([file.target, file.mode & 0o111, file.size]));
      await pipeline(
        createReadStream(file.source),
        new Transform({
          transform(chunk, _encoding, callback) {
            digest.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(target),
        { signal },
      );
      if ((await stamp(file.source)).stamp !== file.stamp)
        throw new SnapshotChangedError(`Input changed while snapshotting: ${file.source}`);
      await chmod(target, file.mode & 0o111 ? 0o555 : 0o444);
    }
    for (const link of plan.links) {
      signal?.throwIfAborted();
      const target = join(directory, link.target);
      const destination = join(directory, link.destination);
      await mkdir(dirname(target), { recursive: true });
      await symlink(
        process.platform === 'win32' ? destination : relative(dirname(target), destination),
        target,
        'junction',
      );
      digest.update(JSON.stringify(link));
    }
    // Re-resolve links as well as file metadata: an installed package can be
    // replaced without modifying the old directory that we just copied.
    if (JSON.stringify(await planSnapshot(resolve(projectRoot), signal)) !== JSON.stringify(plan)) {
      throw new SnapshotChangedError(
        'Project inputs changed while snapshotting; retry from a stable version.',
      );
    }
    signal?.throwIfAborted();
    return { root: join(directory, 'project'), version: `sha256:${digest.digest('hex')}`, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Retry short watcher races while preserving the fail-closed stable-input contract. */
export async function createRunSnapshot(
  projectRoot: string,
  directory: string,
  signal?: AbortSignal,
): Promise<{
  readonly root: string;
  readonly version: string;
  readonly dispose: () => Promise<void>;
}> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await createRunSnapshotAttempt(projectRoot, directory, signal);
    } catch (error) {
      if (!(error instanceof SnapshotChangedError) || attempt >= SNAPSHOT_ATTEMPTS) throw error;
      signal?.throwIfAborted();
      await new Promise((resolveRetry) => setTimeout(resolveRetry, attempt * 50));
    }
  }
}
