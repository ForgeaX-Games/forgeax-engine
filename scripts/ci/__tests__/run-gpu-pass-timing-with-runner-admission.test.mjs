import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessRunnerAdmission,
  collectRunnerTelemetrySnapshot,
  GPU_PASS_TIMING_COMMAND,
  parseCpuCfsQuota,
  parseCpuMax,
  parseCpuPressureFullTotal,
  parseCpuPressureSomeTotal,
  parseCpuStat,
  parseSelectedCpuStat,
  resolveCgroupPaths,
  runGpuPassTimingWithRunnerAdmission,
} from '../run-gpu-pass-timing-with-runner-admission.mjs';

const affinity = { ok: true, mode: 'taskset', selectedCpuList: '0-7' };
const resources = { cpus: 8 };

const v1CpuDirectory = '/sys/fs/cgroup/cpu,cpuacct/kubepods/burstable/pod-a';
const v1CpusetDirectory = '/sys/fs/cgroup/cpuset/kubepods/burstable/pod-a';

function v1Files({
  quota = '800000',
  exclusive = '1',
  throttleTime = '2000',
  throttleEvents = '2',
  cpuset = '0-7',
  cpuProcs = '100\n',
  cpusetProcs = '100\n',
  pressure = 'some avg10=0 avg60=0 avg300=0 total=10\nfull avg10=0 avg60=0 avg300=0 total=30\n',
} = {}) {
  const stat = `nr_periods 10\nnr_throttled ${throttleEvents}\nthrottled_time ${throttleTime}\n`;
  const selectedCpuStat = Array.from(
    { length: 8 },
    (_, cpu) => `cpu${cpu} 1 2 3 4 5 6 7 10 0 0`,
  ).join('\n');
  return new Map([
    [
      '/proc/self/cgroup',
      '9:cpu,cpuacct:/kubepods/burstable/pod-a\n4:cpuset:/kubepods/burstable/pod-a\n',
    ],
    [
      '/proc/self/mountinfo',
      '29 23 0:26 / /sys/fs/cgroup/cpu,cpuacct rw,relatime - cgroup cgroup rw,cpu,cpuacct\n' +
        '30 23 0:27 / /sys/fs/cgroup/cpuset rw,relatime - cgroup cgroup rw,cpuset\n',
    ],
    [`${v1CpuDirectory}/cpu.cfs_quota_us`, `${quota}\n`],
    [`${v1CpuDirectory}/cpu.cfs_period_us`, '100000\n'],
    [`${v1CpuDirectory}/cpu.stat`, stat],
    [`${v1CpuDirectory}/cgroup.procs`, cpuProcs],
    [`${v1CpusetDirectory}/cpuset.effective_cpus`, ''],
    [`${v1CpusetDirectory}/cpuset.cpus`, ''],
    ['/sys/fs/cgroup/cpuset/kubepods/burstable/cpuset.cpus', `${cpuset}\n`],
    [`${v1CpusetDirectory}/cpuset.cpu_exclusive`, `${exclusive}\n`],
    [`${v1CpusetDirectory}/cgroup.procs`, cpusetProcs],
    ['/proc/pressure/cpu', pressure],
    ['/proc/stat', selectedCpuStat],
    ['/proc/loadavg', '0.00 0.00 0.00 1/100 100\n'],
  ]);
}

function readMap(files) {
  return (path) => {
    if (!files.has(path)) throw new Error(`fixture has no ${String(path)}`);
    return files.get(path);
  };
}

function v2Files() {
  const selectedCpuStat = Array.from(
    { length: 8 },
    (_, cpu) => `cpu${cpu} 1 2 3 4 5 6 7 10 0 0`,
  ).join('\n');
  return new Map([
    ['/proc/self/cgroup', '0::/github/job\n'],
    ['/proc/self/mountinfo', '29 23 0:26 / /sys/fs/cgroup rw,relatime - cgroup2 cgroup rw\n'],
    ['/sys/fs/cgroup/github/job/cpu.max', '800000 100000\n'],
    ['/sys/fs/cgroup/github/job/cpu.stat', 'usage_usec 100\nthrottled_usec 20\nnr_throttled 2\n'],
    ['/sys/fs/cgroup/github/job/cpuset.cpus.effective', '0-7\n'],
    ['/sys/fs/cgroup/github/job/cpu.pressure', 'some total=10\nfull total=30\n'],
    ['/sys/fs/cgroup/github/job/cgroup.procs', '100\n'],
    ['/proc/stat', selectedCpuStat],
    ['/proc/loadavg', '0.00 0.00 0.00 1/100 100\n'],
  ]);
}

function telemetrySnapshot({
  cpuset = '0-7',
  stealTicks = 10,
  throttledUsec = 20,
  throttleEvents = 2,
  pressureSomeTotal = 10,
  pressureFullTotal = 30,
  processIds = [100],
  allowedProcessIds = [100],
  complete = true,
} = {}) {
  return {
    at: '2026-08-30T00:00:00.000Z',
    monotonicNanoseconds: '1',
    raw: {
      cgroup: '0::/github/job',
      cpuMax: '800000 100000',
      cpuStat: 'usage_usec 100\nthrottled_usec 20\nnr_throttled 2',
      cpusetCpusEffective: cpuset,
      cpuPressure: `some avg10=0 avg60=0 avg300=0 total=${pressureSomeTotal}${
        pressureFullTotal === null
          ? ''
          : `\nfull avg10=0 avg60=0 avg300=0 total=${pressureFullTotal}`
      }`,
      selectedCpuStat:
        'cpu0 1 2 3 4 5 6 7 10 0 0\ncpu1 1 2 3 4 5 6 7 10 0 0\ncpu2 1 2 3 4 5 6 7 10 0 0\ncpu3 1 2 3 4 5 6 7 10 0 0\ncpu4 1 2 3 4 5 6 7 10 0 0\ncpu5 1 2 3 4 5 6 7 10 0 0\ncpu6 1 2 3 4 5 6 7 10 0 0\ncpu7 1 2 3 4 5 6 7 10 0 0',
      loadavg: '0.00 0.00 0.00 1/100 100',
      cgroupProcs: processIds.join('\n'),
    },
    parsed: {
      cpuMax: parseCpuMax('800000 100000'),
      cpuStat: parseCpuStat(
        `usage_usec 100\nthrottled_usec ${throttledUsec}\nnr_throttled ${throttleEvents}`,
      ),
      cpuset:
        cpuset === '0-95'
          ? Array.from({ length: 96 }, (_, index) => index)
          : [0, 1, 2, 3, 4, 5, 6, 7],
      pressureSomeTotal,
      pressureFullTotal,
      selectedCpuStat: { stealTicks },
      cgroupProcs: processIds,
    },
    processMembership: {
      observedProcessIds: processIds,
      allowedProcessIds,
      childPid: 200,
      processTreeComplete: true,
    },
    complete,
    missing: complete ? [] : ['cpuStatCounters'],
  };
}

function cleanPair(options = {}) {
  return [
    telemetrySnapshot({
      ...options,
      stealTicks: 10,
      throttledUsec: 20,
      throttleEvents: 2,
      pressureFullTotal: 30,
    }),
    telemetrySnapshot({
      ...options,
      stealTicks: 10,
      throttledUsec: 20,
      throttleEvents: 2,
      pressureFullTotal: 30,
    }),
  ];
}

function assess(snapshots, child = { exitCode: 0, signal: null }) {
  return assessRunnerAdmission({
    resources,
    affinity,
    snapshots,
    child,
    platform: 'linux',
    cgroup: { ok: true, version: 'v2', hierarchy: 'cgroup-v2', pressureSource: 'cgroup' },
  });
}

test('accepts an exclusive, quiet, naturally exited benchmark', () => {
  const result = assess(cleanPair());
  assert.equal(result.verdict, 'accepted');
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.pressureEvidenceMode, 'cgroup-some-and-full');
  assert.equal(result.checks.pressureEvidenceAccepted, true);
  assert.deepEqual(result.deltas, {
    selectedCpuStealTicks: 0,
    cgroupThrottledUsec: 0,
    cgroupThrottledTimeNanoseconds: null,
    cgroupThrottleEvents: 0,
    cgroupFullPressureTotal: 0,
  });
});

test('rejects a wider effective cpuset instead of selecting an arbitrary subset', () => {
  const result = assess([
    telemetrySnapshot({ cpuset: '0-95' }),
    telemetrySnapshot({ cpuset: '0-95' }),
  ]);
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.reasonCodes.includes('cpuset-not-exclusive'));
});

test('rejects selected CPU steal, cgroup throttling, and full pressure deltas', () => {
  const cases = [
    ['selected-cpu-steal-delta', { first: { stealTicks: 10 }, last: { stealTicks: 11 } }],
    ['cgroup-throttled-usec-delta', { first: { throttledUsec: 20 }, last: { throttledUsec: 21 } }],
    [
      'cgroup-full-pressure-delta',
      { first: { pressureFullTotal: 30 }, last: { pressureFullTotal: 31 } },
    ],
  ];
  for (const [reason, values] of cases) {
    const first = telemetrySnapshot(values.first);
    const last = telemetrySnapshot(values.last);
    const result = assess([first, last]);
    assert.equal(result.verdict, 'rejected');
    assert.ok(result.reasonCodes.includes(reason));
  }
});

test('rejects cgroup throttle event growth and sibling processes', () => {
  const result = assess([
    telemetrySnapshot({ throttleEvents: 2, processIds: [100, 300], allowedProcessIds: [100] }),
    telemetrySnapshot({ throttleEvents: 3, processIds: [100, 300], allowedProcessIds: [100] }),
  ]);
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.reasonCodes.includes('cgroup-throttle-event-delta'));
  assert.ok(result.reasonCodes.includes('unrelated-cgroup-process'));
  assert.deepEqual(result.unrelatedProcessIds, [300]);
});

test('rejects missing telemetry counters', () => {
  const result = assess([
    telemetrySnapshot({ complete: false }),
    telemetrySnapshot({ complete: false }),
  ]);
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.reasonCodes.includes('telemetry-incomplete'));
});

test('rejects a signalled child but preserves a naturally blocked benchmark result as a separate decision', () => {
  const signalled = assess(cleanPair(), { exitCode: null, signal: 'SIGTERM' });
  assert.equal(signalled.verdict, 'rejected');
  assert.ok(signalled.reasonCodes.includes('child-exit-not-natural'));

  const blocked = assess(cleanPair(), { exitCode: 2, signal: null });
  assert.equal(blocked.verdict, 'accepted');
  assert.equal(blocked.checks.naturalChildExit, true);
});

test('wrapper clears a stale report and runs the literal benchmark once', async () => {
  const report = '{"verdict":"blocked"}\n';
  const written = [];
  let reportState = report;
  let unlinkCalls = 0;
  let snapshots = 0;
  const cgroup = {
    ok: true,
    mountpoint: '/sys/fs/cgroup',
    relativePath: '/github/job',
    rawCgroup: { value: '0::/github/job' },
    files: {},
  };
  const result = await runGpuPassTimingWithRunnerAdmission({
    read: (path) => {
      if (path === 'gpu-pass-timing-report.json' && reportState !== null) return reportState;
      throw new Error(`fixture has no ${String(path)}`);
    },
    unlink: (path) => {
      assert.equal(path, 'gpu-pass-timing-report.json');
      unlinkCalls += 1;
      reportState = null;
    },
    write: (path, value) => written.push({ path, value }),
    resources,
    platform: 'linux',
    allowedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    affinity,
    cgroup,
    processId: 100,
    snapshotFactory: () => {
      snapshots += 1;
      return telemetrySnapshot();
    },
    spawnChild: async ({ command, useTaskset, onSpawn }) => {
      assert.deepEqual(command, [...GPU_PASS_TIMING_COMMAND]);
      assert.equal(useTaskset, true);
      onSpawn(200);
      reportState = report;
      return { exitCode: 2, signal: null, naturalExit: true };
    },
    intervalMs: 60_000,
    timestamp: () => '2026-08-30T00:00:00.000Z',
    monotonicNanoseconds: () => '1',
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.artifact.admission.verdict, 'accepted');
  assert.equal(result.artifact.child.exitCode, 2);
  assert.equal(unlinkCalls, 1);
  assert.equal(result.artifact.report.cleanup.cleared, true);
  assert.equal(result.artifact.preflight.reportCleared, true);
  assert.equal(result.artifact.report.after.bytes, Buffer.byteLength(report));
  assert.equal(result.artifact.report.after.sha256, result.artifact.report.before.sha256);
  assert.equal(snapshots, 2);
  assert.equal(written.length, 1);
  assert.equal(written[0].path, 'gpu-pass-timing-runner-admission.json');
  assert.deepEqual(result.artifact.command, [...GPU_PASS_TIMING_COMMAND]);
});

test('rejects a stale report when exact output cleanup fails before spawn', async () => {
  const report = '{"verdict":"stale"}\n';
  let childRuns = 0;
  const cgroup = {
    ok: true,
    version: 'v2',
    hierarchy: 'cgroup-v2',
    pressureSource: 'cgroup',
    mountpoint: '/sys/fs/cgroup',
    relativePath: '/github/job',
    rawCgroup: { value: '0::/github/job' },
    files: {},
  };
  const result = await runGpuPassTimingWithRunnerAdmission({
    read: (path) => {
      if (path === 'gpu-pass-timing-report.json') return report;
      throw new Error(`fixture has no ${String(path)}`);
    },
    unlink: () => {
      throw new Error('permission denied');
    },
    write: () => {},
    resources,
    platform: 'linux',
    allowedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    affinity,
    cgroup,
    processId: 100,
    snapshotFactory: () => telemetrySnapshot(),
    spawnChild: async ({ onSpawn }) => {
      childRuns += 1;
      onSpawn(200);
      return { exitCode: 0, signal: null, naturalExit: true };
    },
    intervalMs: 60_000,
  });
  assert.equal(childRuns, 0);
  assert.equal(result.artifact.benchmarkStarted, false);
  assert.equal(result.artifact.report.cleanup.cleared, false);
  assert.ok(result.artifact.admission.reasonCodes.includes('report-output-not-cleared'));
  assert.equal(result.exitCode, 1);
});

test('wrapper rejects a shared runner before spawning the benchmark', async () => {
  let childRuns = 0;
  const cgroup = {
    ok: true,
    mountpoint: '/sys/fs/cgroup',
    relativePath: '/github/job',
    rawCgroup: { value: '0::/github/job' },
    files: {},
  };
  const result = await runGpuPassTimingWithRunnerAdmission({
    read: () => {
      throw new Error('not used by synthetic snapshots');
    },
    write: () => {},
    resources,
    platform: 'linux',
    allowedCpus: Array.from({ length: 96 }, (_, index) => index),
    affinity,
    cgroup,
    processId: 100,
    snapshotFactory: () => telemetrySnapshot({ cpuset: '0-95' }),
    spawnChild: async ({ onSpawn }) => {
      childRuns += 1;
      onSpawn(200);
      return { exitCode: 0, signal: null, naturalExit: true };
    },
    intervalMs: 60_000,
  });
  assert.equal(childRuns, 0);
  assert.equal(result.artifact.admission.verdict, 'rejected');
  assert.equal(result.artifact.benchmarkStarted, false);
  assert.equal(result.artifact.admission.reasonCodes.includes('cpuset-not-exclusive'), true);
  assert.equal(result.exitCode, 1);
});

test('records cgroup v1 as unavailable instead of mislabeling it as cgroup v2', async () => {
  const result = await runGpuPassTimingWithRunnerAdmission({
    read: () => {
      throw new Error('not used by synthetic snapshots');
    },
    write: () => {},
    resources,
    platform: 'linux',
    allowedCpus: Array.from({ length: 8 }, (_, index) => index),
    affinity,
    cgroup: { ok: false, reason: 'cgroup-v2-membership-unavailable' },
    processId: 100,
    snapshotFactory: () => telemetrySnapshot(),
    spawnChild: async ({ onSpawn }) => {
      onSpawn(200);
      return { exitCode: 0, signal: null, naturalExit: true };
    },
    intervalMs: 60_000,
  });
  assert.equal(result.artifact.preflight.cgroupV2, false);
  assert.equal(result.artifact.preflight.cgroupReason, 'cgroup-v2-membership-unavailable');
  assert.ok(result.artifact.admission.reasonCodes.includes('cgroup-v2-unavailable'));
  assert.equal(result.exitCode, 1);
});

test('resolves cgroup v1 controller mounts and inherited cpuset evidence', () => {
  const files = v1Files();
  const cgroup = resolveCgroupPaths({ read: readMap(files) });
  assert.equal(cgroup.ok, true);
  assert.equal(cgroup.version, 'v1');
  assert.equal(cgroup.controllers.cpu.mountpoint, '/sys/fs/cgroup/cpu,cpuacct');
  assert.equal(cgroup.files.cpusetSource, 'cpuset.cpus');
  assert.equal(cgroup.files.cpuset, '/sys/fs/cgroup/cpuset/kubepods/burstable/cpuset.cpus');
  assert.equal(cgroup.pressureSource, 'host');
  assert.match(cgroup.files.cpuStat, /cpu\.stat$/);
});

test('strips a non-root cgroup mount root before joining membership paths', () => {
  const files = v1Files();
  const nonRoot = new Map(files);
  for (const [path, value] of files) {
    if (path.includes('/sys/fs/cgroup/cpu,cpuacct/kubepods/burstable/pod-a')) {
      nonRoot.delete(path);
      nonRoot.set(
        path.replace(
          '/sys/fs/cgroup/cpu,cpuacct/kubepods/burstable/pod-a',
          '/sys/fs/cgroup/cpu,cpuacct/pod-a',
        ),
        value,
      );
    }
    if (path.includes('/sys/fs/cgroup/cpuset/kubepods/burstable/pod-a')) {
      nonRoot.delete(path);
      nonRoot.set(
        path.replace(
          '/sys/fs/cgroup/cpuset/kubepods/burstable/pod-a',
          '/sys/fs/cgroup/cpuset/pod-a',
        ),
        value,
      );
    }
  }
  nonRoot.delete('/sys/fs/cgroup/cpuset/kubepods/burstable/cpuset.cpus');
  nonRoot.set('/sys/fs/cgroup/cpuset/cpuset.cpus', '0-7\n');
  nonRoot.set(
    '/proc/self/mountinfo',
    files
      .get('/proc/self/mountinfo')
      .replace(' / /sys/fs/cgroup/cpu,cpuacct', ' /kubepods/burstable /sys/fs/cgroup/cpu,cpuacct')
      .replace(' / /sys/fs/cgroup/cpuset', ' /kubepods/burstable /sys/fs/cgroup/cpuset'),
  );
  const cgroup = resolveCgroupPaths({ read: readMap(nonRoot) });
  assert.equal(cgroup.ok, true);
  assert.equal(cgroup.controllers.cpu.directory, '/sys/fs/cgroup/cpu,cpuacct/pod-a');
  assert.equal(cgroup.controllers.cpuset.directory, '/sys/fs/cgroup/cpuset/pod-a');
  assert.equal(cgroup.files.cpuset, '/sys/fs/cgroup/cpuset/cpuset.cpus');
});

test('rejects admission without an explicit cgroup hierarchy', () => {
  const result = assessRunnerAdmission({
    resources,
    affinity,
    snapshots: cleanPair(),
    child: { exitCode: 0, signal: null, naturalExit: true },
    platform: 'linux',
  });
  assert.equal(result.verdict, 'rejected');
  assert.equal(result.preflightAccepted, false);
  assert.ok(result.reasonCodes.includes('cgroup-v2-unavailable'));
});

test('decodes escaped cgroup v1 mountpoints', () => {
  const files = v1Files();
  const escaped = new Map(files);
  for (const [path, value] of files) {
    if (path.includes('/sys/fs/cgroup/cpu,cpuacct/')) {
      escaped.delete(path);
      escaped.set(path.replace('/sys/fs/cgroup/cpu,cpuacct', '/sys/fs/cgroup/cpu acct'), value);
    }
  }
  escaped.set(
    '/proc/self/mountinfo',
    files
      .get('/proc/self/mountinfo')
      .replace('/sys/fs/cgroup/cpu,cpuacct', '/sys/fs/cgroup/cpu\\040acct'),
  );
  const cgroup = resolveCgroupPaths({ read: readMap(escaped) });
  assert.equal(cgroup.ok, true);
  assert.equal(cgroup.controllers.cpu.mountpoint, '/sys/fs/cgroup/cpu acct');
});

test('keeps cgroup v2 resolver and admission behavior intact', () => {
  const files = v2Files();
  const cgroup = resolveCgroupPaths({ read: readMap(files) });
  assert.equal(cgroup.ok, true);
  assert.equal(cgroup.version, 'v2');
  assert.equal(cgroup.pressureSource, 'cgroup');
  const snapshot = collectRunnerTelemetrySnapshot({
    read: readMap(files),
    cgroup,
    selectedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    allowedProcessIds: [100],
  });
  assert.equal(snapshot.complete, true);
  const result = assessRunnerAdmission({
    resources,
    affinity,
    snapshots: [snapshot, structuredClone(snapshot)],
    child: { exitCode: 0, signal: null, naturalExit: true },
    platform: 'linux',
    cgroup,
  });
  assert.equal(result.verdict, 'accepted');
  assert.equal(result.checks.zeroCgroupThrottledTimeDelta, true);
  assert.equal(result.pressureEvidenceMode, 'cgroup-some-and-full');
  assert.equal(result.checks.zeroCgroupFullPressureTotalDelta, true);
  assert.equal(result.checks.pressureEvidenceAccepted, true);
});

test('accepts clean cgroup v1 telemetry with normalized throttled time', () => {
  const files = v1Files({ throttleTime: '2000' });
  const cgroup = resolveCgroupPaths({ read: readMap(files) });
  assert.equal(cgroup.ok, true);
  const snapshot = collectRunnerTelemetrySnapshot({
    read: readMap(files),
    cgroup,
    selectedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    allowedProcessIds: [100],
  });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.raw.cpuQuota, '800000\n');
  assert.equal(snapshot.parsed.cpuMax.cpus, 8);
  assert.equal(snapshot.parsed.cpuStat.throttled_time_nanoseconds, '2000');
  assert.equal(snapshot.parsed.cpuStat.throttled_usec, 2);
  const result = assessRunnerAdmission({
    resources,
    affinity,
    snapshots: [snapshot, structuredClone(snapshot)],
    child: { exitCode: 0, signal: null, naturalExit: true },
    platform: 'linux',
    cgroup,
  });
  assert.equal(result.verdict, 'accepted');
  assert.equal(result.pressureSource, 'host');
  assert.equal(result.pressureEvidenceMode, 'host-some-and-full');
  assert.equal(result.checks.zeroCgroupFullPressureTotalDelta, true);
  assert.equal(result.checks.pressureEvidenceAccepted, true);
  assert.deepEqual(result.deltas, {
    selectedCpuStealTicks: 0,
    cgroupThrottledUsec: 0,
    cgroupThrottledTimeNanoseconds: 0,
    cgroupThrottleEvents: 0,
    cgroupFullPressureTotal: 0,
  });
});

test('accepts isolated cgroup v1 telemetry with host some-only PSI', () => {
  const files = v1Files({
    pressure: 'some avg10=0 avg60=0 avg300=0 total=10\n',
  });
  const cgroup = resolveCgroupPaths({ read: readMap(files) });
  const snapshot = collectRunnerTelemetrySnapshot({
    read: readMap(files),
    cgroup,
    selectedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    allowedProcessIds: [100],
  });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.parsed.pressureSomeTotal, 10);
  assert.equal(snapshot.parsed.pressureFullTotal, null);
  assert.equal(snapshot.pressureEvidenceMode, 'host-some-only');

  const result = assessRunnerAdmission({
    resources,
    affinity,
    snapshots: [snapshot, structuredClone(snapshot)],
    child: { exitCode: 0, signal: null, naturalExit: true },
    platform: 'linux',
    cgroup,
  });
  assert.equal(result.verdict, 'accepted');
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.pressureEvidenceMode, 'host-some-only');
  assert.equal(result.checks.pressureEvidenceAccepted, true);
  assert.equal(result.checks.zeroCgroupFullPressureTotalDelta, null);
  assert.equal(result.deltas.cgroupFullPressureTotal, null);
});

test('rejects v1 some-only PSI on broad, nonexclusive, or unrelated runner state before spawn', async () => {
  const files = v1Files({
    cpuset: '0-95',
    exclusive: '0',
    cpuProcs: '100\n868\n',
    cpusetProcs: '100\n868\n',
    pressure: 'some avg10=0 avg60=0 avg300=0 total=10\n',
  });
  const cgroup = resolveCgroupPaths({ read: readMap(files) });
  const report = '{"verdict":"stale"}\n';
  let reportState = report;
  let childRuns = 0;
  const result = await runGpuPassTimingWithRunnerAdmission({
    read: (path) => {
      if (path === 'gpu-pass-timing-report.json' && reportState !== null) return reportState;
      return readMap(files)(path);
    },
    unlink: (path) => {
      assert.equal(path, 'gpu-pass-timing-report.json');
      reportState = null;
    },
    write: () => {},
    resources,
    platform: 'linux',
    allowedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    affinity,
    cgroup,
    processId: 100,
    snapshotFactory: (options) =>
      collectRunnerTelemetrySnapshot({
        ...options,
        read: readMap(files),
        cgroup,
      }),
    spawnChild: async ({ onSpawn }) => {
      childRuns += 1;
      onSpawn(200);
      return { exitCode: 0, signal: null, naturalExit: true };
    },
    intervalMs: 60_000,
  });
  assert.equal(childRuns, 0);
  assert.equal(result.artifact.benchmarkStarted, false);
  assert.equal(result.artifact.preflight.reportCleared, true);
  assert.equal(result.artifact.report.cleanup.cleared, true);
  assert.equal(result.artifact.preflight.pressureEvidenceMode, 'host-some-only');
  assert.equal(result.artifact.admission.pressureEvidenceMode, 'host-some-only');
  assert.ok(result.artifact.admission.reasonCodes.includes('cpuset-not-exclusive'));
  assert.ok(result.artifact.admission.reasonCodes.includes('cpuset-cpu-exclusive-not-set'));
  assert.ok(result.artifact.admission.reasonCodes.includes('unrelated-cgroup-process'));
  assert.equal(result.artifact.admission.reasonCodes.includes('telemetry-incomplete'), false);
  assert.equal(result.artifact.admission.checks.pressureEvidenceAccepted, false);
  assert.equal(result.exitCode, 1);
});

test('rejects cgroup v1 telemetry when both PSI totals are missing', async () => {
  const files = v1Files({ pressure: '' });
  const cgroup = resolveCgroupPaths({ read: readMap(files) });
  let childRuns = 0;
  const result = await runGpuPassTimingWithRunnerAdmission({
    read: readMap(files),
    write: () => {},
    resources,
    platform: 'linux',
    allowedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    affinity,
    cgroup,
    processId: 100,
    snapshotFactory: (options) =>
      collectRunnerTelemetrySnapshot({
        ...options,
        read: readMap(files),
        cgroup,
      }),
    spawnChild: async ({ onSpawn }) => {
      childRuns += 1;
      onSpawn(200);
      return { exitCode: 0, signal: null, naturalExit: true };
    },
    intervalMs: 60_000,
  });
  assert.equal(childRuns, 0);
  assert.equal(result.artifact.benchmarkStarted, false);
  assert.equal(result.artifact.preflight.pressureEvidenceMode, 'unavailable');
  assert.equal(result.artifact.admission.pressureEvidenceMode, 'unavailable');
  assert.ok(result.artifact.admission.reasonCodes.includes('telemetry-incomplete'));
  assert.equal(
    result.artifact.admission.reasonCodes.includes('cgroup-full-pressure-missing'),
    false,
  );
  assert.equal(result.artifact.admission.checks.pressureEvidenceAccepted, false);
  assert.equal(result.exitCode, 1);
});

test('rejects cgroup v1 exclusivity, quota, and dynamic contention evidence', () => {
  const files = v1Files();
  const cgroup = resolveCgroupPaths({ read: readMap(files) });
  const clean = collectRunnerTelemetrySnapshot({
    read: readMap(files),
    cgroup,
    selectedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    allowedProcessIds: [100],
  });

  const nonexclusive = structuredClone(clean);
  nonexclusive.parsed.cpusetExclusive = false;
  assert.ok(
    assessRunnerAdmission({
      resources,
      affinity,
      snapshots: [nonexclusive, structuredClone(nonexclusive)],
      child: { exitCode: 0, signal: null, naturalExit: true },
      platform: 'linux',
      cgroup,
    }).reasonCodes.includes('cpuset-cpu-exclusive-not-set'),
  );

  const readableNonexclusiveFiles = v1Files({ exclusive: '0' });
  const readableNonexclusiveCgroup = resolveCgroupPaths({
    read: readMap(readableNonexclusiveFiles),
  });
  const readableNonexclusive = collectRunnerTelemetrySnapshot({
    read: readMap(readableNonexclusiveFiles),
    cgroup: readableNonexclusiveCgroup,
    selectedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    allowedProcessIds: [100],
  });
  assert.equal(readableNonexclusive.complete, true);
  assert.deepEqual(readableNonexclusive.missing, []);

  const quotaMismatch = structuredClone(clean);
  quotaMismatch.parsed.cpuMax.cpus = 4;
  assert.ok(
    assessRunnerAdmission({
      resources,
      affinity,
      snapshots: [quotaMismatch, structuredClone(quotaMismatch)],
      child: { exitCode: 0, signal: null, naturalExit: true },
      platform: 'linux',
      cgroup,
    }).reasonCodes.includes('cpuset-not-exclusive'),
  );

  const contention = structuredClone(clean);
  contention.parsed.selectedCpuStat.stealTicks += 1;
  contention.parsed.cpuStat.throttled_usec += 1;
  contention.parsed.cpuStat.throttled_time_nanoseconds = '3000';
  contention.parsed.cpuStat.nr_throttled += 1;
  contention.parsed.pressureFullTotal += 1;
  const result = assessRunnerAdmission({
    resources,
    affinity,
    snapshots: [clean, contention],
    child: { exitCode: 0, signal: null, naturalExit: true },
    platform: 'linux',
    cgroup,
  });
  assert.ok(result.reasonCodes.includes('selected-cpu-steal-delta'));
  assert.ok(result.reasonCodes.includes('cgroup-throttled-usec-delta'));
  assert.ok(result.reasonCodes.includes('cgroup-throttled-time-delta'));
  assert.ok(result.reasonCodes.includes('cgroup-throttle-event-delta'));
  assert.ok(result.reasonCodes.includes('cgroup-full-pressure-delta'));

  const subMicrosecond = structuredClone(clean);
  subMicrosecond.parsed.cpuStat.throttled_time_nanoseconds = '2001';
  const subMicrosecondResult = assessRunnerAdmission({
    resources,
    affinity,
    snapshots: [clean, subMicrosecond],
    child: { exitCode: 0, signal: null, naturalExit: true },
    platform: 'linux',
    cgroup,
  });
  assert.ok(subMicrosecondResult.reasonCodes.includes('cgroup-throttled-time-delta'));
  assert.equal(subMicrosecondResult.reasonCodes.includes('cgroup-throttled-usec-delta'), false);
});

test('reports missing v1 counters without manufacturing nonzero deltas', () => {
  const files = v1Files();
  const cgroup = resolveCgroupPaths({ read: readMap(files) });
  const clean = collectRunnerTelemetrySnapshot({
    read: readMap(files),
    cgroup,
    selectedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    allowedProcessIds: [100],
  });
  const missing = structuredClone(clean);
  missing.parsed.cpuStat.throttled_usec = undefined;
  missing.parsed.pressureFullTotal = null;
  const result = assessRunnerAdmission({
    resources,
    affinity,
    snapshots: [clean, missing],
    child: { exitCode: 0, signal: null, naturalExit: true },
    platform: 'linux',
    cgroup,
  });
  assert.ok(result.reasonCodes.includes('cgroup-throttled-usec-missing'));
  assert.ok(result.reasonCodes.includes('cgroup-full-pressure-missing'));
  assert.equal(result.reasonCodes.includes('cgroup-throttled-usec-delta'), false);
  assert.equal(result.reasonCodes.includes('cgroup-full-pressure-delta'), false);
});

test('runs an admitted cgroup v1 benchmark exactly once', async () => {
  const files = v1Files();
  const cgroup = resolveCgroupPaths({ read: readMap(files) });
  const snapshot = collectRunnerTelemetrySnapshot({
    read: readMap(files),
    cgroup,
    selectedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    allowedProcessIds: [100],
  });
  let childRuns = 0;
  const result = await runGpuPassTimingWithRunnerAdmission({
    read: readMap(files),
    write: () => {},
    resources,
    platform: 'linux',
    allowedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    affinity,
    cgroup,
    processId: 100,
    snapshotFactory: () => structuredClone(snapshot),
    spawnChild: async ({ command, useTaskset, onSpawn }) => {
      childRuns += 1;
      assert.deepEqual(command, [...GPU_PASS_TIMING_COMMAND]);
      assert.equal(useTaskset, true);
      onSpawn(200);
      return { exitCode: 0, signal: null, naturalExit: true };
    },
    intervalMs: 60_000,
  });
  assert.equal(childRuns, 1);
  assert.equal(result.artifact.preflight.staticAccepted, true);
  assert.equal(result.artifact.benchmarkStarted, true);
  assert.equal(result.exitCode, 0);
});

test('parses the raw Linux admission counters', () => {
  assert.deepEqual(parseCpuMax('800000 100000'), { quota: '800000', period: 100000, cpus: 8 });
  assert.deepEqual(parseCpuCfsQuota('800000', '100000'), {
    quota: 800000,
    period: 100000,
    cpus: 8,
  });
  assert.deepEqual(parseCpuStat('nr_throttled 2\nthrottled_time 2000', 'v1'), {
    nr_throttled: 2,
    throttled_time_nanoseconds: '2000',
    throttled_usec: 2,
  });
  assert.equal(parseCpuPressureSomeTotal('some total=1\nfull total=42'), 1);
  assert.equal(parseCpuPressureFullTotal('some total=1\nfull total=42'), 42);
  assert.equal(parseCpuPressureFullTotal('some total=1'), null);
  assert.equal(parseSelectedCpuStat('cpu0 1 2 3 4 5 6 7 8 9 10', [0]).stealTicks, 8);
});
