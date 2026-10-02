# Skill benefit on your machine (experimental)

This fork adds a small local companion. It observes runtime-reported skill activity and estimated API cost, and lets you compare your actual workload before and after a change. It does not require repository CI, upload feedback, or claim that an activation caused an improvement.

Two questions stay separate:

| Question | Evidence |
|---|---|
| Did the runtime report using this skill, and at what API cost? | Claude Code OpenTelemetry log events |
| Did my workload improve after the change? | Repeated before/after measurements from your benchmark |

A model already knowing the answer, an extra tool, a hardware change or an unrelated code change can explain a better result. This tool reports **observed workload change**, never a universal skill ROI score. Guidance-only skills can remain **not measured**. Any catalog skill can label a comparison; live automatic observation currently supports Claude Code only.

## Preview without enabling anything

From the checkout, with Node 20 or later:

```sh
node bin/intel-skills-benefit.mjs serve --data-dir /tmp/intel-benefit-demo --demo
```

Open the printed `http://127.0.0.1:4319` URL. The banner says DEMO; events are constructed, not a real Intel result. No Claude process is started. Stop with Ctrl-C. Do not mix demo data and real measurements in the same data directory.

## Opt in to runtime observation

1. Start `serve` without `--demo`, in a new private data directory. It binds only to `127.0.0.1` and creates a temporary collector credential with restricted file permissions.
2. In another terminal, run `node bin/intel-skills-benefit.mjs config --data-dir <same-directory>`. It writes a Claude `--settings` file, but does not activate it. By default third-party skill names may be redacted. Add **`--named-skills` only if you accept the privacy tradeoff below**.
3. After checking your organization’s exporter settings, explicitly start a new Claude session with `claude --settings <data-directory>/claude-settings.json`. Work normally and watch the local page update. Stop the collector and remove that launch option to stop this collection. The generated credential expires when the collector stops; regenerate config after a restart.

Managed exporter settings and environment variables can override the settings file. Do not claim local-only collection if those direct telemetry elsewhere. This companion does not override organization policy or disable Claude’s separate operational telemetry. Use the runtime’s debug diagnostics to verify the configured third-party exporter and check the local collector receives events before relying on it. A quiet dashboard means unobserved, not zero use.

### Privacy tradeoff, without fine print

Claude’s `OTEL_LOG_TOOL_DETAILS=1` reveals real third-party skill names **and tool arguments**. Named mode permits those arguments to reach the local receiver in memory. The receiver immediately selects approved numeric/name fields and drops everything else. It never writes raw exports, prompts, arguments, email, account identifiers, repository paths or response bodies. Explicit content flags are off; metrics and traces are disabled so this adapter cannot double-count them.

The receiver keeps runtime skill names, hashed session IDs, activity counts and estimated costs. Names may themselves be sensitive. There are no external requests in the collector. Data files are local, private on POSIX, and retained until you delete the directory; Windows ACLs are not audited. The dashboard and API have no remote scripts, outbound analytics or write/command endpoints. A loopback service is not a sandbox against other processes running as you.

### Evidence limits

- Session activity is **since collector start**, not necessarily the entire session. Capture stops after 50,000 unique records or 200 sessions; the page reports this stopped state. Rejected authorized exports also appear as a degraded capture. Missing event fields remain unknown. No event coverage guarantee.
- `skill_activated` is a runtime-reported invocation. It does not prove every instruction was followed, or verify the installed files came from Intel. Name collisions remain possible.
- API request cost is a runtime estimate for that scope, not billing, time saved or an independent performance result. Unattributed requests remain a separate row. Missing costs are not counted as zero-cost samples.
- Actual Claude-to-collector transmission has **not** been exercised in this development task. Tests use constructed OTLP JSON matching public documentation. Current docs identify v2.1.273 as the point where real names are available on attributed usage with detail logging; earlier clients may redact them.

## Measure a real before/after workload

Prepare two directories representing the baseline and the changed workload. Use the same benchmark command in both. Its final stdout line must be:

```json
{"value": 120.5, "checks_passed": true}
```

`value` is your measured latency, peak memory, throughput or another named metric. `checks_passed` must come from correctness assertions in your benchmark, not the agent saying it looks right. Optional `metric` and `unit` fields must match the command options if included.

```sh
node bin/intel-skills-benefit.mjs compare \
  --data-dir /tmp/intel-benefit-live \
  --skill dpnp-migration \
  --baseline /absolute/path/to/before \
  --candidate /absolute/path/to/after \
  --metric runtime --unit ms --direction lower \
  --repeats 5 -- node benchmark.mjs
```

This executes the supplied command in both directories. It is not an automatic replay of agent actions, and is not sandboxed: choose a benchmark safe to run repeatedly. It may consume compute or contact services if your command does so. Keep machine, input, environment and settings comparable. Alternating paired repetitions reduce order bias; a small sample is not statistical proof. Warmups are excluded. Failed correctness, malformed output or timeout prevents a success summary and preserves the partial report. Zero baselines produce no percentage.

The dashboard reads reports from its data directory every two seconds. A before/after percentage is workload-specific and does not isolate the causal effect of the skill. For causal comparison, control the alternatives and run a reviewed experiment; the tool does not silently spend model tokens or repeat dangerous actions to manufacture that evidence.

## Contributor path and tests

Add a harmless benchmark protocol example for a skill in contributor documentation or a maintained workload project; keep eval fixtures out of installed skill content. Do not modify imported skill bytes directly. Reuse existing provenance/verify when adding future source identity.

```sh
npm run test:benefit
```

No dependencies are installed by this command. Tests exercise evidence normalization, raw-content exclusion, authorization/origin/host checks, repeated comparison, invalid data and failure paths. Review the boundary before expanding beyond a single runtime.

## Primary references (checked October 2, 2026)

- [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage): logs, typed event attributes, HTTP/JSON, privacy flags, scope and cost limitations.
- [OTLP JSON protocol](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding): standard envelope and typed values.
- [Intel SkillEvaluator proposal](https://github.com/intel/skills/pull/34): repository evaluation remains complementary to local observation.
