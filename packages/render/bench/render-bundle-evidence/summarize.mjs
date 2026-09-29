import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = new URL('./', import.meta.url);
const sources = ['performance-2.json', 'performance-3.json'];
const runs = await Promise.all(sources.map(async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))));
assert.equal(runs[0].benchmarkSha256, runs[1].benchmarkSha256);
assert.equal(runs[0].baselineSha256, runs[1].baselineSha256);
const variants = ['direct', 'before', 'after'];
const metrics = ['encodingMs', 'finishMs', 'submitMs', 'cpuSubmitMs'];
const quantile = (values, p) => {
  const sorted = [...values].sort((a,b)=>a-b);
  assert(sorted.length > 0 && sorted.every(Number.isFinite));
  const index=(sorted.length-1)*p, low=Math.floor(index), frac=index-low;
  return sorted[low]+(sorted[Math.ceil(index)]-sorted[low])*frac;
};
const cases = runs[0].results.map((first,i)=>{
  const cases = runs.map(run=>run.results[i]);
  for(const c of cases) assert.deepEqual(c.scenario,first.scenario);
  const stats=Object.fromEntries(variants.map(variant=>{
    const samples=cases.flatMap(c=>c.samples[variant]);
    assert.equal(samples.length,cases.reduce((sum,c)=>sum+c.measuredTriads,0));
    return [variant,{count:samples.length,...Object.fromEntries(metrics.map(metric=>[metric,{p50:quantile(samples.map(x=>x[metric]),.5),p95:quantile(samples.map(x=>x[metric]),.95)}]))}];
  }));
  return {scenario:first.scenario,stats};
});
const f=x=>x.toFixed(3), pct=x=>(x>0?'+':'')+x.toFixed(1)+'%';
const rows=cases.map(c=>{
 const s=c.stats;
 return `| ${c.scenario.name} | ${c.scenario.draws} x ${c.scenario.passes} | ${variants.map(v=>f(s[v].cpuSubmitMs.p50)).join(' / ')} | ${variants.map(v=>f(s[v].cpuSubmitMs.p95)).join(' / ')} | ${pct((s.after.cpuSubmitMs.p50/s.direct.cpuSubmitMs.p50-1)*100)} |`;
});
const encode=cases.map(c=>`| ${c.scenario.name} | ${variants.map(v=>f(c.stats[v].encodingMs.p50)).join(' / ')} | ${variants.map(v=>f(c.stats[v].encodingMs.p95)).join(' / ')} |`);
const report = await readFile(new URL('README.md', root), 'utf8');
for (const row of [...rows, ...encode]) assert(report.includes(row), `Report differs from samples: ${row}`);
const volatileSources = ['volatile-performance-1.json', 'volatile-performance-2.json'];
const volatileRuns = await Promise.all(
  volatileSources.map(async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))),
);
assert.equal(volatileRuns[0].benchmarkSha256, volatileRuns[1].benchmarkSha256);
assert.equal(volatileRuns[0].baselineSha256, volatileRuns[1].baselineSha256);
const volatileRows = volatileRuns[0].results.map((first, index) => {
  const cases = volatileRuns.map(run => run.results[index]);
  for (const current of cases) assert.deepEqual(current.scenario, first.scenario);
  const direct = cases.flatMap(current => current.samples.direct.map(sample => sample.cpuSubmitMs));
  const after = cases.flatMap(current => current.samples.after.map(sample => sample.cpuSubmitMs));
  const paired = cases.map(current =>
    quantile(
      current.samples.after.map(
        (sample, sampleIndex) => sample.cpuSubmitMs / current.samples.direct[sampleIndex].cpuSubmitMs - 1,
      ),
      .5,
    ) * 100,
  );
  const directP50 = quantile(direct, .5);
  const afterP50 = quantile(after, .5);
  return `| ${first.scenario.name} | ${f(directP50)} / ${f(afterP50)} | ${pct((afterP50 / directP50 - 1) * 100)} | ${paired.map(pct).join(' / ')} | ${f(quantile(direct, .95))} / ${f(quantile(after, .95))} |`;
});
for (const row of volatileRows)
  assert(report.includes(row), `Volatile report differs from samples: ${row}`);
console.log([
'| Case | Draws x passes | CPU submission p50 D / B / A (ms) | CPU submission p95 D / B / A (ms) | After vs direct p50 |',
'|:--|--:|--:|--:|--:|',...rows,'',
'| Case | Encoding p50 D / B / A (ms) | Encoding p95 D / B / A (ms) |','|:--|--:|--:|',...encode,''].join('\n'));
console.log([
  '| Case | Pooled p50 D / A (ms) | Absolute p50 delta | Paired median delta run 1 / run 2 | Pooled p95 D / A (ms) |',
  '|:--|--:|--:|--:|--:|',
  ...volatileRows,
  '',
].join('\n'));
