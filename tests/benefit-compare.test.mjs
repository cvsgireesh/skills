// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runComparison, ComparisonError } from '../bin/benefit/compare.mjs';

async function fixture(t, baseline = 100, candidate = 80, script) {
  const root = await mkdtemp(path.join(tmpdir(), 'benefit-comparison-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineDir = path.join(root, 'baseline');
  const candidateDir = path.join(root, 'candidate');
  for (const [dir, value] of [[baselineDir, baseline], [candidateDir, candidate]]) {
    await mkdir(dir);
    await writeFile(path.join(dir, 'value.json'), JSON.stringify(value));
    await writeFile(path.join(dir, 'benchmark.mjs'), script ?? `
      import { readFileSync } from 'node:fs';
      console.log(JSON.stringify({value: JSON.parse(readFileSync('value.json')), checks_passed:true}));
    `);
  }
  return { root, baselineDir, candidateDir, command: [process.execPath, 'benchmark.mjs'],
    skill: 'sample-skill', metric: 'latency', unit: 'ms', direction: 'lower', repeats: 3, warmups: 0 };
}

test('lower-is-better comparison retains all pairs and excludes warmups', async (t) => {
  const events = [];
  const options = await fixture(t);
  const report = await runComparison({ ...options, warmups: 1, onProgress: (event) => events.push(event) });
  assert.equal(report.status, 'completed');
  assert.equal(report.summary.baseline_median, 100);
  assert.equal(report.summary.candidate_median, 80);
  assert.equal(report.summary.observed_improvement_percent, 20);
  assert.equal(report.summary.paired_improvement_median, 20);
  assert.equal(report.trials.length, 8);
  assert.equal(report.pairs.length, 3);
  assert.equal(events.length, 8);
  assert.deepEqual(report.pairs.map((pair) => pair.order), [
    ['baseline', 'candidate'], ['candidate', 'baseline'], ['baseline', 'candidate'],
  ]);
  assert.deepEqual(report.trials.map((trial) => trial.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(report.attribution, 'not-established');
  assert.equal(report.kind, 'observed-workload-change');
  assert.match(report.command_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(report).includes(options.root), false);
  assert.equal(JSON.stringify(report).includes('benchmark.mjs'), false);
});

test('higher-is-better and regression signs follow requested direction', async (t) => {
  const options = await fixture(t, 100, 120);
  const higher = await runComparison({ ...options, direction: 'higher' });
  assert.equal(higher.summary.observed_improvement_percent, 20);
  const lower = await runComparison(options);
  assert.equal(lower.summary.observed_improvement_percent, -20);
});

test('zero baseline reports absolute change with no fabricated percent', async (t) => {
  const options = await fixture(t, 0, 5);
  const report = await runComparison({ ...options, direction: 'higher' });
  assert.equal(report.summary.observed_improvement, 5);
  assert.equal(report.summary.observed_improvement_percent, null);
  assert.equal(report.summary.percentage_status, 'undefined-zero-baseline');
});

test('failed correctness stops comparison and preserves the successful first trial', async (t) => {
  const options = await fixture(t, 100, 80, `
    import { readFileSync } from 'node:fs';
    const value = JSON.parse(readFileSync('value.json'));
    console.log(JSON.stringify({value, checks_passed: value === 100}));
  `);
  await assert.rejects(runComparison(options), (error) => {
    assert.ok(error instanceof ComparisonError);
    assert.equal(error.code, 'correctness-not-confirmed');
    assert.equal(error.report.trials.length, 2);
    assert.equal(error.report.trials[0].value, 100);
    assert.equal(error.report.trials[1].status, 'failed');
    assert.equal(error.report.counts.completed_pairs, 0);
    assert.equal(error.report.summary, null);
    return true;
  });
});

test('numeric strings and non-finite JSON values are rejected', async (t) => {
  const options = await fixture(t, 0, 0, `console.log('{"value":"20","checks_passed":true}');`);
  await assert.rejects(runComparison(options), { code: 'invalid-result' });
  await writeFile(path.join(options.baselineDir, 'benchmark.mjs'), `console.log('{"value":1e999,"checks_passed":true}');`);
  await assert.rejects(runComparison(options), { code: 'invalid-result' });
});

test('optional reported metric and unit must match the requested protocol', async (t) => {
  const options = await fixture(t, 1, 1, `console.log(JSON.stringify({value:1,checks_passed:true,unit:'seconds'}));`);
  await assert.rejects(runComparison(options), { code: 'metric-mismatch' });
});

test('timeout stops a hung workload and retains the failed attempt', async (t) => {
  const options = await fixture(t, 1, 1, 'setInterval(() => {}, 1000);');
  const start = Date.now();
  await assert.rejects(runComparison({ ...options, timeoutMs: 80 }), (error) => {
    assert.equal(error.code, 'timeout');
    assert.equal(error.report.counts.attempted_trials, 1);
    assert.equal(error.report.trials[0].status, 'failed');
    return true;
  });
  assert.ok(Date.now() - start < 3000, 'the collector must also finish within a bound');
});

test('output is bounded and raw output is never copied into a report', async (t) => {
  const options = await fixture(t, 1, 1, `console.log('private-canary-'.repeat(10000));`);
  await assert.rejects(runComparison(options), (error) => {
    assert.equal(error.code, 'output-limit');
    assert.equal(JSON.stringify(error.report).includes('private-canary'), false);
    return true;
  });
});

test('same directory, including a symlink alias, is rejected before running', async (t) => {
  const options = await fixture(t);
  await assert.rejects(runComparison({ ...options, candidateDir: options.baselineDir }), { code: 'invalid-options' });
  const alias = path.join(options.root, 'alias');
  await symlink(options.baselineDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runComparison({ ...options, candidateDir: alias }), { code: 'invalid-options' });
});

test('shell strings, missing identity and out-of-bound runs are rejected', async (t) => {
  const options = await fixture(t);
  for (const patch of [{ command: 'echo 1' }, { command: [] }, { skill: '' }, { repeats: 2 },
    { repeats: 31 }, { warmups: 6 }, { timeoutMs: 0 }, { direction: 'faster' }]) {
    await assert.rejects(runComparison({ ...options, ...patch }), { code: 'invalid-options' });
  }
});

test('nonzero exit cannot be rescued by a valid-looking result', async (t) => {
  const options = await fixture(t, 1, 1, `console.log('{"value":1,"checks_passed":true}'); process.exitCode=1;`);
  await assert.rejects(runComparison(options), { code: 'command-failed' });
});

test('unavailable executable produces a sanitized spawn failure', async (t) => {
  const options = await fixture(t);
  await assert.rejects(runComparison({ ...options, command: [path.join(options.root, 'private-missing-executable')] }), (error) => {
    assert.equal(error.code, 'spawn-failed');
    assert.equal(JSON.stringify(error.report).includes(options.root), false);
    assert.equal(error.message.includes('private-missing'), false);
    return true;
  });
});
