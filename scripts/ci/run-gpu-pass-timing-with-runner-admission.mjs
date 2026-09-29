#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerResources } from '../lib/runner-resources.mjs';
import {
  formatCpuList,
  parseCpuList,
  readAllowedCpuList,
  resolveRunnerCpuAffinity,
} from './run-with-runner-cpu-affinity.mjs';

export const GPU_PASS_TIMING_COMMAND = Object.freeze([
  'pnpm',
  'gpu-pass-timing:bench',
  '--',
  '--output=gpu-pass-timing-report.json',
]);

const GPU_PASS_TIMING_REPORT = 'gpu-pass-timing-report.json';
const GPU_PASS_TIMING_ADMISSION = 'gpu-pass-timing-runner-admission.json';
const SAMPLE_INTERVAL_MS = 250;

function defaultRead(path) {
  return readFileSync(path, 'utf8');
}

function rawRead(read, path) {
  if (typeof path !== 'string' || path.length === 0) {
    return { value: null, error: 'path-unavailable' };
  }
  try {
    const value = read(path);
    if (typeof value !== 'string') return { value: null, error: 'non-string-read' };
    return { value, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function decodeMountField(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function safeCgroupRelativePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('..')) return null;
  return value;
}

function parseCgroupEntries(raw) {
  if (typeof raw !== 'string') return [];
  const entries = [];
  for (const line of raw.split('\n')) {
    const match = /^(\d+):([^:]*):(.*)$/.exec(line.trim());
    if (match === null) continue;
    const relativePath = safeCgroupRelativePath(decodeMountField(match[3]));
    if (relativePath === null) continue;
    entries.push({
      hierarchyId: Number(match[1]),
      controllers: match[2] === '' ? [] : match[2].split(','),
      relativePath,
    });
  }
  return entries;
}

function parseCgroupMounts(raw) {
  if (typeof raw !== 'string') return [];
  const mounts = [];
  for (const line of raw.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator === -1) continue;
    const before = line.slice(0, separator).split(' ');
    const after = line.slice(separator + 3).split(' ');
    if (before[4] === undefined || after[0] === undefined) continue;
    const filesystem = after[0];
    if (filesystem !== 'cgroup' && filesystem !== 'cgroup2') continue;
    const optionFields = [before[5] ?? '', after[2] ?? ''];
    const options = new Set(optionFields.flatMap((field) => field.split(',')));
    mounts.push({
      filesystem,
      root: decodeMountField(before[3] ?? '/'),
      mountpoint: decodeMountField(before[4]),
      controllers: ['cpu', 'cpuacct', 'cpuset'].filter((controller) => options.has(controller)),
      raw: line,
    });
  }
  return mounts;
}

function findCgroupMount(mounts, filesystem, requiredControllers = []) {
  return mounts.find(
    (mount) =>
      mount.filesystem === filesystem &&
      requiredControllers.every((controller) => mount.controllers.includes(controller)),
  );
}

function pathWithinMount(relativePath, mountRoot) {
  if (mountRoot === '/') return relativePath;
  if (mountRoot === relativePath) return '/';
  if (relativePath.startsWith(`${mountRoot}/`)) return relativePath.slice(mountRoot.length);
  return null;
}

function cgroupDirectory(mountpoint, relativePath, mountRoot = '/') {
  const path = pathWithinMount(relativePath, mountRoot);
  return path === null ? null : join(mountpoint, path.slice(1));
}

function parentCgroupDirectories(directory, mountpoint) {
  const directories = [];
  let current = directory;
  while (current === mountpoint || current.startsWith(`${mountpoint}/`)) {
    directories.push(current);
    if (current === mountpoint) break;
    const parent = join(current, '..');
    const normalizedParent = resolve(parent);
    if (normalizedParent === current) break;
    current = normalizedParent;
  }
  return directories;
}

function readableCgroupFile(read, paths) {
  for (const path of paths) {
    const result = rawRead(read, path);
    if (result.value !== null) return { path, result };
  }
  return { path: paths[0] ?? null, result: { value: null, error: 'path-unavailable' } };
}

function readableNonEmptyCgroupFile(read, paths) {
  let firstResult = null;
  for (const path of paths) {
    const result = rawRead(read, path);
    if (firstResult === null) firstResult = { path, result };
    if (result.value !== null && result.value.trim() !== '') return { path, result };
  }
  return firstResult ?? { path: null, result: { value: null, error: 'path-unavailable' } };
}

function resolveV1CpusetFiles({ read, mountpoint, directory }) {
  const directories = parentCgroupDirectories(directory, mountpoint);
  const effective = readableNonEmptyCgroupFile(
    read,
    directories.map((value) => join(value, 'cpuset.effective_cpus')),
  );
  if (effective.result.value !== null && effective.result.value.trim() !== '') {
    return {
      path: effective.path,
      source: 'effective_cpus',
      attemptedPaths: directories.map((value) => join(value, 'cpuset.effective_cpus')),
    };
  }

  const inherited = readableNonEmptyCgroupFile(
    read,
    directories.map((value) => join(value, 'cpuset.cpus')),
  );
  return {
    path: inherited.path,
    source:
      inherited.result.value === null || inherited.result.value.trim() === ''
        ? 'cpuset-cpus-unavailable'
        : 'cpuset.cpus',
    attemptedPaths: directories.map((value) => join(value, 'cpuset.cpus')),
  };
}

function resolveV1MembershipFile(read, directory) {
  return readableCgroupFile(read, [join(directory, 'cgroup.procs'), join(directory, 'tasks')]).path;
}

export function resolveCgroupPaths({ read = defaultRead, cgroupRoot } = {}) {
  const cgroupRead = rawRead(read, '/proc/self/cgroup');
  const mountInfoRead = rawRead(read, '/proc/self/mountinfo');
  const entries = parseCgroupEntries(cgroupRead.value);
  const mounts = parseCgroupMounts(mountInfoRead.value);
  const v2Entry = entries.find((entry) => entry.controllers.length === 0);
  if (v2Entry !== undefined) {
    const mount =
      cgroupRoot === undefined
        ? findCgroupMount(mounts, 'cgroup2')
        : { mountpoint: cgroupRoot, filesystem: 'cgroup2', controllers: [] };
    if (mount?.mountpoint === undefined) {
      return {
        ok: false,
        reason: 'cgroup-v2-mount-unavailable',
        version: 'v2',
        hierarchy: 'cgroup-v2',
        rawCgroup: cgroupRead,
        rawMountInfo: mountInfoRead,
      };
    }
    const directory = cgroupDirectory(mount.mountpoint, v2Entry.relativePath, mount.root ?? '/');
    if (directory === null) {
      return {
        ok: false,
        reason: 'cgroup-v2-membership-outside-mount-root',
        version: 'v2',
        hierarchy: 'cgroup-v2',
        rawCgroup: cgroupRead,
        rawMountInfo: mountInfoRead,
      };
    }
    const procs = join(directory, 'cgroup.procs');
    return {
      ok: true,
      version: 'v2',
      hierarchy: 'cgroup-v2',
      mountpoint: mount.mountpoint,
      relativePath: v2Entry.relativePath,
      directory,
      rawCgroup: cgroupRead,
      rawMountInfo: mountInfoRead,
      pressureSource: 'cgroup',
      files: {
        cpuMax: join(directory, 'cpu.max'),
        cpuStat: join(directory, 'cpu.stat'),
        cpuset: join(directory, 'cpuset.cpus.effective'),
        cpusetExclusive: null,
        pressure: join(directory, 'cpu.pressure'),
        procs,
        cpusetProcs: procs,
      },
      membership: { cpu: procs, cpuset: procs },
    };
  }

  const cpuEntry = entries.find(
    (entry) => entry.controllers.includes('cpu') && entry.controllers.includes('cpuacct'),
  );
  const cpusetEntry = entries.find((entry) => entry.controllers.includes('cpuset'));
  const cpuMount = findCgroupMount(mounts, 'cgroup', ['cpu', 'cpuacct']);
  const cpusetMount = findCgroupMount(mounts, 'cgroup', ['cpuset']);
  if (cpuEntry === undefined || cpusetEntry === undefined) {
    return {
      ok: false,
      reason: 'cgroup-v1-controller-membership-unavailable',
      version: 'v1',
      hierarchy: 'cgroup-v1',
      rawCgroup: cgroupRead,
      rawMountInfo: mountInfoRead,
    };
  }
  if (cpuMount === undefined || cpusetMount === undefined) {
    return {
      ok: false,
      reason: 'cgroup-v1-mount-unavailable',
      version: 'v1',
      hierarchy: 'cgroup-v1',
      rawCgroup: cgroupRead,
      rawMountInfo: mountInfoRead,
    };
  }

  const cpuDirectory = cgroupDirectory(
    cpuMount.mountpoint,
    cpuEntry.relativePath,
    cpuMount.root ?? '/',
  );
  const cpusetDirectory = cgroupDirectory(
    cpusetMount.mountpoint,
    cpusetEntry.relativePath,
    cpusetMount.root ?? '/',
  );
  if (cpuDirectory === null || cpusetDirectory === null) {
    return {
      ok: false,
      reason: 'cgroup-v1-membership-outside-mount-root',
      version: 'v1',
      hierarchy: 'cgroup-v1',
      rawCgroup: cgroupRead,
      rawMountInfo: mountInfoRead,
    };
  }
  const cpuset = resolveV1CpusetFiles({
    read,
    mountpoint: cpusetMount.mountpoint,
    directory: cpusetDirectory,
  });
  const cpuProcs = resolveV1MembershipFile(read, cpuDirectory);
  const cpusetProcs = resolveV1MembershipFile(read, cpusetDirectory);
  return {
    ok: true,
    version: 'v1',
    hierarchy: 'cgroup-v1',
    mountpoint: null,
    relativePath: null,
    rawCgroup: cgroupRead,
    rawMountInfo: mountInfoRead,
    controllers: {
      cpu: {
        mountpoint: cpuMount.mountpoint,
        relativePath: cpuEntry.relativePath,
        directory: cpuDirectory,
      },
      cpuset: {
        mountpoint: cpusetMount.mountpoint,
        relativePath: cpusetEntry.relativePath,
        directory: cpusetDirectory,
      },
    },
    pressureSource: 'host',
    files: {
      cpuMax: null,
      cpuQuota: join(cpuDirectory, 'cpu.cfs_quota_us'),
      cpuPeriod: join(cpuDirectory, 'cpu.cfs_period_us'),
      cpuStat: join(cpuDirectory, 'cpu.stat'),
      cpuset: cpuset.path,
      cpusetSource: cpuset.source,
      cpusetAttemptedPaths: cpuset.attemptedPaths,
      cpusetExclusive: join(cpusetDirectory, 'cpuset.cpu_exclusive'),
      pressure: '/proc/pressure/cpu',
      procs: cpuProcs,
      cpusetProcs,
    },
    membership: { cpu: cpuProcs, cpuset: cpusetProcs },
  };
}

export const resolveCgroupV2Paths = resolveCgroupPaths;

export function parseCpuMax(raw) {
  if (typeof raw !== 'string') return null;
  const [quota, period] = raw.trim().split(/\s+/);
  const periodValue = Number(period);
  if (!Number.isSafeInteger(periodValue) || periodValue <= 0) return null;
  if (quota === 'max') return { quota, period: periodValue, cpus: null };
  const quotaValue = Number(quota);
  if (!Number.isSafeInteger(quotaValue) || quotaValue <= 0) return null;
  return { quota, period: periodValue, cpus: quotaValue / periodValue };
}

export function parseCpuCfsQuota(quotaRaw, periodRaw) {
  if (typeof quotaRaw !== 'string' || typeof periodRaw !== 'string') return null;
  const quota = Number(quotaRaw.trim());
  const period = Number(periodRaw.trim());
  if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(period) || quota <= 0 || period <= 0)
    return null;
  return { quota, period, cpus: quota / period };
}

export function parseCpuStat(raw, version = 'v2') {
  if (typeof raw !== 'string') return null;
  const values = {};
  const rawValues = {};
  for (const line of raw.trim().split('\n')) {
    const match = /^(\S+)\s+(\d+)$/.exec(line.trim());
    if (match === null) continue;
    const key = match[1];
    rawValues[key] = match[2];
    if (key === 'throttled_time') continue;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    values[key] = value;
  }
  if (version === 'v1') {
    if (values.nr_throttled === undefined || rawValues.throttled_time === undefined) return null;
    let throttledTime;
    try {
      throttledTime = BigInt(rawValues.throttled_time);
    } catch {
      return null;
    }
    const throttledUsec = throttledTime / 1000n;
    if (throttledUsec > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return {
      ...values,
      throttled_time_nanoseconds: rawValues.throttled_time,
      throttled_usec: Number(throttledUsec),
    };
  }
  if (
    values.usage_usec === undefined ||
    values.throttled_usec === undefined ||
    values.nr_throttled === undefined
  )
    return null;
  return values;
}

function parseCpuExclusive(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

function parseCpuPressureTotal(raw, section) {
  if (typeof raw !== 'string') return null;
  const line = raw.split('\n').find((value) => value.startsWith(`${section} `));
  const match = /(?:^|\s)total=(\d+)(?:\s|$)/.exec(line ?? '');
  if (match === null) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) ? total : null;
}

export function parseCpuPressureSomeTotal(raw) {
  return parseCpuPressureTotal(raw, 'some');
}

export function parseCpuPressureFullTotal(raw) {
  return parseCpuPressureTotal(raw, 'full');
}

function resolvePressureEvidenceMode({ version, pressureSource, someTotal, fullTotal }) {
  if (!Number.isSafeInteger(someTotal)) return 'unavailable';
  const hasFullTotal = Number.isSafeInteger(fullTotal);
  if (version === 'v1' && pressureSource === 'host') {
    return hasFullTotal ? 'host-some-and-full' : 'host-some-only';
  }
  if (version === 'v2' && pressureSource === 'cgroup') {
    return hasFullTotal ? 'cgroup-some-and-full' : 'cgroup-some-only';
  }
  return 'unavailable';
}

export function parseSelectedCpuStat(raw, selectedCpus) {
  if (typeof raw !== 'string' || !Array.isArray(selectedCpus) || selectedCpus.length === 0) {
    return null;
  }
  const byCpu = new Map();
  for (const line of raw.split('\n')) {
    const match = /^cpu(\d+)\s+(.*)$/.exec(line.trim());
    if (match === null) continue;
    const cpu = Number(match[1]);
    const fields = match[2].trim().split(/\s+/).map(Number);
    if (fields.length < 8 || fields.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      return null;
    }
    byCpu.set(cpu, { steal: fields[7] });
  }
  const counters = selectedCpus.map((cpu) => byCpu.get(cpu));
  if (counters.some((counter) => counter === undefined)) return null;
  return {
    byCpu: Object.fromEntries(selectedCpus.map((cpu, index) => [String(cpu), counters[index]])),
    stealTicks: counters.reduce((sum, counter) => sum + counter.steal, 0),
  };
}

export function parseCgroupProcs(raw) {
  if (typeof raw !== 'string') return null;
  const pids = [];
  for (const line of raw.trim().split('\n')) {
    if (line.trim() === '') continue;
    const pid = Number(line.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    pids.push(pid);
  }
  return [...new Set(pids)].sort((left, right) => left - right);
}

function readParentPid(read, pid) {
  const status = rawRead(read, `/proc/${pid}/status`).value;
  const match = /^PPid:\s+(\d+)$/m.exec(status ?? '');
  return match === null ? null : Number(match[1]);
}

function processAncestors(read, pid) {
  const ancestors = [];
  const seen = new Set([pid]);
  let current = pid;
  for (let depth = 0; depth < 32; depth += 1) {
    const parent = readParentPid(read, current);
    if (parent === null || parent <= 0 || seen.has(parent)) break;
    ancestors.push(parent);
    seen.add(parent);
    current = parent;
  }
  return ancestors;
}

function processTree(read, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ids: [], complete: true };
  const ids = new Set([pid]);
  const queue = [pid];
  let complete = true;
  while (queue.length > 0) {
    const current = queue.shift();
    const childrenRead = rawRead(read, `/proc/${current}/task/${current}/children`);
    if (childrenRead.value === null) {
      complete = false;
      continue;
    }
    for (const token of childrenRead.value.trim().split(/\s+/)) {
      if (token === '') continue;
      const child = Number(token);
      if (!Number.isSafeInteger(child) || child <= 0) {
        complete = false;
        continue;
      }
      if (!ids.has(child)) {
        ids.add(child);
        queue.push(child);
      }
    }
  }
  return { ids: [...ids].sort((left, right) => left - right), complete };
}

function pathOrNull(cgroup, name) {
  return cgroup?.ok === true ? cgroup.files[name] : null;
}

function selectCpuStatLines(raw, selectedCpus) {
  if (typeof raw !== 'string') return null;
  const selected = new Set(selectedCpus);
  return raw
    .split('\n')
    .filter((line) => {
      const match = /^cpu(\d+)\s/.exec(line);
      return match !== null && selected.has(Number(match[1]));
    })
    .join('\n');
}

function requiredSnapshotRawKeys(version) {
  return version === 'v1'
    ? [
        'cgroup',
        'cpuQuota',
        'cpuPeriod',
        'cpuStat',
        'cpusetCpusEffective',
        'cpusetCpuExclusive',
        'cpuPressure',
        'selectedCpuStat',
        'loadavg',
        'cgroupProcs',
        'cpusetCgroupProcs',
      ]
    : [
        'cgroup',
        'cpuMax',
        'cpuStat',
        'cpusetCpusEffective',
        'cpuPressure',
        'selectedCpuStat',
        'loadavg',
        'cgroupProcs',
      ];
}

function runnerSnapshotComplete({ raw, parsed, processTreeComplete, version, requiredProcessId }) {
  const requiredRaw = requiredSnapshotRawKeys(version);
  return (
    requiredRaw.every((key) => raw[key] !== null) &&
    parsed.cpuMax !== null &&
    parsed.cpuStat !== null &&
    parsed.cpuset.length > 0 &&
    (version !== 'v1' || parsed.cpusetExclusive !== null) &&
    parsed.pressureSomeTotal !== null &&
    (version === 'v1' || parsed.pressureFullTotal !== null) &&
    parsed.selectedCpuStat !== null &&
    parsed.cgroupProcs !== null &&
    parsed.cgroupProcs.length > 0 &&
    (requiredProcessId === undefined || parsed.cgroupProcs.includes(requiredProcessId)) &&
    (version !== 'v1' ||
      (parsed.cpusetCgroupProcs !== null &&
        parsed.cpusetCgroupProcs.length > 0 &&
        (requiredProcessId === undefined ||
          parsed.cpusetCgroupProcs.includes(requiredProcessId)))) &&
    processTreeComplete
  );
}

export function collectRunnerTelemetrySnapshot({
  read = defaultRead,
  cgroup,
  selectedCpus,
  childPid,
  allowedProcessIds = [process.pid],
  timestamp = new Date().toISOString(),
  monotonicNanoseconds = process.hrtime.bigint().toString(),
} = {}) {
  const selectedCpuStatRead = rawRead(read, '/proc/stat');
  const version = cgroup?.version ?? 'v2';
  const raw = {
    cgroup: cgroup?.rawCgroup?.value ?? null,
    cpuMax: rawRead(read, pathOrNull(cgroup, 'cpuMax')).value,
    cpuQuota: rawRead(read, pathOrNull(cgroup, 'cpuQuota')).value,
    cpuPeriod: rawRead(read, pathOrNull(cgroup, 'cpuPeriod')).value,
    cpuStat: rawRead(read, pathOrNull(cgroup, 'cpuStat')).value,
    cpusetCpusEffective: rawRead(read, pathOrNull(cgroup, 'cpuset')).value,
    cpusetCpuExclusive: rawRead(read, pathOrNull(cgroup, 'cpusetExclusive')).value,
    cpuPressure: rawRead(read, pathOrNull(cgroup, 'pressure')).value,
    selectedCpuStat: selectCpuStatLines(selectedCpuStatRead.value, selectedCpus),
    loadavg: rawRead(read, '/proc/loadavg').value,
    cgroupProcs: rawRead(read, pathOrNull(cgroup, 'procs')).value,
    cpusetCgroupProcs: rawRead(read, pathOrNull(cgroup, 'cpusetProcs')).value,
  };
  const tree = processTree(read, childPid);
  const allowed = [...new Set([...allowedProcessIds, ...tree.ids])].sort(
    (left, right) => left - right,
  );
  const parsed = {
    cpuMax:
      version === 'v1' ? parseCpuCfsQuota(raw.cpuQuota, raw.cpuPeriod) : parseCpuMax(raw.cpuMax),
    cpuStat: parseCpuStat(raw.cpuStat, version),
    cpuset: parseCpuList(raw.cpusetCpusEffective ?? ''),
    cpusetExclusive: parseCpuExclusive(raw.cpusetCpuExclusive),
    pressureSomeTotal: parseCpuPressureSomeTotal(raw.cpuPressure),
    pressureFullTotal: parseCpuPressureFullTotal(raw.cpuPressure),
    selectedCpuStat: parseSelectedCpuStat(raw.selectedCpuStat, selectedCpus),
    cgroupProcs: parseCgroupProcs(raw.cgroupProcs),
    cpusetCgroupProcs: parseCgroupProcs(raw.cpusetCgroupProcs),
  };
  const missing = [];
  for (const key of requiredSnapshotRawKeys(version)) {
    if (raw[key] === null) missing.push(key);
  }
  if (parsed.cpuMax === null) missing.push('cpuMaxCounters');
  if (parsed.cpuStat === null) missing.push('cpuStatCounters');
  if (parsed.cpuset.length === 0) missing.push('cpusetCounters');
  if (version === 'v1' && parsed.cpusetExclusive === null) missing.push('cpusetExclusive');
  if (parsed.pressureSomeTotal === null) missing.push('cpuPressureSomeTotal');
  if (version !== 'v1' && parsed.pressureFullTotal === null) missing.push('cpuPressureFullTotal');
  if (parsed.selectedCpuStat === null) missing.push('selectedCpuStatCounters');
  if (parsed.cgroupProcs === null || parsed.cgroupProcs.length === 0)
    missing.push('cgroupProcessMembership');
  if (
    version === 'v1' &&
    (parsed.cpusetCgroupProcs === null || parsed.cpusetCgroupProcs.length === 0)
  )
    missing.push('cpusetProcessMembership');
  if (!tree.complete) missing.push('processTreeMembership');
  return {
    at: timestamp,
    monotonicNanoseconds,
    raw,
    parsed,
    pressureEvidenceMode: resolvePressureEvidenceMode({
      version,
      pressureSource: cgroup?.pressureSource,
      someTotal: parsed.pressureSomeTotal,
      fullTotal: parsed.pressureFullTotal,
    }),
    processMembership: {
      observedProcessIds: uniqueNumbers([
        ...(parsed.cgroupProcs ?? []),
        ...(parsed.cpusetCgroupProcs ?? []),
      ]),
      controllerProcessIds: {
        cpu: parsed.cgroupProcs ?? [],
        cpuset: parsed.cpusetCgroupProcs ?? [],
      },
      allowedProcessIds: allowed,
      childPid: childPid ?? null,
      processTreeComplete: tree.complete,
    },
    complete: runnerSnapshotComplete({
      raw,
      parsed,
      processTreeComplete: tree.complete,
      version,
      requiredProcessId: allowedProcessIds[0],
    }),
    missing: [...new Set(missing)],
  };
}

function uniqueNumbers(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function counterDelta(before, after, key) {
  const left = before?.[key];
  const right = after?.[key];
  if (typeof left === 'string' && typeof right === 'string') {
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return null;
    const delta = BigInt(right) - BigInt(left);
    if (delta > BigInt(Number.MAX_SAFE_INTEGER)) return 'positive-overflow';
    if (delta < BigInt(Number.MIN_SAFE_INTEGER)) return 'negative-overflow';
    return Number(delta);
  }
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;
  return right - left;
}

export function assessRunnerAdmission({
  resources,
  affinity,
  snapshots,
  child = { exitCode: null, signal: null, naturalExit: false },
  platform = process.platform,
  cgroup,
  benchmarkStarted = true,
  preflightExtraReasonCodes = [],
} = {}) {
  const started = benchmarkStarted !== false;
  const staticReasons = [...new Set(preflightExtraReasonCodes)];
  const reasons = [];
  const first = snapshots?.[0];
  const last = snapshots?.[snapshots.length - 1];
  const budget = resources?.cpus;
  const version = cgroup?.version ?? (cgroup?.ok === true ? 'v2' : null);
  const hierarchyAvailable = cgroup?.ok === true && (version === 'v1' || version === 'v2');
  const effectiveCpus = first?.parsed?.cpuset ?? [];
  const effectiveCpuList = formatCpuList(effectiveCpus);
  const selectedCpuList = affinity?.selectedCpuList ?? '';
  const pressureEvidenceMode = resolvePressureEvidenceMode({
    version,
    pressureSource: cgroup?.pressureSource,
    someTotal: first?.parsed?.pressureSomeTotal,
    fullTotal: first?.parsed?.pressureFullTotal,
  });
  const exactCpuset =
    platform === 'linux' &&
    hierarchyAvailable &&
    Number.isInteger(budget) &&
    budget > 0 &&
    effectiveCpus.length === budget &&
    effectiveCpuList === selectedCpuList &&
    first?.parsed?.cpuMax?.cpus === budget;
  const telemetryComplete =
    Array.isArray(snapshots) &&
    snapshots.length >= (started ? 2 : 1) &&
    snapshots.every((sample) => sample.complete);
  if (!telemetryComplete) staticReasons.push('telemetry-incomplete');
  if (!hierarchyAvailable) {
    staticReasons.push(version === 'v1' ? 'cgroup-v1-unavailable' : 'cgroup-v2-unavailable');
  }
  if (!exactCpuset) staticReasons.push('cpuset-not-exclusive');
  if (affinity?.ok !== true || affinity.mode !== 'taskset')
    staticReasons.push('cpu-affinity-unavailable');
  if (cgroup?.version === 'v1' && first?.parsed?.cpusetExclusive !== true)
    staticReasons.push('cpuset-cpu-exclusive-not-set');
  if (cgroup?.version === 'v1' && cgroup.pressureSource !== 'host')
    staticReasons.push('pressure-source-unavailable');
  if (cgroup?.version === 'v2' && cgroup.pressureSource !== 'cgroup')
    staticReasons.push('pressure-source-unavailable');

  const firstUnrelatedProcessIds = uniqueNumbers(
    (first?.processMembership?.observedProcessIds ?? []).filter(
      (pid) => !(first?.processMembership?.allowedProcessIds ?? []).includes(pid),
    ),
  );
  if (firstUnrelatedProcessIds.length > 0) staticReasons.push('unrelated-cgroup-process');

  let selectedCpuStealDelta = null;
  let throttledUsecDelta = null;
  let throttledTimeNanosecondsDelta = null;
  let nrThrottledDelta = null;
  let fullPressureTotalDelta = null;
  if (started) {
    selectedCpuStealDelta = counterDelta(
      first?.parsed?.selectedCpuStat,
      last?.parsed?.selectedCpuStat,
      'stealTicks',
    );
    throttledUsecDelta = counterDelta(
      first?.parsed?.cpuStat,
      last?.parsed?.cpuStat,
      'throttled_usec',
    );
    if (version === 'v1') {
      throttledTimeNanosecondsDelta = counterDelta(
        first?.parsed?.cpuStat,
        last?.parsed?.cpuStat,
        'throttled_time_nanoseconds',
      );
    }
    nrThrottledDelta = counterDelta(first?.parsed?.cpuStat, last?.parsed?.cpuStat, 'nr_throttled');
    fullPressureTotalDelta =
      Number.isSafeInteger(first?.parsed?.pressureFullTotal) &&
      Number.isSafeInteger(last?.parsed?.pressureFullTotal)
        ? last.parsed.pressureFullTotal - first.parsed.pressureFullTotal
        : null;
    if (selectedCpuStealDelta === null) reasons.push('selected-cpu-steal-missing');
    else if (selectedCpuStealDelta !== 0) reasons.push('selected-cpu-steal-delta');
    if (throttledUsecDelta === null) reasons.push('cgroup-throttled-usec-missing');
    else if (throttledUsecDelta !== 0) reasons.push('cgroup-throttled-usec-delta');
    if (version === 'v1') {
      if (throttledTimeNanosecondsDelta === null) reasons.push('cgroup-throttled-time-missing');
      else if (throttledTimeNanosecondsDelta !== 0) reasons.push('cgroup-throttled-time-delta');
    }
    if (nrThrottledDelta === null) reasons.push('cgroup-throttle-event-missing');
    else if (nrThrottledDelta !== 0) reasons.push('cgroup-throttle-event-delta');
    if (pressureEvidenceMode !== 'host-some-only') {
      if (fullPressureTotalDelta === null) reasons.push('cgroup-full-pressure-missing');
      else if (fullPressureTotalDelta !== 0) reasons.push('cgroup-full-pressure-delta');
    }
  }
  reasons.unshift(...staticReasons);

  const unrelatedProcessIds = uniqueNumbers(
    (snapshots ?? []).flatMap((sample) =>
      (sample.processMembership?.observedProcessIds ?? []).filter(
        (pid) => !(sample.processMembership?.allowedProcessIds ?? []).includes(pid),
      ),
    ),
  );
  const noUnrelatedProcess = unrelatedProcessIds.length === 0;
  if (!noUnrelatedProcess && !staticReasons.includes('unrelated-cgroup-process'))
    reasons.push('unrelated-cgroup-process');

  const naturalExit = started && child.signal === null && Number.isInteger(child.exitCode);
  if (started && !naturalExit) reasons.push('child-exit-not-natural');
  if (!started) reasons.push('benchmark-not-started');

  const reasonCodes = [...new Set(reasons)];
  const preflightReasonCodes = [...new Set(staticReasons)];
  const pressureEvidenceAccepted =
    reasonCodes.length === 0 && pressureEvidenceMode !== 'unavailable';

  return {
    verdict: reasonCodes.length === 0 ? 'accepted' : 'rejected',
    accepted: reasonCodes.length === 0,
    benchmarkStarted: started,
    preflightAccepted: preflightReasonCodes.length === 0,
    preflightReasonCodes,
    reasonCodes,
    checks: {
      telemetryComplete,
      exactCpuset,
      cgroupCpuExclusive: cgroup?.version === 'v1' ? first?.parsed?.cpusetExclusive === true : true,
      zeroSelectedCpuStealDelta: started ? selectedCpuStealDelta === 0 : null,
      zeroCgroupThrottledUsecDelta: started ? throttledUsecDelta === 0 : null,
      zeroCgroupThrottledTimeDelta: started
        ? version === 'v1'
          ? throttledTimeNanosecondsDelta === 0
          : true
        : null,
      zeroCgroupThrottleEventDelta: started ? nrThrottledDelta === 0 : null,
      zeroCgroupFullPressureTotalDelta:
        started && pressureEvidenceMode !== 'host-some-only' ? fullPressureTotalDelta === 0 : null,
      pressureEvidenceAccepted,
      noUnrelatedProcess,
      naturalChildExit: naturalExit,
    },
    hierarchy: cgroup?.hierarchy ?? null,
    version,
    pressureSource: cgroup?.pressureSource ?? null,
    pressureEvidenceMode,
    runnerCpuBudget: budget ?? null,
    effectiveCpuList,
    selectedCpuList,
    deltas: {
      selectedCpuStealTicks: selectedCpuStealDelta,
      cgroupThrottledUsec: throttledUsecDelta,
      cgroupThrottledTimeNanoseconds: throttledTimeNanosecondsDelta,
      cgroupThrottleEvents: nrThrottledDelta,
      cgroupFullPressureTotal: fullPressureTotalDelta,
    },
    unrelatedProcessIds,
  };
}

function runnerIdentity(env) {
  return {
    name: env.RUNNER_NAME ?? null,
    id: env.RUNNER_ID ?? null,
    os: env.RUNNER_OS ?? process.platform,
    arch: env.RUNNER_ARCH ?? process.arch,
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    sourceHead: env.GITHUB_SHA ?? env.FORGEAX_GPU_PASS_TIMING_SOURCE_HEAD ?? null,
  };
}

function fileEvidence(path, read = defaultRead, stat = statSync) {
  try {
    const value = read(path);
    const bytes = Buffer.from(value, 'utf8');
    return {
      exists: true,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    return {
      exists: false,
      bytes: null,
      sha256: null,
      error: error instanceof Error ? error.message : String(error),
      stat: (() => {
        try {
          return stat(path).size;
        } catch {
          return null;
        }
      })(),
    };
  }
}

function clearReportOutput({ reportPath, read, unlink, before }) {
  const missing = (evidence) => !evidence.exists && evidence.stat === null;
  const present = before.exists || before.stat !== null;
  if (!present) {
    return { attempted: false, cleared: true, after: before };
  }
  try {
    unlink(reportPath);
  } catch (error) {
    const after = fileEvidence(reportPath, read);
    return {
      attempted: true,
      cleared: missing(after),
      error: error instanceof Error ? error.message : String(error),
      after,
    };
  }
  const after = fileEvidence(reportPath, read);
  return {
    attempted: true,
    cleared: missing(after),
    after,
  };
}

function spawnBenchmarkChild({
  command = GPU_PASS_TIMING_COMMAND,
  selectedCpuList,
  useTaskset,
  env,
  onSpawn,
  spawnImpl = spawn,
}) {
  const childCommand = useTaskset ? 'taskset' : command[0];
  const childArgs = useTaskset ? ['--cpu-list', selectedCpuList, ...command] : command.slice(1);
  return new Promise((resolveChild) => {
    let settled = false;
    let child;
    try {
      child = spawnImpl(childCommand, childArgs, { env, stdio: 'inherit' });
      if (child.pid !== undefined) onSpawn(child.pid);
    } catch (error) {
      resolveChild({
        exitCode: null,
        signal: null,
        naturalExit: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      process.stderr.write(`[runner-admission] failed to start benchmark: ${error.message}\n`);
      resolveChild({
        exitCode: null,
        signal: null,
        naturalExit: false,
        spawnError: error.message,
      });
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (signal !== null)
        process.stderr.write(`[runner-admission] benchmark terminated by ${signal}\n`);
      resolveChild({
        exitCode,
        signal,
        naturalExit: signal === null && exitCode !== null,
      });
    });
  });
}

function initialPreflight({
  snapshot,
  resources,
  affinity,
  platform,
  cgroup,
  assessment,
  reportCleanup,
}) {
  const effectiveCpus = snapshot?.parsed?.cpuset ?? [];
  const effectiveCpuList = formatCpuList(effectiveCpus);
  const version = cgroup?.version ?? (cgroup?.ok === true ? 'v2' : null);
  return {
    platform,
    hierarchy: cgroup?.hierarchy ?? null,
    version,
    runnerCpuBudget: resources?.cpus ?? null,
    effectiveCpuList,
    exactCpuset:
      platform === 'linux' &&
      Number.isInteger(resources?.cpus) &&
      effectiveCpus.length === resources.cpus &&
      snapshot?.parsed?.cpuMax?.cpus === resources.cpus &&
      affinity?.ok === true &&
      affinity.mode === 'taskset' &&
      affinity.selectedCpuList === effectiveCpuList,
    cgroupV2: version === 'v2' && cgroup?.ok === true,
    cgroupReason: cgroup?.ok === true ? null : (cgroup?.reason ?? 'cgroup-v2-unavailable'),
    pressureSource: cgroup?.pressureSource ?? null,
    pressureEvidenceMode: assessment?.pressureEvidenceMode ?? null,
    staticAccepted: assessment?.preflightAccepted === true,
    staticReasonCodes: assessment?.preflightReasonCodes ?? [],
    reportCleared: reportCleanup?.cleared === true,
    reportCleanupError: reportCleanup?.error ?? null,
  };
}

export async function runGpuPassTimingWithRunnerAdmission({
  read = defaultRead,
  write = writeFileSync,
  resources = runnerResources(),
  platform = process.platform,
  allowedCpus = readAllowedCpuList({ read }),
  affinity = resolveRunnerCpuAffinity({ platform, resources, allowedCpus }),
  cgroup = resolveCgroupPaths({ read }),
  command = GPU_PASS_TIMING_COMMAND,
  reportPath = GPU_PASS_TIMING_REPORT,
  admissionPath = GPU_PASS_TIMING_ADMISSION,
  intervalMs = SAMPLE_INTERVAL_MS,
  snapshotFactory = collectRunnerTelemetrySnapshot,
  spawnChild = spawnBenchmarkChild,
  unlink = unlinkSync,
  env = process.env,
  timestamp = () => new Date().toISOString(),
  monotonicNanoseconds = () => process.hrtime.bigint().toString(),
  processId = process.pid,
} = {}) {
  const ancestors = processAncestors(read, processId);
  const firstSnapshot = snapshotFactory({
    read,
    cgroup,
    selectedCpus: parseCpuList(affinity.selectedCpuList ?? ''),
    allowedProcessIds: [processId, ...ancestors],
    timestamp: timestamp(),
    monotonicNanoseconds: monotonicNanoseconds(),
  });
  const reportBefore = fileEvidence(reportPath, read);
  const reportCleanup = clearReportOutput({ reportPath, read, unlink, before: reportBefore });
  const preflightAssessment = assessRunnerAdmission({
    resources,
    affinity,
    snapshots: [firstSnapshot],
    child: { exitCode: null, signal: null, naturalExit: false },
    platform,
    cgroup,
    benchmarkStarted: false,
    preflightExtraReasonCodes: reportCleanup.cleared ? [] : ['report-output-not-cleared'],
  });
  const preflight = initialPreflight({
    snapshot: firstSnapshot,
    resources,
    affinity,
    platform,
    cgroup,
    assessment: preflightAssessment,
    reportCleanup,
  });
  if (!preflightAssessment.preflightAccepted) {
    const child = {
      exitCode: null,
      signal: null,
      naturalExit: false,
      benchmarkStarted: false,
    };
    const reportAfter = fileEvidence(reportPath, read);
    const artifact = {
      schemaVersion: 1,
      benchmark: 'render-gpu-pass-timing',
      command: [...command],
      runner: runnerIdentity(env),
      affinity,
      preflight,
      child,
      report: {
        path: reportPath,
        before: reportBefore,
        cleanup: reportCleanup,
        after: reportAfter,
      },
      admission: preflightAssessment,
      telemetry: {
        sampleCount: 1,
        complete: firstSnapshot.complete,
        cgroup:
          cgroup.ok === true
            ? {
                version: cgroup.version,
                hierarchy: cgroup.hierarchy,
                mountpoint: cgroup.mountpoint,
                relativePath: cgroup.relativePath,
                controllers: cgroup.controllers,
                files: cgroup.files,
                membership: cgroup.membership,
              }
            : cgroup,
        snapshots: [firstSnapshot],
      },
      benchmarkStarted: false,
      verdict: preflightAssessment.verdict,
    };
    write(admissionPath, `${JSON.stringify(artifact, null, 2)}\n`);
    return { artifact, exitCode: 1 };
  }
  const snapshots = [firstSnapshot];
  let childPid;
  let childRunning = false;
  const capture = () => {
    snapshots.push(
      snapshotFactory({
        read,
        cgroup,
        selectedCpus: parseCpuList(affinity.selectedCpuList ?? ''),
        childPid: childRunning ? childPid : undefined,
        allowedProcessIds: [processId, ...ancestors],
        timestamp: timestamp(),
        monotonicNanoseconds: monotonicNanoseconds(),
      }),
    );
  };
  const interval = setInterval(capture, intervalMs);
  let child;
  try {
    child = await spawnChild({
      command,
      selectedCpuList: affinity.selectedCpuList ?? '',
      useTaskset: preflight.exactCpuset,
      env: { ...env, FORGEAX_RUNNER_CPU_AFFINITY: JSON.stringify(affinity) },
      onSpawn: (pid) => {
        childPid = pid;
        childRunning = true;
      },
    });
  } finally {
    childRunning = false;
    clearInterval(interval);
    capture();
  }

  const assessment = assessRunnerAdmission({
    resources,
    affinity,
    snapshots,
    child,
    platform,
    cgroup,
  });
  const reportAfter = fileEvidence(reportPath, read);
  const artifact = {
    schemaVersion: 1,
    benchmark: 'render-gpu-pass-timing',
    command: [...command],
    runner: runnerIdentity(env),
    affinity,
    preflight,
    child,
    report: {
      path: reportPath,
      before: reportBefore,
      cleanup: reportCleanup,
      after: reportAfter,
    },
    admission: assessment,
    telemetry: {
      sampleCount: snapshots.length,
      complete: snapshots.every((sample) => sample.complete),
      cgroup:
        cgroup.ok === true
          ? {
              version: cgroup.version,
              hierarchy: cgroup.hierarchy,
              mountpoint: cgroup.mountpoint,
              relativePath: cgroup.relativePath,
              controllers: cgroup.controllers,
              pressureSource: cgroup.pressureSource,
              files: cgroup.files,
              membership: cgroup.membership,
            }
          : cgroup,
      snapshots,
    },
    verdict: assessment.verdict,
    benchmarkStarted: true,
  };
  write(admissionPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const childExitCode = Number.isInteger(child.exitCode) ? child.exitCode : 1;
  return {
    artifact,
    exitCode: childExitCode === 0 && assessment.verdict !== 'accepted' ? 1 : childExitCode,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGpuPassTimingWithRunnerAdmission()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `[runner-admission] ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
