// SPDX-License-Identifier: Apache-2.0
// Local, explicitly requested workload comparison. This does not evaluate an agent.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const OUTPUT_LIMIT = 64 * 1024;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
};

export class ComparisonError extends Error {
  constructor(code, message, report) {
    super(message);
    this.name = 'ComparisonError';
    this.code = code;
    if (report) this.report = report;
  }
}

function requireOption(condition, message) {
  if (!condition) throw new ComparisonError('invalid-options', message);
}

function label(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
}

async function validate(options) {
  requireOption(options && typeof options === 'object', 'Comparison options are required.');
  const { baselineDir, candidateDir, command, skill, metric, unit, direction } = options;
  requireOption(typeof baselineDir === 'string' && typeof candidateDir === 'string', 'Two workspace directories are required.');
  requireOption(Array.isArray(command) && command.length > 0 && typeof command[0] === 'string'
    && command[0].length > 0 && command.every((part) => typeof part === 'string' && !part.includes('\0')),
  'Command must be a nonempty executable-and-arguments array.');
  requireOption(typeof skill === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(skill), 'A catalog skill identifier is required.');
  requireOption(label(metric) && label(unit), 'Metric and unit must be explicit, short labels without control characters.');
  requireOption(direction === 'lower' || direction === 'higher', 'Direction must be lower or higher.');
  const repeats = options.repeats ?? 5;
  const warmups = options.warmups ?? 1;
  const timeoutMs = options.timeoutMs ?? 30_000;
  requireOption(Number.isInteger(repeats) && repeats >= 3 && repeats <= 30, 'Repeats must be an integer from 3 to 30.');
  requireOption(Number.isInteger(warmups) && warmups >= 0 && warmups <= 5, 'Warmups must be an integer from 0 to 5.');
  requireOption(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300_000, 'Timeout must be an integer from 1 to 300000 milliseconds.');
  requireOption(options.onProgress === undefined || typeof options.onProgress === 'function', 'Progress handler must be a function.');
  let directories;
  try {
    directories = await Promise.all([baselineDir, candidateDir].map(async (path) => {
      const resolved = await realpath(path);
      if (!(await stat(resolved)).isDirectory()) throw new Error('not-directory');
      return resolved;
    }));
  } catch {
    throw new ComparisonError('invalid-workspace', 'Both comparison workspaces must be existing directories.');
  }
  requireOption(directories[0] !== directories[1], 'Baseline and candidate must resolve to different directories.');
  return { directories, command: [...command], skill, metric, unit, direction, repeats, warmups, timeoutMs, onProgress: options.onProgress };
}

function execute(command, cwd, timeoutMs, metric, unit) {
  return new Promise((resolve) => {
    const started = performance.now();
    let child;
    let timer;
    let forceTimer;
    let settleTimer;
    let finished = false;
    let terminating = false;
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      // A child may close its pipes before descendants handle termination.
      if (terminating) kill('SIGKILL');
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(settleTimer);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({ ...result, duration_ms: Math.round((performance.now() - started) * 100) / 100,
        stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes });
    };
    const kill = (signal) => {
      try {
        if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, signal);
        else child?.kill(signal);
      } catch {
        try { child?.kill(signal); } catch { /* Process has already exited. */ }
      }
    };
    const stop = (code) => {
      if (terminating || finished) return;
      terminating = true;
      failure = code;
      kill('SIGTERM');
      forceTimer = setTimeout(() => kill('SIGKILL'), 100);
      // Descendants can keep pipes open. Bound the collector too.
      settleTimer = setTimeout(() => finish({ status: 'failed', error: code }), 250);
    };
    try {
      child = spawn(command[0], command.slice(1), {
        cwd, shell: false, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch {
      finish({ status: 'failed', error: 'spawn-failed' });
      return;
    }
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes + stderrBytes > OUTPUT_LIMIT) stop('output-limit');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > OUTPUT_LIMIT) stop('output-limit');
    });
    child.on('error', () => finish({ status: 'failed', error: 'spawn-failed' }));
    child.on('close', (code) => {
      if (finished) return;
      if (failure) return finish({ status: 'failed', error: failure });
      if (code !== 0) return finish({ status: 'failed', error: 'command-failed' });
      let result;
      try {
        const line = Buffer.concat(stdout).toString('utf8').trim().split(/\r?\n/).at(-1);
        result = JSON.parse(line);
      } catch {
        return finish({ status: 'failed', error: 'invalid-result' });
      }
      if (!result || Array.isArray(result) || typeof result !== 'object'
        || typeof result.value !== 'number' || !Number.isFinite(result.value)) {
        return finish({ status: 'failed', error: 'invalid-result' });
      }
      if (result.checks_passed !== true) return finish({ status: 'failed', error: 'correctness-not-confirmed' });
      if ((result.metric !== undefined && result.metric !== metric)
        || (result.unit !== undefined && result.unit !== unit)) {
        return finish({ status: 'failed', error: 'metric-mismatch' });
      }
      finish({ status: 'passed', value: result.value });
    });
  });
}

/**
 * Run an explicit benchmark in two user-prepared workspaces. No shell is used.
 * The last nonempty stdout line must be JSON with a finite numeric `value` and
 * `checks_passed: true`. Optional metric/unit fields must match the options.
 * Earlier stdout and stderr are discarded, bounded to 64 KiB combined per run.
 * onProgress receives sanitized {type: 'trial-complete', trial, counts} events.
 * Failures throw ComparisonError with the partial, sanitized report on .report.
 * This executes user code with the caller's environment and is NOT a sandbox.
 */
export async function runComparison(options) {
  const config = await validate(options);
  const started = performance.now();
  const report = {
    schema_version: 1,
    kind: 'observed-workload-change',
    source: 'user-supplied-benchmark',
    attribution: 'not-established',
    status: 'running',
    skill: config.skill, metric: config.metric, unit: config.unit, direction: config.direction,
    command_sha256: createHash('sha256').update(JSON.stringify(config.command)).digest('hex'),
    environment: { node: process.version, os: process.platform, arch: process.arch },
    configuration: { repeats: config.repeats, warmups_per_arm: config.warmups, timeout_ms: config.timeoutMs, output_limit_bytes: OUTPUT_LIMIT },
    started_at: new Date().toISOString(),
    counts: { planned_trials: 2 * (config.repeats + config.warmups), attempted_trials: 0,
      completed_trials: 0, failed_trials: 0, completed_pairs: 0 },
    trials: [], pairs: [], summary: null,
    limitations: [
      'Observed workload difference only; no causal attribution to the named skill.',
      'Correctness is asserted by the user-supplied benchmark, not independently verified.',
      'No statistical generalization; workloads, caches and external state may differ.',
      'No skill activation or agent token/cost measurement is performed.',
    ],
  };
  const finishReport = () => {
    report.elapsed_ms = Math.round((performance.now() - started) * 100) / 100;
    report.finished_at = new Date().toISOString();
  };
  for (const phase of ['warmup', 'measurement']) {
    const count = phase === 'warmup' ? config.warmups : config.repeats;
    for (let pair = 0; pair < count; pair += 1) {
      const order = pair % 2 === 0 ? [0, 1] : [1, 0];
      const values = {};
      for (const index of order) {
        const arm = index === 0 ? 'baseline' : 'candidate';
        report.counts.attempted_trials += 1;
        const trial = {
          sequence: report.counts.attempted_trials, phase, pair: pair + 1, arm,
          ...await execute(config.command, config.directories[index], config.timeoutMs, config.metric, config.unit),
        };
        report.trials.push(trial);
        if (trial.status === 'passed') {
          report.counts.completed_trials += 1;
          values[arm] = trial.value;
        } else report.counts.failed_trials += 1;
        if (phase === 'measurement' && Object.hasOwn(values, 'baseline') && Object.hasOwn(values, 'candidate')) {
          report.pairs.push({ pair: pair + 1, order: order.map((i) => i === 0 ? 'baseline' : 'candidate'),
            baseline: values.baseline, candidate: values.candidate });
          report.counts.completed_pairs += 1;
        }
        if (trial.status !== 'passed') report.status = 'failed';
        finishReport();
        if (config.onProgress) {
          try {
            await config.onProgress({ type: 'trial-complete', trial: { ...trial }, counts: { ...report.counts } });
          } catch {
            report.status = 'failed';
            throw new ComparisonError('progress-handler-failed', 'Progress reporting failed; comparison stopped.', report);
          }
        }
        if (trial.status !== 'passed') {
          throw new ComparisonError(trial.error, `Comparison stopped: ${trial.error}. Partial trials are retained.`, report);
        }
      }
    }
  }
  const baseline = median(report.pairs.map((pair) => pair.baseline));
  const candidate = median(report.pairs.map((pair) => pair.candidate));
  const sign = config.direction === 'lower' ? -1 : 1;
  const improvement = sign * (candidate - baseline);
  const pairedImprovement = median(report.pairs.map((pair) => sign * (pair.candidate - pair.baseline)));
  const percent = baseline === 0 ? null : improvement / Math.abs(baseline) * 100;
  // Finite inputs can still overflow during arithmetic; never serialize Infinity as null.
  if (![improvement, pairedImprovement, ...(percent === null ? [] : [percent])].every(Number.isFinite)) {
    report.status = 'failed';
    finishReport();
    throw new ComparisonError('numeric-overflow', 'Observed values exceed the supported arithmetic range.', report);
  }
  report.summary = {
    baseline_median: baseline, candidate_median: candidate,
    observed_improvement: improvement,
    observed_improvement_percent: percent,
    paired_improvement_median: pairedImprovement,
    percent_formula: 'directional improvement / abs(baseline median) * 100',
    percentage_status: baseline === 0 ? 'undefined-zero-baseline' : 'available',
    interpretation: 'Positive improvement favors the candidate under the requested metric direction.',
  };
  report.status = 'completed';
  finishReport();
  return report;
}
